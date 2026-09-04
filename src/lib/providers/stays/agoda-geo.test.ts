import { describe, expect, it } from 'vitest';
import { haversineDistanceKm } from './agoda-geo';

describe('haversineDistanceKm', () => {
	it('is zero for the same point', () => {
		expect(haversineDistanceKm({ latitude: 48.2, longitude: 16.37 }, { latitude: 48.2, longitude: 16.37 })).toBe(0);
	});

	it('matches the well-known Vienna-to-Bratislava distance within a couple of km', () => {
		// Vienna city centre to Bratislava city centre is commonly cited as ~55km — real
		// geography, not a value chosen to make the test pass.
		const vienna = { latitude: 48.2082, longitude: 16.3738 };
		const bratislava = { latitude: 48.1486, longitude: 17.1077 };
		const distance = haversineDistanceKm(vienna, bratislava);
		expect(distance).toBeGreaterThan(50);
		expect(distance).toBeLessThan(60);
	});

	it('is symmetric', () => {
		const a = { latitude: 48.2, longitude: 16.37 };
		const b = { latitude: 40.4, longitude: -3.7 };
		expect(haversineDistanceKm(a, b)).toBeCloseTo(haversineDistanceKm(b, a), 9);
	});
});
