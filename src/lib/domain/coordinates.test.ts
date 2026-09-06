import { describe, expect, it } from 'vitest';
import { thinRoutePath, type Coordinates } from './coordinates';

/** A straight run east from Barcelona airport, `count` points over `spanDegrees`. */
function straightRun(count: number, spanDegrees: number): Coordinates[] {
	return Array.from({ length: count }, (_, i) => ({
		latitude: 41.2971,
		longitude: 2.0785 + (spanDegrees * i) / (count - 1)
	}));
}

describe('thinRoutePath', () => {
	it('keeps both ends, because they are the itinerary\'s own endpoints', () => {
		const path = straightRun(50, 0.2);
		const thinned = thinRoutePath(path);

		expect(thinned[0]).toEqual({ latitude: 41.2971, longitude: 2.0785 });
		expect(thinned[thinned.length - 1].longitude).toBeCloseTo(2.2785, 5);
	});

	it('collapses a straight road to the two points it always was', () => {
		expect(thinRoutePath(straightRun(200, 0.2))).toHaveLength(2);
	});

	it('keeps a bend a preview would show', () => {
		// A right-angle detour half a kilometre off the direct line, on a 20 km leg. That is
		// three pixels on a 120-unit box and it is the difference between "the road goes
		// round the hill" and "the road does not".
		const path: Coordinates[] = [
			{ latitude: 41.2971, longitude: 2.0785 },
			{ latitude: 41.3421, longitude: 2.1785 },
			{ latitude: 41.2971, longitude: 2.2785 }
		];

		expect(thinRoutePath(path)).toHaveLength(3);
	});

	it('drops a wobble nothing can draw', () => {
		// Ten centimetres off the line, on a 20 km leg: a ten-thousandth of the picture at
		// the widest anything here renders one.
		const path: Coordinates[] = [
			{ latitude: 41.2971, longitude: 2.0785 },
			{ latitude: 41.29711, longitude: 2.1785 },
			{ latitude: 41.2971, longitude: 2.2785 }
		];

		expect(thinRoutePath(path)).toHaveLength(2);
	});

	it('scales its tolerance to the leg, so a short walk is not flattened', () => {
		// The same shape at two sizes. A 200 m walk with a 5 m dogleg is as much of a bend,
		// proportionally, as a 20 km drive with a 500 m one, and a fixed tolerance in metres
		// would keep one and lose the other.
		const short: Coordinates[] = [
			{ latitude: 41.2971, longitude: 2.0785 },
			{ latitude: 41.29755, longitude: 2.0795 },
			{ latitude: 41.2971, longitude: 2.0805 }
		];

		expect(thinRoutePath(short)).toHaveLength(3);
	});

	it('leaves a path with nothing to thin alone', () => {
		const pair = straightRun(2, 0.1);

		expect(thinRoutePath(pair)).toEqual(pair);
		expect(thinRoutePath([])).toEqual([]);
	});

	it('survives a route that never moves, rather than dividing by its own extent', () => {
		const here = { latitude: 41.2971, longitude: 2.0785 };

		expect(thinRoutePath([here, here, here])).toEqual([here, here]);
	});

	it('rounds to a metre, which is finer than anything it keeps', () => {
		const thinned = thinRoutePath([
			{ latitude: 41.29710123456, longitude: 2.07850987654 },
			{ latitude: 41.3421, longitude: 2.1785 },
			{ latitude: 41.29713, longitude: 2.2785 }
		]);

		expect(thinned[0]).toEqual({ latitude: 41.2971, longitude: 2.07851 });
	});

	it('cuts a real airport transfer to something a card can carry', () => {
		// Six hundred points of road over 14 km, the shape OSRM's `overview=full` returns.
		// Caching that whole was measured at 40.4 kB a route against a 5 MB budget shared by
		// every provider; what a picture needs is nearer forty points.
		const road: Coordinates[] = Array.from({ length: 600 }, (_, i) => ({
			latitude: 41.2971 + 0.08 * (i / 599) + Math.sin(i / 7) * 0.0004,
			longitude: 2.0785 + 0.09 * (i / 599) + Math.cos(i / 5) * 0.0004
		}));
		const thinned = thinRoutePath(road);

		expect(thinned.length).toBeLessThan(200);
		expect(thinned.length).toBeGreaterThan(10);
	});
});
