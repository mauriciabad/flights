import { describe, expect, it } from 'vitest';
import { formatDistanceKm, haversineDistanceKm } from './distance';

describe('haversineDistanceKm', () => {
	it('is zero for the same point', () => {
		const p = { latitude: 48.2, longitude: 16.37 };
		expect(haversineDistanceKm(p, p)).toBe(0);
	});

	it('matches the well-known Vienna-to-Bratislava distance within a few km', () => {
		// Real geography (~55km, commonly cited), not a value picked to pass the test -
		// same reference points providers/stays/agoda-geo.test.ts (PR #67) uses.
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

describe('formatDistanceKm', () => {
	it('formats sub-kilometre distances in whole metres', () => {
		expect(formatDistanceKm(0.65)).toBe('650 m');
		expect(formatDistanceKm(0.004)).toBe('4 m');
	});

	it('formats kilometre-and-above distances with one decimal place', () => {
		expect(formatDistanceKm(4.2)).toBe('4.2 km');
		expect(formatDistanceKm(12)).toBe('12.0 km');
	});

	it('treats exactly 1km as kilometres, not metres', () => {
		expect(formatDistanceKm(1)).toBe('1.0 km');
	});
});
