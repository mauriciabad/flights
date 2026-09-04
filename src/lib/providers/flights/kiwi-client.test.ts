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

	it('maps the documented 403 "not subscribed" body to not-subscribed, quoting it', async () => {
		const fetchImpl = fakeFetch(
			() => new Response(JSON.stringify({ message: 'You are not subscribed to this API.' }), { status: 403 })
		);
		const result = await fetchOneWay(baseParams, { signal: new AbortController().signal, apiKey: 'k', fetchImpl });
		expect(result).toEqual({
			ok: false,
			error: {
				code: 'not-subscribed',
				message: 'Kiwi.com (RapidAPI) returned HTTP 403: You are not subscribed to this API.',
				status: 403
			}
		});
	});

	/**
	 * `not-subscribed` is permanent for the session (budget/permanent-failures.ts), so
	 * handing it out on the strength of a bare 403 switches the provider off for the rest of
	 * the visit over a failure nobody profiled. AGENTS.md, after issue #122: that code must
	 * only ever come from a real 403 carrying RapidAPI's own literal sentence.
	 */
	it('does not label a 403 with different wording as not-subscribed', async () => {
		const fetchImpl = fakeFetch(
			() => new Response(JSON.stringify({ message: 'Request blocked by the gateway' }), { status: 403 })
		);
		const result = await fetchOneWay(baseParams, { signal: new AbortController().signal, apiKey: 'k', fetchImpl });
		expect(result).toMatchObject({
			ok: false,
			error: {
				code: 'http-error',
				message: 'Kiwi.com (RapidAPI) returned HTTP 403: Request blocked by the gateway',
				status: 403
			}
		});
	});

	it('maps a 429 to rate-limited, reading Retry-After', async () => {
		const fetchImpl = fakeFetch(() => new Response(null, { status: 429, headers: { 'Retry-After': '60' } }));
		const result = await fetchOneWay(baseParams, { signal: new AbortController().signal, apiKey: 'k', fetchImpl });
		expect(result).toEqual({
			ok: false,
			error: {
				code: 'rate-limited',
				message: 'Kiwi.com (RapidAPI) returned HTTP 429 with an empty body',
				status: 429,
				retryAfterSeconds: 60
			}
		});
	});

	it('repeats what a 429 actually said, when it said anything', async () => {
		const fetchImpl = fakeFetch(
			() =>
				new Response(JSON.stringify({ message: 'You have exceeded the MONTHLY quota for Requests' }), {
					status: 429
				})
		);
		const result = await fetchOneWay(baseParams, { signal: new AbortController().signal, apiKey: 'k', fetchImpl });
		expect(result).toMatchObject({
			ok: false,
			error: {
				code: 'rate-limited',
				message: 'Kiwi.com (RapidAPI) returned HTTP 429: You have exceeded the MONTHLY quota for Requests'
			}
		});
	});

	/**
	 * Issue #171's headline example, and the only failure this listing has ever actually
	 * produced (docs/PROVIDERS.md). The old code answered "Kiwi returned HTTP 402" and threw
	 * away both the provider's sentence and the one header that names the real cause: a
	 * Vercel deployment its owner has taken offline, which is neither a key nor a
	 * subscription problem and cannot be fixed from this app.
	 */
	it('maps the live 402/DEPLOYMENT_DISABLED case to http-error, keeping its sentence and its header', async () => {
		const fetchImpl = fakeFetch(
			() =>
				new Response(JSON.stringify({ error: { code: '402', message: 'Payment required' } }), {
					status: 402,
					headers: { 'x-vercel-error': 'DEPLOYMENT_DISABLED' }
				})
		);
		const result = await fetchOneWay(baseParams, { signal: new AbortController().signal, apiKey: 'k', fetchImpl });
		expect(result).toMatchObject({
			ok: false,
			error: {
				code: 'http-error',
				message:
					'Kiwi.com (RapidAPI) returned HTTP 402: Payment required; x-vercel-error: DEPLOYMENT_DISABLED',
				status: 402,
				cause: {
					status: 402,
					message: 'Payment required',
					errorHeaders: { 'x-vercel-error': 'DEPLOYMENT_DISABLED' }
				}
			}
		});
	});

	it('quotes a non-JSON gateway page rather than reporting only its status', async () => {
		const fetchImpl = fakeFetch(
			() => new Response('<html>\n  <body>504 Gateway Timeout</body>\n</html>', { status: 504 })
		);
		const result = await fetchOneWay(baseParams, { signal: new AbortController().signal, apiKey: 'k', fetchImpl });
		expect(result).toMatchObject({
			ok: false,
			error: {
				code: 'http-error',
				message: 'Kiwi.com (RapidAPI) returned HTTP 504 with body: <html> <body>504 Gateway Timeout</body> </html>',
				status: 504
			}
		});
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
