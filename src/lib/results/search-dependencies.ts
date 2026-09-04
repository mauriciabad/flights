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
 */
export function createSearchDependencies(keys: ProviderKeys): SearchDependencies {
	return {
		registry: getProviderRegistry(),
		keys,
		currency: DEFAULT_SEARCH_CURRENCY
	};
}
