import { describe, expect, it } from 'vitest';
import type { Coordinates } from '$lib/domain';
import {
	boundsOfCoordinates,
	CITY_VIEW_ZOOM,
	greatCircleArc,
	longitudeNear,
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

	// The owner's complaint in his own words: "the flight lines in the map should follow
	// the flight trajectory aprox, a straignt line is wrong in the map projection". The
	// test above states that in latitude; this one states it the way he sees it, in the
	// projection MapLibre actually draws, on his own reference route.
	it('leaves the straight Mercator line by a visible distance on the reference route', () => {
		const boaVista: Coordinates = { latitude: 16.1365, longitude: -22.8889 };
		const gatwick: Coordinates = { latitude: 51.1487, longitude: -0.1857 };

		// Web Mercator, normalised so the whole world is 1 wide and 1 tall.
		const project = (point: Coordinates) => ({
			x: point.longitude / 360,
			y: Math.log(Math.tan(Math.PI / 4 + (point.latitude * Math.PI) / 360)) / (2 * Math.PI)
		});

		const from = project(boaVista);
		const to = project(gatwick);
		const chord = Math.hypot(to.x - from.x, to.y - from.y);
		const offChord = greatCircleArc(boaVista, gatwick).map((point) => {
			const p = project(point);
			return (
				Math.abs((to.x - from.x) * (from.y - p.y) - (from.x - p.x) * (to.y - from.y)) / chord
			);
		});

		// 2.5% of the leg's own length. On the map that is tens of pixels of daylight
		// between the arc and where a straight segment would have been drawn.
		expect(Math.max(...offChord) / chord).toBeGreaterThan(0.025);
		// The endpoints are on the line by definition, so a curve that bulges is the only
		// way this passes.
		expect(offChord[0]).toBeCloseTo(0, 10);
		expect(offChord.at(-1)).toBeCloseTo(0, 10);
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

	// Issue #141: a stopover with no bed priced is a city, not an address, and framing it
	// at street level put the runway on screen and called it the free city.
	it('honours a caller-chosen zoom for a point that locates a city rather than an address', () => {
		const view = viewForCoordinates([vienna], { pointZoom: CITY_VIEW_ZOOM });
		expect(view).toEqual({ kind: 'point', center: [vienna.longitude, vienna.latitude], zoom: CITY_VIEW_ZOOM });
		expect(CITY_VIEW_ZOOM).toBeLessThan(POINT_VIEW_ZOOM);
	});

	it('ignores the override when the points span real distance, since a box sizes itself', () => {
		const view = viewForCoordinates([madrid, vienna], { pointZoom: CITY_VIEW_ZOOM });
		expect(view.kind).toBe('bounds');
	});
});

describe('longitudeNear', () => {
	it('leaves a longitude alone when it is already the nearest way round', () => {
		expect(longitudeNear(10, 20)).toBe(20);
		expect(longitudeNear(-170, -175)).toBe(-175);
	});

	it('rewrites the far side of the antimeridian into the near one, both directions', () => {
		expect(longitudeNear(175, -175)).toBe(185);
		expect(longitudeNear(-175, 175)).toBe(-185);
	});

	it('crosses as many worlds as it takes, since an arc can already be past 180', () => {
		expect(longitudeNear(540, 175)).toBe(535);
	});
});
