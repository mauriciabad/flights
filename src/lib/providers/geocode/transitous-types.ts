/**
 * Raw shapes returned by Transitous's `/api/v1/geocode` and `/api/v1/reverse-geocode`
 * endpoints (issue #64). Both answer with the same array-of-place shape — the only
 * difference is what goes in: free text for one, a `lat,lon` pair for the other — so one
 * type serves both. Verified against real responses on 2026-09-04, captured in this
 * adapter's test fixtures.
 *
 * Only the fields this adapter actually reads, same convention as
 * transfers/transitous-types.ts. The real payload also carries `tokens`, `id`, `score`,
 * `modes`, `importance` and a `category` on some rows — routing/ranking internals this
 * adapter never looks at, so typing them would make an unrelated upstream tweak a breaking
 * change here for no benefit.
 *
 * ## The scientific-notation trap
 *
 * A real response looks like `"lat":4.1403983999999994E1,"lon":2.175106E0`, not
 * `"lat":41.403984`. That is still a syntactically valid JSON number (the grammar allows an
 * exponent), so `JSON.parse` — and therefore `Response.json()` — decodes it into the
 * correct `number` with no special handling needed here; this comment and
 * transitous-mapper.test.ts's fixture exist so nobody "fixes" a phantom bug by adding a
 * manual decimal parse that would only break on this exact shape.
 */

export interface TransitousArea {
	name: string;
	/** Coarser is a lower number in Transitous's own scale (country is 2, a district can be
	 * 10+) — see transitous-mapper.ts for how this orders the candidate's disambiguation
	 * trail. */
	adminLevel: number;
	/** Whether this area matched a term in the query text, e.g. searching "Barcelona"
	 * marks the "Barcelona" area `true` on every candidate actually in Barcelona. Absent
	 * from a reverse-geocode response (nothing was typed to match against), so this
	 * adapter treats a missing value the same as `false`. */
	matched?: boolean;
}

export interface TransitousGeocodePlace {
	/** Wider than the `'STOP' | 'PLACE'` values seen so far — an OSM/GTFS aggregator adds
	 * categories over time, and an unrecognised one should still geocode, not vanish. */
	type: string;
	name: string;
	lat: number;
	lon: number;
	/** ISO 3166-1 alpha-2. Absent on the rare row with no country match (open ocean, a
	 * sliver of disputed territory) — kept optional rather than defaulted, per AGENTS.md
	 * "say what you do not know rather than guessing". */
	country?: string;
	/** IANA zone, e.g. "Europe/Madrid". Present on every place observed so far; treated as
	 * absent-but-recoverable rather than required, matching
	 * transfers/transitous-types.ts's `TransitousPlace.tz`. */
	tz?: string;
	areas?: TransitousArea[];
}

/** Both `/geocode` and `/reverse-geocode` resolve with a bare JSON array on success —
 * confirmed against the live API, no wrapper object. */
export type TransitousGeocodeResponse = TransitousGeocodePlace[];
