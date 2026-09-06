/**
 * The shape of a transit journey, decoded out of the `/plan` response this adapter was
 * already receiving (issue #416).
 *
 * Every leg MOTIS returns carries a `legGeometry`, and until this file nothing read it, so
 * a stopover transfer drew the dashed straight line `segments.ts` falls back to when no
 * provider gave a shape. That fallback was correct at the time and is wrong now: the shape
 * was in the payload, already fetched, already waited for. `docs/PROVIDERS.md` and the
 * owner's own request ("the ground transport to show more details because they are zoomed
 * in", #408) both point at the leg a traveller looks at most, which on a stopover is this
 * one.
 *
 * Nothing here makes a request. The whole file is a pure function of a response the app
 * has in hand.
 *
 * ## What the wire actually holds, measured
 *
 * Berlin BER to Alexanderplatz, `api.transitous.org`, 2026-09-06, one `/plan` call:
 *
 * | leg | declared `length` | decoded points |
 * | --- | --- | --- |
 * | WALK | 76 | 76 |
 * | REGIONAL_RAIL | 471 | 471 |
 * | WALK | 13 | 13 |
 * | METRO | 112 | 112 |
 * | WALK | 33 | 33 |
 *
 * `precision` was `7` on every leg of every response measured, which is MOTIS's own choice
 * and not the `5` an OTP-compatible API is usually assumed to send. Decoding a
 * precision-7 line at 5 puts Berlin at latitude 5252, so this is the one field that cannot
 * be guessed — see `decodeEncodedPolyline`, which requires it and refuses rather than
 * defaulting.
 *
 * A present `legGeometry` is not the same as a shape, either: MOTIS answers a leg it did
 * not route with an empty `points` string. `transitItineraryPath` below says what happens
 * then, and it is the part of this file a live run rewrote.
 */

import type { Coordinates } from '../../domain';
import { greatCircleDistanceKm, thinRoutePath } from '../../domain';
import type { TransitousLeg, TransitousPlace } from './transitous-types';

/**
 * How long a straight line this file drew itself may be, as a fraction of the journey it
 * sits inside, before the whole path is refused. See `transitItineraryPath` for where the
 * number comes from and the live response that made it necessary.
 */
const MAX_UNSHAPED_LEG_FRACTION = 1 / 50;

/**
 * One variable-length integer out of a Google-encoded polyline, plus where the next one
 * starts. `undefined` if the string ran out mid-value or holds a character the encoding
 * does not use.
 *
 * The arithmetic is deliberately `+=` and `2 ** shift` rather than the `|=` and `<<` every
 * published snippet of this algorithm uses. JavaScript's bitwise operators truncate to 32
 * bits, and at precision 7 a longitude of 150 degrees is 1,500,000,000, whose zigzag
 * encoding is 3,000,000,000 — past `2 ** 31`, so `|=` would hand back a negative number
 * and the arithmetic shift that follows would decode the southern Pacific into nonsense.
 * It happens to work everywhere in Europe, which is exactly why it is worth spelling out:
 * the bug would have shipped and appeared only for a traveller flying to Auckland.
 */
function readVarint(encoded: string, start: number): { value: number; next: number } | undefined {
	let result = 0;
	let shift = 0;
	let index = start;
	let chunk: number;
	do {
		// A varint that runs off the end of the string is a truncated body, not a short
		// route. `charCodeAt` past the end returns `NaN`, which `& 0x1f` silently turns into
		// a zero-valued continuation, so without this check a cut-off response decodes into
		// a plausible-looking point that is simply wrong.
		if (index >= encoded.length) return undefined;
		chunk = encoded.charCodeAt(index++) - 63;
		if (chunk < 0 || chunk > 63) return undefined;
		result += (chunk & 0x1f) * 2 ** shift;
		shift += 5;
		// Doubles count integers exactly to 2 ** 53, and the largest real delta here is
		// under 2 ** 32. A varint longer than this is a corrupted string.
		if (shift > 50) return undefined;
	} while (chunk >= 0x20);
	return { value: result, next: index };
}

/** Zigzag: an even encoding is a positive delta, an odd one is negative. */
function zigzag(value: number): number {
	return value % 2 === 1 ? -(value + 1) / 2 : value / 2;
}

/**
 * A `legGeometry.points` string as coordinates, or `undefined` when it cannot be read as
 * one.
 *
 * `precision` is a parameter with no default on purpose. It decides the scale of every
 * number that comes out, so a wrong one does not degrade the answer, it relocates the
 * journey; and MOTIS sends the field on every leg (see the file header), so the only way
 * to arrive here without one is a schema change, which should surface as a leg that draws
 * dashed rather than a leg that draws a route across the wrong continent.
 *
 * The latitude/longitude bound below is what catches that class of mistake even if a
 * caller does supply a wrong number. It is not a range check on the data, which is already
 * a coordinate by construction — it is the assertion that the scale was right, and the
 * only cheap one available: at precision 5 the Berlin line above decodes to latitude
 * 5252.51496, which fails on the first point.
 *
 * Fewer than two points is `undefined` rather than a one-point path, because everything
 * downstream (`segments.ts`'s `transferLine`) treats a path as a line to draw.
 */
export function decodeEncodedPolyline(encoded: string, precision: number): Coordinates[] | undefined {
	if (!Number.isInteger(precision) || precision < 1 || precision > 10) return undefined;
	const factor = 10 ** precision;

	const points: Coordinates[] = [];
	let index = 0;
	let latitudeUnits = 0;
	let longitudeUnits = 0;
	while (index < encoded.length) {
		const latitude = readVarint(encoded, index);
		if (!latitude) return undefined;
		const longitude = readVarint(encoded, latitude.next);
		if (!longitude) return undefined;
		index = longitude.next;

		latitudeUnits += zigzag(latitude.value);
		longitudeUnits += zigzag(longitude.value);
		const point = { latitude: latitudeUnits / factor, longitude: longitudeUnits / factor };
		if (Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) return undefined;
		points.push(point);
	}
	return points.length >= 2 ? points : undefined;
}

/**
 * The whole journey as one line: every leg's own shape, in order, thinned to what a
 * drawing can carry.
 *
 * ## Walking legs are part of the stroke
 *
 * A transit transfer is a walk, a ride, sometimes another walk and another ride, and the
 * walks are what make this a continuous line rather than a set of disconnected rides.
 * Measured on the Berlin plan in the header, each leg's decoded shape ends within a few
 * metres of where the next one starts (6 m, 7 m and 46 m at the three joins; the tolerance
 * `thinRoutePath` applies to that journey is about 130 m), so concatenating them needs no
 * stitching and leaves no visible seam.
 *
 * Leaving the walks out was the alternative, and it is worse in the one way that matters
 * here. The station approach on that plan is 958 m; drop it and the line runs dead straight
 * from the traveller's door to the platform, tagged `'real'`, which is the precise thing
 * the dashed style exists to prevent. Drawing them as a *second*, differently stroked line
 * needs `Transfer.path` to stop being one `Coordinates[]`, which reaches `segments.ts`,
 * `previews.ts`, `RoutePreview.svelte`, `ItineraryMap` and the cached shape — a large
 * change for a distinction that is a few pixels wide in a 100 px thumbnail.
 *
 * ## A leg with no shape is bridged, up to a point
 *
 * This started as all-or-nothing and a live run says that is wrong. Asked for the owner's
 * own acceptance route on 2026-09-06, Birmingham airport to Birmingham Central Backpackers,
 * MOTIS answered a seven-leg itinerary in which one leg is
 * `{"points": "", "length": 0, "precision": 6}` — a platform-to-platform walk it did not
 * route. Its two ends are 83 m apart. Refusing the whole path over that threw away 11.2 km
 * of real road and left the leg drawing the same dashed straight line the issue is about,
 * which is how this rule got measured instead of assumed.
 *
 * So an unshaped leg contributes the straight line between its own two endpoints, and the
 * bound is on how long that line is: **one fiftieth of the journey's own straight-line
 * extent**, past which the whole path is refused and the leg goes back to the honest dash.
 *
 * The fraction is derived rather than picked. `RENDERED_RESOLUTION` in
 * `domain/coordinates.ts` records that nothing here draws a leg across more than about
 * 1,200 device pixels, so a fiftieth of the extent is about 24 px on the widest drawing
 * this app makes: the width at which a straight run stops being a join and starts reading
 * as a deliberately straight road. The BHX gap is 0.7% of its journey, about 9 px.
 *
 * Per gap rather than summed, on the house rule every other bound in this codebase states
 * (`SLOWEST_USEFUL_TRANSIT_KM_PER_HOUR`, `FASTEST_PLAUSIBLE_WALK_KM_PER_HOUR`): where the
 * evidence runs out it runs out on the loose side, because deleting a journey somebody
 * would take is the more expensive mistake. Five scattered one-pixel joins are not one
 * straight road and must not be refused as though they were.
 *
 * The total is deliberately not bounded as well, and does not need to be. Any single gap
 * over a fiftieth refuses the whole path, so assembling an invented journey purely out of
 * joins would take fifty legs, and MOTIS answers these queries with between three and
 * eight.
 *
 * ## Thinned here, not at the drawing
 *
 * The same reason `providers/transfers/osrm.ts` thins before caching: the value this
 * returns is what `transitous.ts` stores, and the store is 5 MB shared across every
 * provider (`cache/constants.ts`). Measured on the two live plans that answered on
 * 2026-09-06, raw against thinned: Berlin 705 points and 32.7 kB against 54 points and
 * 2.3 kB, Paris CDG to Chatelet 570 points and 25.3 kB against 71 points and 3.0 kB.
 */
export function transitItineraryPath(legs: readonly TransitousLeg[]): Coordinates[] | undefined {
	if (legs.length === 0) return undefined;
	const journeyKm = greatCircleDistanceKm(placeOf(legs[0].from), placeOf(legs[legs.length - 1].to));
	// A journey that ends where it started has no extent for a gap to be a fraction of, and
	// nothing worth drawing either.
	if (!(journeyKm > 0)) return undefined;
	const longestBridge = journeyKm * MAX_UNSHAPED_LEG_FRACTION;

	const path: Coordinates[] = [];
	for (const leg of legs) {
		const decoded = decodeLegGeometry(leg);
		if (decoded) {
			for (const point of decoded) path.push(point);
			continue;
		}
		const from = placeOf(leg.from);
		const to = placeOf(leg.to);
		if (greatCircleDistanceKm(from, to) > longestBridge) return undefined;
		path.push(from, to);
	}
	return path.length >= 2 ? thinRoutePath(path) : undefined;
}

/** The shape MOTIS sent for one leg, or `undefined` when it sent none it can be read from
 *  — an absent `legGeometry`, an empty `points` string, or a `precision` that is not a
 *  number to scale by. All three mean the same thing to the caller. */
function decodeLegGeometry(leg: TransitousLeg): Coordinates[] | undefined {
	const geometry = leg.legGeometry;
	if (typeof geometry?.points !== 'string' || typeof geometry.precision !== 'number') return undefined;
	return decodeEncodedPolyline(geometry.points, geometry.precision);
}

function placeOf(place: TransitousPlace): Coordinates {
	return { latitude: place.lat, longitude: place.lon };
}
