import { test, expect } from './support/fixtures';
import type { Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, routeRyanairFlights } from './support/providers';
import { waitForSearchToSettle } from '../shared/search-wait';
import { pickStripSegment } from './support/results-ui';

/**
 * Issue #318: the seams between the six components rebuilt on 4 and 5 September, each with
 * the measurement that found it.
 *
 * Contrast is computed from what the browser actually painted rather than from the hex in
 * the stylesheet, because the question is what a reader sees: which token won, what surface
 * it landed on, and whether the pair clears WCAG 1.4.3. A test that read `app.css` would
 * pass the day somebody puts the right colour on the wrong element.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

/** WCAG 1.4.3 for text under 18.66px, which is every string measured here. */
const MINIMUM_CONTRAST = 4.5;

const SEARCH_URL = '/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL';

function flights() {
	return [
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
	];
}

/**
 * A provider answering with an error, so the strip has a plate in the `failed` state to
 * measure. Kiwi's public endpoint, because Ryanair is what builds the cards this page needs
 * and the two ground providers do not reach the strip as failures: a 503 from Transitous and
 * a 500 from OSRM both left every plate reading `answered` or `nothing-found`, which is
 * `providerAnswer`'s job and not this test's business.
 */
async function failOneProvider(page: Page) {
	await page.context().route('https://api.skypicker.com/**', (route) =>
		route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' })
	);
}

async function openResults(page: Page, { failing = false } = {}) {
	await mockAllKeylessProviders(page.context());
	await routeRyanairFlights(page.context(), flights());
	if (failing) await failOneProvider(page);
	await page.context().route('https://basemaps.cartocdn.com/**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
	);
	await page.goto(SEARCH_URL);
	await waitForSearchToSettle(page, { timeout: 20_000 });
	await expect(page.locator('.result-card').first()).toBeVisible();
}

/**
 * The painted colour of an element against the first painted background behind it, and the
 * ratio between them. Walking up for the background is what makes this measure the real
 * pair: the arrow's own box is transparent, and the surface it reads against is the card
 * header two elements up.
 */
async function contrastOf(page: Page, selector: string) {
	return page.locator(selector).first().evaluate((element) => {
		const channel = (value: number) => {
			const c = value / 255;
			return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
		};
		const luminance = (color: string) => {
			const [r, g, b] = color.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number);
			return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
		};
		let background = 'rgb(255, 255, 255)';
		for (let at: Element | null = element; at; at = at.parentElement) {
			const painted = getComputedStyle(at).backgroundColor;
			if (painted && !/rgba\(0, 0, 0, 0\)|transparent/.test(painted)) {
				background = painted;
				break;
			}
		}
		const foreground = getComputedStyle(element).color;
		const [a, b] = [luminance(foreground), luminance(background)].sort((x, y) => y - x);
		return {
			foreground,
			background,
			ratio: Number((((a + 0.05) / (b + 0.05))).toFixed(2))
		};
	});
}

test.describe('contrast, on what the browser painted', () => {
	test.use({ viewport: { width: 375, height: 812 } });

	for (const scheme of ['dark', 'light'] as const) {
		test(`the card header's route arrow reads on its band in ${scheme}`, async ({ page }) => {
			// Measured 3.58:1 in dark mode before this: the band is the one warm surface on a
			// navy page and the arrow was still using the page's neutral muted token.
			await page.emulateMedia({ colorScheme: scheme });
			await openResults(page);

			const arrow = await contrastOf(page, '.card-header .route-arrow');
			expect(
				arrow.ratio,
				`${arrow.foreground} on ${arrow.background}`
			).toBeGreaterThanOrEqual(MINIMUM_CONTRAST);
		});
	}

	for (const answer of ['answered', 'failed'] as const) {
		test(`the "${answer}" provider plate reads on its inset in light mode`, async ({ page }) => {
			// Both measured 4.33:1 at 12px, which is a miss by a hair and still a miss.
			await page.emulateMedia({ colorScheme: 'light' });
			await openResults(page, { failing: answer === 'failed' });

			const flap = await contrastOf(page, `.provider-plate[data-answer="${answer}"] .plate-flap`);
			expect(flap.ratio, `${flap.foreground} on ${flap.background}`).toBeGreaterThanOrEqual(
				MINIMUM_CONTRAST
			);
		});
	}
});

test.describe('what a screen reader is told', () => {
	test.use({ viewport: { width: 375, height: 812 } });

	test('the trip strip says it is a composite, since arrow keys are how you cross it', async ({
		page
	}) => {
		await openResults(page);

		const track = page.locator('.trip-strip-track').first();
		// The roving tabindex was already correct: one stop in the tab order, arrows for the
		// rest. What was missing was anything telling the reader that.
		await expect(track).toHaveAttribute('role', 'toolbar');
		await expect(track).toHaveAttribute('aria-label', /arrow keys/i);
		const stops = await track.locator('[tabindex]').evaluateAll((items) =>
			items.map((item) => item.getAttribute('tabindex'))
		);
		expect(stops.filter((value) => value === '0')).toHaveLength(1);
		expect(stops.filter((value) => value === '-1').length).toBeGreaterThan(0);
	});

	test('the timeline control has no space in front of its comma', async ({ page }) => {
		await openResults(page);

		// "8h 22m in Napoli , show the full timeline", from the indentation between two
		// elements being a text node.
		const name = await page
			.locator('.trip-strip-caption-mid')
			.first()
			.evaluate((element) => element.textContent!.replace(/\s+/g, ' ').trim());
		expect(name).not.toContain(' ,');
		expect(name).toMatch(/, (show|hide) the full timeline$/);
	});
});

test.describe('the customise sheet on a phone', () => {
	test.use({ viewport: { width: 375, height: 812 } });

	test('announces itself, keeps its scrolling, and hands focus over', async ({ page }) => {
		await openResults(page);
		await pickStripSegment(page, 'stopover');

		const sheet = page.locator('.customise-sheet');
		await expect(sheet).toBeVisible();
		// Non-modal on purpose: it names itself without trapping anybody, which is why there
		// is no `aria-modal` here to assert.
		await expect(sheet).toHaveAttribute('role', 'dialog');
		await expect(sheet).toHaveAttribute('aria-label', /customise/i);
		await expect(sheet).not.toHaveAttribute('aria-modal', 'true');

		// Scrolling to the bottom of the sheet used to chain into scrolling the page behind
		// it, taking away the card the sheet is about.
		expect(
			await sheet.evaluate((element) => getComputedStyle(element).overscrollBehavior)
		).toContain('contain');

		// Focus inside it, so something is announced. Before, it stayed on the button outside.
		expect(
			await page.evaluate(() => {
				const sheetEl = document.querySelector('.customise-sheet');
				return Boolean(sheetEl && sheetEl.contains(document.activeElement));
			})
		).toBe(true);
	});

	test('the panel dismisses under one word, not two', async ({ page }) => {
		// "Clear" on a desktop and "Close" on a phone, same slot, same colour, same 44px, both
		// calling the same function. One action, one word, and the word is not "Clear":
		// nothing the traveller chose is discarded.
		await openResults(page);
		await pickStripSegment(page, 'stopover');

		await expect(page.locator('.customise-sheet .customise-close')).toHaveText('Done');
		await page.locator('.customise-sheet .customise-close').click();
		await expect(page.locator('.customise-sheet')).toHaveCount(0);
	});
});

test.describe('the customise rail on a desktop', () => {
	test.use({ viewport: { width: 1280, height: 900 } });

	test('uses the same word as the phone for the same action', async ({ page }) => {
		await openResults(page);
		await pickStripSegment(page, 'stopover');

		await expect(page.locator('.results-customise .customise-close')).toHaveText('Done');
	});
});
