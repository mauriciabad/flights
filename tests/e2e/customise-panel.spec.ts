import { test, expect } from './support/fixtures';
import type { Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, routeRyanairFlights } from './support/providers';
import { customiser, openTimeline, pickStripSegment, pickTimelineSegment } from './support/results-ui';

/**
 * Issue #278: the card stopped being a thing you open, and the controls moved beside it.
 *
 * Everything here is either geometric or about the one selection three surfaces share.
 * That split is on purpose. `45151ce` is the reminder: five e2e tests covered the trip
 * strip and all five passed while its segments rendered at 0px, because they asserted that
 * a panel opened, that the keyboard reached every cell and that the words were right, and
 * every one of those is true of elements that have collapsed to nothing. So the checks
 * that matter most below measure boxes.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

async function openResults(page: Page) {
	await mockAllKeylessProviders(page.context());
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
			dep: 'BCN',
			arr: 'VIE',
			depDate: '2027-03-09T16:30:00',
			arrDate: '2027-03-09T18:45:00',
			price: FIXTURE_PRICES.second,
			flightNumber: FIXTURE_FLIGHT_NUMBERS[3]
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
	await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
	await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 20_000 });
	const card = page.locator('.result-card').first();
	await expect(card).toBeVisible();
	return card;
}

test.describe('the customise rail on a wide screen', () => {
	test.use({ viewport: { width: 1280, height: 900 } });

	test('the card is no longer a thing you open', async ({ page }) => {
		await openResults(page);
		await expect(page.getByRole('button', { name: 'Show details' })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Hide details' })).toHaveCount(0);
	});

	test('the rail is a real third column beside the answers, not an overlay on them', async ({
		page
	}) => {
		const card = await openResults(page);
		const rail = page.getByRole('complementary', { name: 'Customise the selected trip' });

		const railBox = (await rail.boundingBox())!;
		const cardBox = (await card.boundingBox())!;

		expect(railBox.width, 'the rail collapsed to nothing').toBeGreaterThan(200);
		expect(
			cardBox.x + cardBox.width,
			'the rail is sitting on top of the results rather than beside them'
		).toBeLessThanOrEqual(railBox.x);
	});

	test('filling the rail does not make the card taller, which is the whole point', async ({
		page
	}) => {
		const card = await openResults(page);
		const before = (await card.boundingBox())!.height;

		// The stopover panel is the fattest of them: the nights ladder plus a stay list.
		await pickStripSegment(page, 'stopover');
		await expect(customiser(page)).toHaveAttribute('data-segment', 'free-time');

		const after = (await card.boundingBox())!.height;
		expect(after, `the card grew from ${before}px to ${after}px when a picker opened`).toBe(before);
	});

	test('the strip, the timeline and the rail agree on one selection', async ({ page }) => {
		const card = await openResults(page);
		await openTimeline(page);

		// Picked on the strip, and the timeline row says so.
		await pickStripSegment(page, 'flight');
		await expect(customiser(page)).toHaveAttribute('data-segment', 'outbound-flight');
		await expect(
			card.locator('.itinerary-timeline [data-segment="outbound-flight"]')
		).toHaveAttribute('aria-current', 'true');

		// Picked on the timeline, and the strip's own cell says so.
		await pickTimelineSegment(page, 'connection-waiting');
		await expect(customiser(page)).toHaveAttribute('data-segment', 'connection-waiting');
		await expect(card.locator('.trip-strip-hit-wait').nth(1)).toHaveAttribute('aria-pressed', 'true');
		await expect(card.locator('.trip-strip-hit-flight').first()).toHaveAttribute(
			'aria-pressed',
			'false'
		);
	});

	test('picking the same segment twice clears it, which is how the rail is emptied', async ({
		page
	}) => {
		await openResults(page);
		await pickStripSegment(page, 'flight');
		await expect(customiser(page)).toHaveAttribute('data-segment', 'outbound-flight');

		await pickStripSegment(page, 'flight');
		await expect(customiser(page)).toHaveAttribute('data-segment', '');
	});

	test('arrowing along the strip previews without moving the rail', async ({ page }) => {
		const card = await openResults(page);
		await pickStripSegment(page, 'flight');
		await expect(customiser(page)).toHaveAttribute('data-segment', 'outbound-flight');

		// W3C's APG: selection following focus is "devastating" when showing a panel is not
		// instant, and this panel mounts a stay list or a radiogroup. So the arrow keys walk
		// the strip and the rail holds still until Enter or Space.
		await card.locator('.trip-strip-hit').first().focus();
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ArrowRight');
		await expect(customiser(page)).toHaveAttribute('data-segment', 'outbound-flight');

		await page.keyboard.press('Enter');
		await expect(customiser(page)).not.toHaveAttribute('data-segment', 'outbound-flight');
	});

	test('the keyboard is handed the panel, and handed back the segment', async ({ page }) => {
		const card = await openResults(page);
		const hits = card.locator('.trip-strip-hit');

		await hits.first().focus();
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('Enter');

		// Without this the traveller would have to tab past every remaining card, the
		// provider strip and the widen panel to reach the control they just asked for: the
		// rail is the last thing in the layout.
		const rail = page.getByRole('complementary', { name: 'Customise the selected trip' });
		await expect(rail).toBeFocused();

		// And back again, rather than to the top of the document.
		await page.keyboard.press('Escape');
		await expect(hits.nth(1)).toBeFocused();
	});

	test('a waiting time edited in the rail changes the totals in the timeline', async ({ page }) => {
		const card = await openResults(page);
		await openTimeline(page);
		const nights = card.locator('.itinerary-timeline-totals .metric', { hasText: 'Nights' });
		await expect(nights).toContainText('1');

		await pickStripSegment(page, 'wait', 1);
		await expect(customiser(page)).toHaveAttribute('data-segment', 'connection-waiting');

		// The one control the timeline and the rail now share. 1530 minutes at the connection
		// eats the night off the far end of the stopover, which is issue #250's own repro
		// driven from the other surface.
		const input = customiser(page).locator('.waiting-stepper-input');
		await input.fill('1530');
		await input.dispatchEvent('input');

		await expect(nights).toContainText('0');
	});
});

test.describe('the customise sheet on a phone', () => {
	test.use({ viewport: { width: 375, height: 812 } });

	test('there is no rail, because there is no room for one', async ({ page }) => {
		await openResults(page);
		await expect(page.getByRole('complementary', { name: 'Customise the selected trip' })).toHaveCount(
			0
		);
	});

	test('the sheet leaves most of the screen to the card it is about', async ({ page }) => {
		await openResults(page);
		await pickStripSegment(page, 'stopover');

		const sheet = page.locator('.customise-sheet');
		await expect(sheet).toBeVisible();
		const box = (await sheet.boundingBox())!;
		// NN/g's caution about bottom sheets is that they obscure relevant background
		// content, and here the background content is the price these controls change.
		expect(box.height, `the sheet took ${Math.round(box.height)}px of an 812px screen`).toBeLessThanOrEqual(
			812 * 0.55
		);
		expect(Math.round(box.y + box.height)).toBe(812);
	});

	test('the card stays the same height when the sheet opens', async ({ page }) => {
		const card = await openResults(page);
		const before = (await card.boundingBox())!.height;
		await pickStripSegment(page, 'stopover');
		await expect(page.locator('.customise-sheet')).toBeVisible();
		expect((await card.boundingBox())!.height).toBe(before);
	});
});
