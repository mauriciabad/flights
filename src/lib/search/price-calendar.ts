/**
 * Mid-task finding, recorded on `main` (docs/PROVIDERS.md, "Flights Sky has a price
 * calendar, and it is the reason this app is affordable"): flight cost is not two tiers, it
 * is three.
 *
 * 1. **Free.** Ryanair, the bundled route table, the build-time Travelpayouts cheap-routes
 *    data (issue #52). Zero quota, always runs — `cost-aware.ts` plus `providers/budget`.
 * 2. **Cheap and broad — this file.** A price CALENDAR: one request returns 366 contiguous
 *    days, today through exactly one year forward, for one route (Flights Sky, issue #61,
 *    verified live against a real capture: 50 requests/month). Six connection candidates
 *    over two legs is 12 requests here for a FULL YEAR of daily prices on every one of them,
 *    with quota to spare — Sky Scrapper would need 4,392 requests (one per date) for the
 *    same coverage against its 20-a-month limit.
 * 3. **Expensive and narrow.** A per-date confirmation (Skyscanner/Sky Scrapper: one request
 *    per route PER DATE, 20/month — `providers/budget`'s `estimateWidenCost`, used in
 *    `pipeline.ts` for `WidenOption`s with `tier: 'confirm'`). Spent only once the traveller
 *    has committed to one candidate and one date.
 *
 * Because tier 2 already returns the whole year in one shot, this module's job stops at
 * "fetch it and hand back everything the provider sent." A caller (`pipeline.ts`'s
 * `widenWithPriceCalendar`, and beyond it the results list / search form) must NOT re-derive
 * how many requests to spend from the user's current search date window, and must NOT
 * re-fetch when that window changes — narrowing, widening or shifting dates afterwards costs
 * zero further requests, because the full year for that route is already in hand. Caching
 * that answer hard (keyed on origin+destination, not on any date) is Flights Sky's own
 * adapter's job (`providers/flights/flights-sky.ts`, a six-hour TTL cache-aside), the same
 * way Ryanair's and Transitous's adapters already cache internally — this module trusts that
 * a second call for a route it already asked about is cheap or free at the adapter level,
 * and never adds a second cache of its own on top.
 *
 * The capability contract (`FlightPriceCalendarProvider`, `PriceCalendarQuery`,
 * `PriceCalendarDay`, `hasPriceCalendar`) is imported from Flights Sky's own adapter module,
 * not redefined here: `flights-sky-types.ts`'s own doc comment says exactly this is the
 * intended seam ("Issue #56 ... can depend on this interface directly"), kept as its own
 * interface rather than a change to `providers/types.ts` since only one adapter has it.
 * Ryanair and Skyscanner do not implement it and are never expected to.
 */

import { contextFor, isProviderUsable } from '../providers/registry';
import { hasPriceCalendar } from '../providers/flights/flights-sky-types';
import type { FlightPriceCalendarProvider, FlightsSkyProvider, PriceCalendarDay, PriceCalendarQuery } from '../providers/flights/flights-sky-types';
import type { AvailableKeys, FlightProvider, ProviderId, ProviderResult } from '../providers/types';
import type { IataAirportCode } from '../domain';
import type { WidenOption } from './types';

export { hasPriceCalendar };
export type { FlightPriceCalendarProvider, FlightsSkyProvider, PriceCalendarDay, PriceCalendarQuery };

/** Every registered flight provider that offers a price calendar — the pool both
 * `estimatePriceCalendarWidenCost` and `pipeline.ts`'s `widenWithPriceCalendar` draw from. */
export function priceCalendarProviders(providers: readonly FlightProvider[]): FlightsSkyProvider[] {
	return providers.filter(hasPriceCalendar);
}

/**
 * Tier 2 cost preview: what asking "which dates are cheap, for the whole next year" would
 * cost, per candidate, across every registered calendar-capable provider — usable or not, so
 * an unusable one (no key yet) still shows up as "add a key to widen for ~N requests"
 * (`WidenOption.requiresKey`). `queries` is typically the candidate's two legs (`origin ->
 * candidate`, `candidate -> destination`); this sums whatever is given, so a caller
 * previewing only one leg gets only that leg's cost. The cost is flat per route regardless of
 * how wide the search's own date window is — unlike tier 3, widening a ten-day search to a
 * thirty-day one does not change this number, because the underlying call already covers a
 * full year either way.
 */
export function estimatePriceCalendarWidenCost(
	providers: readonly FlightProvider[],
	keys: AvailableKeys,
	queries: readonly PriceCalendarQuery[],
	candidateAirportCode?: IataAirportCode
): WidenOption[] {
	const options: WidenOption[] = [];
	for (const provider of priceCalendarProviders(providers)) {
		const requests = queries.reduce((sum, query) => sum + provider.estimatePriceCalendarCost(query), 0);
		if (requests <= 0) continue;
		options.push({
			providerId: provider.id,
			kind: 'flight',
			tier: 'calendar',
			label: provider.label,
			candidateAirportCode,
			requests,
			requiresKey: !isProviderUsable(provider, keys)
		});
	}
	return options.sort((a, b) => a.requests - b.requests || a.providerId.localeCompare(b.providerId));
}

/** One calendar call's outcome, tagged with which candidate/leg/provider it answers for —
 * `pipeline.ts`'s `widenWithPriceCalendar` yields these progressively. Carries the full
 * `ProviderResult`, failures included, rather than silently dropping them: "one provider
 * failing must never fail a search" applies here too, and a caller deciding where to spend
 * tier 3 needs to know a calendar call came back empty because of an error, not because the
 * route is simply not served. */
export interface PriceCalendarOutcome {
	candidateAirportCode: IataAirportCode;
	leg: 'outbound' | 'onward';
	providerId: ProviderId;
	result: ProviderResult<PriceCalendarDay[]>;
}

/**
 * Spends tier 2, for real — one calendar call per candidate per leg (each returning a full
 * year of daily prices, not a query-shaped subset — see the module doc comment), gated by an
 * explicit, caller-confirmed `maxMeteredRequests` ceiling, same non-negotiable rule as tier
 * 3's `WidenRequest` in `types.ts`. Processes candidate/leg/provider combinations one at a
 * time (never `Promise.all`) so `budget.remaining` is checked and decremented from real spend
 * before the next call ever starts — a concurrent race here could spend more than the
 * traveller agreed to, which is exactly the silent overspend this whole pipeline exists to
 * prevent (see `cost-aware.ts`'s `pickMeteredWithinBudget` for the same argument applied to
 * tier 3).
 *
 * Called once per candidate route is the intended usage for the lifetime of that route in a
 * session: because a successful result already covers the next 366 days, a caller (issue
 * #16/#23) that later narrows, widens or shifts the traveller's date window should hold onto
 * the returned `PriceCalendarDay[]` and re-filter it in memory, never call this again for the
 * same candidate just because the window changed. Calling it again anyway is not incorrect —
 * the adapter is expected to cache the route hard and answer for free or near-free — but
 * relying on that is a fallback, not the design.
 *
 * No `SourceTracker`/status map here, unlike `runSearch`/`widenSearch`: each yielded
 * `PriceCalendarOutcome` already carries its own full `ProviderResult`, source and all, so a
 * caller wanting an aggregate view can fold over the stream itself rather than this function
 * threading bookkeeping it has no other use for.
 */
export async function* runPriceCalendarWiden(
	candidateAirportCodes: readonly IataAirportCode[],
	legQueriesFor: (candidateAirportCode: IataAirportCode) => { outbound: PriceCalendarQuery; onward: PriceCalendarQuery },
	providers: readonly FlightProvider[],
	keys: AvailableKeys,
	signal: AbortSignal,
	maxMeteredRequests: number
): AsyncGenerator<PriceCalendarOutcome, void, void> {
	const usable = priceCalendarProviders(providers).filter((provider) => isProviderUsable(provider, keys));
	const budget = { remaining: Math.max(0, maxMeteredRequests) };

	for (const candidateAirportCode of candidateAirportCodes) {
		const legs = legQueriesFor(candidateAirportCode);
		for (const leg of ['outbound', 'onward'] as const) {
			const query = legs[leg];
			for (const provider of usable) {
				if (signal.aborted || budget.remaining <= 0) return;

				const ctx = contextFor(provider.id, keys, signal, budget.remaining);
				const result = await provider.getPriceCalendar(query, ctx);
				budget.remaining -= result.requestsUsed;
				yield { candidateAirportCode, leg, providerId: provider.id, result };
			}
		}
	}
}
