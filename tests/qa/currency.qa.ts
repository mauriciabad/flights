/**
 * Invariant: money in an itinerary is all one currency, and a part quoted in another one
 * costs the traveller that part, never the whole trip.
 *
 * The owner's report: "Price a bed and the trip vanishes. Fail to price one and the user
 * sees 'No bed priced for this stopover'. The app could only ever show bedless results."
 *
 * The two checks below hold that from both sides, which is the only way to catch the class
 * rather than the instance:
 *
 * - Adding a stay key must never REMOVE an itinerary. This is the one that caught the
 *   defect: `resources.ts` used to build its `StaySearchQuery` without a currency, Agoda
 *   answered in USD, `sumMoney` refused the EUR mix, and `pipeline.ts`'s per-candidate
 *   `catch` degraded the whole candidate to nothing. Fixed by #154/#152.
 * - A rendered itinerary must quote one currency. This is the check that stops the first one
 *   ever being "fixed" by letting two currencies onto the same card instead, which would
 *   produce a total that cannot be right.
 *
 * The bench is what makes this observable: it quotes in the currency the caller asked for
 * and falls back to USD when nobody asked, exactly as `agoda-mapper.ts` records the real
 * Agoda doing. A mock that always answered EUR would show a healthy app.
 */

import { test, expect } from './support/bench';
import { QA_KEYS } from './support/bench';
import { resultsUrl } from './support/scenario';
import { currenciesIn, resultCards, resultsText, waitForSearchToSettle } from './support/page';

async function connectionCities(page: import('@playwright/test').Page): Promise<string[]> {
	return resultCards(page).locator('.city').allInnerTexts();
}

test.describe('currency', () => {
	test('pricing a bed never removes an itinerary', async ({ page, context }) => {

		// Run one: no stay keys, so no stay is ever priced and nothing can disagree about a
		// currency. This is the baseline the traveller already has.
		await page.goto(resultsUrl());
		await waitForSearchToSettle(page);
		const bedless = await connectionCities(page);

		// Run two: identical search, with the two stay providers configured. An init script
		// applies to the next navigation, so the reload below is the first load that sees a
		// key — same context, same cache, only the keys differ.
		await context.addInitScript((keys) => {
			window.localStorage.setItem('flights.byokKeys.v1', JSON.stringify(keys));
		}, QA_KEYS);
		await page.goto(resultsUrl());
		await waitForSearchToSettle(page);
		const priced = await connectionCities(page);

		const lost = bedless.filter((city) => !priced.includes(city));
		expect(
			lost,
			[
				`Adding a stay key deleted ${lost.length} itinerary(s) that existed without one: ${lost.join(', ')}.`,
				`  without stay keys: ${bedless.length} — ${bedless.join(', ')}`,
				`  with stay keys:    ${priced.length} — ${priced.join(', ')}`,
				'',
				'A stay a provider quoted in a currency the flights are not in must degrade to',
				'"No bed priced for this stopover", never to no stopover at all. Two things hold',
				'that today and both have to keep holding: resources.ts filters a mismatched stay',
				'out of the candidates, and build.ts drops the bed rather than totalling a mix.'
			].join('\n')
		).toEqual([]);
	});

	test('a rendered itinerary quotes one currency', async ({ page, withKeys }) => {
		await withKeys();
		await page.goto(resultsUrl());
		await waitForSearchToSettle(page);

		const cards = await resultCards(page).all();
		expect(cards.length, 'no itineraries rendered, so there is nothing to check').toBeGreaterThan(0);

		for (const [index, card] of cards.entries()) {
			const text = await card.innerText();
			const currencies = currenciesIn(text);
			expect(
				currencies,
				`Itinerary ${index + 1} quotes ${currencies.length} currencies (${currencies.join(', ')}) on one card. Money is an integer plus a currency code and this app does no conversion, so two currencies on one card means a total that cannot be right.\n\n${text}`
			).toHaveLength(1);
		}

		// Across cards too: the whole list is one search, at one currency.
		const everywhere = currenciesIn(await resultsText(page));
		expect(everywhere, `The results list mixes ${everywhere.join(' and ')} across its cards.`).toHaveLength(1);
	});

	/**
	 * docs/ACCEPTANCE.md's third condition, stated as a check: "A bed is priced into the
	 * total. Not 'No bed priced for this stopover'."
	 *
	 * It lives in this file because it is the far end of the same chain. #152 stopped a
	 * mismatched stay destroying its itinerary, which was the urgent half. The other half was
	 * open until PR #176: `+page.svelte`'s `deps()` named no currency, so `currency_id` never
	 * reached Agoda, Agoda answered in USD as it documents, and `build.ts` correctly dropped a
	 * stay it could not total. The trip survived and the bed never did. This check was pinned
	 * to #158 for that and is not any more — the bench still answers USD when nobody names a
	 * currency, so it would go red again the day something stops naming one.
	 *
	 * Asserting "at least one" rather than "every one" on purpose. A stopover with genuinely
	 * no bed within the radius is a real answer, and the app is right to say so. Every
	 * stopover being bedless while two stay providers answered is not.
	 */
	test('a configured stay provider prices at least one bed', async ({ page, bench, withKeys }) => {
		await withKeys();
		await page.goto(resultsUrl());
		await waitForSearchToSettle(page);

		const cards = await resultCards(page).allInnerTexts();
		expect(cards.length, 'nothing was found, so nothing could carry a bed').toBeGreaterThan(0);

		const bedless = cards.filter((text) => /No bed priced/i.test(text));
		const staysRequested = bench.countFor('agoda') + bench.countFor('booking');

		expect(
			bedless.length,
			[
				`All ${cards.length} itineraries say "No bed priced for this stopover", after ${staysRequested} requests to the stay providers.`,
				'',
				'Requests the stay providers actually received:',
				...bench.requests
					.filter((request) => request.providerId === 'agoda' || request.providerId === 'booking')
					.map((request) => `  ${request.providerId}: ${request.url.split('?')[1] ?? request.url}`),
				'',
				'A get-prices call with no currency_id gets USD back, which is what agoda-mapper.ts',
				'records Agoda doing. build.ts then drops a stay it cannot total against EUR flights.',
				'The currency has to be named at the top of the chain, in',
				'SearchDependencies.currency, which +page.svelte deps() sets since #176. Check the',
				'requests above for a get-prices without a currency_id.'
			].join('\n')
		).toBeLessThan(cards.length);
	});
});
