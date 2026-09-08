import { expect, test, type Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, mockHostelworld, routeRyanairFlights } from './support/providers';
import { customiser, openTimeline } from './support/results-ui';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * Issue #449 in a real browser, which is the only place it can be checked.
 *
 * Two of the three things this feature promises are invisible to a unit test. The lookup
 * runs from an `$effect`, and AGENTS.md's "Svelte trap that cost us a working search" is
 * exactly a defect that survives a green suite and freezes the page. And the request budget
 * is the whole design, one property and never the list, which is a count of network requests
 * rather than a property of a function.
 *
 * The third is the honesty rule, and it is checked here as well as in `stay-photos.test.ts`
 * because what matters is the word a person reads on the picture, not the field behind it.
 */

/** A real image with real intrinsic dimensions and no binary fixture to check in, the same
 * trick `stays-map.spec.ts` uses. An `<img>` decodes an SVG like any other format. */
function photo(label: string): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000"><rect width="100%" height="100%" fill="#264653"/><text x="24" y="120" font-size="72" fill="#e9c46a">${label}</text></svg>`;
}

interface OpenedPicker {
	/** Every availability URL the page asked for. The count is the assertion. */
	availabilityRequests: string[];
}

async function openPicker(page: Page): Promise<OpenedPicker> {
	const availabilityRequests: string[] = [];
	page.on('request', (request) => {
		if (request.url().includes('/availability/')) availabilityRequests.push(request.url());
	});

	await mockAllKeylessProviders(page.context());
	await mockHostelworld(
		page.context(),
		'hostelworld/continents-vienna.json',
		'hostelworld/properties-vienna-photos.json',
		'hostelworld/property-availability.json'
	);
	await page.context().route('https://photos.fixture.invalid/**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'image/svg+xml',
			body: photo(route.request().url().split('/').pop() ?? '')
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

	await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
	await waitForSearchToSettle(page, { timeout: 30_000 });
	await expect(page.locator('.result-card').first()).toBeVisible();
	// `openTimeline` picks the stopover on its way in, and a second activation of the picked
	// segment clears it, which is how a traveller hands the map back the whole route. So
	// asking for the stopover again here emptied the panel this spec had just filled.
	// `pickTimelineSegment` guards against the same thing by reading `aria-current` first.
	await openTimeline(page);
	await expect(carousel(page)).toBeVisible({ timeout: 20_000 });

	return { availabilityRequests };
}

/**
 * The open card's carousel, which is the property the traveller has a bed at.
 *
 * Scoped to `.stay-open-body` rather than taken as the panel's first carousel. Issue #440
 * put `StopoverBlock` at the top of this panel, so `PickedBed` draws a second carousel of
 * the same property above the picker, and that one shows the building's own photographs
 * only. Asking for the first one read its "1 / 2" and never saw the room photographs at all.
 * `stays-map.spec.ts` names the open card this way for the same reason.
 */
function carousel(page: Page) {
	return customiser(page).locator('.stay-open-body .photo-carousel');
}

test.describe('room photographs on the open stay card (issue #449)', () => {
	test.use({ viewport: { width: 1280, height: 1000 } });

	test('spends one request for the open property and none for the rest of the list', async ({ page }) => {
		const { availabilityRequests } = await openPicker(page);

		// The counter is what says the room photographs actually landed in the list. The
		// fixture property publishes two of its own; the availability answer adds a mixed dorm
		// and a private, both of which this property prices.
		const counter = carousel(page).locator('.photo-count');
		await expect(counter).toContainText('/ 5', { timeout: 20_000 });

		// One property, never the list. Thirty of these was measured at up to 7 seconds behind
		// the browser's six-per-host limit (`tools/probe-hostelworld-rooms.mjs`), and the list
		// on screen holds one property with a bed on it.
		expect(availabilityRequests).toHaveLength(1);
		expect(availabilityRequests[0]).toContain('/2.2/properties/991002/availability/');
		expect(availabilityRequests[0]).toContain('num-nights=2');
	});

	test('never calls a room-kind photograph the room whose price is on screen', async ({ page }) => {
		await openPicker(page);
		const strip = carousel(page);

		// The building's own come first and carry no badge at all.
		await expect(strip.locator('.photo-subject')).toHaveCount(0);

		// Paging to a room photograph names the kind in the plural. "Dorm rooms at this
		// property" is true; "Room" would be a claim about a bed nobody can point at, because
		// a `dorm` is priced from a property-level average no single room quotes.
		const next = strip.locator('.photo-arrow-next');
		await next.click();
		await next.click();
		const badge = strip.locator('.photo-subject');
		await expect(badge).toBeVisible();
		await expect(badge).toHaveText(/rooms$/i);
		await expect(badge).not.toHaveText('Room');
	});

	test('leaves the page usable, which an effect that retriggers itself would not', async ({ page }) => {
		// AGENTS.md, #87: an `$effect` calling an async function without awaiting it aborts
		// Svelte with `effect_update_depth_exceeded` and the page freezes before anything
		// renders. It survives every unit test. The check is that the page still answers.
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await openPicker(page);
		await expect(carousel(page).locator('.photo-arrow-next')).toBeEnabled();
		expect(errors.filter((message) => message.includes('effect_update_depth'))).toEqual([]);
	});
});
