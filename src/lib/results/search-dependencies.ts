/**
 * Issue #158: the one place the app assembles the `SearchDependencies` a real search runs
 * on. It used to be a three-line closure inside `routes/results/+page.svelte`, which is why
 * nothing caught that it never named a currency.
 *
 * That defect had already survived one PR that "fixed" it. #154 threaded
 * `SearchDependencies.currency` correctly through `pipeline.ts` and into the stay query in
 * `resources.ts`, and every unit test in `pipeline.test.ts` passed `currency: 'EUR'` by
 * hand, so the whole chain looked right and read right. The top of it was `undefined`:
 * Agoda was called with no `currency_id`, answered in USD (its documented default when the
 * parameter is omitted, `agoda-mapper.ts`), and `sumMoney` refused to total a USD bed
 * against EUR flights — so the single candidate that managed to price a bed was the single
 * candidate that got dropped. Pricing a bed deleted the trip.
 *
 * A closure in a component cannot be unit tested without mounting Svelte, and this repo has
 * no component test harness. A plain exported function can, which is the point of moving it
 * here: `search-dependencies.test.ts` now asserts that what a real search runs on actually
 * carries a currency, so the next omission fails a test rather than a traveller's search.
 * `provider-setup.ts` next door is the same idea for the registry.
 */

import { DEFAULT_SEARCH_CURRENCY } from '$lib/domain';
import type { IsoCurrencyCode } from '$lib/domain';
import type { SearchDependencies } from '$lib/search';
import type { ProviderKeys } from '$lib/keys';
import { getProviderRegistry } from './provider-setup';

/**
 * Assembles what `runSearch`, `widenSearch` and `widenWithPriceCalendar` all take. Called
 * once per search rather than memoised, because `keys` must be whatever the traveller has
 * saved at the moment the search starts, not at the moment the page loaded.
 *
 * `resolveAirport` is deliberately left out: `pipeline.ts` defaults it to `getAirport`
 * (`$lib/data/airports`), and passing it here would make every caller of this function pull
 * in that module's 165KB generated dataset. It is optional in the type for exactly that
 * reason — unlike `currency`, which is required, because there is no sane default a layer
 * below can invent for it and a missing one silently costs the traveller a bed.
 *
 * `savedCurrency` is the traveller's own choice from the settings screen
 * (`keyStore.currency`, saved in `localStorage` next to their keys), and `undefined` means
 * they have never picked one. It arrives as an argument rather than being read from
 * `keyStore` in here for the same reason `keys` does: this function stays a plain unit a
 * test can call without a Svelte runtime or a browser, which is the whole reason issue
 * #158 moved it out of a component closure in the first place.
 */
export function createSearchDependencies(
	keys: ProviderKeys,
	savedCurrency?: IsoCurrencyCode
): SearchDependencies {
	return {
		registry: getProviderRegistry(),
		keys,
		// The traveller's pick wins, and `DEFAULT_SEARCH_CURRENCY` is where a search lands
		// when there is no pick. Kept as a fallback here rather than as a value written into
		// storage on first load, so someone who never chose follows the app's default if it
		// ever changes, while someone who chose EUR on purpose keeps EUR.
		currency: savedCurrency ?? DEFAULT_SEARCH_CURRENCY
	};
}
