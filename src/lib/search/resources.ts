/**
 * Gathers the bed and the transfers a candidate connection needs before `build.ts` can turn
 * it into an `Itinerary` — issue #56's algorithm steps 3-4: "Fetch stays near each
 * connection" and "Fetch transfers for all four legs."
 *
 * `algorithm/build.ts`'s `ConnectionResources` takes exactly one `Stay` and exactly one
 * `Transfer` per leg, even though a `StayProvider`/`TransferProvider` call can return many
 * (one property can offer both a dorm and a private room; one transfer query can return both
 * `walk` and `transit`). Picking one representative of each is this module's job — `build.ts`
 * itself is explicit that this choice happens upstream of it ("a connection with no entry
 * here simply never produces an itinerary"), not something it decides.
 *
 * Issue #80: the one `Stay` picked here has to be one the party can actually book, not
 * merely the cheapest one a provider happened to return — a `female-dorm` a group has no
 * female travellers for is not a cheaper option, it is a wrong total. `fetchCheapestStay`
 * filters by `stays/female-dorm-fit.ts` (issue #27's own rule, reused rather than
 * re-derived) before ranking, and `fetchConnectionResources` keeps every candidate found
 * alongside the pick (`ConnectionResourcesWithStayCandidates.stayCandidates`) so a caller
 * still has real alternatives to offer once a stay picker is wired up, instead of only this
 * pipeline's already-decided choice.
 *
 * Issue #114: `fetchBestTransfer` had the same problem `fetchCheapestStay` had before issue
 * #80 fixed it — it merged every mode a provider returned (walk, transit, drive, taxi) and
 * then threw all but one away, leaving `TransportPicker` wired to an always-empty
 * `alternatives` list. `fetchBestTransfer` now returns a `TransferSearchOutcome`
 * (candidates and pick, same shape as `StaySearchOutcome`), `ConnectionResourcesWithStayCandidates`
 * carries both connection-side legs' candidate lists and OSRM taxi fare estimates, and
 * `pipeline.ts` carries the origin/destination legs' equivalents in every `SearchSnapshot`.
 * None of this issues one additional provider request: it only stops discarding what the
 * same calls already returned (see `TransferSearchOutcome` and `estimateTaxiFareForLeg`'s own
 * doc comments for exactly how).
 */

import { contextFor, isProviderUsable } from '../providers/registry';
import { runCostAwareSearch } from '../providers/budget';
import type {
	AvailableKeys,
	ProviderResult,
	StayProvider,
	StaySearchQuery,
	TransferProvider,
	TransferSearchQuery
} from '../providers/types';
import type {
	AirportSizeClass,
	Coordinates,
	Duration,
	IsoCalendarDate,
	IsoCountryCode,
	IsoCurrencyCode,
	LandingToTransportRule,
	Stay,
	Transfer,
	TransferMode
} from '../domain';
import type { ConnectionResources, TransferAnchor } from '../algorithm/build';
import { femaleDormFit, isFemaleDormSelectable } from '../stays/female-dorm-fit';
import { getTaxiFareEstimate, OSRM_PROVIDER_ID } from '../providers/transfers/osrm';
import type { TaxiFareEstimate } from '../providers/transfers/taxi-rate-table';
import { claimAutoWidenStaySources, flattenOk, stayCostAwareSources } from './cost-aware';
import type { StayLookupBudget } from '../providers/budget';
import type { RecordProviderCall, SourceTracker } from './provenance';

/** Brief line 76: "cheapest hotels/hostels for each connection within 100km." */
export const DEFAULT_STAY_RADIUS_KM = 100;

/**
 * Every `Stay` this candidate's usable providers returned, cheapest first, so a caller can
 * fall back to the next-cheapest if the top pick turns out to be unavailable — `build.ts`
 * itself only ever consumes the first one (`ConnectionResources.stay` is singular), but
 * picking "which stay a traveller might actually book instead" (brief line 65: "user can
 * select to update total") is a UI concern this module hands the option list to rather than
 * decides.
 *
 * Compares raw minor units with no currency conversion, which is safe only because
 * `fetchCheapestStay` has already dropped every stay not quoted in the search's own
 * currency before calling this. That filter is what makes the comparison meaningful —
 * issue #152: this function's previous comment claimed a mismatch "would already be a
 * degraded result by the time it reaches sorting", which was the assumption that hid the
 * bug. Nothing asked providers for a currency at all, so mismatches were the normal case
 * and sorting them by bare minor units ranked 2000 USD below 2200 EUR.
 */
export function rankStaysByPrice(stays: readonly Stay[]): Stay[] {
	return [...stays].sort((a, b) => a.pricePerNight.minorUnits - b.pricePerNight.minorUnits);
}

/**
 * Whether this `Stay` can be booked as the whole party's one stay — issue #80. Every
 * non-`female-dorm` room kind always qualifies; a `female-dorm` goes through
 * `stays/female-dorm-fit.ts`'s rule, built for issue #27's picker and reused here rather
 * than re-derived, so the pipeline and the picker can never disagree about what counts as
 * bookable. A zero-female group excludes it outright, and so does a mixed group — `Stay`
 * is priced as one flat per-night figure for the whole party, and there is no way to book
 * a female-only dorm for 1 of 4 travellers as "the" stay without inventing a formula
 * nobody asked for, the same call #27's picker already made and documents in its own UI.
 */
function isStaySelectable(stay: Stay, travellers: number | undefined, females: number | undefined): boolean {
	if (stay.roomKind !== 'female-dorm') return true;
	return isFemaleDormSelectable(femaleDormFit(travellers, females));
}

/** Preference order when more than one `Transfer` mode is on offer for the same A-to-B:
 * real public transport first (what this app's traveller actually wants to know exists —
 * docs/PROVIDERS.md: Transitous "answers the question ordinary flight search cannot"),
 * then walking (free, always available if the distance allows it), then paid options. */
const TRANSFER_MODE_PREFERENCE: readonly TransferMode[] = ['transit', 'walk', 'taxi', 'drive'];

/**
 * Issue #119, the owner's own words: **"'Walk 11h 42m' WTF dont even show this, walk is
 * not an option in this case."** He was right, and nothing here had ever asked whether a
 * walking duration was plausible before ranking it — `TRANSFER_MODE_PREFERENCE` above puts
 * walking second, so an eleven-hour walk beat a taxi that took forty minutes.
 *
 * 45 minutes, and the number is arguable, so here is the argument. OSRM's foot profile
 * runs about 4.5 km/h (measured directly, see `providers/transfers/osrm.ts`'s header), so
 * this is roughly 3.4 km — a walk somebody who has just dragged a suitcase off a flight
 * might still choose, and past which they will not. It also has to leave the short walks
 * alone, because a 12-minute walk genuinely beats waiting for a bus, and this cap does:
 * `TransportPicker` already treats a wait under 20 minutes as one you would have had
 * anyway, so a typical airport hop of "wait 20, ride 15" is 35 minutes end to end and any
 * walk that beats it survives this filter with room to spare.
 *
 * A single named constant rather than a `SearchQuery` field, deliberately. The brief's
 * editable waiting time is a preference this app has no grounds to overrule. A twelve-hour
 * walk is not a preference — it is the router answering a question nobody asked, and the
 * leg degrades to "no transfer found", which every caller here already handles.
 *
 * Driving and taxi are left uncapped on purpose. Issue #119 says the same reasoning
 * applies to an absurd driving duration and it does, but a road cap needs its own argument
 * about ferry links and routing artefacts, and it belongs with the rest of that issue.
 */
export const MAX_PLAUSIBLE_WALK_MINUTES = 45 as Duration;

/**
 * Whether this transfer is worth putting in front of a traveller at all.
 *
 * Applied to a provider's own answer, before `applyLandingBuffer` runs, and never after —
 * that buffer is the time it takes to get out of the terminal, not time spent walking, so
 * measuring a padded duration against a walking cap would drop a 40-minute walk for the
 * sin of following a landing at a large airport.
 */
export function isPlausibleTransfer(transfer: Transfer): boolean {
	return transfer.mode !== 'walk' || transfer.duration <= MAX_PLAUSIBLE_WALK_MINUTES;
}

/** Picks one `Transfer` to represent an A-to-B leg out of everything usable providers
 * returned, by mode preference and then by shortest duration within the same mode. Pure
 * ranking: `fetchBestTransfer` has already dropped whatever `isPlausibleTransfer` rejects,
 * and this runs on landing-buffered lists too, where re-applying that cap would be wrong. */
export function pickBestTransfer(transfers: readonly Transfer[]): Transfer | undefined {
	if (transfers.length === 0) return undefined;
	return [...transfers].sort((a, b) => {
		const modeRank = TRANSFER_MODE_PREFERENCE.indexOf(a.mode) - TRANSFER_MODE_PREFERENCE.indexOf(b.mode);
		return modeRank !== 0 ? modeRank : a.duration - b.duration;
	})[0];
}

/**
 * Brief line 39, second half: "landing to transport time, usually 15min or 30min depending
 * on the airport size" — a field `SearchQuery.landingToTransportRules` and
 * `domain/waiting-time.ts`'s `LandingToTransportRule` already model, but that neither
 * `algorithm/connections.ts` nor `algorithm/build.ts` reads: both were built and merged
 * before this pipeline existed to supply the transfer data those rules apply to. This is the
 * one place in the merged codebase where a real, provider-fetched transfer duration and this
 * rule table meet, so applying the buffer happens here rather than being silently dropped.
 *
 * Same "most specific rule wins" logic as `build.ts`'s own (unexported) `pickWaitingTime`,
 * minus that function's flight-length axis — `LandingToTransportRule` only ever matches on
 * `airportSize`.
 */
export function pickLandingToTransportTime(
	rules: readonly LandingToTransportRule[],
	airportSize: AirportSizeClass
): Duration {
	let best: LandingToTransportRule | undefined;
	for (const rule of rules) {
		if (rule.airportSize !== undefined && rule.airportSize !== airportSize) continue;
		// A rule naming this airport size is strictly more specific than a catch-all
		// (`airportSize === undefined`); among equally-specific rules the later one in the
		// list wins, matching how `DEFAULT_LANDING_TO_TRANSPORT_RULES` reads as "flat
		// default, then an override for large airports" without requiring rules to be
		// pre-sorted.
		if (!best || rule.airportSize !== undefined || best.airportSize === undefined) best = rule;
	}
	return best?.time ?? (0 as Duration);
}

/**
 * Only ever applied to a transfer that starts right after a flight lands
 * (`transferToHotel`, `transferToDestinationLocation`) — never to one that ends at a
 * departure (`transferToConnectionAirport`, `transferToOriginAirport`), which is already
 * covered by `build.ts`'s own pre-boarding waiting-time buffer and would double-count the
 * same minutes if this were applied there too.
 *
 * Re-tags the adjusted object with the original's provenance in `sources`: the returned
 * value is a new object (this never mutates a provider's own `Transfer`), so without
 * re-tagging, `sourceFor` would report "unknown" for a value that really did come from a
 * specific provider, just with its duration padded afterward.
 */
export function applyLandingBuffer(transfer: Transfer, buffer: Duration, sources: SourceTracker): Transfer {
	if (buffer <= 0) return transfer;
	const adjusted: Transfer = { ...transfer, duration: (transfer.duration + buffer) as Duration };
	const source = sources.sourceFor(transfer);
	if (source) sources.attach(adjusted, source);
	return adjusted;
}

/**
 * Issue #114: `fetchBestTransfer`'s full answer, not just its pick — mirrors
 * `StaySearchOutcome` below (issue #80's pattern applied to transfers instead of stays).
 * `candidates` is every `Transfer` any usable provider returned for this A-to-B (walk,
 * transit, drive, taxi — whatever the providers queried actually cover), which is exactly
 * what a `TransportPicker` needs as its `alternatives`; `pickBestTransfer(candidates)` is
 * still `build.ts`'s own single pick, unchanged.
 *
 * This used to say "there is no eligibility filter to apply here — every transfer found is
 * equally offerable to the traveller", which held right up until OSRM answered an airport
 * run with an 11h 42m walk (issue #119). `candidates` is what `isPlausibleTransfer` left.
 */
export interface TransferSearchOutcome {
	candidates: Transfer[];
	selected: Transfer | undefined;
	/** Issue #135: every provider's untouched answer for this leg, in call order, so a
	 * caller can tell "asked, and there is no service here" from "never asked" for THIS leg
	 * rather than only for the whole search. `SearchSnapshot.providers` already answers the
	 * search-wide version of that question (issue #130), and it cannot: one Transitous call
	 * covering Barcelona and another covering Bucharest collapse into one provider row that
	 * reads "answered". */
	results: ProviderResult<Transfer[]>[];
}

/**
 * The modes that do not depend on what time it is. A walking or driving duration is the
 * same at 04:00 as at 13:00, so these can be fetched before any flight is known; a
 * timetable cannot (issue #135), which is why the pipeline's pre-flight transfer lookups
 * ask for exactly these and leave `'transit'` to `search/transit-schedule.ts`, once there
 * is a real journey moment to plan for.
 */
export const ROAD_TRANSFER_MODES: readonly TransferMode[] = ['walk', 'drive', 'taxi'];

/** Queries every given (already usability-filtered) transfer provider for one A-to-B leg,
 * merges what comes back, tags each with its provenance, and returns both every candidate
 * found and the one representative `build.ts` builds with — the shared implementation
 * behind both the per-connection legs below and the origin/destination legs `pipeline.ts`
 * fetches once per search. Issues exactly the same provider calls as before this candidate
 * list existed (issue #114: "no increase in provider requests") — this only changes what the
 * merged results are handed back as. */
export async function fetchBestTransfer(
	query: TransferSearchQuery,
	providers: readonly TransferProvider[],
	keys: AvailableKeys,
	signal: AbortSignal,
	sources: SourceTracker,
	record: RecordProviderCall
): Promise<TransferSearchOutcome> {
	// Issue #135: an adapter with nothing to contribute is left out of the call, not called
	// and then ignored. Calling it returns an empty, `ok`, zero-request result that issue
	// #130's status machinery cannot tell from "asked, and there is no service here" — so
	// asking Transitous for a walking duration would have put "Transitous: nothing found"
	// on screen for every leg, which is the same lie #130 exists to stop, pointed the other
	// way.
	const usable = providers.filter(
		(provider) => isProviderUsable(provider, keys) && servesAnyRequestedMode(provider, query.modes)
	);
	const results = await Promise.all(
		usable.map(async (provider) => {
			const result = await provider.searchTransfers(query, contextFor(provider.id, keys, signal));
			record(provider, result);
			if (!result.ok) return result;
			for (const transfer of result.data) sources.attach(transfer, result.source);
			return result;
		})
	);
	// Issue #119: filtered here, at the one place a provider's raw answer becomes this
	// app's candidate list, so an implausible walk is gone from `TransportPicker`'s
	// alternatives too and not merely passed over by `pickBestTransfer`. The issue's own
	// wording is "dont even show this", and a row a traveller can still click is showing it.
	const candidates = results
		.flatMap((result) => (result.ok ? result.data : []))
		.filter(isPlausibleTransfer);
	return { candidates, selected: pickBestTransfer(candidates), results };
}

function servesAnyRequestedMode(provider: TransferProvider, requested: readonly TransferMode[] | undefined): boolean {
	if (!requested) return true;
	return provider.modes.some((mode) => requested.includes(mode));
}

/**
 * OSRM's own distance-based taxi fare range for one A-to-B, computed only when `candidates`
 * already contains a `taxi` `Transfer` (proof OSRM ran and had a route for this exact pair)
 * and only when a country code is known to rate it against. Deliberately reaches past the
 * generic `TransferProvider` interface into osrm.ts's own `getTaxiFareEstimate`: a
 * `TaxiFareEstimate` only ever exists there, on purpose, never on `Transfer` itself
 * (osrm.ts's own header comment — so nothing can mistake this for a quoted `Transfer.price`).
 *
 * Never a second network request for the same route: osrm.ts's own driving-route fetch
 * always returns duration AND distance in one response, and the `searchTransfers` call that
 * produced the `taxi` candidate in `candidates` already cached both under this exact
 * coordinate pair — `getTaxiFareEstimate` finds that entry and returns it with
 * `requestsUsed: 0` (verified directly in osrm.test.ts's "reuses a driving route already
 * cached by searchTransfers" case). This is why every call site awaits `fetchBestTransfer`
 * FIRST and only then calls this: calling both concurrently for the same pair would race two
 * cache misses into two separate driving-route requests instead of one.
 */
export async function estimateTaxiFareForLeg(
	candidates: readonly Transfer[],
	from: Coordinates,
	to: Coordinates,
	countryCode: IsoCountryCode | undefined,
	signal: AbortSignal,
	record: RecordProviderCall
): Promise<TaxiFareEstimate | undefined> {
	if (countryCode === undefined) return undefined;
	if (!candidates.some((transfer) => transfer.mode === 'taxi')) return undefined;
	const result = await getTaxiFareEstimate(from, to, countryCode, { signal });
	record({ id: OSRM_PROVIDER_ID, kind: 'transfer', label: 'OSRM (walking & driving)' }, result);
	return result.ok ? result.data.fareEstimate : undefined;
}

/** One candidate's stay search, resolved into everything downstream needs: every `Stay`
 * found (unfiltered, cheapest first — issue #80's "keep the candidate list" so a future
 * picker (#27) has alternatives, ineligible ones included, to show rather than silently
 * drop) and, separately, the cheapest one this party can actually book. */
interface StaySearchOutcome {
	/** Every `Stay` returned, cheapest first, gender-eligibility NOT applied. */
	candidates: Stay[];
	/** The cheapest candidate that is also `isStaySelectable` for this party, or
	 * `undefined` when every candidate found is a `female-dorm` this party cannot fully
	 * use — never a stay nobody in the group can book, no matter how cheap. */
	selected: Stay | undefined;
}

/**
 * Runs every FREE stay provider plus every METERED one cheap enough, against its own
 * tracked monthly cap, that a configured key already counts as consent to spend it
 * (`autoWidenStaySources`, issue #94) for one candidate's stay search, and picks the
 * cheapest result THIS PARTY CAN ACTUALLY BOOK.
 *
 * The two real stay adapters (Agoda, Booking.com) are `needsKey: true`, so before this
 * fix `runCostAwareSearch` ran with no `widenTo` at all here and neither ever ran, keyed
 * or not — no search could ever price a bed. `autoWidenStaySources` derives which metered
 * sources are safe to auto-run from `providers/budget`'s own cap table rather than naming
 * Agoda/Booking here, so a future stay provider is classified by its real numbers rather
 * than silently defaulting to "never runs" by omission. A provider with a Sky-Scrapper-tight
 * cap would be left out of `widenTo` here exactly the way it is for flights, still showing
 * up in `report.skipped` rather than being auto-run.
 *
 * Issue #80: filtering by `isStaySelectable` happens BEFORE picking the cheapest, not
 * after — the previous version ranked by raw price alone and returned index `[0]`, which
 * could and did hand a female-only dorm to a group with no female travellers. A price for
 * a bed nobody in the party can book is not a cheaper option, it is a wrong answer.
 */
async function fetchCheapestStay(
	query: StaySearchQuery,
	providers: readonly StayProvider[],
	keys: AvailableKeys,
	signal: AbortSignal,
	sources: SourceTracker,
	record: RecordProviderCall,
	travellers: number | undefined,
	females: number | undefined,
	stayLookupBudget: StayLookupBudget
): Promise<StaySearchOutcome> {
	const costAwareSources = stayCostAwareSources(providers, query, keys, signal, sources, record);
	const result = await runCostAwareSearch(costAwareSources, {
		widenTo: claimAutoWidenStaySources(costAwareSources, stayLookupBudget)
	});
	// Issue #152: a stay priced in a currency this itinerary cannot total is not a cheaper
	// option, it is an unusable one — the same reasoning issue #80 applied to a female-only
	// dorm a group cannot book. Dropped here, before ranking, so it can neither become the
	// pick nor sit in `stayCandidates` offering a picker a price in the wrong money.
	// `build.ts` refuses to total a mix (`sumMoney`), and until this filter existed that
	// refusal threw, which `pipeline.ts` caught by discarding the whole candidate — so a
	// successfully priced bed destroyed the itinerary it belonged to.
	const inSearchCurrency = flattenOk(result).filter(
		(stay) => query.currency === undefined || stay.pricePerNight.currency === query.currency
	);
	const candidates = rankStaysByPrice(inSearchCurrency);
	const selected = candidates.find((stay) => isStaySelectable(stay, travellers, females));
	return { candidates, selected };
}

export interface FetchConnectionResourcesInput {
	connectionCoordinates: { latitude: number; longitude: number };
	connectionAirportSize: AirportSizeClass;
	/** Every registered stay provider, not pre-filtered — `fetchCheapestStay` above decides
	 * which ones actually run via `runCostAwareSearch`. */
	stayProviders: readonly StayProvider[];
	transferProviders: readonly TransferProvider[];
	keys: AvailableKeys;
	signal: AbortSignal;
	stayRadiusKm: number;
	checkIn: IsoCalendarDate;
	checkOut: IsoCalendarDate;
	landingToTransportRules: readonly LandingToTransportRule[];
	sources: SourceTracker;
	record: RecordProviderCall;
	/** `SearchQuery.travellers`/`.females` — the only two fields this module needs from the
	 * whole query, threaded down rather than passing the query object itself so this stays
	 * a narrow interface (AGENTS.md). An absent `females` is NOT the same as `0` — see
	 * `stays/female-dorm-fit.ts`'s own doc comment, which this module matches rather than
	 * inventing a third interpretation. */
	travellers?: number;
	females?: number;
	/** Issue #114: the connection airport's own country, used only to rate a taxi fare
	 * estimate for this connection's two hotel-bound legs (`estimateTaxiFareForLeg`) —
	 * consulted for nothing else here. `undefined` degrades to no taxi estimate for this
	 * connection, never a guess borrowed from the wrong country's rate card. */
	connectionCountryCode?: IsoCountryCode;
	/**
	 * Issue #161: where the two connection-side legs run to when no bed is priced —
	 * `Airport.city.coordinates`, which is a hand-checked city point or nothing
	 * (`data/airport-city-names.ts`, issue #162).
	 *
	 * With no key for a stay provider this pipeline used to return before requesting a
	 * single transfer, so a first-run search made zero OSRM and zero Transitous calls for
	 * the stopover even though both are free and keyless, and the detail view carried two
	 * rows saying nothing. Routing airport to city centre instead is the whole pitch of the
	 * app: "six free days in Bergamo" is worth much less without "and the old town is ten
	 * minutes from the runway".
	 *
	 * `undefined` (the normal case — only a handful of airports have a checked centre) puts
	 * this back exactly where it was: no destination, no request, no row.
	 */
	connectionCityCentre?: Coordinates;
	/**
	 * Issue #152: the currency every provider in this search is asked to quote in
	 * (`SearchDependencies.currency`). Threading it here is the actual fix for "No bed
	 * priced for this stopover" — it never reached the stay query before, so Agoda was
	 * called with no `currency_id` and answered in USD (its documented default) while the
	 * flights came back in EUR. `build.ts`'s `sumMoney` then refused to total the mix and
	 * threw, and `pipeline.ts` caught that by dropping the whole candidate. Every itinerary
	 * that successfully priced a bed was destroyed by having priced one; only the bedless
	 * ones survived to be rendered, each captioned "No bed priced for this stopover."
	 *
	 * `undefined` disables the currency filter rather than rejecting everything — a search
	 * that never asked for a particular currency has no grounds to refuse one.
	 */
	currency?: IsoCurrencyCode;
	/** Issue #148: this search's shared ration of stay lookups, created once per search by
	 * `pipeline.ts` and passed to every candidate. Without it each candidate called every
	 * keyed stay provider, so one click cost as many lookups as the route graph happened to
	 * return candidates — 6 ordinarily, 24 on the fallback sweep. See
	 * `providers/budget/stay-lookup-budget.ts`. */
	stayLookupBudget: StayLookupBudget;
}

/**
 * Full resource bundle for one connection candidate — issue #94: NEVER `undefined`
 * any more. A stay with no way to get there, or no stay found at all (no key configured,
 * every stay provider out of quota or erroring, or nothing this party can book nearby),
 * degrades to `stay`/`transferToHotel`/`transferToConnectionAirport` all `undefined`
 * rather than dropping the whole candidate: flights, free time and the outer transfers
 * still stand on their own without a priced bed (`algorithm/build.ts`'s own doc comment
 * on `ConnectionResources`). Widens `ConnectionResources` with `stayCandidates` (issue
 * #80) rather than changing that type itself, which `algorithm/build.ts` owns and already
 * ships merged — see this module's own doc comment.
 */
export interface ConnectionResourcesWithStayCandidates extends ConnectionResources {
	/** Every `Stay` found near this connection, cheapest first, gender-eligibility NOT
	 * applied — the candidate list issue #80 exists to stop discarding, so a results page
	 * has real alternatives to hand issue #27's `StayPicker` instead of only this
	 * pipeline's already-decided pick. `stay` above is this list's cheapest entry that also
	 * passes `isStaySelectable` for this party. Empty, not missing, when nothing was found. */
	stayCandidates: Stay[];
	/** Issue #114: every `Transfer` a usable provider returned for the connection-airport-
	 * to-hotel leg, landing-buffer already applied to each one (the same buffer
	 * `transferToHotel` itself carries — see `applyLandingBuffer`'s own doc comment for why
	 * this leg needs it and the return leg below does not) — real alternatives for
	 * `TransportPicker`, not just the one pick `build.ts` uses. Empty whenever
	 * `stay`/`transferToHotel` are `undefined` too. */
	transferToHotelCandidates: Transfer[];
	/** Same idea as `transferToHotelCandidates`, for the return leg (hotel to connection
	 * airport) — no landing buffer: this leg ends at a departure, not a runway. */
	transferToConnectionAirportCandidates: Transfer[];
	/** OSRM's distance-based taxi fare range for the hotel-bound leg, present only when a
	 * `taxi` candidate is among `transferToHotelCandidates` and a country code was given to
	 * rate it against. Never folds into any candidate's own `Transfer.price` — see
	 * `estimateTaxiFareForLeg`'s own doc comment for why that separation is deliberate. */
	transferToHotelTaxiFareEstimate?: TaxiFareEstimate;
	/** Same idea as `transferToHotelTaxiFareEstimate`, for the return leg. */
	transferToConnectionAirportTaxiFareEstimate?: TaxiFareEstimate;
}

/** The "nothing to travel to" outcome shared by the early-outs below — no bed this party
 * can book AND no city point to route to instead (issue #161), or a destination that no
 * transfer provider could reach. A degraded connection, never a dropped one (issue #94),
 * and never a stay-shaped hole papered over with a guess. */
function withoutTransfers(stayCandidates: Stay[]): ConnectionResourcesWithStayCandidates {
	return {
		stay: undefined,
		transferAnchor: undefined,
		transferToHotel: undefined,
		transferToConnectionAirport: undefined,
		stayCandidates,
		transferToHotelCandidates: [],
		transferToConnectionAirportCandidates: []
	};
}

export async function fetchConnectionResources(
	input: FetchConnectionResourcesInput
): Promise<ConnectionResourcesWithStayCandidates> {
	const { candidates: stayCandidates, selected: stay } = await fetchCheapestStay(
		{
			near: input.connectionCoordinates,
			radiusKm: input.stayRadiusKm,
			checkIn: input.checkIn,
			checkOut: input.checkOut,
			// Issue #152: both of these were simply missing, and both were silently wrong
			// rather than absent in effect. No `currency` meant Agoda omitted `currency_id`
			// and priced in USD against EUR flights; no `travellers` meant every stay was
			// priced for `DEFAULT_TRAVELLERS` regardless of the party the traveller entered,
			// so a party of three saw one adult's rate.
			currency: input.currency,
			travellers: input.travellers
		},
		input.stayProviders,
		input.keys,
		input.signal,
		input.sources,
		input.record,
		input.travellers,
		input.females,
		input.stayLookupBudget
	);
	// Issue #161: a bed is the best destination for these two legs, and it is not the only
	// one. With no stay priced — the default state of a first-run search, since both stay
	// adapters need a key and neither transfer provider does — the city centre is a real
	// place to route to, and "the old town is a ten-minute bus from the runway" is the fact
	// the whole stopover pitch rests on. `connectionCityCentre` is `undefined` for every
	// airport without a hand-checked centre (issue #162), and then there is genuinely
	// nowhere to go, which is where this returns empty exactly as it did before.
	const destination = stay?.property.coordinates ?? input.connectionCityCentre;
	if (!destination) return withoutTransfers(stayCandidates);
	const transferAnchor: TransferAnchor = stay ? 'stay' : 'city-centre';

	const [transferToHotelOutcome, transferToConnectionAirportOutcome] = await Promise.all([
		// Roads only: this runs before any flight for this candidate has resolved, so there
		// is no journey moment to plan a timetable for. `search/transit-schedule.ts` asks
		// about public transport once there is (issue #135).
		fetchBestTransfer(
			{ from: input.connectionCoordinates, to: destination, modes: [...ROAD_TRANSFER_MODES] },
			input.transferProviders,
			input.keys,
			input.signal,
			input.sources,
			input.record
		),
		fetchBestTransfer(
			{ from: destination, to: input.connectionCoordinates, modes: [...ROAD_TRANSFER_MODES] },
			input.transferProviders,
			input.keys,
			input.signal,
			input.sources,
			input.record
		)
	]);
	// A destination exists but nothing can get the traveller there and back — the same "no
	// usable transfer" outcome as having nowhere to go at all (one provider failing, here a
	// transfer provider, must never fail the whole search). `stayCandidates` is still
	// returned: a caller deciding to show alternatives doesn't need a reachable transfer to
	// list them.
	if (!transferToHotelOutcome.selected || !transferToConnectionAirportOutcome.selected) {
		return withoutTransfers(stayCandidates);
	}

	const landingBuffer = pickLandingToTransportTime(input.landingToTransportRules, input.connectionAirportSize);
	// Buffered here, on every candidate, not only the pick — a traveller who picks a
	// different mode via TransportPicker still needs the same "time to actually reach the
	// street" padding the pipeline's own choice gets (issue #114). Re-deriving `transferToHotel`
	// from the buffered list (rather than buffering the already-picked transfer separately)
	// keeps exactly one code path decide "which one is best", never two that could disagree.
	const transferToHotelCandidates = transferToHotelOutcome.candidates.map((transfer) =>
		applyLandingBuffer(transfer, landingBuffer, input.sources)
	);
	const transferToHotel = pickBestTransfer(transferToHotelCandidates);
	if (!transferToHotel) return withoutTransfers(stayCandidates); // unreachable: buffering cannot empty a non-empty list

	const transferToConnectionAirportCandidates = transferToConnectionAirportOutcome.candidates;
	const transferToConnectionAirport = transferToConnectionAirportOutcome.selected;

	// Sequenced after the transfers above have resolved (never `Promise.all`'d with them) —
	// see `estimateTaxiFareForLeg`'s own doc comment for why that ordering is what keeps this
	// a cache hit instead of a second driving-route request for the same pair.
	const [transferToHotelTaxiFareEstimate, transferToConnectionAirportTaxiFareEstimate] = await Promise.all([
		estimateTaxiFareForLeg(
			transferToHotelCandidates,
			input.connectionCoordinates,
			destination,
			input.connectionCountryCode,
			input.signal,
			input.record
		),
		estimateTaxiFareForLeg(
			transferToConnectionAirportCandidates,
			destination,
			input.connectionCoordinates,
			input.connectionCountryCode,
			input.signal,
			input.record
		)
	]);

	return {
		stay,
		transferAnchor,
		transferToHotel,
		transferToConnectionAirport,
		stayCandidates,
		transferToHotelCandidates,
		transferToConnectionAirportCandidates,
		transferToHotelTaxiFareEstimate,
		transferToConnectionAirportTaxiFareEstimate
	};
}
