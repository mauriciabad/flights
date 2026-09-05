import { expect, test } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, mockHostelworld, routeRyanairFlights } from './support/providers';

/**
 * Issue #279's bed block, measured rather than read.
 *
 * The unit tests in `src/lib/stays/PickedBed.test.ts` already assert every word this block
 * prints. They cannot assert a single pixel, because jsdom has no layout: every element
 * there is 0x0, so a check on the reserved media box would pass just as happily against a
 * box that reserves nothing.
 *
 * That gap is not hypothetical in this repo. `TripStrip`'s segments shipped invisible to
 * production at 0 to 2px wide, with the right colours and `visibility: visible`, while all
 * five e2e tests covering the component passed throughout. They asserted that a panel opens
 * and the right words appear. Nothing asked whether anything had size.
 *
 * So this file asks about size, and about the one thing a photograph uniquely threatens:
 * arriving late and shoving the page under the reader's thumb. Every photograph here is
 * served on a delay for exactly that reason. A test where the image is already there when
 * layout runs cannot fail the way the real keyless path fails, where a 2.8 MB Hostelworld
 * original lands seconds after the card does.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

/** A real image with real intrinsic dimensions and no binary fixture to check in. An
 * `<img>` decodes an SVG like any other format, and `naturalWidth` reports what the file
 * says, so "did a picture actually decode" is answerable. */
function photo(label: string, width: number, height: number): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#264653"/><text x="24" y="72" font-size="48" fill="#e9c46a">FIXTURE ${label}</text></svg>`;
}

/** How long each photograph is held back. Long enough that the card has certainly laid out
 * without it, short enough that the test is not slow. */
const PHOTO_DELAY_MS = 1200;

test.describe('the picked bed on the card (issue #279)', () => {
	test('reserves the photograph its space, so a late image shifts nothing', async ({ page }) => {
		await mockAllKeylessProviders(page.context());
		await mockHostelworld(
			page.context(),
			'hostelworld/continents-vienna.json',
			'hostelworld/properties-vienna-photos.json'
		);

		const requested: string[] = [];
		await page.context().route('https://photos.fixture.invalid/**', async (route) => {
			requested.push(route.request().url());
			// The delay is the point. See the file comment.
			await new Promise((resolve) => setTimeout(resolve, PHOTO_DELAY_MS));
			await route.fulfill({
				status: 200,
				contentType: 'image/svg+xml',
				body: route.request().url().includes('one') ? photo('ONE', 1600, 1000) : photo('TWO', 1600, 1000)
			});
		});

		await routeRyanairFlights(page.context(), [
			{
				dep: 'BCN',
				arr: 'VIE',
				depDate: '2027-03-08T08:00:00',
				arrDate: '2027-03-08T10:15:00',
				price: FIXTURE_PRICES.first,
				flightNumber: FIXTURE_FLIGHT_NUMBERS[2]
			},
			{
				dep: 'VIE',
				arr: 'TLL',
				depDate: '2027-03-10T11:00:00',
				arrDate: '2027-03-10T13:20:00',
				price: FIXTURE_PRICES.third,
				flightNumber: FIXTURE_FLIGHT_NUMBERS[4]
			}
		]);

		await page.context().route('https://basemaps.cartocdn.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
		);

		await page.setViewportSize({ width: 375, height: 780 });
		await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
		await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 20_000 });

		await openTheDetail(page);

		const media = page.locator('.bed-media').first();
		await expect(media).toBeVisible();

		// 1. The box holds its space before a byte of image has arrived. This is the
		//    assertion TripStrip's five passing tests did not make.
		const empty = await media.boundingBox();
		expect(empty).not.toBeNull();
		expect(empty!.width).toBeGreaterThan(250);
		expect(empty!.height).toBeGreaterThan(140);

		// 2. Nothing below the photograph moves when it lands. The transfer line sits under
		//    the whole block, so its top is what a late image would push down.
		const transfer = page.locator('.bed-transfer').first();
		const beforeLoad = await transfer.boundingBox();

		const image = media.locator('img').first();
		await expect
			.poll(async () => image.evaluate((el: HTMLImageElement) => el.naturalWidth), {
				timeout: 15_000
			})
			.toBeGreaterThan(0);

		const afterLoad = await transfer.boundingBox();
		expect(afterLoad!.y).toBeCloseTo(beforeLoad!.y, 0);

		// 3. The picture is genuinely drawn at the box's size, not collapsed inside it.
		const drawn = await image.boundingBox();
		expect(drawn!.width).toBeCloseTo(empty!.width, 0);
		expect(drawn!.height).toBeCloseTo(empty!.height, 0);

		// 4. Only the first photograph was ever fetched. Hostelworld's originals run to
		//    2.8 MB with no resize, so the second one is the reader's to ask for.
		expect(requested).toHaveLength(1);
		expect(requested[0]).toContain('FIXTURE-one');
	});

	test('pages to the second photograph on click and on an arrow key, and fetches it then', async ({
		page
	}) => {
		await mockAllKeylessProviders(page.context());
		await mockHostelworld(
			page.context(),
			'hostelworld/continents-vienna.json',
			'hostelworld/properties-vienna-photos.json'
		);

		const requested: string[] = [];
		await page.context().route('https://photos.fixture.invalid/**', async (route) => {
			requested.push(route.request().url());
			await route.fulfill({
				status: 200,
				contentType: 'image/svg+xml',
				body: route.request().url().includes('one') ? photo('ONE', 1600, 1000) : photo('TWO', 1600, 1000)
			});
		});

		await routeRyanairFlights(page.context(), [
			{
				dep: 'BCN',
				arr: 'VIE',
				depDate: '2027-03-08T08:00:00',
				arrDate: '2027-03-08T10:15:00',
				price: FIXTURE_PRICES.first,
				flightNumber: FIXTURE_FLIGHT_NUMBERS[2]
			},
			{
				dep: 'VIE',
				arr: 'TLL',
				depDate: '2027-03-10T11:00:00',
				arrDate: '2027-03-10T13:20:00',
				price: FIXTURE_PRICES.third,
				flightNumber: FIXTURE_FLIGHT_NUMBERS[4]
			}
		]);

		await page.context().route('https://basemaps.cartocdn.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
		);

		await page.setViewportSize({ width: 375, height: 780 });
		await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
		await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 20_000 });

		await openTheDetail(page);

		const media = page.locator('.bed-media').first();
		await expect(media).toBeVisible();
		await expect(media.locator('.bed-count')).toHaveText('1 / 2');

		await media.getByRole('button', { name: 'Next photo' }).click();
		await expect(media.locator('.bed-count')).toHaveText('2 / 2');
		await expect
			.poll(() => requested.length, { timeout: 10_000 })
			.toBe(2);
		expect(requested[1]).toContain('FIXTURE-two');

		// The strip really moved, which the counter alone cannot prove: a label that counts
		// while the pictures stay put is exactly how TripStrip shipped invisible. Polled
		// because the scroll is animated, and asserted on the offset between the second
		// slide and the frame rather than on either position alone.
		const frame = (await media.boundingBox())!;
		const secondSlide = media.locator('.bed-slide').nth(1);
		await expect
			.poll(async () => Math.abs((await secondSlide.boundingBox())!.x - frame.x), {
				timeout: 5_000
			})
			.toBeLessThan(2);

		// Back to the start, so the keyboard run below begins where a reader would.
		const prevArrow = media.getByRole('button', { name: 'Previous photo' });
		const nextArrow = media.getByRole('button', { name: 'Next photo' });
		await prevArrow.click();
		await expect(media.locator('.bed-count')).toHaveText('1 / 2');

		// Now the keyboard, which is the path the focus handling exists for. Paging to an
		// end disables the arrow that got you there, and a browser blurs a button the moment
		// it becomes disabled: without the handover, Enter on Next would leave a reader on
		// the last photograph with focus dumped back on the document body, the carousel
		// gone. Asserted in both directions, because both ends disable an arrow.
		await nextArrow.focus();
		// Asserted, not assumed. Without this checkpoint the Enter below can outrun the
		// focus call; the component then reads focus sitting on the document body and
		// correctly declines to move it, which looks exactly like the bug this section
		// exists to catch. A racing test that accuses the code is worse than no test.
		await expect(nextArrow).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(media.locator('.bed-count')).toHaveText('2 / 2');
		await expect(nextArrow).toBeDisabled();
		await expect(prevArrow).toBeFocused();

		await page.keyboard.press('ArrowLeft');
		await expect(media.locator('.bed-count')).toHaveText('1 / 2');
		await expect(prevArrow).toBeDisabled();
		await expect(nextArrow).toBeFocused();

		// And no trap. The arrows are ordinary buttons and nothing inside the strip is
		// focusable, so Tab leaves the carousel rather than cycling inside it.
		await page.keyboard.press('Tab');
		const trapped = await page.evaluate(() =>
			Boolean(document.activeElement?.closest('.bed-media'))
		);
		expect(trapped).toBe(false);
	});
});

/** The bed block lives inside the expanded result detail today. Issue #278 is moving where
 * that renders, and when it lands this is the one helper that needs rewriting rather than
 * both tests above. */
async function openTheDetail(page: import('@playwright/test').Page) {
	await expect(page.locator('.result-card').first()).toBeVisible();
	await page.getByRole('button', { name: 'Show details' }).first().click();
	await expect(page.locator('.stopover').first()).toBeVisible();
}
