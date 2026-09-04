import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getReportedProviderQuota } from '../budget';
import { callSkyscanner } from './skyscanner-client';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers });
}

describe('callSkyscanner', () => {
	it('resolves ok with the parsed body on a 2xx response', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { status: true, data: [] }));
		const result = await callSkyscanner(
			'/api/v1/flights/searchAirport',
			{ query: 'barcelona' },
			{ apiKey: 'k', signal: new AbortController().signal, fetchImpl }
		);
		expect(result).toEqual({ ok: true, data: { status: true, data: [] } });
	});

	it('sends the RapidAPI headers and query params', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));
		await callSkyscanner(
			'/api/v1/flights/searchAirport',
			{ query: 'barcelona', locale: 'en-US' },
			{ apiKey: 'the-key', signal: new AbortController().signal, fetchImpl }
		);
		const [calledUrl, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(calledUrl).toBe(
			'https://sky-scrapper.p.rapidapi.com/api/v1/flights/searchAirport?query=barcelona&locale=en-US'
		);
		expect((init.headers as Record<string, string>)['x-rapidapi-key']).toBe('the-key');
		expect((init.headers as Record<string, string>)['x-rapidapi-host']).toBe(
			'sky-scrapper.p.rapidapi.com'
		);
	});

	// docs/PROVIDERS.md: measured, real shape of an unsubscribed RapidAPI key on this
	// exact host. Not this adapter's own capture, since triggering it for real would mean
	// deliberately breaking the owner's subscription.
	it('maps the documented 403 "not subscribed" body to a not-subscribed error', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse(403, { message: 'You are not subscribed to this API.' }));
		const result = await callSkyscanner(
			'/api/v1/flights/searchAirport',
			{},
			{ apiKey: 'bad', signal: new AbortController().signal, fetchImpl }
		);
		expect(result).toEqual({
			ok: false,
			error: {
				code: 'not-subscribed',
				message: 'You are not subscribed to this API.',
				status: 403
			}
		});
	});

	it('does not mislabel an unrelated 403 as not-subscribed', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403, { message: 'Forbidden origin' }));
		const result = await callSkyscanner(
			'/api/v1/flights/searchAirport',
			{},
			{ apiKey: 'k', signal: new AbortController().signal, fetchImpl }
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe('unknown');
	});

	it('maps a 429 to quota-exceeded and carries Retry-After through', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse(429, { message: 'Too Many Requests' }, { 'retry-after': '30' }));
		const result = await callSkyscanner(
			'/api/v1/flights/searchAirport',
			{},
			{ apiKey: 'k', signal: new AbortController().signal, fetchImpl }
		);
		expect(result).toEqual({
			ok: false,
			error: {
				code: 'quota-exceeded',
				message: 'Sky Scrapper rate limit or monthly quota reached',
				status: 429,
				retryAfterSeconds: 30
			}
		});
	});

	it('maps a 429 with no Retry-After header to quota-exceeded with no retry hint', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(429, {}));
		const result = await callSkyscanner(
			'/api/v1/flights/searchAirport',
			{},
			{ apiKey: 'k', signal: new AbortController().signal, fetchImpl }
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe('quota-exceeded');
			if (result.error.code === 'quota-exceeded') {
				expect(result.error.retryAfterSeconds).toBeUndefined();
			}
		}
	});

	it('maps a thrown network failure to network-error when the signal was not aborted', async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
		const result = await callSkyscanner(
			'/api/v1/flights/searchAirport',
			{},
			{ apiKey: 'k', signal: new AbortController().signal, fetchImpl }
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe('network-error');
	});

	it('maps a thrown failure to cancelled when the signal was already aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchImpl = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));
		const result = await callSkyscanner(
			'/api/v1/flights/searchAirport',
			{},
			{ apiKey: 'k', signal: controller.signal, fetchImpl }
		);
		expect(result).toEqual({
			ok: false,
			error: { code: 'cancelled', message: 'Sky Scrapper request was aborted' }
		});
	});

	it('maps invalid JSON on an otherwise-ok response to malformed-response', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>not json</html>', { status: 200 }));
		const result = await callSkyscanner(
			'/api/v1/flights/searchAirport',
			{},
			{ apiKey: 'k', signal: new AbortController().signal, fetchImpl }
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe('malformed-response');
	});

	it('maps an unexpected status code to unknown rather than guessing', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { message: 'oops' }));
		const result = await callSkyscanner(
			'/api/v1/flights/searchAirport',
			{},
			{ apiKey: 'k', signal: new AbortController().signal, fetchImpl }
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe('unknown');
	});
});

/**
 * Issue #146. Sky Scrapper's free tier is 20 requests a month and this app's own counter
 * lives in one browser's `localStorage`, so a second profile has always believed it had
 * all 20. RapidAPI states the real figure in headers on every response, and until this
 * suite existed nothing in `src/` read them.
 */
describe('callSkyscanner and the account’s own quota', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('records what the response said about the key’s remaining quota', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse(
				200,
				{ status: true, data: [] },
				{
					'x-ratelimit-requests-limit': '20',
					'x-ratelimit-requests-remaining': '4',
					'x-ratelimit-requests-reset': '1209600'
				}
			)
		);
		await callSkyscanner('/api/v1/flights/searchAirport', {}, { apiKey: 'k', signal: new AbortController().signal, fetchImpl });

		expect(getReportedProviderQuota('skyscanner')).toMatchObject({ limit: 20, remaining: 4, scope: 'requests' });
	});

	it('records them off a 429 too, which is when they matter most', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse(429, {}, { 'x-ratelimit-requests-limit': '20', 'x-ratelimit-requests-remaining': '0' }));
		await callSkyscanner('/api/v1/flights/searchAirport', {}, { apiKey: 'k', signal: new AbortController().signal, fetchImpl });

		expect(getReportedProviderQuota('skyscanner')?.remaining).toBe(0);
	});

	it('leaves the store untouched when a response carries no such headers', async () => {
		// The expected case until someone measures a real RapidAPI response from a browser:
		// a cross-origin fetch cannot read a header the server does not expose.
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { status: true }));
		await callSkyscanner('/api/v1/flights/searchAirport', {}, { apiKey: 'k', signal: new AbortController().signal, fetchImpl });

		expect(getReportedProviderQuota('skyscanner')).toBeUndefined();
	});
});
