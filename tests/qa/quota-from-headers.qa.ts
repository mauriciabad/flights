/**
 * Invariant: the quota on screen is the provider's number, not this browser's guess.
 *
 * "Eighty-five percent of his Booking.com allowance went in a single morning, spent by
 * agents testing, while the settings card still read '0 of 40 requests spent'. Both numbers
 * were right. The cap lives in `localStorage`, the quota belongs to the RapidAPI account, so
 * a counter is per browser profile and the allowance is per key." (AGENTS.md)
 *
 * A local tally can only ever be right for one browser profile. The account's own count is
 * in the response, and nothing reads it: every client in `providers/` reads `retry-after`
 * on a 429 and drops the `Response` entirely on a 200, so no header survives as far as the
 * budget module — `call-with-budget.ts`'s `execute: () => Promise<T>` has resolved to parsed
 * data by then.
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
 * `pnpm qa` may do. It is a one-line note for whoever fixes issue #146, not a gap in this
 * check.
 */

import { test, expect } from './support/bench';
import { knownBroken } from './known-broken';

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
		knownBroken('quota-from-headers');

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

		const shown = await card.locator('.provider-card-quota').first().innerText();
		const note = await card.locator('.provider-card-quota-note').innerText();

		expect(
			shown,
			[
				`The card says "${shown.trim()}" and "${note.replace(/\s+/g, ' ').trim()}".`,
				`Agoda answered that request with x-ratelimit-requests-remaining: ${REMAINING} of ${LIMIT}.`,
				'',
				'The number on screen is cap-minus-a-localStorage-counter, so it is right only for',
				'this browser profile and only until somebody uses the key anywhere else. Where a',
				'provider reports its own count, that is the number to show.'
			].join('\n')
		).toContain(String(REMAINING));
	});
});
