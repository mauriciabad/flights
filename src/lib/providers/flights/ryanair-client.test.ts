import { describe, expect, it } from 'vitest';
import cheapestPerDayFixture from './fixtures/cheapest-per-day-bcn-stn.json';
import scheduleFixture from './fixtures/schedule-bcn-stn.json';
import { fetchActiveAirports, fetchCheapestFaresPerDay, fetchMonthlySchedule } from './ryanair-client';

/** A `fetch` stub that never touches the network: it inspects the URL it was called with
 * and resolves with whatever `Response` the test configured for it. */
function fakeFetch(responder: (url: string) => Response): typeof fetch {
	return (async (input: RequestInfo | URL) => responder(input.toString())) as typeof fetch;
}

const route = { origin: 'BCN', destination: 'STN', monthStart: '2026-10-01' };

describe('fetchCheapestFaresPerDay', () => {
	it('puts the route in the path and the month in the query string', async () => {
		let requestedUrl = '';
		const fetchImpl = fakeFetch((url) => {
			requestedUrl = url;
			return new Response(JSON.stringify(cheapestPerDayFixture), { status: 200 });
		});

		await fetchCheapestFaresPerDay({ ...route, currency: 'GBP' }, { signal: new AbortController().signal, fetchImpl });

		const url = new URL(requestedUrl);
		expect(url.origin + url.pathname).toBe(
			'https://services-api.ryanair.com/farfnd/v4/oneWayFares/BCN/STN/cheapestPerDay'
		);
		expect(url.searchParams.get('outboundMonthOfDate')).toBe('2026-10-01');
		expect(url.searchParams.get('currency')).toBe('GBP');
	});

	it('omits currency when not given, leaving Ryanair to pick its own', async () => {
		let requestedUrl = '';
		const fetchImpl = fakeFetch((url) => {
			requestedUrl = url;
			return new Response(JSON.stringify(cheapestPerDayFixture), { status: 200 });
		});

		await fetchCheapestFaresPerDay(route, { signal: new AbortController().signal, fetchImpl });
		expect(new URL(requestedUrl).searchParams.has('currency')).toBe(false);
	});

	it('resolves ok:true with the parsed body on a 200', async () => {
		const fetchImpl = fakeFetch(() => new Response(JSON.stringify(cheapestPerDayFixture), { status: 200 }));
		const result = await fetchCheapestFaresPerDay(route, { signal: new AbortController().signal, fetchImpl });
		expect(result).toEqual({ ok: true, data: cheapestPerDayFixture });
	});

	it('maps a 429 to a rate-limited error, reading Retry-After', async () => {
		const fetchImpl = fakeFetch(() => new Response(null, { status: 429, headers: { 'Retry-After': '30' } }));
		const result = await fetchCheapestFaresPerDay(route, { signal: new AbortController().signal, fetchImpl });
		expect(result).toEqual({
			ok: false,
			error: { code: 'rate-limited', message: expect.any(String), status: 429, retryAfterSeconds: 30 }
		});
	});

	it('maps a 500 to an http-error', async () => {
		const fetchImpl = fakeFetch(() => new Response('server on fire', { status: 500 }));
		const result = await fetchCheapestFaresPerDay(route, { signal: new AbortController().signal, fetchImpl });
		expect(result).toEqual({ ok: false, error: { code: 'http-error', message: expect.any(String), status: 500 } });
	});

	it('maps a 200 with invalid JSON to malformed-response', async () => {
		const fetchImpl = fakeFetch(() => new Response('<html>not json</html>', { status: 200 }));
		const result = await fetchCheapestFaresPerDay(route, { signal: new AbortController().signal, fetchImpl });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe('malformed-response');
	});

	// The old fare-finder shape put `fares` at the top level; this endpoint nests it under
	// `outbound`. A body carrying the old shape must be rejected rather than read as empty.
	it('maps a 200 with no outbound.fares array to malformed-response', async () => {
		const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ fares: [] }), { status: 200 }));
		const result = await fetchCheapestFaresPerDay(route, { signal: new AbortController().signal, fetchImpl });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe('malformed-response');
	});

	it('maps an already-aborted signal to cancelled instead of network-error', async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchImpl: typeof fetch = async () => {
			throw new DOMException('The operation was aborted', 'AbortError');
		};
		const result = await fetchCheapestFaresPerDay(route, { signal: controller.signal, fetchImpl });
		expect(result).toEqual({ ok: false, error: { code: 'cancelled', message: expect.any(String) } });
	});

	it('maps a thrown network error (not an abort) to network-error', async () => {
		const fetchImpl: typeof fetch = async () => {
			throw new TypeError('Failed to fetch');
		};
		const result = await fetchCheapestFaresPerDay(route, { signal: new AbortController().signal, fetchImpl });
		expect(result).toEqual({
			ok: false,
			error: { code: 'network-error', message: 'Failed to fetch', cause: expect.any(TypeError) }
		});
	});
});

describe('fetchMonthlySchedule', () => {
	it('builds the route-and-month path, with the month one-based', async () => {
		let requestedUrl = '';
		const fetchImpl = fakeFetch((url) => {
			requestedUrl = url;
			return new Response(JSON.stringify(scheduleFixture), { status: 200 });
		});

		await fetchMonthlySchedule(
			{ origin: 'BCN', destination: 'STN', year: 2026, month: 10 },
			{ signal: new AbortController().signal, fetchImpl }
		);
		expect(requestedUrl).toBe('https://services-api.ryanair.com/timtbl/3/schedules/BCN/STN/years/2026/months/10');
	});

	it('resolves ok:true with the parsed body on a 200', async () => {
		const fetchImpl = fakeFetch(() => new Response(JSON.stringify(scheduleFixture), { status: 200 }));
		const result = await fetchMonthlySchedule(
			{ origin: 'BCN', destination: 'STN', year: 2026, month: 10 },
			{ signal: new AbortController().signal, fetchImpl }
		);
		expect(result).toEqual({ ok: true, data: scheduleFixture });
	});

	// Measured 2026-09-04: a route Ryanair does not fly answers 200 with an empty `days`,
	// never a 404, so an empty timetable is a valid response and not a malformed one.
	it('accepts an empty days array as a valid answer', async () => {
		const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ month: 10, days: [] }), { status: 200 }));
		const result = await fetchMonthlySchedule(
			{ origin: 'BCN', destination: 'OTP', year: 2026, month: 10 },
			{ signal: new AbortController().signal, fetchImpl }
		);
		expect(result).toEqual({ ok: true, data: { month: 10, days: [] } });
	});

	it('rejects a body with no days array as malformed', async () => {
		const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ month: 10 }), { status: 200 }));
		const result = await fetchMonthlySchedule(
			{ origin: 'BCN', destination: 'STN', year: 2026, month: 10 },
			{ signal: new AbortController().signal, fetchImpl }
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe('malformed-response');
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
});
