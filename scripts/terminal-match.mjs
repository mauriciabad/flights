// The rule that decides which OpenStreetMap building is an airport's passenger terminal
// (issue #341). Pure and separately tested in terminal-match.test.mjs, for the same reason
// city-centre-match.mjs is: this is where a wrong answer would hide. A table that quietly
// points at a cargo shed is worse than no table at all, because the app would then route a
// walk from the freight apron with total confidence.
//
// The runner (prepare-airport-terminals.mjs) does the downloading. Everything here is a
// function of its arguments.

/** Great-circle kilometres. Same formula as `src/lib/geo`, repeated here because a build
 * script cannot import a `$lib` alias and this is four lines. */
export function haversineKm(a, b) {
	const earthRadiusKm = 6371;
	const toRadians = (degrees) => (degrees * Math.PI) / 180;
	const dLat = toRadians(b.latitude - a.latitude);
	const dLon = toRadians(b.longitude - a.longitude);
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLon / 2) ** 2;
	return 2 * earthRadiusKm * Math.asin(Math.sqrt(h));
}

/**
 * How far a terminal is allowed to be from the runway point it is claimed to serve.
 *
 * 6 km, which sounds enormous for a building on the same site and is not. An airport's
 * published coordinate is its reference point, roughly the middle of the movement area, and
 * at a big two-runway field the terminals sit well off it: the widest genuine match in the
 * current dataset is 5.9 km. What this bound is really for is the other failure, two
 * airports close enough to steal each other's buildings, and `chooseTerminal` handles that
 * case directly by giving every terminal to its own nearest airport before this applies.
 */
export const MAX_TERMINAL_DISTANCE_KM = 6;

/**
 * The smallest correction worth shipping to a phone.
 *
 * 250 m. Below this the terminal and the published point are effectively the same place, so
 * the row would cost bytes and change no answer: measured against `routed-foot` on
 * 2026-09-05, OSRM's own nearest-way snap at twenty large airports ranged from 1 m to
 * 446 m, so a correction under a quarter of a kilometre is inside the distance the router
 * already moves the origin to reach a footpath.
 *
 * It is also what keeps the generated file honest about its own purpose. Every row in it
 * exists because it moves a routed answer.
 */
export const MIN_SHIFT_KM = 0.25;

/**
 * Buildings tagged `aeroway=terminal` that no passenger walks out of.
 *
 * OSM uses that tag for the whole family of airside buildings, so the freight sheds and the
 * maintenance hangars come back in the same query as the passenger halls. Excluded by
 * `building` value rather than by guesswork: a hangar is a hangar.
 */
export const EXCLUDED_BUILDING_VALUES = new Set([
	'hangar',
	'warehouse',
	'industrial',
	'construction',
	'ruins'
]);

/**
 * Name fragments that mark a terminal as one scheduled passengers do not use, matched
 * case-insensitively against `name` and `name:en`.
 *
 * Cargo in five languages, plus the two kinds of building that serve real passengers who
 * are not the ones this app plans for: general-aviation and fixed-base-operator terminals,
 * which handle private aircraft. Stansted is the case that motivated the second half —
 * `Harrods Aviation` is 640 m from the runway point and is a private jet centre, and
 * without this it would out-compete the passenger terminal by a few metres.
 */
export const EXCLUDED_NAME_FRAGMENTS = [
	'cargo',
	'freight',
	'fracht',
	'fret',
	'carga',
	'maintenance',
	'general aviation',
	'business aviation',
	'harrods aviation',
	'private jet',
	'executive aviation'
];

/**
 * Whether this OSM element is a building a departing passenger stands in.
 *
 * @param {{building?: string, name?: string, nameEn?: string}} terminal
 */
export function isPassengerTerminal(terminal) {
	if (terminal.building && EXCLUDED_BUILDING_VALUES.has(terminal.building)) return false;
	const names = [terminal.name, terminal.nameEn].filter(Boolean).join(' ').toLowerCase();
	return !EXCLUDED_NAME_FRAGMENTS.some((fragment) => names.includes(fragment));
}

/**
 * @typedef {object} Terminal
 * @property {string} id OSM type/id, so any accepted row can be opened at openstreetmap.org/<id>
 * @property {string} name
 * @property {number} latitude
 * @property {number} longitude
 */

/**
 * Picks one terminal for an airport, or nothing.
 *
 * Nearest wins, and the deliberate alternative was the centroid of every terminal on the
 * site. Both fix the bug this table exists for — at Gatwick they land 700 m apart and the
 * walk to the acceptance hotel comes out at 32m and 31m respectively, against 73m from the
 * published point — and nearest is the one that can be checked. It always names a building
 * a reviewer can open on osm.org, where a centroid names a spot on the apron between two.
 *
 * The consequence to know about is that at a big airport this answers a pier rather than
 * the main hall: Vienna resolves to `Pier Nord`, Zurich to `Dock E`. Those are places
 * passengers genuinely stand, and they are a few hundred metres from the hall, which is an
 * order below the error being corrected.
 *
 * `candidates` must already be filtered to terminals whose own nearest airport is this one.
 * Two fields sharing a city otherwise trade buildings across the radius below.
 *
 * The shift is measured against the ROUNDED coordinate, which is the one that ships. The
 * two differ by up to 11 m and that is enough to matter at the floor: measured against the
 * first draft of this file, Loja lands at 0.2504 km unrounded and 0.2499 rounded, so the
 * file claimed a row the rule would have refused. `airport-terminals.test.ts` checks the
 * agreement over every shipped row, and that is what caught it.
 *
 * @param {{latitude: number, longitude: number}} airport
 * @param {readonly Terminal[]} candidates
 * @returns {{terminal: Terminal, latitude: number, longitude: number, km: number} | null}
 */
export function chooseTerminal(airport, candidates) {
	let best = null;
	for (const terminal of candidates) {
		const point = {
			latitude: roundCoordinate(terminal.latitude),
			longitude: roundCoordinate(terminal.longitude)
		};
		const km = haversineKm(airport, point);
		if (km > MAX_TERMINAL_DISTANCE_KM) continue;
		if (!best || km < best.km) best = { terminal, ...point, km };
	}
	if (!best || best.km < MIN_SHIFT_KM) return null;
	return best;
}

/** Four decimals is about 11 m. A terminal is a building a hundred metres across, and this
 * ships to a phone, so the digits past that are noise with a byte cost. Same precision as
 * `city-centre-match.mjs` uses for the same reason. */
export function roundCoordinate(value) {
	return Number(value.toFixed(4));
}
