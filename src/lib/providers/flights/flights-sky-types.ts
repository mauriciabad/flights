/**
 * Raw shapes returned by `flights-sky.p.rapidapi.com` (undocumented beyond RapidAPI's own
 * marketplace page — this project is not a partner), plus the capability contract this
 * adapter adds on top of `FlightProvider` (../types.ts).
 *
 * Captured 2026-09-04 from three real, live calls (see the PR body and
 * ./fixtures/flights-sky-*.json for exactly which requests produced them). Kept separate
 * from the mapped domain shapes (flights-sky-map-offers.ts, flights-sky-map-calendar.ts) so
 * a future schema change on Flights Sky's side is caught at the mapping boundary instead of
 * an `any` leaking deeper into the adapter — same split as ryanair-types.ts.
 */

import type { IataAirportCode, IsoCalendarDate, IsoCurrencyCode, Money } from '../../domain';
import type { FlightProvider, ProviderContext, ProviderResult } from '../types';

/**
 * `auto-complete`'s one useful field per entry: the pair Flights Sky's other endpoints
 * actually key on. Confirmed identical, entity-id for entity-id, to Sky Scrapper's own
 * `searchAirport` response (docs/PROVIDERS.md; fixtures/search-airport-bcn.json has the same
 * BCN -> "95565085" mapping this adapter's own fixture does) — both RapidAPI listings proxy
 * the same underlying Skyscanner data, which is also why this adapter's deep link
 * (flights-sky-deep-link.ts) can honestly point at skyscanner.net.
 */
export interface FlightsSkyEntity {
	/** Letters-only place code, e.g. "BCN". Despite the query parameter being named
	 * `fromEntityId`/`toEntityId` on `price-calendar` and `search-one-way`, this — not
	 * `entityId` below — is the value those endpoints actually accept: a live call with the
	 * numeric `entityId` answered 400 `"SkyId can contain only letters"` (measured
	 * 2026-09-04). `entityId` is kept on this type anyway since it is real data this
	 * adapter already has for free and a future endpoint may want it. */
	skyId: string;
	/** Numeric-looking id string, e.g. "95565085". Not used as a request parameter by this
	 * adapter today — see `skyId`'s doc comment. */
	entityId: string;
}

/** One `auto-complete` result entry's shape, just enough of it to extract `FlightsSkyEntity`
 * and reject a same-named place in the wrong country (the Barcelona/Barcelona-Venezuela
 * trap docs/PROVIDERS.md and this issue both call out). */
export interface FlightsSkyAutoCompleteEntry {
	navigation?: {
		entityId?: unknown;
		relevantFlightParams?: {
			skyId?: unknown;
			entityId?: unknown;
		};
	};
}

export interface FlightsSkyAutoCompleteResponse {
	data?: FlightsSkyAutoCompleteEntry[];
	status?: boolean;
}

/** One day of `price-calendar`'s `data.flights.days` array. `price` is a bare float in
 * major units (e.g. `34.0` for  &euro;34.00) — AGENTS.md's "Money" rule, and the caution this
 * issue calls out by name (`19.99 * 100` is `1998.9999999999998` in JavaScript), is why this
 * is never used as `Money.minorUnits` directly; see flights-sky-money.ts `moneyFromMajorUnits`. */
export interface FlightsSkyCalendarDayEntry {
	day?: unknown;
	group?: unknown;
	price?: unknown;
}

export interface FlightsSkyPriceCalendarResponse {
	data?: {
		flights?: {
			groups?: { id?: unknown; label?: unknown }[];
			days?: FlightsSkyCalendarDayEntry[];
		};
	};
	/** Present on a 400 instead of `data`, e.g. `"departDate is required"` wrapped in a long
	 * Spring stack trace string — confirmed 2026-09-04 by omitting `departDate` and, once
	 * more, by passing the wrong id shape (`entityId` where `skyId` was required). Typed as
	 * `unknown` rather than parsed: this adapter only needs to know an error response is not
	 * the happy shape, not to unpick RapidAPI's proxied Spring exception text. */
	errors?: unknown;
}

/** One `search-one-way` itinerary. Structurally identical, field name for field name, to Sky
 * Scrapper's `searchFlights` itinerary shape (skyscanner-map-offers.ts) — further evidence
 * both RapidAPI listings proxy the same Skyscanner backend. */
export interface FlightsSkySearchOneWayResponse {
	data?: {
		itineraries?: unknown[];
	};
}

/**
 * The API's own cheapness banding on a calendar day (`price-calendar`'s `groups` array:
 * `low` = "$", `medium` = "$$", `high` = "$$$"). Kept as this adapter's return type rather
 * than recomputed from the gathered prices, per this issue's brief: "free ranking signal
 * and better than recomputing a threshold from prices we did not gather."
 */
export type PriceCalendarGroup = 'low' | 'medium' | 'high';

/** One priced day out of `getPriceCalendar`. */
export interface PriceCalendarDay {
	date: IsoCalendarDate;
	group: PriceCalendarGroup;
	price: Money;
}

/**
 * Input to `getPriceCalendar` — deliberately its own shape, not `FlightSearchQuery`
 * (../types.ts), because `earliestDeparture`/`latestDeparture` describe a want that
 * `search-one-way` fulfils one request per day at a time; the calendar fulfils a different
 * want ("which dates are cheap at all") that costs the same one request regardless of how
 * wide a window the caller cares about. Reusing `FlightSearchQuery` here would suggest the
 * two are interchangeable, which is exactly the conflation this issue's brief says not to
 * make ("Do NOT force it through `searchOffers` and lose that distinction").
 */
export interface PriceCalendarQuery {
	origin: IataAirportCode;
	destination: IataAirportCode;
	/**
	 * Required by the API even for the calendar endpoint — confirmed 2026-09-04, omitting
	 * it answers `{"errors":{"departDate":"departDate is required"}}`. One measurement
	 * against a real BCN-VIE query found the returned calendar started at *today* and ran a
	 * full year forward regardless of what was passed here (2026-10-15 in, 2026-09-04
	 * through 2027-09-04 out) — so this may be closer to "a hint the API mostly ignores"
	 * than a real window bound. That is one data point, not a proof it never matters for a
	 * different route or a date far outside the returned window, so it stays a required,
	 * cached-on field here rather than being dropped.
	 */
	departDate: IsoCalendarDate;
	currency?: IsoCurrencyCode;
}

/**
 * The calendar capability this issue adds on top of `FlightProvider` (../types.ts) —
 * exported as its own interface rather than a change to that shared file. `types.ts`'s own
 * header calls itself "a chokepoint six adapters and the whole pipeline get written against
 * in parallel," and AGENTS.md asks an agent whose issue depends on something not yet built
 * to "define the narrowest possible interface" rather than compete with whoever owns that
 * file next. Issue #56 (the search pipeline) can depend on this interface directly, or fold
 * it into `FlightProvider` itself later once more than one adapter has a calendar to offer —
 * that decision belongs to whoever owns `types.ts` at that point, not to this issue.
 *
 * Signature, for the PR description: `getPriceCalendar(query, ctx) =>
 * Promise<ProviderResult<PriceCalendarDay[]>>`, plus `estimatePriceCalendarCost(query) =>
 * number`, mirroring `FlightProvider.searchOffers` /`estimateSearchOffersCost`'s own shape
 * one-for-one so a caller already fluent in one reads the other for free.
 */
export interface FlightPriceCalendarProvider {
	/**
	 * Requests this call would cost, WITHOUT making one — same contract as
	 * `FlightProvider.estimateSearchOffersCost`. Always 1 (excluding the at-most-2 entity
	 * lookups, usually already cached, for the same reason that estimate excludes Sky
	 * Scrapper's airport lookups): unlike `searchOffers`, this number does not grow with how
	 * wide a date range the caller cares about, because one call already answers for about a
	 * year. That gap — 1 versus "one request per day" — is the entire reason this
	 * capability exists apart from `searchOffers`.
	 */
	estimatePriceCalendarCost(query: PriceCalendarQuery): number;
	/**
	 * Answers "which dates are cheap at all" for a route: a `PriceCalendarDay` per day the
	 * API returned a price for, each carrying the API's own `low`/`medium`/`high` banding.
	 * A fundamentally cheaper question than `searchOffers`'s "give me priced itineraries for
	 * these exact dates" — see this interface's own doc comment for why the two are kept
	 * apart rather than one adapter method trying to answer both.
	 */
	getPriceCalendar(
		query: PriceCalendarQuery,
		ctx: ProviderContext
	): Promise<ProviderResult<PriceCalendarDay[]>>;
}

/** What `createFlightsSkyFlightProvider` actually returns: a `FlightProvider` that also
 * implements the calendar capability above. */
export type FlightsSkyProvider = FlightProvider & FlightPriceCalendarProvider;

/** Duck-types a `FlightProvider` for the calendar capability, so a caller (issue #56's
 * search pipeline) can check `hasPriceCalendar(provider)` before calling `getPriceCalendar`
 * without importing this adapter module directly or maintaining its own list of which
 * provider ids happen to support it. */
export function hasPriceCalendar(provider: FlightProvider): provider is FlightsSkyProvider {
	return typeof (provider as Partial<FlightPriceCalendarProvider>).getPriceCalendar === 'function';
}
