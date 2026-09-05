/**
 * Issue #341: the building at an airport a traveller actually walks out of, as opposed to
 * the point the airport is published at.
 *
 * `Airport.coordinates` comes from OurAirports and is the runway reference point, near the
 * middle of the movement area. Nothing had ever needed the difference, because a car drives
 * the perimeter either way and two minutes of detour disappears into a driving estimate. A
 * walk is the mode that cannot absorb it.
 *
 * ## The measurement that produced this file
 *
 * Gatwick's published point is 51.1487, -0.1857. On `routing.openstreetmap.de/routed-foot`,
 * on 2026-09-05, that point is 304 m from the nearest way a pedestrian may use, on the
 * south-west perimeter, with the runway between it and both terminals. Asked to walk from
 * there to The Gatwick White House Hotel in Horley, OSRM answers 5.46 km and 1h 13m: a lap
 * of the airfield by Church Road and the Beehive Ring Road, past neither terminal.
 *
 * From the North Terminal, this file's answer for LGW, the same walk is 2.42 km and 32m.
 * From the South Terminal 2.28 km and 30m. The owner reported the walk as "arround 30 mins"
 * and filed the issue because the app offered a two-bus journey with a change instead.
 *
 * So the 45-minute walking cap in `domain/transfer.ts` did exactly what it was written to
 * do. It refused a 73-minute walk. The walk was 73 minutes because the app started it in
 * the middle of an airfield, and the cap is untouched by this fix.
 *
 * ## Why generated and not hand-checked
 *
 * A stopover can be any airport, which is the same argument `city-centres.ts` makes at
 * greater length. `scripts/prepare-airport-terminals.mjs` resolves every airport in the
 * dataset against OpenStreetMap's `aeroway=terminal` (keyless, ODbL) under a rule in
 * `scripts/terminal-match.mjs` that is separately tested, and writes
 * `airport-terminals.audit.tsv` naming the OSM element each row came from so any single one
 * can be opened on osm.org and checked.
 *
 * ## Absent is a real answer
 *
 * 3,089 of the dataset's 4,133 airports have a row. The rest have no terminal mapped, or one
 * within 250 m of the published point, where the correction could not change a routed
 * answer. Both come back `undefined` and every reader falls back to `Airport.coordinates`,
 * which is exactly today's behaviour. Nothing regresses at an airport this file has never
 * heard of.
 */

import type { Coordinates, IataAirportCode } from '$lib/domain';

let terminalsPromise: Promise<ReadonlyMap<IataAirportCode, Coordinates>> | null = null;

/**
 * Turns the generated file's `[latitude, longitude]` pairs into `Coordinates`.
 *
 * A row that is not two finite numbers is dropped rather than passed on, the same guard
 * `city-centres.ts` `parseCityCentres` makes and for the same reason: a `NaN` here would
 * reach a haversine and an OSRM URL, where it becomes a distance of `NaN km` and a request
 * for a route from nowhere. Absent is a state every reader already handles.
 *
 * Exported for its own test — this is the only place the file's shape is trusted.
 */
export function parseAirportTerminals(
	raw: Readonly<Record<string, readonly number[]>>
): ReadonlyMap<IataAirportCode, Coordinates> {
	const terminals = new Map<IataAirportCode, Coordinates>();
	for (const [iataCode, pair] of Object.entries(raw)) {
		const [latitude, longitude] = pair;
		if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
		terminals.set(iataCode, { latitude, longitude });
	}
	return terminals;
}

/**
 * Loads the generated table once and memoizes it, the same shape and for the same reason as
 * `city-centres.ts` `loadCityCentres`: a dynamic `import()` of a JSON file is its own chunk
 * under Vite, so nothing downloads until an airport is actually looked up.
 */
export function loadAirportTerminals(): Promise<ReadonlyMap<IataAirportCode, Coordinates>> {
	terminalsPromise ??= import('./airport-terminals.generated.json').then((mod) =>
		parseAirportTerminals(mod.default as Readonly<Record<string, readonly number[]>>)
	);
	return terminalsPromise;
}
