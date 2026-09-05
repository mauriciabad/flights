/**
 * Issue #267: routing the two in-city legs for a property the search never picked.
 *
 * `fetchConnectionResources` routes to exactly one destination per connection,
 * `stay?.property.coordinates ?? connectionCityCentre`, so every other bed in
 * `stayCandidatesByConnection` arrives with a price, a rating and coordinates and no
 * journey at all. #264 made that honest: swap to one of them and both legs read "Nothing
 * routed to this property, so the journey to it is unknown." True, and not what a
 * traveller wants when the bed is 2.8 km from the terminal.
 *
 * This asks the same question `fetchConnectionResources` asks, for one property, after the
 * search has finished. It lives here rather than in the panel for two reasons. The provider
 * fan-out, the plausibility gate and the landing buffer are all `resources.ts`'s rules, and
 * a second copy of them in a `.svelte` file is how the two would drift. And a plain
 * exported async function is unit-testable without a Svelte runtime, which is the whole
 * argument `results/search-dependencies.ts` makes next door.
 *
 * ## Why this costs what it costs
 *
 * Two legs, road modes only. `servesAnyRequestedMode` therefore leaves Transitous out of
 * the call entirely, so this is OSRM and nothing else, and OSRM is free (AGENTS.md, "the
 * owner's quota"). Inside `searchTransfersImpl` a walk and a drive are two separate route
 * requests, and `walkIsWorthRouting` skips the walk for anything far, so one near property
 * costs 4 requests and one far property costs 2. Every answer is written to the 30-day
 * route cache under the same key `fetchConnectionResources` would have used, so the second
 * traveller to compare the same beds on the same trip pays nothing.
 *
 * The taxi fare estimate comes free with the route, since issue #249: OSRM rates the
 * driving distance it already fetched and hands the range back on the taxi `Transfer`
 * itself. Not a second provider call, not a second request, and without it a bed swap
 * would leave the receipt saying "not priced" for a ride the same screen priced a moment
 * earlier under a different bed.
 */

import type {
  AirportSizeClass,
  Coordinates,
  IsoCountryCode,
  LandingToTransportRule,
  Transfer,
} from "../domain";
import type {
  AvailableKeys,
  ProviderResult,
  TransferProvider,
} from "../providers/types";
import {
  ROAD_TRANSFER_MODES,
  applyLandingBuffer,
  fetchBestTransfer,
  pickBestTransfer,
  pickLandingToTransportTime,
} from "./resources";
import { SourceTracker } from "./provenance";
import type { RecordProviderCall } from "./provenance";

export interface RouteToPropertyInput {
  /** The connection airport the traveller lands at and leaves from. */
  connectionCoordinates: Coordinates;
  /** The property they just picked. */
  propertyCoordinates: Coordinates;
  transferProviders: readonly TransferProvider[];
  keys: AvailableKeys;
  signal: AbortSignal;
  /** The same two inputs `fetchConnectionResources` runs `pickLandingToTransportTime`
   * over, so the padding on the leg that starts at a runway is picked by one function
   * rather than by two that could drift. Without it a bed routed here would arrive several
   * minutes earlier than the identical bed routed by the pipeline, and the free-time window
   * would disagree with itself depending on which code path produced it. */
  landingToTransportRules: readonly LandingToTransportRule[];
  connectionAirportSize: AirportSizeClass;
  /** The connection airport's own country, so a taxi routed here is rated against the same
   * card `fetchConnectionResources` would have used (issue #249). Absent means no estimate
   * for this bed, never one borrowed from a neighbouring country. */
  connectionCountryCode?: IsoCountryCode;
  /** Where a provider call gets reported. The panel does not feed the search-wide status
   * map (this call happens after the search is over and would make "Ryanair answered
   * twice" wrong), so this exists so a failure has somewhere to go rather than being
   * swallowed — AGENTS.md, "show the error you got, never the one you assumed". */
  record: RecordProviderCall;
}

/**
 * What routing to one property produced. A tagged union rather than an optional pair plus
 * a boolean, because the three outcomes read differently on screen and #243's whole lesson
 * was that a half-known journey shown as a known one is worse than no journey at all.
 *
 * `no-route` is a provider that answered and had nothing (or had something
 * `isPlausibleTransfer` refused, which is #119's 11h walk). `failed` is a provider that
 * could not be asked. The panel says different sentences for those and must not merge them.
 */
export type PropertyRouting =
  | {
      kind: "routed";
      transferToHotel: Transfer;
      transferToConnectionAirport: Transfer;
    }
  | { kind: "no-route" }
  | { kind: "failed"; message: string };

export async function routeToProperty(
  input: RouteToPropertyInput,
): Promise<PropertyRouting> {
  const {
    connectionCoordinates,
    propertyCoordinates,
    transferProviders,
    keys,
    signal,
    landingToTransportRules,
    connectionAirportSize,
    connectionCountryCode,
    record,
  } = input;

  // Local, not the search's. Nothing downstream of this call reads provenance back off
  // these transfers today; a tracker is required by `fetchBestTransfer`'s signature and
  // sharing the search's would attach entries to a search that has already ended.
  const sources = new SourceTracker();

  const [toHotel, toAirport] = await Promise.all([
    fetchBestTransfer(
      // Roads only, exactly as `fetchConnectionResources` asks. A timetable needs a
      // journey moment and `search/transit-schedule.ts` owns that question (issue #135);
      // asking for transit here would put a Transitous call behind every bed tap.
      {
        from: connectionCoordinates,
        to: propertyCoordinates,
        modes: [...ROAD_TRANSFER_MODES],
        countryCode: connectionCountryCode,
      },
      transferProviders,
      keys,
      signal,
      sources,
      record,
    ),
    fetchBestTransfer(
      {
        from: propertyCoordinates,
        to: connectionCoordinates,
        modes: [...ROAD_TRANSFER_MODES],
        countryCode: connectionCountryCode,
      },
      transferProviders,
      keys,
      signal,
      sources,
      record,
    ),
  ]);

  const failure = firstFailure([...toHotel.results, ...toAirport.results]);

  // Buffered on every candidate and the pick re-derived from the buffered list, which is
  // what `fetchConnectionResources` does and for the same reason: one code path decides
  // which transfer is best, never two that could disagree.
  const landingBuffer = pickLandingToTransportTime(
    landingToTransportRules,
    connectionAirportSize,
  );
  const transferToHotel = pickBestTransfer(
    toHotel.candidates.map((transfer) =>
      applyLandingBuffer(transfer, landingBuffer, sources),
    ),
  );
  const transferToConnectionAirport = toAirport.selected;

  // Both or neither. `recomputeItinerarySelection` reads the free-time window off
  // `transferToHotel` and the departure off `transferToConnectionAirport`, so handing it
  // one of the two would rebuild half the stopover from a real journey and leave the other
  // half describing nothing.
  if (!transferToHotel || !transferToConnectionAirport) {
    return failure ? { kind: "failed", message: failure } : { kind: "no-route" };
  }

  return { kind: "routed", transferToHotel, transferToConnectionAirport };
}

/**
 * The first provider error verbatim, never this app's own paraphrase of it, and with the
 * HTTP status where `ProviderError`'s union carries one. AGENTS.md is emphatic about that
 * last part: "`403` versus `200`-with-an-error-body is exactly the distinction that went
 * missing, and it is what eventually resolved this."
 */
function firstFailure(
  results: readonly ProviderResult<Transfer[]>[],
): string | undefined {
  for (const result of results) {
    if (result.ok) continue;
    const { error } = result;
    const code = "status" in error ? `${error.code} ${error.status}` : error.code;
    return error.message ? `${code}: ${error.message}` : code;
  }
  return undefined;
}
