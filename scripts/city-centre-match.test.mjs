import { describe, expect, it } from 'vitest';
import {
	chooseCityCentre,
	haversineKm,
	MAX_CENTRE_DISTANCE_KM,
	normalizeCityName,
	roundCoordinate
} from './city-centre-match.mjs';

const place = (name, latitude, longitude, population, id = name) => ({
	id,
	name,
	latitude,
	longitude,
	population
});

// Real coordinates, so a failure here is about the rule and not about a fixture nobody
// can check. Each is the GeoNames record named in the audit file.
const LGW = { latitude: 51.148102, longitude: -0.190278 };
const LONDON = place('London', 51.50853, -0.12574, 8_961_989, '2643743');
const MXP = { latitude: 45.6306, longitude: 8.72811 };
const MILAN = place('Milan', 45.46427, 9.18951, 1_371_498, '3173435');
const FERNO = place('Ferno', 45.61667, 8.75, 6_008, '3177098');

describe('normalizeCityName', () => {
	it('ignores case, accents and punctuation', () => {
		expect(normalizeCityName('Sankt Pölten')).toBe('sankt polten');
		expect(normalizeCityName('SANKT-POLTEN')).toBe('sankt polten');
		expect(normalizeCityName("'s-Hertogenbosch")).toBe('s hertogenbosch');
	});

	it('does NOT fuzzy match, so Aarhus and Århus stay different', () => {
		// The runner's alternate-names pass is what pairs these, deliberately, rather than
		// an edit distance that would also pair Cork with Kork.
		expect(normalizeCityName('Aarhus')).not.toBe(normalizeCityName('Århus'));
	});
});

describe('haversineKm', () => {
	it('measures Gatwick to central London', () => {
		expect(haversineKm(LGW, LONDON)).toBeCloseTo(40.2, 0);
	});
});

describe('chooseCityCentre', () => {
	it('takes the nearest candidate in the best-named tier', () => {
		const chosen = chooseCityCentre(LGW, [[LONDON]]);
		expect(chosen?.place.id).toBe('2643743');
		expect(chosen?.km).toBeCloseTo(40.2, 0);
		expect(chosen?.tier).toBe(0);
	});

	it('lets the printed city name beat a nearer municipality in a later tier', () => {
		// Issue #198's sharpest case. Malpensa's municipality is Ferno, a village of 6,000
		// beside the runway; the app prints "Milan" and the traveller is going to Milan.
		// Sorting purely by distance answers Ferno and the app would then print a city
		// centre for a place it never calls the city.
		const chosen = chooseCityCentre(MXP, [[MILAN], [FERNO]]);
		expect(chosen?.place.name).toBe('Milan');
		expect(chosen?.tier).toBe(0);
	});

	it('falls through to a later tier when the best name finds nothing in range', () => {
		const chosen = chooseCityCentre(MXP, [[], [FERNO]]);
		expect(chosen?.place.name).toBe('Ferno');
		expect(chosen?.tier).toBe(1);
	});

	it('prefers the bigger place when two sit on top of each other', () => {
		// Bergamo's own shape: the runway is in Orio al Serio (1,662 people), and Bergamo
		// proper is a few hundred metres further on. Same conurbation, and the city is the
		// one a traveller means.
		const bgy = { latitude: 45.673889, longitude: 9.704166 };
		const orio = place('Orio al Serio', 45.66278, 9.69889, 1_662, 'orio');
		const bergamo = place('Bergamo', 45.69601, 9.66721, 121_200, 'bergamo');

		expect(chooseCityCentre(bgy, [[orio, bergamo]])?.place.name).toBe('Bergamo');
	});

	it('keeps the nearer place when the bigger one is a separate city', () => {
		// Beauvais is 85 km from Paris and is its own town. `alsoFoundAs` keeps it
		// searchable as Paris; it must never be TOLD it is Paris.
		const bva = { latitude: 49.454399, longitude: 2.11278 };
		const beauvais = place('Beauvais', 49.43333, 2.08333, 53_393, 'beauvais');
		const paris = place('Paris', 48.85341, 2.3488, 2_138_551, 'paris');

		expect(chooseCityCentre(bva, [[beauvais, paris]])?.place.name).toBe('Beauvais');
	});

	it('refuses everything beyond the distance cap', () => {
		const far = place('Somewhere', 0, 0, 5_000_000, 'far');
		expect(chooseCityCentre(LGW, [[far]])).toBeNull();
	});

	it('refuses a candidate just outside the cap and takes one just inside', () => {
		// One degree of latitude is about 111 km, so these two straddle the 50 km line.
		const inside = place('Inside', 51.148102 + 0.4, -0.190278, 1000, 'in');
		const outside = place('Outside', 51.148102 + 0.5, -0.190278, 9_000_000, 'out');
		expect(haversineKm(LGW, inside)).toBeLessThan(MAX_CENTRE_DISTANCE_KM);
		expect(haversineKm(LGW, outside)).toBeGreaterThan(MAX_CENTRE_DISTANCE_KM);
		expect(chooseCityCentre(LGW, [[outside, inside]])?.place.name).toBe('Inside');
	});

	it('answers nothing rather than guessing when no tier has a candidate', () => {
		// Frankfurt-Hahn is the shape this protects: the app calls it "Frankfurt Hahn",
		// which is not a city, and the honest answer is no centre at all.
		expect(chooseCityCentre(LGW, [[], [], []])).toBeNull();
	});
});

describe('roundCoordinate', () => {
	it('keeps four decimals, about 11 metres', () => {
		expect(roundCoordinate(51.508530000001)).toBe(51.5085);
		expect(roundCoordinate(-0.12574)).toBe(-0.1257);
	});
});
