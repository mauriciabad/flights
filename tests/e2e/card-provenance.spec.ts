import { test, expect } from './support/fixtures';
import type { Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, mockHostelworld, routeRyanairFlights } from './support/providers';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * The card's provenance, after issue #312 moved it behind a control.
 *
 * The owner could not read the row it replaces: "the text is elipsed and cant be ssen". The
 * two things that must be true of whatever replaced it are the two the issue names, and
 * neither is about wording, so both are measured here.
 *
 * A `title` is not a tooltip. It does not open on touch at all, and this is a phone problem
 * first, so the control is driven by tap and by keyboard below, on a touch viewport.
 *
 * And the staleness signal survives. The brief asks that stale cached results be marked
 * visibly; a fact reachable only by a deliberate tap is not marked, so something on the card
 * has to say a source is old without anyone opening anything.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });
const OLD_SOURCE_HOURS = 21;

/** Ages one provider's cache entries and leaves every other entry one minute past its own
 * TTL, so the reload paints one genuinely old source beside fresh ones. `localStorage.clear()`
 * does not reach this cache (AGENTS.md); the entries have to be reached directly. */
async function backdateCache(page: Page, olderProviderId: string, olderAgeHours: number): Promise<number> {
	return page.evaluate(
		([provider, hoursBack]) =>
			new Promise<number>((resolve, reject) => {
				const open = indexedDB.open('flights-cache', 1);
				open.onsuccess = () => {
					const transaction = open.result.transaction('entries', 'readwrite');
					const store = transaction.objectStore('entries');
					const all = store.getAll();
					all.onsuccess = () => {
						for (const entry of all.result) {
							const back =
								entry.providerId === provider ? (hoursBack as number) * 3_600_000 : entry.ttlMs + 60_000;
							store.put({ ...entry, storedAt: Date.now() - back });
						}
						transaction.oncomplete = () => resolve(all.result.length);
					};
					all.onerror = () => reject(all.error);
				};
				open.onerror = () => reject(open.error);
			}),
		[olderProviderId, olderAgeHours] as const
	);
}

async function openResults(page: Page) {
	await mockAllKeylessProviders(page.context());
	await mockHostelworld(
		page.context(),
		'hostelworld/continents-vienna.json',
		'hostelworld/properties-vienna.json'
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
	await page.context().route('https://basemaps.cartocdn.com/**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
	);
	await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
	await waitForSearchToSettle(page, { timeout: 20_000 });
	await expect(page.locator('.result-card').first()).toBeVisible();
}

test.describe('on a phone, where the old row showed a tenth of itself', () => {
	test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

	test('the footer no longer overflows the card it is in', async ({ page }) => {
		await openResults(page);

		// The defect, measured rather than described: the row's content was wider than the row.
		const overflow = await page.locator('.result-card').first().locator('.provenance').evaluate((row) => {
			const parts = [...row.children].map((child) => child.scrollWidth);
			return { scroll: row.scrollWidth, client: row.clientWidth, parts };
		});
		expect(overflow.scroll, 'the provenance row still needs more width than it has').toBeLessThanOrEqual(
			overflow.client + 1
		);
	});

	test('a tap opens the sources, and they are readable', async ({ page }) => {
		await openResults(page);
		const trigger = page.locator('.result-card').first().locator('.source-note-trigger');
		await expect(trigger).toHaveAttribute('aria-expanded', 'false');

		await trigger.tap();
		await expect(trigger).toHaveAttribute('aria-expanded', 'true');

		const panel = page.locator('.source-note').first();
		await expect(panel).toBeVisible();
		await expect(panel).toContainText('Ryanair');
		await expect(panel).toContainText('fetched');

		// Inside the viewport, both edges. A panel positioned off a 375px screen is the same
		// defect in a new place.
		const box = (await panel.boundingBox())!;
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(375);
	});

	test('the target is big enough to tap', async ({ page }) => {
		await openResults(page);
		const box = (await page.locator('.result-card').first().locator('.source-note-trigger').boundingBox())!;
		expect(box.width).toBeGreaterThanOrEqual(24);
		expect(box.height).toBeGreaterThanOrEqual(24);
	});

	test('Escape closes it, which is WCAG 1.4.13 Dismissible', async ({ page }) => {
		await openResults(page);
		const trigger = page.locator('.result-card').first().locator('.source-note-trigger');
		await trigger.tap();
		await expect(page.locator('.source-note').first()).toBeVisible();

		await page.keyboard.press('Escape');
		await expect(trigger).toHaveAttribute('aria-expanded', 'false');
	});
});

test.describe('the keyboard reaches it too', () => {
	test.use({ viewport: { width: 1280, height: 900 } });

	test('focusing the control reveals the sources', async ({ page }) => {
		await openResults(page);
		const trigger = page.locator('.result-card').first().locator('.source-note-trigger');

		await trigger.focus();
		await expect(page.locator('.source-note').first()).toBeVisible();
		await expect(trigger).toHaveAttribute('aria-expanded', 'true');
	});

	test('the whole sentence is the control’s name, so nothing is lost by never opening it', async ({
		page
	}) => {
		await openResults(page);
		const label = await page
			.locator('.result-card')
			.first()
			.locator('.source-note-trigger')
			.getAttribute('aria-label');

		expect(label).toContain('Ryanair');
		expect(label).toContain('fetched');
	});
});

test.describe('the staleness signal stays visible', () => {
	test.use({ viewport: { width: 375, height: 812 } });

	test('an old source is marked on the card without opening anything', async ({ page }) => {
		await openResults(page);
		// Nothing is old yet, so nothing claims to be.
		await expect(page.locator('.provenance-stale')).toHaveCount(0);

		// The bed, because it is a source this card really has: with no origin or destination
		// location in the query, the road router never contributes a part to this itinerary,
		// so ageing it would age nothing the footer names.
		expect(await backdateCache(page, 'hostelworld', OLD_SOURCE_HOURS)).toBeGreaterThan(0);

		// Registered after the mocks above, so Playwright gives it first refusal: from here
		// the bed cannot be refreshed and its 21 hours stay 21 hours for the reload to read.
		// Since #293 a card follows the refetch it started, so an aged entry whose provider
		// still answers goes fresh before this assertion runs and the test then measures a
		// page doing exactly the right thing. `card-age-line.spec.ts` learned this the same
		// way. Holding a source at an age is a matter of it having nothing to refresh WITH,
		// not of picking a number. Only the properties endpoint, so the city index behind it
		// still resolves and the stopover keeps its bed.
		await page.context().route('https://api.m.hostelworld.com/2.2/cities/**', (route) =>
			route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
		);

		await page.reload();
		await waitForSearchToSettle(page, { timeout: 20_000 });

		const stale = page.locator('.result-card').first().locator('.provenance-stale');
		await expect(stale, 'the brief asks for stale results to be marked VISIBLY').toBeVisible();
		// "oldest", not a claim about the card: sources on one card do not share a TTL, which
		// is the whole of #289.
		await expect(stale).toContainText('oldest');
		await expect(stale).toContainText(`${OLD_SOURCE_HOURS} hours ago`);
	});
});
