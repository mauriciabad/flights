import { test, expect } from './support/fixtures';
import type { Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, mockHostelworld, routeRyanairFlights } from './support/providers';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * Issue #289: "a card says fetched 1 hour ago one minute after every flight price on it was
 * refetched".
 *
 * The footer used to take `Math.min` over every source that touched the card and print it
 * once, as a single "fetched N ago". Sources on one card do not share a TTL and never will:
 * Kiwi offers last 15 minutes and Ryanair fares an hour, while an OSRM road route is cached
 * for 30 days because a road does not move. So the oldest TTL on the card won the sentence,
 * and the number a traveller read as the age of the fare was the age of something nothing had
 * any reason to refetch. Measured on a real page with `tools/probe-card-age.mjs`, three runs
 * out of three: every flight and bed entry came back 0 minutes old and the whole footer read
 * "fetched 3 hours ago".
 *
 * This spec forces two ages onto one card rather than waiting for them. It runs a search, then
 * backdates the bed three hours while leaving every other entry one minute past its own TTL,
 * and reloads. The old footer printed 3 hours over all of it, including fares an hour old.
 *
 * What this does NOT check is the card following a refetch that lands while it is on screen.
 * That is issue #293, and `card-refetch-age.spec.ts` next door owns it.
 *
 * #293 is also why the bed's own source stops answering here. A Hostelworld bed is cached for
 * an hour, so a bed aged three hours is expired, and since #293 the refetch behind it reaches
 * the card: every source went fresh, the split this spec exists to measure closed, and the
 * spec failed on a page that was doing exactly the right thing. Holding a source at an age is
 * therefore a matter of it having nothing to refresh WITH, not of picking a number. A provider
 * that is briefly down is the honest way to say that, and it is the one this spec needs.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });
const BED_AGE_HOURS = 3;

/**
 * `localStorage.clear()` does not reach this cache and neither does clearing Cache Storage
 * (AGENTS.md). Reaching into the entries directly is also the only way to age one provider
 * differently from another, which is the whole point here.
 */
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

/**
 * The whole provenance sentence, read off the control that reveals it.
 *
 * Issue #312 took this off the footer as prose, because at 375px the row showed about a
 * tenth of its text whatever it said. The sentence is unchanged and is now the accessible
 * name of the disclosure button, so a reader who never opens the panel still hears it, and
 * so this spec still measures what #289 built. `card-provenance.spec.ts` owns the panel.
 */
async function sourceSentence(page: Page): Promise<string> {
	const label =
		(await page.locator('.result-card').first().locator('.source-note-trigger').getAttribute('aria-label')) ??
		'';
	return label.replace(/^Sources and when each was fetched: /, '');
}

/** The part of the sentence that is about one provider. It is a list of
 *  `<labels>, fetched <age>` groups joined by `; `, and which group a provider lands in is
 *  the whole subject of this spec, so an assertion may not assume an order. */
function clause(line: string | null, provider: string): string {
	const found = (line ?? '').split('; ').find((group) => group.includes(provider));
	expect(found, `no clause for ${provider} in "${line}"`).toBeDefined();
	return found as string;
}

test.describe('issue #289: the footer ages each source separately', () => {
	test('a fare is not printed at the age of a bed the app has no reason to refetch', async ({ page }) => {
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

		const source = page.locator('.result-card').first().locator('.provenance-source');
		await expect(source).toBeVisible();
		// Both have to be named or there is no split to measure and the rest of this spec
		// would pass against any implementation at all.
		const cold = await sourceSentence(page);
		expect(cold).toContain('Hostelworld');
		expect(cold).toContain('Ryanair');
		// A search that fetched everything at once still names it all in one clause, which is
		// the sentence this page had before #289 and the one it keeps. Asserted as "these two
		// share a clause" rather than "there is no semicolon", so a search that happens to
		// straddle a minute boundary moves both of them together instead of failing. The exact
		// one-age wording is pinned in `view-model.test.ts`.
		expect(clause(cold, 'Ryanair')).toBe(clause(cold, 'Hostelworld'));

		expect(await backdateCache(page, 'hostelworld', BED_AGE_HOURS)).toBeGreaterThan(0);

		// Registered after the mock above, so Playwright gives it first refusal: from here the
		// bed cannot be refreshed, and its three hours stay three hours for the reload to
		// print. Only the properties endpoint, so the city index behind it still resolves and
		// the stopover keeps its bed.
		await page.context().route('https://api.m.hostelworld.com/2.2/cities/**', (route) =>
			route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
		);

		await page.reload();
		await waitForSearchToSettle(page, { timeout: 20_000 });
		await expect(source).toBeVisible();
		const line = await sourceSentence(page);

		// Naming the old source is what tells a traveller which number on the card is the old
		// one. The single-age line could not say it at all.
		expect(clause(line, 'Hostelworld')).toContain(`fetched ${BED_AGE_HOURS} hours ago`);

		// The assertion issue #289 is about. The fares are an hour old, not three, and the old
		// footer printed all four sources under the bed's three hours. Asserted as "not the
		// bed's age" rather than as a figure, so it stays true if a fare TTL ever moves.
		expect(clause(line, 'Ryanair')).not.toContain(`${BED_AGE_HOURS} hours ago`);
		expect(clause(line, 'Ryanair')).not.toBe(clause(line, 'Hostelworld'));
	});
});
