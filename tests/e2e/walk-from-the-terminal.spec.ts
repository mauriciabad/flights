import { test, expect } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import {
	mockAllKeylessProviders,
	mockHostelworld,
	OSRM_BASE_URL,
	routeRyanairFlights
} from './support/providers';
import { customiser, openTimeline } from './support/results-ui';
import { waitForSearchToSettle } from '../shared/search-wait';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Issue #341, in a real browser against a real build.
 *
 * The owner asked for a walk to a hotel he had measured at "arround 30 mins" and got a
 * two-bus journey with a change and no walking row at all. The cause was not the
 * 45-minute plausibility cap, which is untouched by this fix. It was that every ground
 * transfer began at `Airport.coordinates` — the runway reference point — so at Gatwick
 * OSRM was asked to walk from a spot on the far side of the airfield and answered 1h 13m
 * for a walk that is 32m from the North Terminal.
 *
 * This spec asserts the coordinate, not the duration, because the duration is only ever a
 * consequence. The OSRM mock below reads the origin out of the request URL and answers a
 * plausible walk ONLY when asked from Vienna's terminal, and an implausible one from
 * anywhere else. So the walking row can appear for exactly one reason: the app asked from
 * the right place. Fixing the cap instead would leave this red.
 */

/** Read off the generated table rather than copied, so this spec measures what the app
 * actually ships. `readFileSync` and not an `import`, because Playwright's runner needs an
 * import attribute for JSON and `tests/e2e/support/providers.ts` already reads its fixtures
 * this way. */
const terminals = JSON.parse(
	readFileSync(
		fileURLToPath(new URL('../../src/lib/data/airport-terminals.generated.json', import.meta.url)),
		'utf-8'
	)
) as Record<string, [number, number]>;

const VIE_TERMINAL = terminals.VIE;

/** VIE's published point, from `airports.generated.json`. 875 m from the terminal above,
 * which is the whole distance this spec is about. */
const VIE_PUBLISHED: [number, number] = [48.110298, 16.5697];

/** Comfortably inside `MAX_PLAUSIBLE_WALK_MINUTES`, and the walk the traveller must be
 * offered. */
const PLAUSIBLE_WALK_MINUTES = 31;
/** Over the cap, so `isPlausibleTransfer` throws it away and no walking row survives —
 * which is what the app did for every walk before this fix. */
const IMPLAUSIBLE_WALK_MINUTES = 73;

function osrmWalk(minutes: number) {
	return JSON.stringify({
		code: 'Ok',
		waypoints: [
			{ hint: 'FIXTURE-origin', distance: 4.2, name: '', location: [16.5697, 48.1103] },
			{ hint: 'FIXTURE-destination', distance: 8.1, name: '', location: [16.3738, 48.2082] }
		],
		routes: [
			{
				geometry: '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
				legs: [{ steps: [], summary: '', weight: 1, duration: minutes * 60, distance: minutes * 75 }],
				weight_name: 'routability',
				weight: 1,
				duration: minutes * 60,
				distance: minutes * 75
			}
		]
	});
}

/** Metres between two points, near enough at these distances. Only has to tell a terminal
 * from a runway point 875 m away. */
function metresApart(a: [number, number], b: [number, number]): number {
	const latMetres = (a[0] - b[0]) * 111_320;
	const lonMetres = (a[1] - b[1]) * 111_320 * Math.cos((a[0] * Math.PI) / 180);
	return Math.hypot(latMetres, lonMetres);
}

/** OSRM puts the pair in the path as `lon,lat;lon,lat`. */
function originOf(url: string): [number, number] | null {
	const pair = url.split('/foot/')[1]?.split('?')[0]?.split(';')[0];
	const [longitude, latitude] = (pair ?? '').split(',').map(Number);
	return Number.isFinite(latitude) && Number.isFinite(longitude) ? [latitude, longitude] : null;
}

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

test.describe('a walk measured from the terminal, not the runway (issue #341)', () => {
	test('offers the walking option the runway point had hidden', async ({ page }) => {
		await mockAllKeylessProviders(page.context());
		// A bed 2.5 km north of Vienna's terminal and 3.4 km from its published point. Both
		// are inside the 4.5 km radius `osrm.ts` will ask for a foot route within, so this
		// spec turns on the origin alone and not on whether a walk was requested at all.
		await mockHostelworld(
			page.context(),
			'hostelworld/continents-vienna.json',
			'hostelworld/properties-vienna-walkable.json'
		);

		const askedFrom: [number, number][] = [];
		// Registered after the batch above, so this wins for foot routes: Playwright asks
		// the most-recently-registered matching route first. Driving still falls through to
		// the default fixture, so the drive row is unaffected either way.
		await page.context().route(`${OSRM_BASE_URL}/routed-foot/**`, async (route) => {
			const origin = originOf(route.request().url());
			if (origin) askedFrom.push(origin);
			const fromTerminal = origin !== null && metresApart(origin, VIE_TERMINAL) < 300;
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: osrmWalk(fromTerminal ? PLAUSIBLE_WALK_MINUTES : IMPLAUSIBLE_WALK_MINUTES)
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

		await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
		await waitForSearchToSettle(page, { timeout: 20_000 });
		await openTimeline(page);

		const hotelRow = page.locator('.itinerary-timeline [data-segment="transfer-to-hotel"]');
		await expect(hotelRow).toBeVisible();
		await hotelRow.click();

		// The owner's complaint, in one assertion: "it doesnt even suggest walking option".
		await expect(customiser(page).locator('.picker-row', { hasText: 'Walk' })).toHaveCount(1);

		// And the reason it is there, stated as the two facts that matter. A walk did leave
		// Vienna's terminal, and no walk anywhere in this search left Vienna's published
		// point. Not "every origin is the terminal": legs run in both directions and from
		// the other two airports too, so most of these origins are hotels and runways
		// elsewhere.
		expect(askedFrom.some((origin) => metresApart(origin, VIE_TERMINAL) < 300)).toBe(true);
		expect(askedFrom.some((origin) => metresApart(origin, VIE_PUBLISHED) < 300)).toBe(false);
	});
});
