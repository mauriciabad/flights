import { test, expect } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, mockHostelworld, routeRyanairFlights } from './support/providers';
import { customiser, openTimeline, pickStripSegment } from './support/results-ui';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * Issue #374: a full stay list is still one provider's catalogue, and the page has to say so.
 *
 * A keyless visitor searching Porto got 54 Hostelworld hostels and no hint that Agoda and
 * Booking.com were never asked. `describeNoStays` speaks only when the list is EMPTY, so a
 * partial catalogue read as the whole market. The owner's own preferred bed, Oporto Sea
 * Rooms, is a Booking.com listing: never fetched, never mentioned.
 *
 * The wording is unit-tested in `src/lib/stays/no-stays-reason.test.ts`. What only a browser
 * can answer is whether the footnote reaches the screen at all — it hangs off the very end
 * of the populated branch, below the alternatives list, which is the arm no other spec had
 * ever asserted anything about. Issue #87 is the standing reminder that this class of defect
 * survives a green unit suite.
 *
 * No key is written anywhere here, on purpose. The note is only true from an empty key
 * store, and that is the state the issue was filed from.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

test.describe('the stay list says whose catalogue it is (issue #374)', () => {
	test.use({ viewport: { width: 1280, height: 900 } });

	test('a populated list with no stay key names its source and who was never asked', async ({
		page
	}) => {
		await mockAllKeylessProviders(page.context());

		// Registered after the defaults so this wins. Vienna's fixture puts several
		// properties on the airport's own coordinates, which is what the real adapter's
		// radius filter needs to keep any of them — and a populated list is the entire
		// precondition of this test.
		await mockHostelworld(
			page.context(),
			'hostelworld/continents-vienna.json',
			'hostelworld/properties-vienna-many.json'
		);

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

		// The Vienna fixture's properties carry photo URLs, and the network guard fails the
		// test for any request no mock answered. Same treatment `stays-map.spec.ts` gives the
		// same fixture, minus its recording: this spec is about a sentence, not the pictures.
		await page.context().route('https://photos.fixture.invalid/**', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'image/svg+xml',
				body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><title>FIXTURE</title></svg>'
			})
		);

		await page.context().route('https://basemaps.cartocdn.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
		);

		await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
		// A reading taken mid-search is a reading of a stay list that has not arrived.
		await waitForSearchToSettle(page, { timeout: 30_000 });
		await expect(page.locator('.result-card').first()).toBeVisible();

		await openTimeline(page);
		await pickStripSegment(page, 'stopover');

		const panel = customiser(page);
		// The footnote belongs under the alternatives, so wait for them: finding the note
		// before the list it annotates has rendered would prove nothing about where it sits.
		await expect(panel.locator('.stay-alternatives')).toBeVisible({ timeout: 20_000 });

		const note = panel.getByTestId('stay-catalogue-note');
		await expect(note).toBeVisible();

		// Who answered, and how many beds that bought. The count comes from the fixture, so
		// the shape of the sentence is asserted rather than the figure.
		await expect(note).toContainText(/Hostelworld listed these \d+ properties\./);
		// And who never got asked. This is the half the owner was missing: his own bed is a
		// Booking.com listing, and the page used to say nothing at all about it.
		await expect(note).toContainText('Agoda and Booking.com have no key saved');
		await expect(note).toContainText('missing from this list');

		const addKey = note.getByRole('link', { name: 'Add an Agoda key' });
		await expect(addKey).toHaveAttribute('href', /\/settings\/#agoda$/);
		// Svelte trims whitespace at the start of a block's content, so a newline after the
		// `{#if}` guarding this link is not a space and the sentence runs into the link text
		// (`SegmentCustomiser.svelte` carries the same warning at its own copy of this).
		await expect(note).not.toContainText('list.Add');

		// The note is the quiet footnote, not a second empty state. Nothing failed here, so
		// no provider message belongs on screen.
		await expect(panel.getByTestId('stay-provider-failure')).toHaveCount(0);
	});
});
