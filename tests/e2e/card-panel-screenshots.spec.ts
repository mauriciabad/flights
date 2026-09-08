import { expect, test } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, mockHostelworld, routeRyanairFlights } from './support/providers';
import { openTimeline, pickTimelineSegment } from './support/results-ui';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * How `docs/screenshots/435-*.png` and `439-*.png` were made, kept so the next person can
 * remake them rather than guess at the setup. Modelled on `picked-bed-screenshots.spec.ts`,
 * which is where this pattern comes from.
 *
 * Not a test, and it asserts almost nothing worth gating on. It is skipped unless
 * `SHOT_LABEL` is set, so `pnpm test:e2e` never rewrites checked-in images as a side effect
 * of running the suite:
 *
 *     SHOT_LABEL=after pnpm test:e2e card-panel-screenshots
 *
 * The `MEASURED` line each run prints reads the real laid-out boxes rather than estimating
 * them, which is where the figures in the PR come from.
 *
 * Four states, because they are the four the change has to be right in at once: a card with
 * a bed and a card without one, each at a phone width where the panel wraps under the
 * receipt and at a desktop width where it sits beside it.
 */

const LABEL = process.env.SHOT_LABEL;

test.skip(!LABEL, 'Screenshot capture. Set SHOT_LABEL to run it.');

/** A picture with enough in it to tell a cropped carousel from an empty frame, and marked so
 * an escaped fixture reads as one (AGENTS.md, "Mocks belong to a test and to nothing else"). */
function photo(label: string): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a4d5e"/><stop offset="1" stop-color="#1b2b3a"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><rect x="120" y="560" width="520" height="380" fill="#3b6b7d"/><rect x="700" y="420" width="700" height="520" fill="#31596b"/><circle cx="1280" cy="220" r="90" fill="#e9c46a"/><text x="80" y="140" font-size="72" fill="#e9c46a" font-family="monospace">FIXTURE ${label}</text></svg>`;
}

const FLIGHTS = [
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
];

/** `bed: false` answers Hostelworld with an empty city, which is the card that must render
 * no property panel at all rather than a frame saying a picture is missing. */
async function search(page: Parameters<typeof waitForSearchToSettle>[0], bed: boolean) {
	await mockAllKeylessProviders(page.context());
	if (bed) {
		await mockHostelworld(
			page.context(),
			'hostelworld/continents-vienna.json',
			'hostelworld/properties-vienna-photos.json'
		);
		await page.context().route('https://photos.fixture.invalid/**', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'image/svg+xml',
				body: photo(route.request().url().includes('one') ? 'ONE' : 'TWO')
			})
		);
	}
	// No basemap route here. `fixtures.ts` answers `basemaps.cartocdn.com` for every test with
	// the shared style, and issue #433 is thirty-six private copies of an empty one that drew
	// nothing while every assertion about the picture passed.
	await routeRyanairFlights(page.context(), FLIGHTS);
	await page.goto(
		`/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL&fromLoc=${encodeURIComponent('FIXTURE start point@41.3851,2.1734')}`
	);
	await waitForSearchToSettle(page, { timeout: 20_000 });
}

for (const bed of [true, false]) {
	for (const width of [375, 1440]) {
		test(`shot ${LABEL ?? '(set SHOT_LABEL)'} card ${bed ? 'with' : 'without'} a bed ${width}`, async ({
			page
		}) => {
			await page.setViewportSize({ width, height: 1000 });
			await search(page, bed);

			const card = page.locator('.result-card').first();
			await expect(card).toBeVisible();
			await card.scrollIntoViewIfNeeded();
			// The photographs arrive over the network and the row's height follows them, so
			// this waits for the picture rather than for a number of seconds.
			if (bed) await expect(card.locator('.card-stay .photo-slide img').first()).toBeVisible();
			await page.waitForTimeout(500);
			await card.screenshot({
				path: `docs/screenshots/435-card-${bed ? 'bed' : 'nobed'}-${LABEL}-${width}.png`
			});

			const measured = await card.evaluate((element) => {
				const box = (selector: string) => {
					const node = element.querySelector(selector) as HTMLElement | null;
					if (!node) return null;
					const rect = node.getBoundingClientRect();
					return { width: Math.round(rect.width), height: Math.round(rect.height) };
				};
				return {
					card: Math.round(element.getBoundingClientRect().height),
					row: box('.card-getting-there'),
					receipt: box('.price-line'),
					stay: box('.card-stay'),
					photo: box('.card-stay .photo-carousel'),
					overflows: element.scrollWidth > element.clientWidth + 1
				};
			});
			console.log(
				`MEASURED ${LABEL} card-${bed ? 'bed' : 'nobed'}-${width} ${JSON.stringify(measured)}`
			);
			expect(measured.overflows, 'the card must not scroll sideways').toBe(false);
		});
	}
}

for (const segment of ['transfer-to-hotel', 'free-time'] as const) {
	test(`shot ${LABEL ?? '(set SHOT_LABEL)'} inspector on ${segment}`, async ({ page }) => {
		// 1280 rather than 1440: the inspector is 20rem between 64rem and 90rem and 24rem
		// above it, and 20rem is the width everything in it has to read at.
		await page.setViewportSize({ width: 1280, height: 1000 });
		await search(page, true);

		await openTimeline(page);
		await pickTimelineSegment(page, segment);

		const panel = page.getByTestId('segment-customiser');
		await expect(panel).toHaveAttribute('data-segment', segment);
		// Back to how a traveller first meets the panel. `openTimeline` had to unfold the trip
		// to reach the row, and what the picture is for is the default: the controls for the
		// step that was tapped, with the whole trip one press above them.
		if ((await page.locator('.customiser-trip[open]').count()) > 0) {
			await page.locator('.customiser-trip-summary').click();
		}
		// The leg's basemap is a capture that arrives after the panel does, and a shot taken
		// before it lands photographs the coast drawing the preview falls back to. The 1500ms
		// is the disclosure animation, which has no event of its own.
		const preview = panel.locator('img.inert-map-picture');
		if ((await panel.locator('.ground-leg').count()) > 0) {
			await expect(preview.first()).toBeVisible({ timeout: 30_000 });
		}
		await page.waitForTimeout(1500);
		// The viewport, not the panel's own element. The rail scrolls inside itself, so an
		// element capture is one long strip with the scrolled-away part blank, and what #439
		// is about is the panel beside the list rather than the panel alone.
		await page.screenshot({ path: `docs/screenshots/439-inspector-${segment}-${LABEL}.png` });

		const measured = await panel.evaluate((element) => {
			const height = (selector: string) => {
				const node = element.querySelector(selector) as HTMLElement | null;
				return node ? Math.round(node.getBoundingClientRect().height) : null;
			};
			return {
				panel: Math.round(element.getBoundingClientRect().width),
				legs: element.querySelectorAll('.ground-legs-item').length,
				timelineRows: element.querySelectorAll('.tl-row').length,
				timeline: height('.customiser-trip'),
				stopover: height('.stopover'),
				ladder: height('.staying-longer'),
				stays: height('.stay-alternatives'),
				overflows: element.scrollWidth > element.clientWidth + 1
			};
		});
		console.log(`MEASURED ${LABEL} inspector-${segment} ${JSON.stringify(measured)}`);
		expect(measured.overflows, 'the inspector must not scroll sideways at 20rem').toBe(false);
	});
}
