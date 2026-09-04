import { describe, expect, it } from 'vitest';
import oneWayFaresFixture from './fixtures/one-way-fares-single-route.json';
import { fetchActiveAirports, fetchOneWayFares } from './ryanair-client';

/** A `fetch` stub that never touches the network: it inspects the URL it was called with
 * and resolves with whatever `Response` the test configured for it. */
function fakeFetch(responder: (url: string) => Response): typeof fetch {
	return (async (input: RequestInfo | URL) => responder(input.toString())) as typeof fetch;
}

describe('fetchOneWayFares', () => {
	it('builds the query string from the given params', async () => {
		let requestedUrl = '';
		const fetchImpl = fakeFetch((url) => {
			requestedUrl = url;
			return new Response(JSON.stringify(oneWayFaresFixture), { status: 200 });
		});

		await fetchOneWayFares(
			{
				departureAirportIataCode: 'BCN',
				arrivalAirportIataCode: 'STN',
				outboundDepartureDateFrom: '2026-10-01',
				outboundDepartureDateTo: '2026-10-20',
				currency: 'GBP'
			},
			{ signal: new AbortController().signal, fetchImpl }
		);

		const url = new URL(requestedUrl);
		expect(url.origin + url.pathname).toBe('https://services-api.ryanair.com/farfnd/v4/oneWayFares');
		expect(url.searchParams.get('departureAirportIataCode')).toBe('BCN');
		expect(url.searchParams.get('arrivalAirportIataCode')).toBe('STN');
		expect(url.searchParams.get('outboundDepartureDateFrom')).toBe('2026-10-01');
		expect(url.searchParams.get('outboundDepartureDateTo')).toBe('2026-10-20');
		expect(url.searchParams.get('currency')).toBe('GBP');
	});

	it('omits arrivalAirportIataCode and currency when not given', async () => {
		let requestedUrl = '';
		const fetchImpl = fakeFetch((url) => {
			requestedUrl = url;
			return new Response(JSON.stringify(oneWayFaresFixture), { status: 200 });
		});

		await fetchOneWayFares(
			{
				departureAirportIataCode: 'BCN',
				outboundDepartureDateFrom: '2026-10-01',
				outboundDepartureDateTo: '2026-10-20'
			},
			{ signal: new AbortController().signal, fetchImpl }
		);

		const url = new URL(requestedUrl);
		expect(url.searchParams.has('arrivalAirportIataCode')).toBe(false);
		expect(url.searchParams.has('currency')).toBe(false);
	});

	it('resolves ok:true with the parsed body on a 200', async () => {
		const fetchImpl = fakeFetch(() => new Response(JSON.stringify(oneWayFaresFixture), { status: 200 }));
		const result = await fetchOneWayFares(
			{ departureAirportIataCode: 'BCN', outboundDepartureDateFrom: '2026-10-01', outboundDepartureDateTo: '2026-10-20' },
			{ signal: new AbortController().signal, fetchImpl }
		);
		expect(result).toEqual({ ok: true, data: oneWayFaresFixture });
	});

	it('maps a 429 to a rate-limited error, reading Retry-After', async () => {
		const fetchImpl = fakeFetch(
			() => new Response(null, { status: 429, headers: { 'Retry-After': '30' } })
		);
		const result = await fetchOneWayFares(
			{ departureAirportIataCode: 'BCN', outboundDepartureDateFrom: '2026-10-01', outboundDepartureDateTo: '2026-10-20' },
			{ signal: new AbortController().signal, fetchImpl }
		);
		expect(result).toEqual({
			ok: false,
			error: { code: 'rate-limited', message: expect.any(String), status: 429, retryAfterSeconds: 30 }
		});
	});

	it('maps a 500 to an http-error', async () => {
		const fetchImpl = fakeFetch(() => new Response('server on fire', { status: 500 }));
		const result = await fetchOneWayFares(
			{ departureAirportIataCode: 'BCN', outboundDepartureDateFrom: '2026-10-01', outboundDepartureDateTo: '2026-10-20' },
			{ signal: new AbortController().signal, fetchImpl }
		);
		expect(result).toEqual({ ok: false, error: { code: 'http-error', message: expect.any(String), status: 500 } });
	});

	it('maps a 200 with invalid JSON to malformed-response', async () => {
		const fetchImpl = fakeFetch(() => new Response('<html>not json</html>', { status: 200 }));
		const result = await fetchOneWayFares(
			{ departureAirportIataCode: 'BCN', outboundDepartureDateFrom: '2026-10-01', outboundDepartureDateTo: '2026-10-20' },
			{ signal: new AbortController().signal, fetchImpl }
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe('malformed-response');
	});

	it('maps a 200 with the wrong shape (no fares array) to malformed-response', async () => {
		const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ oops: true }), { status: 200 }));
		const result = await fetchOneWayFares(
			{ departureAirportIataCode: 'BCN', outboundDepartureDateFrom: '2026-10-01', outboundDepartureDateTo: '2026-10-20' },
			{ signal: new AbortController().signal, fetchImpl }
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe('malformed-response');
	});

	it('maps an already-aborted signal to cancelled instead of network-error', async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchImpl: typeof fetch = async () => {
			throw new DOMException('The operation was aborted', 'AbortError');
		};
		const result = await fetchOneWayFares(
			{ departureAirportIataCode: 'BCN', outboundDepartureDateFrom: '2026-10-01', outboundDepartureDateTo: '2026-10-20' },
			{ signal: controller.signal, fetchImpl }
		);
		expect(result).toEqual({ ok: false, error: { code: 'cancelled', message: expect.any(String) } });
	});

	it('maps a thrown network error (not an abort) to network-error', async () => {
		const fetchImpl: typeof fetch = async () => {
			throw new TypeError('Failed to fetch');
		};
		const result = await fetchOneWayFares(
			{ departureAirportIataCode: 'BCN', outboundDepartureDateFrom: '2026-10-01', outboundDepartureDateTo: '2026-10-20' },
			{ signal: new AbortController().signal, fetchImpl }
		);
		expect(result).toEqual({
			ok: false,
			error: { code: 'network-error', message: 'Failed to fetch', cause: expect.any(TypeError) }
		});
	});
});

describe('fetchActiveAirports', () => {
	it('requests the active-airports endpoint', async () => {
		let requestedUrl = '';
		const fetchImpl = fakeFetch((url) => {
			requestedUrl = url;
			return new Response(JSON.stringify([]), { status: 200 });
		});
		await fetchActiveAirports({ signal: new AbortController().signal, fetchImpl });
		expect(requestedUrl).toBe('https://www.ryanair.com/api/views/locate/3/airports/en/active');
	});

	it('rejects a non-array body as malformed', async () => {
		const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ not: 'an array' }), { status: 200 }));
		const result = await fetchActiveAirports({ signal: new AbortController().signal, fetchImpl });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe('malformed-response');
	});

	// Issue #121: this file used to export a `fetchDirectDestinations` hitting
	// /views/locate/searchWidget/routes/en/airport/{IATA} once per airport. The endpoint
	// above carries every airport's routes as well as every airport's zone, so the
	// per-airport one was deleted rather than cached harder. No test replaces those two
	// because there is no caller left to break.
});
