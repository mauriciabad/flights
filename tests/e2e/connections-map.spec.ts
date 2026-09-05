import { test, expect, type Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { AIRLINE_LOGO_BASE_URL, mockAllKeylessProviders, routeRyanairFlights } from './support/providers';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * Issue #324: the map of every connection between two airports.
 *
 * Two properties are under test and only one of them is about words.
 *
 * The first is the WebGL ceiling issue #280 bought with `tools/probe-map-cost.mjs`: the
 * results page holds no live context however many cards it draws, this dialog holds exactly
 * one, and closing it takes that one away, ten times in a row. A leak there breaks nothing
 * visible until a traveller's seventeenth dialog, which is exactly the kind of defect nobody
 * traces back.
 *
 * The second is the keyboard. A map whose only affordance is hover has no keyboard story at
 * all, and the sidebar is what makes one possible, so "you can reach the points, move
 * between them, pin one and read the answer without touching a pointer" is asserted rather
 * than assumed. Issue #283 lost a keyboard reader entirely while every spec passed.
 *
 * Fare values come from `support/fixture-markers.ts` for the reason that file explains.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

/**
 * Two stopovers out of Barcelona, and only one of them works.
 *
 * Vienna pairs: the outbound lands at 10:15 and the onward leaves two days later. Budapest
 * deliberately does not. A flight reaches it and nothing leaves it for Tallinn, which is
 * the `no-onward-flight` refusal rather than the `no-outbound-flight` one, and separating
 * those two is most of why this screen exists: a city with no pairing never becomes a
 * result card, so the map is the only place in the app it can appear at all.
 *
 * It was Milan until issue #340, and the swap is bookkeeping rather than a change of
 * subject. Ranking a stopover on how evenly it splits the journey drops Milan out of
 * Barcelona to Tallinn's candidates altogether — Milan is southeast and Tallinn is
 * northeast, so it is a corner cut off the journey rather than a halfway point — and this
 * test needs a city the search still proposes. Budapest is the second the panel lists.
 * Measured rather than picked: with Milan gone the panel reads Vienna, Budapest, Berlin,
 * Charleroi, Kraków, Stansted, and the five after Vienna all say "No trip".
 */
const BCN_VIE_TLL = [
	{
		dep: 'BCN',
		arr: 'VIE',
		depDate: '2027-03-08T08:00:00',
		arrDate: '2027-03-08T10:15:00',
		price: FIXTURE_PRICES.first,
		flightNumber: FIXTURE_FLIGHT_NUMBERS[7]
	},
	{
		dep: 'VIE',
		arr: 'TLL',
		depDate: '2027-03-10T11:00:00',
		arrDate: '2027-03-10T13:20:00',
		price: FIXTURE_PRICES.third,
		flightNumber: FIXTURE_FLIGHT_NUMBERS[8]
	},
	{
		dep: 'BCN',
		arr: 'BUD',
		depDate: '2027-03-08T09:00:00',
		arrDate: '2027-03-08T10:40:00',
		price: FIXTURE_PRICES.second,
		flightNumber: FIXTURE_FLIGHT_NUMBERS[9]
	}
];

async function search(page: Page): Promise<void> {
	await mockAllKeylessProviders(page.context());
	await routeRyanairFlights(page.context(), BCN_VIE_TLL);
	await page.context().route('https://basemaps.cartocdn.com/**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
	);

	const params = new URLSearchParams({
		dep: '2027-03-08',
		arr: '2027-03-27',
		from: 'BCN',
		to: 'TLL'
	});
	await page.goto(`/results/?${params}`);
	await waitForSearchToSettle(page, { timeout: 20_000 });
}

/** Every request that left the browser for somebody else: not the test server's own bundle,
 * and not the basemap style, which is CARTO's keyless one. */
function isProviderCall(url: string, origin: string): boolean {
	return !url.startsWith('data:') && !url.startsWith(origin) && !url.includes('basemaps.cartocdn.com');
}

/**
 * Blocks until the page has made no provider request for `quietMs`.
 *
 * The 65 requests this was written against were the search's own, not a refresh's. Issue
 * #337 measured where they came from: `expect(getByText('still searching')).toHaveCount(0)`
 * returned about 30ms after `goto`, because the text is absent on a page that has not
 * started searching as much as on one that has finished, so the six seconds counted from
 * there were the six seconds the search was running in. Waiting for `data-search-phase` to
 * reach `settled` instead, ten runs on this suite's fixture saw zero provider requests in
 * the six seconds that followed.
 *
 * So `search()` above no longer returns early and this is no longer load-bearing. It is
 * kept because a request count is the one assertion worth a second belt, and because a
 * background refresh (#293) genuinely can fire behind a settled page when the cache has
 * something past its TTL — which nothing in this spec sets up, but a later one might.
 */
async function waitUntilQuiet(page: Page, origin: string, quietMs = 1500, maxMs = 30_000): Promise<void> {
	let lastCall = Date.now();
	const bump = (request: { url(): string }) => {
		if (isProviderCall(request.url(), origin)) lastCall = Date.now();
	};
	page.on('request', bump);
	const deadline = Date.now() + maxMs;
	while (Date.now() < deadline && Date.now() - lastCall < quietMs) {
		await page.waitForTimeout(100);
	}
	page.off('request', bump);
}

async function openMap(page: Page) {
	const trigger = page.locator('.connections-map-link');
	await expect(trigger).toBeEnabled();
	await trigger.click();
	await expect(page.locator('dialog.connections-dialog')).toBeVisible();
	return trigger;
}

test.describe('the connections map (issue #324)', () => {
	test('the results page holds no WebGL context until the dialog is opened', async ({ page }) => {
		await search(page);

		await expect(page.locator('.result-card').first()).toBeVisible();
		// Counted rather than assumed: a zero assertion passes for the wrong reason on a page
		// that happens to be drawing nothing at all.
		expect(await page.locator('.route-preview').count()).toBeGreaterThan(0);
		await expect(page.locator('canvas.maplibregl-canvas')).toHaveCount(0);
	});

	test('opening the map makes exactly one, and closing it takes that one away', async ({ page }) => {
		await search(page);
		const trigger = await openMap(page);
		const dialog = page.locator('dialog.connections-dialog');

		await expect(page.locator('canvas.maplibregl-canvas')).toHaveCount(1);

		// Near-fullscreen: a fixed margin and nothing more. `MapDialog` owns that shape for
		// all three dialogs now, so a regression here is a regression in every one of them.
		const dialogBox = (await dialog.boundingBox())!;
		const viewport = page.viewportSize()!;
		expect(dialogBox.width).toBeGreaterThan(viewport.width * 0.8);
		expect(dialogBox.width).toBeLessThan(viewport.width);

		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		await expect(page.locator('canvas.maplibregl-canvas')).toHaveCount(0);
		await expect(trigger).toBeFocused();
	});

	test('ten opens and closes leave no map behind', async ({ page }) => {
		await search(page);
		const trigger = page.locator('.connections-map-link');
		const dialog = page.locator('dialog.connections-dialog');
		const canvases = page.locator('canvas.maplibregl-canvas');

		// One round proves teardown runs. Ten prove it runs every time, which is the shape
		// this defect would have: nothing visibly wrong until the seventeenth context.
		for (let round = 0; round < 10; round++) {
			await trigger.click();
			await expect(dialog).toBeVisible();
			await expect(canvases).toHaveCount(1);
			await page.keyboard.press('Escape');
			await expect(dialog).toHaveCount(0);
			await expect(canvases).toHaveCount(0);
		}
	});

	test('the baseline is drawn and named as a line nobody flies', async ({ page }) => {
		await search(page);
		await openMap(page);

		// The sentence is what stops the dashed arc reading as a route the traveller could
		// take. `FlightDetour` carries the same caption on the card for the same reason.
		await expect(page.locator('.connections-map-legend')).toContainText('Nobody flies it');
	});

	test('a connection with no pairing says which rule refused it', async ({ page }) => {
		await search(page);
		await openMap(page);

		const dialog = page.locator('dialog.connections-dialog');
		// Budapest is reachable and goes nowhere onward, so it never becomes a card. The list
		// is the only place in the app it can appear at all.
		const budapest = dialog.locator('.panel-row').filter({ hasText: 'BUD' });
		await expect(budapest).toHaveCount(1);
		await expect(budapest).toContainText('No trip');

		await budapest.click();
		// Why, not only that. "Nothing flies onward" and "the gap is too short" are different
		// answers and only one of them is worth changing a date over.
		await expect(dialog.locator('.panel-block-headline')).toContainText('Nothing flies onward');
	});

	test('a priced connection shows its price, both flights and the layover rule', async ({ page }) => {
		await search(page);
		await openMap(page);

		const dialog = page.locator('dialog.connections-dialog');
		await dialog.locator('.panel-row').filter({ hasText: 'VIE' }).click();

		// A formatted total, not an empty element with a currency symbol in it.
		await expect(dialog.locator('.panel-price')).toHaveText(/\d/);
		// Both legs, each with its own flight number and its own clock, in the local time of
		// the airport the reading happens at.
		await expect(dialog.locator('.panel-leg')).toHaveCount(2);
		await expect(dialog.locator('.panel-leg-route').first()).toContainText('BCN');
		await expect(dialog.locator('.panel-leg-route').last()).toContainText('TLL');
		await expect(dialog.locator('.panel-legs')).toContainText(FIXTURE_FLIGHT_NUMBERS[7]);
		await expect(dialog.locator('.panel-legs')).toContainText(FIXTURE_FLIGHT_NUMBERS[8]);
		// The minimum is the traveller's own number and the reason a refusal above is a
		// refusal, so it is printed rather than left implied.
		await expect(dialog.locator('.panel-detail')).toContainText('minimum layover');
	});

	test('the whole map is reachable, pinnable and readable with the keyboard alone', async ({ page }) => {
		await search(page);
		await openMap(page);

		const dialog = page.locator('dialog.connections-dialog');
		const rows = dialog.locator('.panel-row');
		const rowCount = await rows.count();
		expect(rowCount).toBeGreaterThan(1);

		// Tab from the close button into the panel. Chromium adds a stop for the detail block
		// when its content overflows, because a scrollable region with no focusable children
		// has to be reachable to be scrollable, and that stop is correct rather than a
		// defect. So this walks the path instead of counting presses: what matters is that
		// the FIRST stopover row is reached in a step or two, not which of them it is.
		await dialog.locator('.map-dialog-close').focus();
		for (let press = 0; press < 3; press += 1) {
			await page.keyboard.press('Tab');
			if (await rows.first().evaluate((element) => element === document.activeElement)) break;
		}
		await expect(rows.first()).toBeFocused();

		// Focusing previews, exactly as hovering a map point does. Without this the panel
		// would only ever answer a pointer.
		await expect(dialog.locator('.panel-name')).toBeVisible();

		await page.keyboard.press('Tab');
		await expect(rows.nth(1)).toBeFocused();

		// Enter pins, and the pin survives focus moving elsewhere. That is the whole reason
		// preview and pin are two things.
		await page.keyboard.press('Enter');
		await expect(rows.nth(1)).toHaveAttribute('aria-pressed', 'true');
		await expect(rows.nth(1)).toBeFocused();

		await dialog.locator('.map-dialog-close').focus();
		await expect(rows.nth(1)).toHaveAttribute('aria-pressed', 'true');
		await expect(dialog.locator('.panel-name')).toBeVisible();

		// And out. Focus goes back to what opened the dialog, not to the document body.
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		await expect(page.locator('.connections-map-link')).toBeFocused();
	});

	test('the map points are buttons with names, not bare dots', async ({ page }) => {
		await search(page);
		await openMap(page);

		const points = page.locator('.connection-point');
		await expect(points.first()).toBeVisible();
		// A screen reader has to hear which city a dot is, and the state it is in, since
		// colour is never the only channel this app uses.
		const names = await points.evaluateAll((elements) =>
			elements.map((element) => element.getAttribute('aria-label') ?? '')
		);
		expect(names.length).toBeGreaterThan(1);
		expect(names.every((name) => name.length > 0)).toBe(true);
		expect(names.some((name) => name.includes('Vienna'))).toBe(true);
	});

	test('drawing the map spends no provider request, for any connection on it', async ({ page }) => {
		await search(page);
		const origin = new URL(page.url()).origin;

		// The dialog's cost is measured against a QUIET page, which the settled search
		// already gives it. See `waitUntilQuiet` for why this is now a belt rather than the
		// thing holding the assertion up.
		await waitUntilQuiet(page, origin);

		const requests: string[] = [];
		page.on('request', (request) => requests.push(request.url()));

		await openMap(page);

		// Every connection, not just the first. The calendars load lazily per connection, so
		// a fetch hiding in that path would only appear for a city nobody had opened, which
		// is exactly the case a one-row test would miss. Hovering is what previews a row, so
		// this is the sweep the owner asked for, done to all of them.
		for (const row of await page.locator('dialog.connections-dialog .panel-row').all()) {
			await row.hover();
			await expect(page.locator('dialog.connections-dialog .panel-name')).toBeVisible();
		}
		await page.locator('dialog.connections-dialog .panel-row').first().click();
		await expect(page.locator('dialog.connections-dialog .panel-price, dialog.connections-dialog .panel-block-headline').first()).toBeVisible();
		// The calendar reads are async, so give them room to have happened before concluding
		// they made no request.
		await page.waitForTimeout(2000);

		const providerCalls = requests.filter((url) => isProviderCall(url, origin));

		// The constraint, stated as itself: this screen fetches no travel data. Not a fare,
		// not a bed, not a route, from any provider, metered or free.
		//
		// `collectLegFares` is documented "Zero requests, always", and both of its sources,
		// `readLedgerMonths` and `readCachedRyanairMonthGrid`, return empty on a miss rather
		// than filling it. A calendar that fetched instead would cost two requests per
		// stopover per month every time this dialog opened, which is the fan-out issue #324
		// forbids outright and the reason this assertion exists.
		const dataCalls = providerCalls.filter((url) => !url.startsWith(AIRLINE_LOGO_BASE_URL));
		expect(dataCalls, `this screen fetched travel data: ${dataCalls.join(', ')}`).toEqual([]);

		// Airline logos are the ONE thing it does fetch, and they are named here rather than
		// filtered out quietly. `data/airline-logos.ts` records the measurement behind that
		// host: keyless, no cookie set, response depends on the URL alone, and the URL
		// carries a public IATA code already printed as text on the same row. It is a
		// picture, not a provider call, and every result card already loads the same ones.
		// If that ever stops being true this list is where it shows.
		const unexpectedHosts = [...new Set(providerCalls.map((url) => new URL(url).origin))].filter(
			(host) => !AIRLINE_LOGO_BASE_URL.startsWith(host)
		);
		expect(unexpectedHosts, `unexpected hosts: ${unexpectedHosts.join(', ')}`).toEqual([]);
	});
});
