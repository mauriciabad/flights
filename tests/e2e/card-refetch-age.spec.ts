import { test, expect } from './support/fixtures';
import type { Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, mockHostelworld, routeRyanairFlights } from './support/providers';

/**
 * Issue #293: "a card's fetch times are frozen at the values it painted with, so a refetch
 * that lands never moves them".
 *
 * The brief's third rule is "stale first, then fresh. Show the cached answer immediately,
 * refetch anyway, update in place." The first two thirds worked. Every adapter that serves a
 * cached answer past its TTL refetches behind it, and every one of them ended at the cache
 * write: the page had already rendered from the value that write replaced, and nothing looked
 * again. Measured with `tools/probe-card-age.mjs` against a real build and real providers, 76
 * responses landed inside 3 seconds and every Kiwi, Ryanair and Hostelworld entry came back 0
 * minutes old, while every card went on saying "fetched 3 hours ago" for as long as it was
 * watched. A marker that never clears is the same as no marker.
 *
 * Forcing that rather than waiting for it: run a search, put every Ryanair entry an hour and
 * a minute into the past, and reload. Only the fare calendar expires at that age, since the
 * timetable is cached for a week and the route graph for a day, so the reload serves an
 * hour-old fare, refetches it in the background, and the card must follow.
 *
 * The refetch is deliberately slowed. Without a delay the fixtures answer inside a frame and
 * the assertion that the card first paints the OLD age, which is what proves the setup
 * produced a stale reading at all, becomes a race the fix itself would win.
 */

const STALE_AGE_MINUTES = 61;
const STALE_AGE_TEXT = '1 hour ago';
/** Long enough that the stale paint is unmissable, short enough that a spec waiting on the
 *  refresh behind it is not. */
const REFETCH_DELAY_MS = 2_000;

/**
 * Ages one provider's entries and leaves every other provider's alone, which is what makes
 * this a test about one source going stale rather than about a cold cache.
 *
 * Reaching into IndexedDB directly because nothing else can: `localStorage.clear()` does not
 * touch this cache and neither does clearing Cache Storage (AGENTS.md).
 */
async function backdateProvider(page: Page, providerId: string, minutes: number): Promise<number> {
	return page.evaluate(
		([provider, back]) =>
			new Promise<number>((resolve, reject) => {
				const open = indexedDB.open('flights-cache', 1);
				open.onsuccess = () => {
					const transaction = open.result.transaction('entries', 'readwrite');
					const store = transaction.objectStore('entries');
					const all = store.getAll();
					all.onsuccess = () => {
						let moved = 0;
						for (const entry of all.result) {
							if (entry.providerId !== provider) continue;
							store.put({ ...entry, storedAt: Date.now() - (back as number) * 60_000 });
							moved += 1;
						}
						transaction.oncomplete = () => resolve(moved);
					};
					all.onerror = () => reject(all.error);
				};
				open.onerror = () => reject(open.error);
			}),
		[providerId, minutes] as const
	);
}

/**
 * The part of the footer that is about one provider. Since #289 the line is a list of
 * `<labels>, fetched <age>` groups joined by `; `, and before it the whole line was one such
 * group, so splitting on `; ` reads both shapes.
 */
function clauseFor(line: string, provider: string): string | undefined {
	return line.split('; ').find((group) => group.includes(provider));
}

test.describe('issue #293: a card follows the refetch it started', () => {
	test('an expired fare that refetches behind the card stops being reported at its old age', async ({
		page
	}) => {
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

		await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
		await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 20_000 });

		const source = page.locator('.result-card').first().locator('.provenance-source');
		await expect(source).toBeVisible();
		// Without Ryanair on the card there is no fare to age and the rest of this would pass
		// against any implementation at all.
		await expect(source).toContainText('Ryanair');

		expect(await backdateProvider(page, 'ryanair', STALE_AGE_MINUTES)).toBeGreaterThan(0);

		await page.context().route('https://services-api.ryanair.com/**', async (route) => {
			await new Promise((resolve) => setTimeout(resolve, REFETCH_DELAY_MS));
			await route.fallback();
		});

		await page.reload();
		await expect(source).toBeVisible({ timeout: 20_000 });

		// Stale first: the hour-old fare is on screen before anything is refetched.
		await expect(source).toContainText(STALE_AGE_TEXT);

		// Then fresh, in place. This is the assertion issue #293 is about, and the one that
		// failed for as long as the fresher fare reached only the next reload.
		await expect
			.poll(async () => clauseFor((await source.textContent()) ?? '', 'Ryanair'), {
				timeout: 25_000,
				message: 'the Ryanair fetch time never moved off the age the card painted with'
			})
			.not.toContain(STALE_AGE_TEXT);

		// The card is still the same card, still naming the same source: a footer that lost
		// Ryanair would satisfy the line above while saying nothing.
		await expect(source).toContainText('Ryanair');
	});
});
