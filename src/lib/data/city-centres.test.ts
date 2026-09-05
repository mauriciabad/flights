import { describe, expect, it } from 'vitest';
import { loadCityCentres, parseCityCentres } from './city-centres';

describe('parseCityCentres', () => {
	it('reads a pair into Coordinates', () => {
		const centres = parseCityCentres({ LGW: [51.5085, -0.1257] });
		expect(centres.get('LGW')).toEqual({ latitude: 51.5085, longitude: -0.1257 });
	});

	it('drops a row that is not two finite numbers, rather than passing NaN on', () => {
		// Only reachable from a hand-edited or half-written generated file, and the point is
		// what happens next: `undefined` is a state every reader of `city.coordinates`
		// already handles, where NaN becomes a map marker in the void and a distance of
		// "NaN km" on a card.
		const centres = parseCityCentres({
			GOOD: [1, 2],
			SHORT: [1],
			EMPTY: [],
			NAN: [Number.NaN, 2],
			INF: [1, Number.POSITIVE_INFINITY]
		});
		expect([...centres.keys()]).toEqual(['GOOD']);
	});
});

describe('the generated table', () => {
	it('covers the acceptance trip and answers London with central London', async () => {
		const centres = await loadCityCentres();
		expect(centres.get('LGW')).toEqual({ latitude: 51.5085, longitude: -0.1257 });
		for (const code of ['MAN', 'BHX', 'FCO', 'PFO']) {
			expect(centres.get(code), code).toBeDefined();
		}
	});

	it('holds no row for an airport the hand-checked table already covers', async () => {
		// The generated file is deliberately written without them, so a reader of it never
		// finds a coordinate that disagrees with the one the app actually uses. `MXP` would
		// otherwise say Ferno, the village by the runway.
		const centres = await loadCityCentres();
		for (const code of ['BGY', 'MXP', 'LIN', 'MRS', 'OTP', 'BVC', 'ZAG', 'ATH', 'BRU', 'EDI']) {
			expect(centres.has(code), code).toBe(false);
		}
	});

	it('is every-row finite, since a bad row would reach a map projection', async () => {
		const centres = await loadCityCentres();
		expect(centres.size).toBeGreaterThan(3000);
		for (const [code, { latitude, longitude }] of centres) {
			expect(Number.isFinite(latitude) && Math.abs(latitude) <= 90, code).toBe(true);
			expect(Number.isFinite(longitude) && Math.abs(longitude) <= 180, code).toBe(true);
		}
	});
});
