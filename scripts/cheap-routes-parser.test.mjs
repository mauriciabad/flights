import { describe, expect, it } from 'vitest';
import {
	buildCheapRoutesDataset,
	CheapRoutesResponseError,
	parseCityDirectionsResponse
} from './cheap-routes-parser.mjs';

// Shaped like a real `/v1/city-directions?origin=BCN&currency=eur` response
// (docs/PROVIDERS.md's documented shape, with representative values -- field
// names and types match a captured response exactly).
const REAL_RESPONSE = {
	success: true,
	currency: 'eur',
	data: {
		LED: {
			origin: 'BCN',
			destination: 'LED',
			airline: 'SU',
			flight_number: 1234,
			departure_at: '2026-10-12T06:30:00+03:00',
			return_at: '2026-10-19T21:35:00+03:00',
			expires_at: '2026-09-04T12:00:00Z',
			price: 320.5,
			transfers: 0
		},
		FCO: {
			origin: 'BCN',
			destination: 'FCO',
			airline: 'FR',
			flight_number: 5678,
			departure_at: '2026-11-02T09:10:00+01:00',
			return_at: null,
			expires_at: '2026-09-04T09:15:00Z',
			price: 45,
			transfers: 0
		}
	}
};

describe('parseCityDirectionsResponse', () => {
	it('parses a real captured response into flat routes', () => {
		const routes = parseCityDirectionsResponse('BCN', REAL_RESPONSE);

		expect(routes).toHaveLength(2);
		expect(routes).toContainEqual({
			origin: 'BCN',
			destination: 'LED',
			airline: 'SU',
			flightNumber: '1234',
			priceMajorUnits: 320.5,
			currency: 'EUR',
			departureAt: '2026-10-12T06:30:00+03:00',
			returnAt: '2026-10-19T21:35:00+03:00',
			transfers: 0,
			expiresAt: '2026-09-04T12:00:00Z'
		});
	});

	it('defaults a missing return_at/transfers rather than inventing a round trip', () => {
		const routes = parseCityDirectionsResponse('BCN', REAL_RESPONSE);
		const oneWay = routes.find((r) => r.destination === 'FCO');

		expect(oneWay?.returnAt).toBeNull();
		expect(oneWay?.transfers).toBe(0);
	});

	it('rejects a response with success: false', () => {
		expect(() =>
			parseCityDirectionsResponse('BCN', { success: false, currency: 'eur', data: {} })
		).toThrow(CheapRoutesResponseError);
	});

	it('rejects a response with no data object', () => {
		expect(() =>
			parseCityDirectionsResponse('BCN', { success: true, currency: 'eur' })
		).toThrow(CheapRoutesResponseError);
	});

	it('rejects a response with no currency', () => {
		expect(() =>
			parseCityDirectionsResponse('BCN', { success: true, data: {} })
		).toThrow(CheapRoutesResponseError);
	});

	it('rejects a non-object response outright', () => {
		expect(() => parseCityDirectionsResponse('BCN', null)).toThrow(CheapRoutesResponseError);
		expect(() => parseCityDirectionsResponse('BCN', 'not json')).toThrow(CheapRoutesResponseError);
	});

	it('skips a single malformed row without losing the rest of the origin', () => {
		const routes = parseCityDirectionsResponse('BCN', {
			success: true,
			currency: 'eur',
			data: {
				LED: REAL_RESPONSE.data.LED,
				// Missing price and expires_at -- not safe to ship, but should not
				// take LED's real data down with it.
				BROKEN: { origin: 'BCN', destination: 'BROKEN', airline: 'FR' }
			}
		});

		expect(routes).toHaveLength(1);
		expect(routes[0]?.destination).toBe('LED');
	});

	it('rejects a row missing expires_at, since an undated price cannot be shown honestly', () => {
		const routes = parseCityDirectionsResponse('BCN', {
			success: true,
			currency: 'eur',
			data: {
				NODATE: {
					origin: 'BCN',
					destination: 'NODATE',
					airline: 'FR',
					price: 50,
					departure_at: '2026-10-01T10:00:00Z'
					// no expires_at
				}
			}
		});

		expect(routes).toHaveLength(0);
	});
});

describe('buildCheapRoutesDataset', () => {
	const ROWS = [
		{ origin: 'BCN', destination: 'STN', expiresAt: '2026-09-04T11:28:50Z' },
		{ origin: 'AGP', destination: 'AMS', expiresAt: '2026-09-04T11:28:50Z' },
		{ origin: 'BCN', destination: 'AHO', expiresAt: '2026-09-04T11:28:50Z' }
	];

	// Issue #169's whole point: the file the app ships has to be able to say when it was
	// fetched, because the runtime shim used to answer that question with `new Date()`.
	it('writes the fetch instant alongside the routes', () => {
		const dataset = buildCheapRoutesDataset(ROWS, '2026-09-04T03:17:22.481Z');
		expect(dataset.fetchedAt).toBe('2026-09-04T03:17:22.481Z');
		expect(dataset.routes).toHaveLength(3);
	});

	it('sorts routes by origin then destination, so a nightly commit shows what moved', () => {
		const dataset = buildCheapRoutesDataset(ROWS, '2026-09-04T03:17:22.481Z');
		expect(dataset.routes.map((route) => `${route.origin}-${route.destination}`)).toEqual([
			'AGP-AMS',
			'BCN-AHO',
			'BCN-STN'
		]);
	});

	it('keeps each row’s own expiresAt, which is a different fact from fetchedAt', () => {
		// Travelpayouts' expiry for its cached fare, ours for the retrieval. Deriving
		// either from the other is the bug this issue is about.
		const dataset = buildCheapRoutesDataset(ROWS, '2026-09-04T03:17:22.481Z');
		for (const route of dataset.routes) {
			expect(route.expiresAt).toBe('2026-09-04T11:28:50Z');
		}
	});

	it('refuses to build a dataset with no usable timestamp rather than defaulting to now', () => {
		for (const bad of [undefined, null, '', 'whenever']) {
			expect(() => buildCheapRoutesDataset(ROWS, bad)).toThrow(CheapRoutesResponseError);
		}
	});

	it('does not mutate the caller’s array while sorting', () => {
		const input = [...ROWS];
		buildCheapRoutesDataset(input, '2026-09-04T03:17:22.481Z');
		expect(input).toEqual(ROWS);
	});
});
