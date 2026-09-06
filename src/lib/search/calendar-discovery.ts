/**
 * Issue #124: last-resort connection-candidate discovery through a calendar-capable flight
 * provider (Flights Sky, `providers/flights/flights-sky.ts`), for a route no free source
 * knows anything about.
 *
 * Measured live for the route this issue exists to fix — BVC -> PFO (Boa Vista, Cabo Verde
 * -> Pafos, Cyprus): Ryanair does not serve Cabo Verde at all, and the Travelpayouts
 * cheap-routes dataset (issue #52, expanded to 46 origins including BVC) has exactly one
 * cached outbound fare from BVC (to RAI, a neighbouring Cape Verde island) and zero cached
 * fares landing at PFO from any of its 46 origins. `algorithm/connections.ts`'s
 * `findConnectionCandidates` is honest about that: it returns nothing, because none of its
 * free sources have an edge to build on, for either leg. No amount of pricing improves a
 * candidate list that is empty.
 *
 * The price calendar cannot fill that gap the way a route-graph source does — it answers
 * "is there a price for this ONE route pair," never "list every destination from X," so it
 * cannot replace `findConnectionCandidates`'s own discovery. What it can do is confirm a
 * SMALL, explicit pool of candidate stopover airports one at a time. Probing broadly would
 * burn real quota fast — one calendar call per direction per candidate,
 * `docs/PROVIDERS.md`'s own arithmetic — so this pool is deliberately short and stops at the
 * first candidate that clears both legs, rather than ranking every survivor the way
 * `findConnectionCandidates` does for its own, free, discovery.
 *
 * `connections-fallback-data.ts`'s bundled hub list is NOT reused here on purpose: it is
 * explicitly a snapshot of "short-haul, LOW-COST routes" (its own doc comment), and this
 * module exists precisely for routes a low-cost carrier's own network doesn't reach — Boa
 * Vista's real connections are leisure-charter routes (the owner's own manual research
 * found BVC -> LGW), not Ryanair-shaped ones. `CALENDAR_DISCOVERY_HUB_POOL` below is a
 * second, deliberately different curated list of major full-service and leisure-charter
 * gateways for that reason, not a duplicate of the low-cost one.
 */

import type { ConnectionAirportInfo, ConnectionCandidate } from '../algorithm/connections';
import type { FlightOffer, IataAirportCode, IsoCalendarDate, IsoCountryCode, IsoCurrencyCode } from '../domain';
import { isQuotaGenerous } from '../providers/budget';
import { contextFor, isProviderUsable } from '../providers/registry';
import type { AvailableKeys, FlightProvider, FlightSearchQuery } from '../providers/types';
import { priceCalendarProviders } from './price-calendar';
import type { FlightsSkyProvider, PriceCalendarDay, PriceCalendarQuery } from './price-calendar';
import type { RecordProviderCall, SourceTracker } from './provenance';

/**
 * Major full-service and leisure-charter European gateways, chosen specifically to avoid
 * the low-cost-carrier bias `connections-fallback-data.ts`'s bundled table carries by
 * design (see this module's own doc comment). Not exhaustive, not ranked by anything more
 * rigorous than "well known to have broad long-haul and charter connectivity" — the same
 * honest limitation `algorithm/connections.ts`'s own `SIZE_CLASS_SCORES` comment already
 * accepts for its size-class signal: a genuine "which airports are good stopovers" dataset
 * does not exist anywhere in this codebase, and a short hand-picked list is what makes this
 * tier affordable at all rather than a claim that these six are provably the best six.
 */
export const CALENDAR_DISCOVERY_HUB_POOL: readonly IataAirportCode[] = ['LGW', 'LHR', 'MAD', 'CDG', 'AMS', 'FRA'];

/**
 * Hard ceiling on how many candidate airports one `discoverCandidateViaCalendar` call will
 * probe, regardless of pool size — each probed hub costs at least one calendar call
 * (outbound leg), and up to four (both legs' calendars plus both legs' single-date
 * confirmations) if it turns out to be viable. Bounding this keeps one search's worst case
 * (every hub probed, none of them viable) a small, predictable slice of Flights Sky's own
 * monthly cap (`providers/budget/caps.ts`'s `DEFAULT_PROVIDER_CAPS['flights-sky']`, 40),
 * never the whole thing.
 */
export const MAX_CALENDAR_DISCOVERY_HUBS = 6;

/** One day's calendar entry, narrowed to what `pickCalendarDateInWindow` needs — kept
 * generic over the exact `PriceCalendarDay` import so a test fixture doesn't have to
 * construct a fully-typed one just to exercise the date-picking logic. */
interface CalendarDayLike {
	date: IsoCalendarDate;
	group: PriceCalendarDay['group'];
	price: { minorUnits: number };
}

/**
 * Picks the day this module should confirm with a real, narrowed `searchOffers` call: the
 * cheapest day the API's own `low` banding flags within the caller's date window, or —
 * absent any `low` day in range — simply the cheapest day in range at all. Returns
 * `undefined` when the calendar has no entry inside `[earliest, latest]`, which this
 * module treats as "not confirmed for these dates," never as licence to pick a date outside
 * what the traveller actually asked for (AGENTS.md: "say what you do not know rather than
 * guessing"). String comparison is safe here because every date is `YYYY-MM-DD`
 * (`IsoCalendarDate`), which sorts lexically the same as chronologically.
 */
export function pickCalendarDateInWindow(
	days: readonly CalendarDayLike[],
	earliestDeparture: IsoCalendarDate,
	latestDeparture: IsoCalendarDate
): IsoCalendarDate | undefined {
	const inWindow = days.filter((day) => day.date >= earliestDeparture && day.date <= latestDeparture);
	if (inWindow.length === 0) return undefined;
	const low = inWindow.filter((day) => day.group === 'low');
	const pool = low.length > 0 ? low : inWindow;
	return [...pool].sort((a, b) => a.price.minorUnits - b.price.minorUnits)[0].date;
}

interface LegQueryOptions {
	currency?: IsoCurrencyCode;
	travellers?: number;
}

/**
 * One leg's worth of "does Flights Sky know a real, bookable flight for this pair, on a
 * date within this window" — the same two-step arithmetic the issue's brief describes:
 * a calendar call (cost 1, `isQuotaGenerous` clears it against Flights Sky's 40-request
 * cap with room to spare) to find a candidate date, then, only if one exists, a
 * `searchOffers` call NARROWED to exactly that one date. That narrowing is what keeps the
 * confirm call itself `isQuotaGenerous` too — a whole-window `searchOffers` call costs one
 * request per day in it (flights-sky.ts's own `estimateSearchOffersCost`) and would fail
 * that same check for anything wider than a single day, which is exactly why this never
 * asks for more than one.
 *
 * Never throws and never returns a partial/fabricated offer: any failure at either step
 * (no key, quota exhausted, a network error, no day in range, or a confirm call that comes
 * back empty because the calendar's own price didn't correspond to a bookable direct
 * fare) degrades to `[]`, the same "one provider failing must never fail a search" contract
 * every other call in this pipeline follows.
 */
export async function calendarConfirmedOffers(
	provider: FlightsSkyProvider,
	origin: IataAirportCode,
	destination: IataAirportCode,
	earliestDeparture: IsoCalendarDate,
	latestDeparture: IsoCalendarDate,
	options: LegQueryOptions,
	keys: AvailableKeys,
	signal: AbortSignal,
	sources: SourceTracker,
	record: RecordProviderCall
): Promise<FlightOffer[]> {
	if (signal.aborted) return [];

	const calendarQuery: PriceCalendarQuery = { origin, destination, departDate: earliestDeparture, currency: options.currency };
	if (!isQuotaGenerous(provider.id, provider.estimatePriceCalendarCost(calendarQuery))) return [];

	const calendarResult = await provider.getPriceCalendar(calendarQuery, contextFor(provider.id, keys, signal));
	record(provider, calendarResult);
	if (!calendarResult.ok) return [];

	const date = pickCalendarDateInWindow(calendarResult.data, earliestDeparture, latestDeparture);
	if (date === undefined) return [];

	if (signal.aborted) return [];

	const confirmQuery: FlightSearchQuery = {
		origin,
		destination,
		earliestDeparture: date,
		latestDeparture: date,
		travellers: options.travellers,
		currency: options.currency
	};
	const confirmCost = provider.estimateSearchOffersCost(confirmQuery);
	if (!isQuotaGenerous(provider.id, confirmCost)) return [];

	const confirmResult = await provider.searchOffers(confirmQuery, contextFor(provider.id, keys, signal, confirmCost));
	record(provider, confirmResult);
	if (!confirmResult.ok) return [];

	for (const offer of confirmResult.data) sources.attach(offer, confirmResult.source);
	return confirmResult.data;
}

/**
 * Cheap, one-call sanity check on the whole origin-to-destination pair before spending
 * anything on individual candidate hubs — the issue's own "pricing the origin-to-
 * destination baseline." A `false` here means Flights Sky's own aggregated search has
 * nothing at all for this pair over the next year, which makes probing `hubs` below very
 * unlikely to pay off (whatever real-world connection exists, if any, isn't one Flights
 * Sky's backend can see), so skipping the rest saves real quota on a search that was very
 * unlikely to succeed. A `true` is not a promise any specific stopover works — only that
 * Flights Sky knows some way to price this pair at all.
 */
async function hasCalendarBaselinePrice(
	provider: FlightsSkyProvider,
	origin: IataAirportCode,
	destination: IataAirportCode,
	departDate: IsoCalendarDate,
	currency: IsoCurrencyCode | undefined,
	keys: AvailableKeys,
	signal: AbortSignal,
	record: RecordProviderCall
): Promise<boolean> {
	const query: PriceCalendarQuery = { origin, destination, departDate, currency };
	if (!isQuotaGenerous(provider.id, provider.estimatePriceCalendarCost(query))) return false;
	const result = await provider.getPriceCalendar(query, contextFor(provider.id, keys, signal));
	record(provider, result);
	return result.ok && result.data.length > 0;
}

export interface CalendarDiscoveryWindow {
	earliestDeparture: IsoCalendarDate;
	latestDeparture: IsoCalendarDate;
}

export interface CalendarDiscoveryInput {
	originAirport: IataAirportCode;
	destinationAirport: IataAirportCode;
	/** Same window `pipeline.ts`'s own `outboundLegQuery` derives for a real candidate. */
	outboundWindow: CalendarDiscoveryWindow;
	/** Same window `pipeline.ts`'s own `onwardLegQuery` derives for a real candidate. */
	onwardWindow: CalendarDiscoveryWindow;
	forbiddenConnectionAirports?: readonly IataAirportCode[];
	forbiddenConnectionCountries?: readonly IsoCountryCode[];
	/**
	 * When given (`SearchQuery.allowedConnectionAirports`, issue #12's explicit via-list),
	 * this is the ENTIRE probe pool, replacing `CALENDAR_DISCOVERY_HUB_POOL`, and the
	 * baseline check is skipped: a traveller who named a specific stopover already believes
	 * it works, and this module trusts that the same way pasting a key already counts as
	 * consent to spend it (this issue's own "Pasting a key is the consent" reasoning,
	 * applied to an explicit airport choice instead of a key).
	 */
	allowedConnectionAirports?: readonly IataAirportCode[];
	resolveAirportInfo: (code: IataAirportCode) => Promise<ConnectionAirportInfo | undefined>;
	/** Every registered flight provider — filtered down to calendar-capable, usable ones
	 * internally, same convention as `cost-aware.ts`'s helpers. */
	flightProviders: readonly FlightProvider[];
	keys: AvailableKeys;
	signal: AbortSignal;
	currency?: IsoCurrencyCode;
	travellers?: number;
	sources: SourceTracker;
	record: RecordProviderCall;
}

export interface CalendarDiscoveredCandidate {
	candidate: ConnectionCandidate;
	outboundOffers: FlightOffer[];
	onwardOffers: FlightOffer[];
}

/**
 * The whole discovery attempt: pick a pool (the caller's explicit allow-list, or the
 * bundled hub list), optionally gate it behind the origin-to-destination baseline check,
 * then probe hubs in order until one clears both legs (calendar + narrowed confirm) or the
 * pool/`MAX_CALENDAR_DISCOVERY_HUBS` is exhausted. Returns `undefined` — never throws — for
 * every way this can fail to find anything: no calendar-capable provider is usable (no key
 * configured), the baseline check came back empty, or every probed hub failed one of its
 * two legs. `pipeline.ts` treats that exactly like `findConnectionCandidates` returning
 * `[]`: a real "nothing found," not an error.
 */
export async function discoverCandidateViaCalendar(
	input: CalendarDiscoveryInput
): Promise<CalendarDiscoveredCandidate | undefined> {
	const providers = priceCalendarProviders(input.flightProviders).filter((provider) => isProviderUsable(provider, input.keys));
	if (providers.length === 0) return undefined;

	const explicitPool = input.allowedConnectionAirports && input.allowedConnectionAirports.length > 0;
	const pool = explicitPool ? input.allowedConnectionAirports! : CALENDAR_DISCOVERY_HUB_POOL;

	const legOptions: LegQueryOptions = { currency: input.currency, travellers: input.travellers };

	if (!explicitPool) {
		const baselineConfirmed = (
			await Promise.all(
				providers.map((provider) =>
					hasCalendarBaselinePrice(
						provider,
						input.originAirport,
						input.destinationAirport,
						input.outboundWindow.earliestDeparture,
						input.currency,
						input.keys,
						input.signal,
						input.record
					)
				)
			)
		).some(Boolean);
		if (!baselineConfirmed || input.signal.aborted) return undefined;
	}

	const forbiddenAirports = new Set(input.forbiddenConnectionAirports ?? []);
	const forbiddenCountries = new Set(input.forbiddenConnectionCountries ?? []);

	let probed = 0;
	for (const hub of pool) {
		if (input.signal.aborted) return undefined;
		if (probed >= MAX_CALENDAR_DISCOVERY_HUBS) break;
		if (hub === input.originAirport || hub === input.destinationAirport) continue;
		if (forbiddenAirports.has(hub)) continue;

		if (forbiddenCountries.size > 0) {
			const hubGeo = await input.resolveAirportInfo(hub);
			// Fail closed, same rule `algorithm/connections.ts` applies to its own
			// discovery: a hub whose country can't be resolved can't be cleared against
			// the forbidden list either, so it's skipped rather than risked.
			if (!hubGeo || forbiddenCountries.has(hubGeo.countryCode)) continue;
		}

		probed += 1;

		for (const provider of providers) {
			const outboundOffers = await calendarConfirmedOffers(
				provider,
				input.originAirport,
				hub,
				input.outboundWindow.earliestDeparture,
				input.outboundWindow.latestDeparture,
				legOptions,
				input.keys,
				input.signal,
				input.sources,
				input.record
			);
			if (outboundOffers.length === 0) continue;

			const onwardOffers = await calendarConfirmedOffers(
				provider,
				hub,
				input.destinationAirport,
				input.onwardWindow.earliestDeparture,
				input.onwardWindow.latestDeparture,
				legOptions,
				input.keys,
				input.signal,
				input.sources,
				input.record
			);
			if (onwardOffers.length === 0) continue;

			return {
				candidate: {
					airportCode: hub,
					// No free ranking signal produced any of this — every other candidate's
					// score comes from size, detour and balance computed over free data
					// (algorithm/connections.ts's scoreCandidate). Scoring this 0 rather than
					// inventing a number is the same "say what you do not know" rule; it never
					// competes with a real-discovery candidate because this path only ever
					// runs when there are none.
					score: 0,
					breakdown: { sizeClass: 0, detour: null, balance: null },
					confirmedBy: { outbound: provider.id, inbound: provider.id },
					meteredRequestSpent: true
				},
				outboundOffers,
				onwardOffers
			};
		}
	}

	return undefined;
}
