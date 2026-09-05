/**
 * Reading the results screen the way a person reads it.
 *
 * Every locator here is derived from what is actually rendered — `.result-card`,
 * `.freshness-badge`, `.provenance` — because the app has no test ids and adding them would
 * be a production change in a QA-only PR. If a selector here stops matching, the screen
 * changed, which is a thing worth being told about rather than a thing to route around.
 *
 * The one exception is `data-search-phase`, which issue #337 added to the results page for
 * these suites to wait on. It is there because no rendered thing could answer the question:
 * the screen says "still searching" or nothing, and "nothing" covers both a search that has
 * not begun and one that has ended.
 */

import { expect, type Locator, type Page } from '@playwright/test';
import { waitForSearchToSettle as settle } from '../../shared/search-wait';

/** Live keyless providers are far slower than a recording — a real Ryanair round trip per
 * leg per candidate, and OSRM throttles itself on top. Measured at just over 45s on a
 * warm connection, so recorded runs keep the tight bound and live runs get room. */
const SEARCH_TIMEOUT_MS = process.env.QA_LIVE === '1' ? 180_000 : 45_000;

/**
 * Blocks until the results page says its search has settled. Issue #337.
 *
 * This used to wait for the words "still searching" to be absent, which a page that has
 * not started searching satisfies just as well as one that has finished. It happened to
 * hold on this bench — measured six times, the indicator was already up before `goto`
 * returned and no provider request arrived after the wait — but nothing enforced that,
 * and the e2e suite is where the same assertion lands on the wrong side of the race.
 * `budget.ts` is the owner's money, so it does not get to depend on luck.
 *
 * A thin wrapper over the shared helper, only to carry the live-versus-recorded bound.
 */
export async function waitForSearchToSettle(page: Page, timeout = SEARCH_TIMEOUT_MS): Promise<void> {
	await settle(page, { timeout });
}

export function resultCards(page: Page): Locator {
	return page.locator('.result-card');
}

/** Everything the results list says, as one string — the input to the currency and marker
 * scans, which care about what a person can read rather than about which element holds it. */
export async function resultsText(page: Page): Promise<string> {
	const cards = await resultCards(page).allInnerTexts();
	return cards.join('\n');
}

/**
 * Currency symbols `Intl.NumberFormat('en-US', { style: 'currency' })` produces for the
 * currencies this app can plausibly be quoted in — `results/format.ts`'s `formatMoney` is
 * the only thing that turns a `Money` into text, so this is the full set of shapes a price
 * can take on screen.
 *
 * Matched next to a digit so a bare "$" in prose, or a "€" in a placeholder, is not counted
 * as a price.
 */
const PRICE_PATTERN = /(?:(€|\$|£|¥|₹|₩|zł|Kč|kr|CHF|R\$)\s?[\d,.]+|[\d,.]+\s?(zł|Kč|kr))/g;

const SYMBOL_TO_CURRENCY: Readonly<Record<string, string>> = {
	'€': 'EUR',
	$: 'USD or another dollar',
	'£': 'GBP',
	'¥': 'JPY or CNY',
	'₹': 'INR',
	'₩': 'KRW',
	zł: 'PLN',
	'Kč': 'CZK',
	kr: 'a Nordic krone',
	CHF: 'CHF',
	R$: 'BRL'
};

/** Every distinct currency a block of rendered text quotes a price in. */
export function currenciesIn(text: string): string[] {
	const found = new Set<string>();
	for (const match of text.matchAll(PRICE_PATTERN)) {
		const symbol = match[1] ?? match[2];
		if (symbol) found.add(SYMBOL_TO_CURRENCY[symbol] ?? symbol);
	}
	return [...found];
}

/** The age the card claims for its own numbers — `ResultCard.svelte`'s `.provenance`
 * footer, "via Ryanair · fetched 6 minutes ago". Returns the text, not a parsed duration,
 * so a failure message can quote what the screen said. */
export async function provenanceLines(page: Page): Promise<string[]> {
	return resultCards(page).locator('.provenance').allInnerTexts();
}


