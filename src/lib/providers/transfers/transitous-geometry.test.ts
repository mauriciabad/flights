/**
 * Issue #416: reading the shape MOTIS was already sending.
 *
 * `transitous-plan-ber-leg-geometry.json` is a real `/api/v1/plan` response captured on
 * 2026-09-06, Berlin Brandenburg airport (52.3667,13.5033) to Alexanderplatz
 * (52.5219,13.4132), one itinerary of five legs — walk, regional rail, walk, metro, walk.
 * Trimmed to the fields this adapter reads (turn-by-turn `steps` and the `debugOutput`
 * block removed), `legGeometry` kept exactly as it arrived.
 *
 * The two properties worth testing here are not "does a polyline decode". They are that
 * the SCALE is right and that the JOURNEY is whole, because both fail quietly. A
 * mis-scaled decode still produces a smooth line, just somewhere else; a journey missing
 * its walk legs still produces a line, just one that claims a straight run where a
 * traveller has 958 m on foot.
 */

import { describe, expect, it } from 'vitest';
import { greatCircleDistanceKm } from '../../domain';
import { decodeEncodedPolyline, transitItineraryPath } from './transitous-geometry';
import type { TransitousLeg, TransitousPlanResponse } from './transitous-types';
import berlinFixture from './fixtures/transitous-plan-ber-leg-geometry.json';
import bhxFixture from './fixtures/transitous-plan-bhx-unshaped-leg.json';

const RECORDED = berlinFixture as TransitousPlanResponse;
const LEGS = RECORDED.itineraries![0].legs;

/**
 * The owner's own acceptance route, Birmingham airport to Birmingham Central Backpackers,
 * captured on 2026-09-06 out of the response the running app received (the URL is in the
 * commit that added it). Kept because of one leg: MOTIS answers a platform-to-platform walk
 * with an empty `points` string, and nothing invented would have predicted that.
 */
const BHX_LEGS = (bhxFixture as TransitousPlanResponse).itineraries![0].legs;

/**
 * Two points in Wellington, New Zealand, encoded at precision 7 — the case that makes the
 * decoder's arithmetic worth writing by hand.
 *
 * 174.7762 degrees is 1,747,762,000 at this precision, and its zigzag encoding is
 * 3,495,524,000, past `2 ** 31`. Decoded with the `|=` and `<<` that every published copy
 * of this algorithm uses, that longitude comes back as -39.9721648: a point in the middle
 * of the Atlantic, on a line that is otherwise perfectly well formed and inside every
 * bound this file checks. No guard catches it. Only the arithmetic does.
 */
const WELLINGTON_PRECISION_7 = 'n}gnrW_t|qdgB~heA__|B';

describe('decodeEncodedPolyline', () => {
	it('decodes a captured MOTIS leg at the precision the response declares', () => {
		const walk = LEGS[0];
		const geometry = walk.legGeometry!;
		const points = decodeEncodedPolyline(geometry.points, 7);

		// MOTIS declares the point count alongside the string. Nothing in the adapter reads
		// it, which is what makes it useful here: an independent statement of the answer.
		expect(geometry.precision).toBe(7);
		expect(geometry.length).toBe(76);
		expect(points).toHaveLength(76);
		// Within a metre of the place MOTIS independently named as this leg's end, which is
		// the check that the scale is right rather than merely plausible.
		expect(
			greatCircleDistanceKm(points![points!.length - 1], {
				latitude: walk.to.lat,
				longitude: walk.to.lon
			})
		).toBeLessThan(0.001);
	});

	it('refuses the same string at the wrong precision instead of relocating the journey', () => {
		const walk = LEGS[0].legGeometry!;
		expect(decodeEncodedPolyline(walk.points, 7)).not.toBeUndefined();
		// At 5 the first point is latitude 5236.63087, which is not a place.
		expect(decodeEncodedPolyline(walk.points, 5)).toBeUndefined();
	});

	it('carries a longitude past 2 ** 31 without wrapping it into the Atlantic', () => {
		const points = decodeEncodedPolyline(WELLINGTON_PRECISION_7, 7);
		expect(points).toEqual([
			{ latitude: -41.2865, longitude: 174.7762 },
			{ latitude: -41.2901, longitude: 174.7826 }
		]);
	});

	it('refuses a truncated string rather than inventing the point it was cut off in', () => {
		const full = LEGS[0].legGeometry!.points;
		expect(decodeEncodedPolyline(full.slice(0, full.length - 1), 7)).toBeUndefined();
	});

	it('refuses a character the encoding does not use', () => {
		expect(decodeEncodedPolyline('}mzxe^ }hss`G', 7)).toBeUndefined();
	});

	it('refuses a precision that is not a whole number of decimal places', () => {
		const points = LEGS[0].legGeometry!.points;
		expect(decodeEncodedPolyline(points, 7.5)).toBeUndefined();
		expect(decodeEncodedPolyline(points, 0)).toBeUndefined();
		expect(decodeEncodedPolyline(points, Number.NaN)).toBeUndefined();
	});

	it('refuses a single point, since every consumer draws a line', () => {
		expect(decodeEncodedPolyline('}mzxe^}hss`G', 7)).toBeUndefined();
		expect(decodeEncodedPolyline('', 7)).toBeUndefined();
	});
});

describe('transitItineraryPath', () => {
	it('draws the whole journey, walks included, starting where the traveller does', () => {
		const path = transitItineraryPath(LEGS)!;
		expect(path.length).toBeGreaterThan(2);

		// The first leg is the 958 m walk to the station. If walks were dropped, this would
		// start at the platform instead, and the line from the traveller's own point to it
		// would be drawn as a real route it is not. The platform is 265 m from where the
		// walk begins as the crow flies, so the two candidates are far enough apart that
		// this cannot pass by coincidence.
		const firstWalk = decodeEncodedPolyline(LEGS[0].legGeometry!.points, 7)!;
		const platform = { latitude: LEGS[1].from.lat, longitude: LEGS[1].from.lon };
		expect(greatCircleDistanceKm(path[0], firstWalk[0])).toBeLessThan(0.001);
		expect(greatCircleDistanceKm(path[0], platform)).toBeGreaterThan(0.2);

		const lastLeg = LEGS[LEGS.length - 1];
		expect(
			greatCircleDistanceKm(path[path.length - 1], {
				latitude: lastLeg.to.lat,
				longitude: lastLeg.to.lon
			})
		).toBeLessThan(0.05);
	});

	it('thins the journey to something a preview can carry', () => {
		const raw = LEGS.reduce((total, leg) => total + (leg.legGeometry?.length ?? 0), 0);
		const path = transitItineraryPath(LEGS)!;

		expect(raw).toBe(705);
		// The number is not the point and will move if MOTIS re-surveys the line; the ratio
		// is. Storing 705 points of a journey nothing draws wider than about 1,200 px costs
		// 32.7 kB against a 5 MB budget shared by every provider (`cache/constants.ts`).
		expect(path.length).toBeLessThan(raw / 5);
		expect(JSON.stringify(path).length).toBeLessThan(6000);
	});

	it('bridges the empty geometry a real MOTIS answer contains, rather than losing the route over it', () => {
		// The owner's own acceptance route, captured through the app on 2026-09-06 (see
		// `BHX_LEGS`). Leg 3 is `{"points": "", "length": 0, "precision": 6}` and its two ends
		// are 83 m apart, so the picture loses a platform-to-platform walk and keeps 11.2 km
		// of real road. Refusing here — which is what this file did first — put the leg back
		// on the dashed straight line issue #416 exists to remove, on the exact route the
		// issue was written about.
		const unshaped = BHX_LEGS[2];
		expect(unshaped.legGeometry?.length).toBe(0);
		const gapKm = greatCircleDistanceKm(
			{ latitude: unshaped.from.lat, longitude: unshaped.from.lon },
			{ latitude: unshaped.to.lat, longitude: unshaped.to.lon }
		);
		expect(gapKm).toBeLessThan(0.1);

		const path = transitItineraryPath(BHX_LEGS)!;
		expect(path.length).toBeGreaterThan(20);
	});

	it('refuses the path when the leg with no shape is long enough to read as a road', () => {
		// The same fixture with the 14 km rail leg's shape taken away. That is not a join a
		// drawing can absorb, it is most of the journey, and a straight line across it tagged
		// `'real'` is precisely what the dash exists to say instead.
		const gutted: TransitousLeg[] = BHX_LEGS.map((leg) =>
			leg.mode === 'LONG_DISTANCE' ? { ...leg, legGeometry: undefined } : leg
		);
		expect(transitItineraryPath(gutted)).toBeUndefined();
	});

	it('gives up when a long leg carries a shape with no precision to read it at', () => {
		const unscaled: TransitousLeg[] = LEGS.map((leg, index) =>
			index === 1 ? { ...leg, legGeometry: { points: leg.legGeometry!.points } } : leg
		);
		expect(transitItineraryPath(unscaled)).toBeUndefined();
	});

	it('gives up on an itinerary with no legs at all', () => {
		expect(transitItineraryPath([])).toBeUndefined();
	});
});
