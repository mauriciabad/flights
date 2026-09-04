/**
 * Raw shapes returned by Transitous's `/api/v1/plan` endpoint (a MOTIS v2 server, whose
 * REST API is OTP-compatible). Verified against real responses on 2026-09-04 — see the
 * commit that added this file for the captured examples this was trimmed from.
 *
 * Only the fields this adapter actually reads. The real payload is much larger (routing
 * geometry, turn-by-turn walking steps, a `debugOutput` counters block), and typing those
 * too would make an unrelated schema change somewhere this adapter never looks a breaking
 * change here. `direct` (walk/bike/car door-to-door itineraries with no transit vehicle)
 * is intentionally untyped beyond its presence: this adapter answers the transit-timetable
 * question only (docs/PROVIDERS.md splits walking/driving duration to a future OSRM
 * adapter), so nothing here ever reads inside it.
 */

export interface TransitousPlace {
	name?: string;
	lat: number;
	lon: number;
	/** IANA zone name, e.g. "Europe/Madrid". Present on every place in every response seen
	 * so far; treated as absent-but-recoverable (falls back to UTC) rather than required,
	 * in case a feed Transitous aggregates ever omits it. */
	tz?: string;
}

/**
 * OTP/MOTIS's leg mode vocabulary is larger than this union enumerates (GTFS defines
 * dozens of route types, and MOTIS adds its own street modes on top). Widened to `string`
 * on purpose: an unrecognised mode should fall back to a generic "Transit" label
 * (transitous-mapper.ts), not fail the whole leg.
 */
export type TransitousLegMode =
	| 'WALK'
	| 'BIKE'
	| 'CAR'
	| 'TRAM'
	| 'SUBWAY'
	| 'METRO'
	| 'RAIL'
	| 'BUS'
	| 'COACH'
	| 'FERRY'
	| 'CABLE_CAR'
	| 'GONDOLA'
	| 'FUNICULAR'
	| 'REGIONAL_RAIL'
	| 'REGIONAL_FAST_RAIL'
	| 'LONG_DISTANCE'
	| 'NIGHT_RAIL'
	| 'HIGHSPEED_RAIL'
	| (string & {});

export interface TransitousLeg {
	mode: TransitousLegMode;
	from: TransitousPlace;
	to: TransitousPlace;
	/** Seconds. */
	duration: number;
	/** UTC instant, e.g. "2026-09-10T09:02:00Z". The actual (possibly real-time-adjusted)
	 * time, as opposed to `scheduledStartTime`, which this adapter does not read — a
	 * traveller planning around a departure cares what will actually happen, not what the
	 * timetable said before today's delays. */
	startTime: string;
	endTime: string;
	/** Metres. Present on WALK legs, absent on transit legs. */
	distance?: number;
	/** e.g. "46", "L1". Absent for some feeds; fall back to `routeLongName`. */
	routeShortName?: string;
	/** e.g. "Pl. Espanya / Aeroport BCN". */
	routeLongName?: string;
	/** Direction of travel as shown at the stop, e.g. "Aeroport BCN". */
	headsign?: string;
	/** Operator, e.g. "TMB". Empty string and absent both mean "unknown" — callers should
	 * treat them the same. */
	agencyName?: string;
}

export interface TransitousItinerary {
	/** Seconds, door to door. */
	duration: number;
	startTime: string;
	endTime: string;
	transfers: number;
	legs: TransitousLeg[];
}

export interface TransitousPlanResponse {
	/** Itineraries that use at least one transit vehicle. Chronologically ordered by
	 * `startTime` in every response observed — verified empirically, not documented by
	 * Transitous, so transitous-mapper.ts re-derives the earliest rather than trusting
	 * array order blindly for anything safety-relevant. */
	itineraries?: TransitousItinerary[];
	/** Walk/bike/car itineraries needing no transit vehicle at all. Never read by this
	 * adapter — see the file header. */
	direct?: TransitousItinerary[];
	/** Present on some error responses instead of a 2xx body; this adapter treats any
	 * non-2xx HTTP status as the error signal (transitous-client.ts) and only keeps this
	 * field typed so a body containing it doesn't fail a naive shape check. */
	error?: string;
}
