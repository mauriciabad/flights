import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	fetchTransitousGeocode,
	fetchTransitousReverseGeocode,
	TransitousHttpError,
	TransitousMalformedResponseError
} from './transitous-client';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
		...init
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('fetchTransitousGeocode', () => {
	it('builds the documented query shape and returns the parsed body on 2xx', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ type: 'STOP', name: 'Sagrada Família', lat: 41.4, lon: 2.17 }]));

		const result = await fetchTransitousGeocode('Sagrada Familia Barcelona', {
			signal: new AbortController().signal,
			fetchImpl
		});

		expect(result).toEqual([{ type: 'STOP', name: 'Sagrada Família', lat: 41.4, lon: 2.17 }]);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://api.transitous.org/api/v1/geocode?text=Sagrada+Familia+Barcelona');
		expect((init.headers as Record<string, string>)['User-Agent']).toContain('flights.mauri.app');
	});

	it('throws TransitousHttpError, carrying Retry-After, on a 429', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response('rate limited', { status: 429, headers: { 'Retry-After': '30' } }));

		await expect(
			fetchTransitousGeocode('Vienna', { signal: new AbortController().signal, fetchImpl })
		).rejects.toMatchObject({ name: 'TransitousHttpError', status: 429, retryAfterSeconds: 30 });
	});

	it('throws TransitousMalformedResponseError on a 2xx body that is not the expected array', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'not an array' }));

		await expect(
			fetchTransitousGeocode('Vienna', { signal: new AbortController().signal, fetchImpl })
		).rejects.toBeInstanceOf(TransitousMalformedResponseError);
	});

	it('throws TransitousMalformedResponseError on a 2xx body that is not valid JSON', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>nope</html>', { status: 200 }));

		await expect(
			fetchTransitousGeocode('Vienna', { signal: new AbortController().signal, fetchImpl })
		).rejects.toBeInstanceOf(TransitousMalformedResponseError);
	});

	it('throws TransitousMalformedResponseError on a row with a non-numeric lat (issue #68)', async () => {
		// transitous-mapper.ts reads `place.lat`/`place.lon` directly into `GeocodeCandidate`
		// coordinates — a string here would silently become part of a "coordinate" nothing
		// downstream expects to validate.
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse([{ type: 'STOP', name: 'Sagrada Família', lat: '41.4', lon: 2.17 }]));

		await expect(
			fetchTransitousGeocode('Sagrada Familia Barcelona', { signal: new AbortController().signal, fetchImpl })
		).rejects.toBeInstanceOf(TransitousMalformedResponseError);
	});

	it('throws TransitousMalformedResponseError on a row with a non-string country when present', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse([{ type: 'STOP', name: 'Sagrada Família', lat: 41.4, lon: 2.17, country: 34 }]));

		await expect(
			fetchTransitousGeocode('Sagrada Familia Barcelona', { signal: new AbortController().signal, fetchImpl })
		).rejects.toBeInstanceOf(TransitousMalformedResponseError);
	});

	it('lets an AbortError propagate unchanged rather than wrapping it', async () => {
		const abortError = new DOMException('aborted', 'AbortError');
		const fetchImpl = vi.fn().mockRejectedValue(abortError);

		await expect(
			fetchTransitousGeocode('Vienna', { signal: new AbortController().signal, fetchImpl })
		).rejects.toBe(abortError);
	});

	it('lets a bare network TypeError propagate unchanged', async () => {
		const networkError = new TypeError('Failed to fetch');
		const fetchImpl = vi.fn().mockRejectedValue(networkError);

		await expect(
			fetchTransitousGeocode('Vienna', { signal: new AbortController().signal, fetchImpl })
		).rejects.toBe(networkError);
	});
});

describe('fetchTransitousReverseGeocode', () => {
	it('sends the point as a "lat,lon" pair against the reverse-geocode path', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));

		await fetchTransitousReverseGeocode(
			{ latitude: 41.2971, longitude: 2.07846 },
			{ signal: new AbortController().signal, fetchImpl }
		);

		const [url] = fetchImpl.mock.calls[0] as [string];
		expect(url).toBe('https://api.transitous.org/api/v1/reverse-geocode?place=41.2971%2C2.07846');
	});

	it('throws TransitousHttpError on a non-2xx', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response('down', { status: 503 }));

		await expect(
			fetchTransitousReverseGeocode(
				{ latitude: 0, longitude: 0 },
				{ signal: new AbortController().signal, fetchImpl }
			)
		).rejects.toBeInstanceOf(TransitousHttpError);
	});
});
