/**
 * Invariant: the quota on screen is the provider's number, not this browser's guess.
 *
 * "Eighty-five percent of his Booking.com allowance went in a single morning, spent by
 * agents testing, while the settings card still read '0 of 40 requests spent'. Both numbers
 * were right. The cap lives in `localStorage`, the quota belongs to the RapidAPI account, so
 * a counter is per browser profile and the allowance is per key." (AGENTS.md)
 *
 * A local tally can only ever be right for one browser profile. The account's own count is
 * in the response, and until PR #172 nothing read it: every client in `providers/` read
 * `retry-after` on a 429 and dropped the `Response` entirely on a 200, so no header survived
 * as far as the budget module. #172 closed that, and this check now holds the fix rather
 * than the defect — it was pinned to #146 and is not any more.
 *
 * What it holds is stricter than "the provider's number appears somewhere". The card shows
 * two numbers, and they are different on purpose: the header reads the app's own safety cap
 * (400) minus what it believes is spent, while `.provider-card-quota-reported` carries
 * Agoda's own figure verbatim. Only the second one can be checked against the response, so
 * that is the one this reads, along with the spent count derived from it — a number a local
 * tally could not reach on a profile that has made one request.
 *
 * ## What this can and cannot prove without spending
 *
 * The bench answers with RapidAPI's rate-limit headers AND with the
 * `access-control-expose-headers` that lets a cross-origin `fetch` read them. That is the
 * shape a fix would rely on, and it is enough to prove the app derives its display from the
 * response rather than from a counter.
 *
 * What it deliberately does not prove is that the real RapidAPI exposes those headers to a
 * browser. docs/PROVIDERS.md records `Access-Control-Allow-Headers` (what the browser may
 * send) and has never measured `Access-Control-Expose-Headers` (what it may read). Measuring
 * that costs one metered request against the owner's own key, so it is not something
 * `pnpm qa` may do. It is a one-line note for whoever next touches this path, not a gap in
 * this check.
 */

import { test, expect } from './support/bench';

/** What the account has left, as the provider would report it. Deliberately unrelated to
 * anything a local tally could arrive at: `caps.ts` holds Agoda at 400 and a fresh profile
 * starts at zero used, so "393 left" cannot be computed from local state by accident. */
const REMAINING = 393;
const LIMIT = 500;

/** Agoda answers every request with its own rate-limit counters, and says the browser may
 * read them. Without `access-control-expose-headers` a cross-origin `fetch` cannot see a
 * header at all, so leaving it out would test the bench rather than the app — the bench
 * adds it for whatever is declared here. */
test.use({
	benchOptions: {
		headers: {
			agoda: {
				'x-ratelimit-requests-remaining': String(REMAINING),
				'x-ratelimit-requests-limit': String(LIMIT)
			}
		}
	}
});

test.describe('quota', () => {
	test('the settings card shows what the provider says is left', async ({ page, context, bench }) => {
		bench.delayResponsesBy(0);
		await context.addInitScript(() => {
			window.localStorage.setItem(
				'flights.byokKeys.v1',
				JSON.stringify({ agoda: { apiKey: 'qa-not-a-real-key' } })
			);
		});

		await page.goto('/settings/');
		const card = page.locator('.provider-card', { hasText: 'Agoda' }).first();
		await expect(card).toBeVisible();

		// The one call this screen makes on purpose. Its response carries the account's real
		// remaining count, which is the cheapest place in the whole app to learn it.
		await card.getByRole('button', { name: 'Test' }).click();
		await expect(card.getByRole('button', { name: 'Test' })).toBeEnabled({ timeout: 20_000 });

		const reported = await card
			.locator('.provider-card-quota-reported')
			.innerText()
			.catch(() => '');
		const note = await card.locator('.provider-card-quota-note').innerText();
		const headline = await card.locator('.provider-card-quota').first().innerText();

		const evidence = [
			`The card's header says "${headline.trim()}".`,
			`Its reported line says "${reported.replace(/\s+/g, ' ').trim() || '(the line is not there at all)'}".`,
			`Its note says "${note.replace(/\s+/g, ' ').trim()}".`,
			`Agoda answered that request with x-ratelimit-requests-remaining: ${REMAINING}, x-ratelimit-requests-limit: ${LIMIT}.`,
			'',
			'A tally kept in localStorage is right only for one browser profile and only until',
			'somebody uses the key on another device. Where a provider reports its own count,',
			'that is the number to show, and to say out loud that it is the account\'s.'
		].join('\n');

		// The provider's own figures, verbatim, in the one line on the card that claims to be
		// quoting the provider rather than the app.
		expect(reported, evidence).toContain(String(REMAINING));
		expect(reported, evidence).toContain(String(LIMIT));

		// And the spent count has to be derived from them. This profile has made exactly one
		// metered request, so a local tally would say "1"; `LIMIT - REMAINING` is the only way
		// to reach 107.
		expect(note, evidence).toContain(String(LIMIT - REMAINING));
	});
});
