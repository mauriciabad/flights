import { describe, expect, it } from 'vitest';
import oneWayFixture from './fixtures/kiwi-one-way-bcn-otp.json';
import { fetchOneWay } from './kiwi-client';

/** A `fetch` stub that never touches the network: it inspects the request it was called
 * with and resolves with whatever `Response` the test configured for it. Mirrors
 * ryanair-client.test.ts's own `fakeFetch`. */
function fakeFetch(responder: (url: string, init: RequestInit | undefined) => Response): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => responder(input.toString(), init)) as typeof fetch;
}

const baseParams = {
	source: 'BCN',
	destination: 'OTP',
	outboundDepartmentDateStart: '2026-10-12T00:00:00',
	outboundDepartmentDateEnd: '2026-10-18T23:59:59',
	currency: 'eur',
	adults: 1,
	handbags: 1,
	holdbags: 0,
	enableSelfTransfer: true,
	allowOvernightStopover: true,
	limit: 20
};

describe('fetchOneWay', () => {
	it('builds the query string and headers from the given params', async () => {
		let requestedUrl = '';
		let requestedInit: RequestInit | undefined;
		const fetchImpl = fakeFetch((url, init) => {
			requestedUrl = url;
			requestedInit = init;
			return new Response(JSON.stringify(oneWayFixture), { status: 200 });
		});

		await fetchOneWay(baseParams, { signal: new AbortController().signal, apiKey: 'test-key', fetchImpl });

		const url = new URL(requestedUrl);
		expect(url.origin + url.pathname).toBe('https://kiwi-com-cheap-flights.p.rapidapi.com/one-way');
		expect(url.searchParams.get('source')).toBe('BCN');
		expect(url.searchParams.get('destination')).toBe('OTP');
		expect(url.searchParams.get('outboundDepartmentDateStart')).toBe('2026-10-12T00:00:00');
		expect(url.searchParams.get('outboundDepartmentDateEnd')).toBe('2026-10-18T23:59:59');
		expect(url.searchParams.get('currency')).toBe('eur');
		expect(url.searchParams.get('adults')).toBe('1');
		expect(url.searchParams.get('enableSelfTransfer')).toBe('true');
		expect(url.searchParams.get('allowOvernightStopover')).toBe('true');
		expect(url.searchParams.has('maxStopsCount')).toBe(false);

		const headers = new Headers(requestedInit?.headers);
		expect(headers.get('x-rapidapi-host')).toBe('kiwi-com-cheap-flights.p.rapidapi.com');
		expect(headers.get('x-rapidapi-key')).toBe('test-key');
	});

	it('omits destination when not given, for an "everywhere from this airport" search', async () => {
		let requestedUrl = '';
		const fetchImpl = fakeFetch((url) => {
			requestedUrl = url;
			return new Response(JSON.stringify(oneWayFixture), { status: 200 });
		});
		const { destination: _omit, ...withoutDestination } = baseParams;
		await fetchOneWay(withoutDestination, { signal: new AbortController().signal, apiKey: 'test-key', fetchImpl });
		expect(new URL(requestedUrl).searchParams.has('destination')).toBe(false);
	});

	it('sends maxStopsCount when given, e.g. for a direct-destinations lookup', async () => {
		let requestedUrl = '';
		const fetchImpl = fakeFetch((url) => {
			requestedUrl = url;
			return new Response(JSON.stringify(oneWayFixture), { status: 200 });
		});
		await fetchOneWay(
			{ ...baseParams, maxStopsCount: 0 },
			{ signal: new AbortController().signal, apiKey: 'test-key', fetchImpl }
		);
		expect(new URL(requestedUrl).searchParams.get('maxStopsCount')).toBe('0');
	});

	it('resolves ok:true with the parsed body on a 200', async () => {
		const fetchImpl = fakeFetch(() => new Response(JSON.stringify(oneWayFixture), { status: 200 }));
		const result = await fetchOneWay(baseParams, { signal: new AbortController().signal, apiKey: 'k', fetchImpl });
		expect(result).toEqual({ ok: true, data: oneWayFixture });
	});

	it('maps a 403 to not-subscribed', async () => {
		const fetchImpl = fakeFetch(
			() => new Response(JSON.stringify({ message: 'You are not subscribed to this API.' }), { status: 403 })
		);
		const result = await fetchOneWay(baseParams, { signal: new AbortController().signal, apiKey: 'k', fetchImpl });
		expect(result).toEqual({
			ok: false,
			error: { code: 'not-subscribed', message: expect.any(String), status: 403 }
		});
	});

	it('maps a 429 to rate-limited, reading Retry-After', async () => {
		const fetchImpl = fakeFetch(() => new Response(null, { status: 429, headers: { 'Retry-After': '60' } }));
		const result = await fetchOneWay(baseParams, { signal: new AbortController().signal, apiKey: 'k', fetchImpl });
		expect(result).toEqual({
			ok: false,
			error: { code: 'rate-limited', message: expect.any(String), status: 429, retryAfterSeconds: 60 }
		});
	});

	it('maps a 402 (the live DEPLOYMENT_DISABLED case this adapter actually observed) to http-error', async () => {
		const fetchImpl = fakeFetch(
			() =>
				new Response(JSON.stringify({ error: { code: '402', message: 'Payment required' } }), {
					status: 402,
					headers: { 'x-vercel-error': 'DEPLOYMENT_DISABLED' }
				})
		);
		const result = await fetchOneWay(baseParams, { signal: new AbortController().signal, apiKey: 'k', fetchImpl });
		expect(result).toEqual({ ok: false, error: { code: 'http-error', message: expect.any(String), status: 402 } });
	});

	it('maps a 200 with invalid JSON to malformed-response', async () => {
		const fetchImpl = fakeFetch(() => new Response('<html>not json</html>', { status: 200 }));
		const result = await fetchOneWay(baseParams, { signal: new AbortController().signal, apiKey: 'k', fetchImpl });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe('malformed-response');
	});

	it('maps a 200 with the wrong shape (no data array) to malformed-response', async () => {
		const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ oops: true }), { status: 200 }));
		const result = await fetchOneWay(baseParams, { signal: new AbortController().signal, apiKey: 'k', fetchImpl });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe('malformed-response');
	});

	it('maps an already-aborted signal to cancelled instead of network-error', async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchImpl: typeof fetch = async () => {
			throw new DOMException('The operation was aborted', 'AbortError');
		};
		const result = await fetchOneWay(baseParams, { signal: controller.signal, apiKey: 'k', fetchImpl });
		expect(result).toEqual({ ok: false, error: { code: 'cancelled', message: expect.any(String) } });
	});

	it('maps a thrown network error (not an abort) to network-error', async () => {
		const fetchImpl: typeof fetch = async () => {
			throw new TypeError('Failed to fetch');
		};
		const result = await fetchOneWay(baseParams, { signal: new AbortController().signal, apiKey: 'k', fetchImpl });
		expect(result).toEqual({
			ok: false,
			error: { code: 'network-error', message: 'Failed to fetch', cause: expect.any(TypeError) }
		});
	});
});
