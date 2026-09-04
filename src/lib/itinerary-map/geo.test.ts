import { describe, expect, it } from 'vitest';
import type { Coordinates } from '$lib/domain';
import {
	boundsOfCoordinates,
	greatCircleArc,
	POINT_VIEW_ZOOM,
	viewForCoordinates
} from './geo';

const madrid: Coordinates = { latitude: 40.4936, longitude: -3.5668 };
const vienna: Coordinates = { latitude: 48.1103, longitude: 16.5697 };

describe('greatCircleArc', () => {
	it('starts and ends exactly at the given points', () => {
		const arc = greatCircleArc(madrid, vienna, 32);
		expect(arc[0]).toEqual(madrid);
		expect(arc.at(-1)).toEqual(vienna);
		expect(arc).toHaveLength(33);
	});

	it('collapses to the two endpoints for coincident points', () => {
		expect(greatCircleArc(madrid, madrid)).toEqual([madrid, madrid]);
	});

	// The defining property this issue calls out: a great circle between two points off
	// the equator bulges toward the nearer pole, unlike the straight Mercator line
	// MapLibre would otherwise draw. New York and Tokyo sit at nearly the same
	// latitude, so a straight line barely moves in latitude at all; the real great
	// circle's midpoint sits well north of both.
	it('bulges toward the pole between two points at the same latitude', () => {
		const newYork: Coordinates = { latitude: 40.7, longitude: -74.0 };
		const tokyo: Coordinates = { latitude: 35.7, longitude: 139.7 };

		const arc = greatCircleArc(newYork, tokyo, 100);
		const midpoint = arc[50];

		expect(midpoint.latitude).toBeGreaterThan(Math.max(newYork.latitude, tokyo.latitude) + 10);
	});

	it('produces a continuous, unwrapped longitude sequence across the antimeridian', () => {
		const fiji: Coordinates = { latitude: -17.7, longitude: 178.0 };
		const samoa: Coordinates = { latitude: -13.8, longitude: -172.1 };

		const arc = greatCircleArc(fiji, samoa, 20);

		for (let i = 1; i < arc.length; i++) {
			expect(Math.abs(arc[i].longitude - arc[i - 1].longitude)).toBeLessThan(180);
		}
	});
});

describe('boundsOfCoordinates', () => {
	it('finds the bounding box of a set of points', () => {
		expect(boundsOfCoordinates([madrid, vienna])).toEqual([
			madrid.longitude,
			madrid.latitude,
			vienna.longitude,
			vienna.latitude
		]);
	});

	it('throws on an empty list rather than fabricating a box', () => {
		expect(() => boundsOfCoordinates([])).toThrow();
	});
});

describe('viewForCoordinates', () => {
	it('returns a bounds view for two distant points', () => {
		const view = viewForCoordinates([madrid, vienna]);
		expect(view.kind).toBe('bounds');
	});

	it('returns a fixed-zoom point view for a single coordinate', () => {
		const view = viewForCoordinates([vienna]);
		expect(view).toEqual({ kind: 'point', center: [vienna.longitude, vienna.latitude], zoom: POINT_VIEW_ZOOM });
	});

	it('treats two very close points (a hotel a few streets from the airport) as a point view', () => {
		const hotel: Coordinates = { latitude: vienna.latitude + 0.0005, longitude: vienna.longitude + 0.0005 };
		const view = viewForCoordinates([vienna, hotel]);
		expect(view.kind).toBe('point');
	});
});
