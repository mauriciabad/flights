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
 * filters by `stays/gendered-room-fit.ts` (issue #27's own rule, reused rather than
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

import { contextFor, isProviderUsable } from "../providers/registry";
import { runCostAwareSearch } from "../providers/budget";
import type {
  AvailableKeys,
  ProviderResult,
  StayProvider,
  StaySearchQuery,
  TransferProvider,
  TransferSearchQuery,
} from "../providers/types";
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
  TransferAnchor,
  TransferMode,
} from "../domain";
import {
  greatCircleDistanceKm,
  MAX_PLAUSIBLE_WALK_MINUTES,
  maxPlausibleRoadMinutes,
  maxPlausibleTransitMinutes,
} from "../domain";
import type { ConnectionResources } from "../algorithm/build";
import { isStayBookableByGroup } from "../stays/gendered-room-fit";
import {
  NIGHTS_ASSUMED_BEFORE_A_PAIRING_EXISTS,
  stopoverStayCostMinorUnits,
} from "../stays/stopover-cost";
import {
  claimAutoWidenStaySources,
  flattenOk,
  stayCostAwareSources,
} from "./cost-aware";
import type { StayLookupBudget } from "../providers/budget";
import type { RecordProviderCall, SourceTracker } from "./provenance";
import type { WithheldRoutes, WithheldTransfers } from "./types";

/**
 * How far from the connection airport a bed may be and still belong to this stopover.
 *
 * The brief's line 76 says "cheapest hotels/hostels for each connection within 100km", so
 * changing it is a product decision. Issue #204 is the argument for changing it, and the
 * measurements are from this repo's own data (`data/airports.generated.json` against the
 * hand-checked city points in `data/airport-city-names.ts`, great-circle):
 *
 * | pair | km |
 * | --- | --- |
 * | BGY -> Bergamo | 4.1 |
 * | LIN -> Milan | 7.1 |
 * | ZAG -> Zagreb | 10.6 |
 * | EDI -> Edinburgh | 11.5 |
 * | CDG -> Paris | 22.5 |
 * | MXP -> Milan | 40.4 |
 * | CRL -> Brussels | 43.5 |
 * | STN -> London | 48.9 |
 * | BVA -> Paris | 68.7 |
 * | PSA -> Florence | 70.0 |
 * | GRO -> Barcelona | 75.7 |
 * | TRF -> Oslo | 85.5 |
 * | NYO -> Stockholm | 89.3 |
 * | FMM -> Munich | 101.2 |
 *
 * There is a gap in that list between 48.9 and 68.7, and it is not a coincidence. Above
 * it sit exactly the airports `data/airport-city-names.ts` already refuses to name after
 * the city on the ticket, in its own words because "each is a real town far from the city
 * on the ticket... Displaying the marketed city would be the same lie in the other
 * direction." A 100km stay radius tells that lie anyway, one layer down: it offers a
 * Barcelona bed for a Girona layover and a Stockholm bed for a Skavsta one, then totals
 * the coach nobody priced as zero. 50 keeps every city this app is willing to name an
 * airport after and drops that whole band.
 *
 * What 50 does NOT do is fix issue #204's reported symptom, and pretending otherwise
 * would be the second mistake. Gatwick to central London is 40.1km and Malpensa to
 * central Milan is 40.4km: no radius separates the bed the owner called "TOO FAR" from a
 * stopover that is the product working. The cost of getting there is what separates them,
 * which is `score.ts`'s `assumedRoadTransferCostPerHour` and this file's own
 * `estimateTaxiFareForLeg`, not this number.
 */
export const DEFAULT_STAY_RADIUS_KM = 50;

/**
 * Every `Stay` this candidate's usable providers returned, best first, so a caller can fall
 * back to the next one if the top pick turns out to be unavailable — `build.ts` itself only
 * ever consumes the first one (`ConnectionResources.stay` is singular), but picking "which
 * stay a traveller might actually book instead" (brief line 65: "user can select to update
 * total") is a UI concern this module hands the option list to rather than decides.
 *
 * Issue #219: best is no longer cheapest. This used to sort on `pricePerNight` alone, and a
 * dorm bed in a big city is structurally cheaper than a private room beside a runway, so
 * with a 50 km radius the first entry was essentially always the far one — a EUR 13.00 bed
 * 48.3 km from Gatwick, over a EUR 52.82 room 2.8 km away, on the owner's own route. The
 * order now weighs the room against getting out to it and back; `stays/stopover-cost.ts`
 * owns that rule, the assumption behind it and the argument for both.
 *
 * Compares raw minor units with no currency conversion, which is safe only because
 * `fetchCheapestStay` has already dropped every stay not quoted in the search's own
 * currency before calling this. That filter is what makes the comparison meaningful —
 * issue #152: this function's previous comment claimed a mismatch "would already be a
 * degraded result by the time it reaches sorting", which was the assumption that hid the
 * bug. Nothing asked providers for a currency at all, so mismatches were the normal case
 * and sorting them by bare minor units ranked 2000 USD below 2200 EUR.
 */
export function rankStaysForStopover(
  stays: readonly Stay[],
  connectionCoordinates: Coordinates,
): Stay[] {
  return [...stays].sort(
    (a, b) =>
      stopoverStayCostMinorUnits(a, connectionCoordinates, NIGHTS_ASSUMED_BEFORE_A_PAIRING_EXISTS) -
      stopoverStayCostMinorUnits(b, connectionCoordinates, NIGHTS_ASSUMED_BEFORE_A_PAIRING_EXISTS),
  );
}

/** Preference order when more than one `Transfer` mode is on offer for the same A-to-B:
 * real public transport first (what this app's traveller actually wants to know exists —
 * docs/PROVIDERS.md: Transitous "answers the question ordinary flight search cannot"),
 * then walking (free, always available if the distance allows it), then paid options. */
const TRANSFER_MODE_PREFERENCE: readonly TransferMode[] = [
  "transit",
  "walk",
  "taxi",
  "drive",
];

/** Issue #204 moved this to `domain/transfer.ts`, where `providers/transfers/osrm.ts` can
 * read it too and stop ASKING for a walking route this filter would only discard. Still
 * exported from here: it has been part of this module's surface since issue #119. */
export {
  MAX_PLAUSIBLE_WALK_MINUTES,
  maxPlausibleRoadMinutes,
  maxPlausibleTransitMinutes,
};

/**
 * Whether this transfer is worth putting in front of a traveller at all.
 *
 * Applied to a provider's own answer, before `applyLandingBuffer` runs, and never after —
 * that buffer is the time it takes to get out of the terminal, not time spent walking, so
 * measuring a padded duration against a walking cap would drop a 40-minute walk for the
 * sin of following a landing at a large airport.
 *
 * Every mode has a rule now, and all three live in `domain/transfer.ts` so the adapters can
 * read the same numbers this filter judges them by:
 *
 * - Walking, since issue #119: a flat 45 minutes. A walk is a walk at any distance.
 * - Transit, since issue #220: `maxPlausibleTransitMinutes` of the straight-line distance
 *   between the two points, because 90 minutes across a big city and 10 across a small one
 *   are both ordinary and no flat number is right for both.
 * - Driving and taxi, since issue #119's second half: `maxPlausibleRoadMinutes` of the same
 *   distance. One rule for both, because they are the same OSRM driving route with two
 *   labels on it (`providers/transfers/osrm.ts`: "a taxi does not get its own physics").
 *   What differs between them is who pays, and #246 already answers that separately by
 *   withholding a fare estimate past the rate card's range.
 *
 * `straightLineKm` is the leg's own distance, and it is a required argument rather than an
 * optional one on purpose: a caller that has not measured the leg cannot apply the transit
 * rule, and silently skipping it is how the 33-hour answer in #220 reached the card.
 *
 * The switch is exhaustive rather than a chain of `if`s ending in `return true`. That
 * trailing `true` is what left driving unjudged from #119 until #119's second half, without
 * anything in the type system noticing, and a fifth `TransferMode` would inherit the same
 * silence.
 */
export function isPlausibleTransfer(
  transfer: Transfer,
  straightLineKm: number,
): boolean {
  switch (transfer.mode) {
    case "walk":
      return transfer.duration <= MAX_PLAUSIBLE_WALK_MINUTES;
    case "transit":
      return transfer.duration <= maxPlausibleTransitMinutes(straightLineKm);
    case "drive":
    case "taxi":
      return transfer.duration <= maxPlausibleRoadMinutes(straightLineKm);
  }
}

/**
 * The two modes `maxPlausibleRoadMinutes` judges: one OSRM driving route wearing two
 * labels. Deliberately not `ROAD_TRANSFER_MODES` below, which also holds `'walk'` because
 * that is the set OSRM can be ASKED for, not the set this rule applies to.
 */
export const VEHICLE_TRANSFER_MODES: readonly TransferMode[] = [
  "drive",
  "taxi",
];

/**
 * What `isPlausibleTransfer` threw away for one leg, reduced to the three numbers a card
 * can print: how many routes, the quickest of them, and the distance they were judged
 * against. `undefined` when it refused nothing of these modes, which is nearly every leg.
 *
 * Filtered by mode because one leg's rejects can hold both kinds, and the two are shown in
 * different places — a refused bus in the transport picker's transit notice (issue #220), a
 * refused drive in the timeline's unrouted-leg row (issue #119). Reporting a refused bus in
 * a sentence about driving would be the same collapse both notices exist to undo.
 */
export function summariseWithheldRoutes(
  rejected: readonly Transfer[],
  straightLineKm: number,
  modes: readonly TransferMode[],
): WithheldRoutes | undefined {
  const matching = rejected.filter((transfer) => modes.includes(transfer.mode));
  if (matching.length === 0) return undefined;
  const quickest = matching.reduce(
    (shortest, transfer) =>
      transfer.duration < shortest ? transfer.duration : shortest,
    matching[0].duration,
  );
  return { count: matching.length, quickest, straightLineKm };
}

/**
 * One leg's refusals, read straight off the outcome that produced them so no caller has to
 * re-measure the distance they were judged against. `undefined` for a leg the query never
 * asked for, which has no outcome and so nothing to report, and for the ordinary leg where
 * nothing was refused.
 *
 * Issue #119 started this with driving and taxi; issue #347 added walking, which was the one
 * mode `isPlausibleTransfer` could refuse with nothing anywhere reporting it. Grouped rather
 * than returned as a second `withheldWalkFor` beside the first: the two are the same
 * observation about the same leg, and issue #296 is this repo's own note about what happens
 * when one sentence gets a parallel copy instead of a shared home.
 */
export function withheldTransfersFor(
  outcome: TransferSearchOutcome | undefined,
): WithheldTransfers | undefined {
  if (!outcome) return undefined;
  const withheld: WithheldTransfers = {
    road: summariseWithheldRoutes(
      outcome.rejected,
      outcome.straightLineKm,
      VEHICLE_TRANSFER_MODES,
    ),
    walk: summariseWithheldRoutes(outcome.rejected, outcome.straightLineKm, [
      "walk",
    ]),
  };
  return withheld.road || withheld.walk ? withheld : undefined;
}

/** Picks one `Transfer` to represent an A-to-B leg out of everything usable providers
 * returned, by mode preference and then by shortest duration within the same mode. Pure
 * ranking: `fetchBestTransfer` has already dropped whatever `isPlausibleTransfer` rejects,
 * and this runs on landing-buffered lists too, where re-applying that cap would be wrong. */
export function pickBestTransfer(
  transfers: readonly Transfer[],
): Transfer | undefined {
  if (transfers.length === 0) return undefined;
  return [...transfers].sort((a, b) => {
    const modeRank =
      TRANSFER_MODE_PREFERENCE.indexOf(a.mode) -
      TRANSFER_MODE_PREFERENCE.indexOf(b.mode);
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
  airportSize: AirportSizeClass,
): Duration {
  let best: LandingToTransportRule | undefined;
  for (const rule of rules) {
    if (rule.airportSize !== undefined && rule.airportSize !== airportSize)
      continue;
    // A rule naming this airport size is strictly more specific than a catch-all
    // (`airportSize === undefined`); among equally-specific rules the later one in the
    // list wins, matching how `DEFAULT_LANDING_TO_TRANSPORT_RULES` reads as "flat
    // default, then an override for large airports" without requiring rules to be
    // pre-sorted.
    if (
      !best ||
      rule.airportSize !== undefined ||
      best.airportSize === undefined
    )
      best = rule;
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
 *
 * Issue #266: the buffer is recorded on the returned transfer as well as spent on its
 * duration. A leg that starts at a runway happens at the flight's arrival plus this
 * number, and once a flight swap moves that arrival, the only way to notice that a
 * timetable was planned for the old landing is to still have the number. It is recorded
 * even at zero, which is a different fact from a leg nobody applied the rule to.
 */
export function applyLandingBuffer(
  transfer: Transfer,
  buffer: Duration,
  sources: SourceTracker,
): Transfer {
  // A negative rule would shorten a journey the provider measured. Refused since this
  // function existed; now it is refused explicitly rather than by returning early.
  const applied = (buffer > 0 ? buffer : 0) as Duration;
  const adjusted: Transfer = {
    ...transfer,
    duration: (transfer.duration + applied) as Duration,
    landingBuffer: applied,
  };
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
  /**
   * Issue #220: what `isPlausibleTransfer` threw away for this leg, kept rather than
   * dropped on the floor so a card can say a route came back and was refused, with its own
   * duration in it, instead of the "there is no service here" the traveller would otherwise
   * read. AGENTS.md: "say what you do not know rather than guessing."
   *
   * Empty on nearly every leg, which is the point. It fills only when a provider answered
   * with a journey nobody could take.
   */
  rejected: Transfer[];
  /** The straight-line distance every rule above was applied against, carried out rather
   * than left for each caller to recompute. Two callers measuring the same leg with two
   * different numbers is how a filtered route and the sentence explaining it end up
   * disagreeing about the distance they are talking about. */
  straightLineKm: number;
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
export const ROAD_TRANSFER_MODES: readonly TransferMode[] = [
  "walk",
  "drive",
  "taxi",
];

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
  record: RecordProviderCall,
): Promise<TransferSearchOutcome> {
  // Issue #135: an adapter with nothing to contribute is left out of the call, not called
  // and then ignored. Calling it returns an empty, `ok`, zero-request result that issue
  // #130's status machinery cannot tell from "asked, and there is no service here" — so
  // asking Transitous for a walking duration would have put "Transitous: nothing found"
  // on screen for every leg, which is the same lie #130 exists to stop, pointed the other
  // way.
  const usable = providers.filter(
    (provider) =>
      isProviderUsable(provider, keys) &&
      servesAnyRequestedMode(provider, query.modes),
  );
  const results = await Promise.all(
    usable.map(async (provider) => {
      const result = await provider.searchTransfers(
        query,
        contextFor(provider.id, keys, signal),
      );
      record(provider, result);
      if (!result.ok) return result;
      for (const transfer of result.data)
        sources.attach(transfer, result.source);
      return result;
    }),
  );
  // Issue #119: filtered here, at the one place a provider's raw answer becomes this
  // app's candidate list, so an implausible walk is gone from `TransportPicker`'s
  // alternatives too and not merely passed over by `pickBestTransfer`. The issue's own
  // wording is "dont even show this", and a row a traveller can still click is showing it.
  // Issue #220 added transit to the same gate, measured against this leg's own distance.
  const straightLineKm = greatCircleDistanceKm(query.from, query.to);
  const answered = results.flatMap((result) => (result.ok ? result.data : []));
  const candidates: Transfer[] = [];
  const rejected: Transfer[] = [];
  for (const transfer of answered) {
    (isPlausibleTransfer(transfer, straightLineKm) ? candidates : rejected).push(
      transfer,
    );
  }
  return {
    candidates,
    selected: pickBestTransfer(candidates),
    rejected,
    straightLineKm,
    results,
  };
}

function servesAnyRequestedMode(
  provider: TransferProvider,
  requested: readonly TransferMode[] | undefined,
): boolean {
  if (!requested) return true;
  return provider.modes.some((mode) => requested.includes(mode));
}

/** One candidate's stay search, resolved into everything downstream needs: every `Stay`
 * found (unfiltered, cheapest first — issue #80's "keep the candidate list" so a future
 * picker (#27) has alternatives, ineligible ones included, to show rather than silently
 * drop) and, separately, the cheapest one this party can actually book. */
interface StaySearchOutcome {
  /** Every `Stay` returned, cheapest first, gender-eligibility NOT applied. */
  candidates: Stay[];
  /** The cheapest candidate that is also `isStayBookableByGroup` for this party, or
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
 * Issue #80: filtering by `isStayBookableByGroup` happens BEFORE picking the cheapest, not
 * after — the previous version ranked by raw price alone and returned index `[0]`, which
 * could and did hand a female-only dorm to a group with no female travellers. A price for
 * a bed nobody in the party can book is not a cheaper option, it is a wrong answer.
 *
 * Issue #219: and "cheapest" is `rankStaysForStopover`'s reading of it, the room plus the
 * ride, rather than the nightly rate on its own. The bed this returns is the one a card
 * opens on and totals, so a rate that ignores a 48 km journey twice is not a cheaper
 * option either.
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
  stayLookupBudget: StayLookupBudget,
): Promise<StaySearchOutcome> {
  const costAwareSources = stayCostAwareSources(
    providers,
    query,
    keys,
    signal,
    sources,
    record,
  );
  const result = await runCostAwareSearch(costAwareSources, {
    widenTo: claimAutoWidenStaySources(costAwareSources, stayLookupBudget),
  });
  // Issue #152: a stay priced in a currency this itinerary cannot total is not a cheaper
  // option, it is an unusable one — the same reasoning issue #80 applied to a female-only
  // dorm a group cannot book. Dropped here, before ranking, so it can neither become the
  // pick nor sit in `stayCandidates` offering a picker a price in the wrong money.
  // `build.ts` refuses to total a mix (`sumMoney`), and until this filter existed that
  // refusal threw, which `pipeline.ts` caught by discarding the whole candidate — so a
  // successfully priced bed destroyed the itinerary it belonged to.
  const inSearchCurrency = flattenOk(result).filter(
    (stay) =>
      query.currency === undefined ||
      stay.pricePerNight.currency === query.currency,
  );
  const candidates = rankStaysForStopover(inSearchCurrency, query.near);
  const selected = candidates.find((stay) =>
    isStayBookableByGroup(stay, travellers, females),
  );
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
   * `stays/gendered-room-fit.ts`'s own doc comment, which this module matches rather than
   * inventing a third interpretation. */
  travellers?: number;
  females?: number;
  /** Issue #114: the connection airport's own country, used only to rate a taxi fare
   * estimate for this connection's two hotel-bound legs, consulted for nothing else here.
   * It goes onto the `TransferSearchQuery` (issue #249), so OSRM attaches the range to the
   * taxi `Transfer` it builds. `undefined` degrades to no taxi estimate for this
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
   * passes `isStayBookableByGroup` for this party. Empty, not missing, when nothing was found. */
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
  /** What `isPlausibleTransfer` refused on the hotel-bound leg, by mode. Set on the degraded
   * outcome too, and for the road rule that is the case it exists for: a route slow enough
   * to trip it leaves nothing behind it, so the leg has no transfer at all and the timeline
   * row is the only place left to say what happened. */
  transferToHotelWithheld?: WithheldTransfers;
  /** Same idea as `transferToHotelWithheld`, for the return leg. */
  transferToConnectionAirportWithheld?: WithheldTransfers;
}

/** The "nothing to travel to" outcome shared by the early-outs below — no bed this party
 * can book AND no city point to route to instead (issue #161), or a destination that no
 * transfer provider could reach. A degraded connection, never a dropped one (issue #94),
 * and never a stay-shaped hole papered over with a guess. */
function withoutTransfers(
  stayCandidates: Stay[],
  stay?: Stay,
  withheld?: {
    transferToHotel?: WithheldTransfers;
    transferToConnectionAirport?: WithheldTransfers;
  },
): ConnectionResourcesWithStayCandidates {
  return {
    stay,
    transferAnchor: undefined,
    transferToHotel: undefined,
    transferToConnectionAirport: undefined,
    stayCandidates,
    transferToHotelCandidates: [],
    transferToConnectionAirportCandidates: [],
    transferToHotelWithheld: withheld?.transferToHotel,
    transferToConnectionAirportWithheld: withheld?.transferToConnectionAirport,
  };
}

export async function fetchConnectionResources(
  input: FetchConnectionResourcesInput,
): Promise<ConnectionResourcesWithStayCandidates> {
  const { candidates: stayCandidates, selected: stay } =
    await fetchCheapestStay(
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
        travellers: input.travellers,
      },
      input.stayProviders,
      input.keys,
      input.signal,
      input.sources,
      input.record,
      input.travellers,
      input.females,
      input.stayLookupBudget,
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
  const transferAnchor: TransferAnchor = stay ? "stay" : "city-centre";

  const [transferToHotelOutcome, transferToConnectionAirportOutcome] =
    await Promise.all([
      // Roads only: this runs before any flight for this candidate has resolved, so there
      // is no journey moment to plan a timetable for. `search/transit-schedule.ts` asks
      // about public transport once there is (issue #135).
      fetchBestTransfer(
        {
          from: input.connectionCoordinates,
          to: destination,
          modes: [...ROAD_TRANSFER_MODES],
          countryCode: input.connectionCountryCode,
          // Issue #339. The same currency the stay fetch above is given and the flight
          // adapters are given, so the rate-card estimate on this leg reads in the one the
          // traveller picked instead of the one the ride's country happens to use. It is
          // not sent to OSRM; no transfer provider quotes a fare.
          displayCurrency: input.currency,
          // Issue #344: the same party the stay fetch above is given, so a taxi here is
          // priced for the people taking it rather than for one car. Never sent to OSRM.
          travellers: input.travellers,
        },
        input.transferProviders,
        input.keys,
        input.signal,
        input.sources,
        input.record,
      ),
      fetchBestTransfer(
        {
          from: destination,
          to: input.connectionCoordinates,
          modes: [...ROAD_TRANSFER_MODES],
          countryCode: input.connectionCountryCode,
          // Issue #339. The same currency the stay fetch above is given and the flight
          // adapters are given, so the rate-card estimate on this leg reads in the one the
          // traveller picked instead of the one the ride's country happens to use. It is
          // not sent to OSRM; no transfer provider quotes a fare.
          displayCurrency: input.currency,
          // Issue #344: the same party the stay fetch above is given, so a taxi here is
          // priced for the people taking it rather than for one car. Never sent to OSRM.
          travellers: input.travellers,
        },
        input.transferProviders,
        input.keys,
        input.signal,
        input.sources,
        input.record,
      ),
    ]);
  // A destination exists but nothing can get the traveller there and back. One provider
  // failing, here a transfer provider, must never fail the whole search.
  //
  // Issue #211: it used to take the bed with it. `withoutTransfers` set `stay: undefined`,
  // so a room a provider had quoted a real price for was deleted because a routing service
  // was unreachable, and the card then said "No bed priced for this stopover" about a bed
  // that had been priced. Measured directly on production with OSRM as the only variable:
  // OSRM answering gave "Bed, 6 nights EUR 78.00"; OSRM refused gave "Bed not priced",
  // three times running, on identical Hostelworld responses.
  //
  // Those are two different answers and the traveller was only ever shown one of them. The
  // bed survives now. A stopover with a priced bed and no route to it is a real, if
  // incomplete, result: the price is known and the way there is not, which is exactly what
  // AGENTS.md means by saying what you do not know. `algorithm/build.ts` already treats
  // both connection-side transfers as optional, so nothing downstream needs them to exist.
  const withheld = {
    transferToHotel: withheldTransfersFor(transferToHotelOutcome),
    transferToConnectionAirport: withheldTransfersFor(
      transferToConnectionAirportOutcome,
    ),
  };
  if (
    !transferToHotelOutcome.selected ||
    !transferToConnectionAirportOutcome.selected
  ) {
    // Carried into the degraded outcome, not dropped with the transfers. Issue #119's road
    // rule empties a leg far more often than it thins one, so this branch is where its
    // refusal usually lands and where the row that explains it has to read from.
    return withoutTransfers(stayCandidates, stay, withheld);
  }

  const landingBuffer = pickLandingToTransportTime(
    input.landingToTransportRules,
    input.connectionAirportSize,
  );
  // Buffered here, on every candidate, not only the pick — a traveller who picks a
  // different mode via TransportPicker still needs the same "time to actually reach the
  // street" padding the pipeline's own choice gets (issue #114). Re-deriving `transferToHotel`
  // from the buffered list (rather than buffering the already-picked transfer separately)
  // keeps exactly one code path decide "which one is best", never two that could disagree.
  const transferToHotelCandidates = transferToHotelOutcome.candidates.map(
    (transfer) => applyLandingBuffer(transfer, landingBuffer, input.sources),
  );
  const transferToHotel = pickBestTransfer(transferToHotelCandidates);
  if (!transferToHotel)
    return withoutTransfers(stayCandidates, stay, withheld); // unreachable: buffering cannot empty a non-empty list

  const transferToConnectionAirportCandidates =
    transferToConnectionAirportOutcome.candidates;
  const transferToConnectionAirport =
    transferToConnectionAirportOutcome.selected;

  return {
    stay,
    transferAnchor,
    transferToHotel,
    transferToConnectionAirport,
    stayCandidates,
    transferToHotelCandidates,
    transferToConnectionAirportCandidates,
    transferToHotelWithheld: withheld.transferToHotel,
    transferToConnectionAirportWithheld: withheld.transferToConnectionAirport,
  };
}
