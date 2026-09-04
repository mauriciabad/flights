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
 */

import { contextFor, isProviderUsable } from '../providers/registry';
import { runCostAwareSearch } from '../providers/budget';
import type { AvailableKeys, StayProvider, StaySearchQuery, TransferProvider, TransferSearchQuery } from '../providers/types';
import type {
	AirportSizeClass,
	Duration,
	IsoCalendarDate,
	LandingToTransportRule,
	Stay,
	Transfer,
	TransferMode
} from '../domain';
import type { ConnectionResources } from '../algorithm/build';
import { femaleDormFit, isFemaleDormSelectable } from '../stays/female-dorm-fit';
import { autoWidenStaySources, flattenOk, stayCostAwareSources } from './cost-aware';
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
 * Ignores currency when comparing prices, same simplification `build.ts`'s own
 * `sumMoney` makes explicit is out of scope at this layer: every provider in one search is
 * asked for the same `SearchDependencies.currency`, so a mismatch here would already be a
 * degraded result by the time it reaches sorting.
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

/** Picks one `Transfer` to represent an A-to-B leg out of everything usable providers
 * returned, by mode preference and then by shortest duration within the same mode. */
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

/** Queries every given (already usability-filtered) transfer provider for one A-to-B leg,
 * merges what comes back, tags each with its provenance, and picks one representative — the
 * shared implementation behind both the per-connection legs below and the origin/destination
 * legs `pipeline.ts` fetches once per search. */
export async function fetchBestTransfer(
	query: TransferSearchQuery,
	providers: readonly TransferProvider[],
	keys: AvailableKeys,
	signal: AbortSignal,
	sources: SourceTracker,
	record: RecordProviderCall
): Promise<Transfer | undefined> {
	const usable = providers.filter((provider) => isProviderUsable(provider, keys));
	const perProvider = await Promise.all(
		usable.map(async (provider) => {
			const result = await provider.searchTransfers(query, contextFor(provider.id, keys, signal));
			record(provider, result);
			if (!result.ok) return [];
			for (const transfer of result.data) sources.attach(transfer, result.source);
			return result.data;
		})
	);
	return pickBestTransfer(perProvider.flat());
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
	females: number | undefined
): Promise<StaySearchOutcome> {
	const costAwareSources = stayCostAwareSources(providers, query, keys, signal, sources, record);
	const result = await runCostAwareSearch(costAwareSources, { widenTo: autoWidenStaySources(costAwareSources) });
	const candidates = rankStaysByPrice(flattenOk(result));
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
}

/** The "no bed for this connection" outcome shared by both early-outs below — no stay
 * provider found one this party can book, or one was found but no transfer can reach it.
 * Both are the same "no usable stay" fact from a caller's point of view (issue #94): a
 * degraded connection, never a dropped one, and never a stay-shaped hole papered over with
 * a guess. */
function withoutStay(stayCandidates: Stay[]): ConnectionResourcesWithStayCandidates {
	return { stay: undefined, transferToHotel: undefined, transferToConnectionAirport: undefined, stayCandidates };
}

export async function fetchConnectionResources(
	input: FetchConnectionResourcesInput
): Promise<ConnectionResourcesWithStayCandidates> {
	const { candidates: stayCandidates, selected: stay } = await fetchCheapestStay(
		{
			near: input.connectionCoordinates,
			radiusKm: input.stayRadiusKm,
			checkIn: input.checkIn,
			checkOut: input.checkOut
		},
		input.stayProviders,
		input.keys,
		input.signal,
		input.sources,
		input.record,
		input.travellers,
		input.females
	);
	if (!stay) return withoutStay(stayCandidates);

	const [transferToHotelRaw, transferToConnectionAirport] = await Promise.all([
		fetchBestTransfer(
			{ from: input.connectionCoordinates, to: stay.property.coordinates },
			input.transferProviders,
			input.keys,
			input.signal,
			input.sources,
			input.record
		),
		fetchBestTransfer(
			{ from: stay.property.coordinates, to: input.connectionCoordinates },
			input.transferProviders,
			input.keys,
			input.signal,
			input.sources,
			input.record
		)
	]);
	// A stay exists but nothing can get the traveller there and back — the same "no usable
	// bed" outcome as finding none at all (one provider failing, here a transfer provider,
	// must never fail the whole search). `stayCandidates` is still returned: a caller
	// deciding to show alternatives doesn't need a reachable transfer to list them.
	if (!transferToHotelRaw || !transferToConnectionAirport) return withoutStay(stayCandidates);

	const landingBuffer = pickLandingToTransportTime(input.landingToTransportRules, input.connectionAirportSize);
	const transferToHotel = applyLandingBuffer(transferToHotelRaw, landingBuffer, input.sources);

	return { stay, transferToHotel, transferToConnectionAirport, stayCandidates };
}
