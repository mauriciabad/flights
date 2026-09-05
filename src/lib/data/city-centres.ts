/**
 * Issue #198: a point in the middle of the city an airport serves, for the ~3,000 airports
 * nobody has hand-checked one for.
 *
 * `Airport.city.coordinates` is what the app routes a stopover transfer into and what it
 * measures "N km from the city centre" against. Issue #162 filled it from a hand-checked
 * table of ten airports and left it `undefined` everywhere else, which was the honest
 * answer at the time and also meant that on the trip docs/ACCEPTANCE.md uses to decide
 * whether this app works — Boa Vista to Pafos via London Gatwick — the feature the product
 * is named for rendered as two empty rows. LGW was not in the ten. Neither was any London
 * airport, nor MAN, nor BHX, which are the connection cities that trip actually returns.
 *
 * ## Why a generated table and not eleven more hand-checked rows
 *
 * A stopover can be any airport. The issue says it: "a table of eleven will always be
 * mostly misses". Adding LGW, MAN and BHX would have fixed the acceptance trip and left
 * the same hole one search to the left.
 *
 * So `scripts/prepare-city-centres.mjs` resolves every airport in the dataset against
 * GeoNames' `cities1000` (keyless, CC BY 4.0, downloaded once and committed), under a rule
 * strict enough that a reviewer can say why any single row passed: same country, the name
 * this app PRINTS for the airport's city matched against the place's own name, and no
 * further from the runway than 60 km. `scripts/city-centre-match.mjs` holds that rule and
 * is separately tested.
 *
 * ## The hand-checked table still wins
 *
 * `airport-city-names.ts` `cityCentreOf` is consulted first and this file second, and the
 * ten hand-checked airports are left out of the generated file entirely rather than
 * overwritten. That order is load-bearing, not politeness: those ten exist precisely
 * because their municipality names a different place from the city on the ticket, which is
 * the one shape a name-matching rule is most likely to get wrong.
 *
 * It is also what verifies the rule. Running the script with `--verify` reports how far its
 * answer lands from each hand-checked coordinate, and nine of the ten agree to within 2 km
 * (six of them within 0.5 km). The tenth is BVC: the rule answers Rabil, the village by the
 * runway, where the hand-checked value is Sal Rei 6.1 km away, because Sal Rei is where a
 * traveller would actually stay. That disagreement is why the curated layer exists.
 */

import type { Coordinates, IataAirportCode } from '$lib/domain';

let centresPromise: Promise<ReadonlyMap<IataAirportCode, Coordinates>> | null = null;

/**
 * Turns the generated file's `[latitude, longitude]` pairs into `Coordinates`.
 *
 * A row that is not two finite numbers is dropped rather than passed on. That can only
 * happen if the generated file was hand-edited or half-written, and the alternative is
 * `{latitude: NaN}` reaching a map projection and a haversine, where it becomes a marker
 * in the void and a distance of `NaN km`. Absent is a state every reader of
 * `Airport.city.coordinates` already handles; NaN is not.
 *
 * Exported for its own test — this is the only place the file's shape is trusted.
 */
export function parseCityCentres(
	raw: Readonly<Record<string, readonly number[]>>
): ReadonlyMap<IataAirportCode, Coordinates> {
	const centres = new Map<IataAirportCode, Coordinates>();
	for (const [iataCode, pair] of Object.entries(raw)) {
		const [latitude, longitude] = pair;
		if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
		centres.set(iataCode, { latitude, longitude });
	}
	return centres;
}

/**
 * Loads the generated table once and memoizes it, the same shape and for the same reason
 * as `airports.ts` `loadRows`: a dynamic `import()` of a JSON file is its own chunk under
 * Vite, so nothing downloads until an airport is actually looked up.
 *
 * The file stores `[latitude, longitude]` pairs at four decimals rather than objects,
 * because this ships to a phone and 3,000 copies of `{"latitude":…,"longitude":…}` is
 * 90 KB of key names.
 */
export function loadCityCentres(): Promise<ReadonlyMap<IataAirportCode, Coordinates>> {
	centresPromise ??= import('./city-centres.generated.json').then((mod) =>
		parseCityCentres(mod.default as Readonly<Record<string, readonly number[]>>)
	);
	return centresPromise;
}
