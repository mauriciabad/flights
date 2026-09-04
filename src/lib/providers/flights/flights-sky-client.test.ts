import { describe, expect, it, vi } from 'vitest';
import { ProviderHttpError } from '../budget';
import {
	FlightsSkyMalformedResponseError,
	classifyFlightsSkyError,
	fetchAutoComplete,
	fetchPriceCalendar,
	fetchSearchOneWay
} from './flights-sky-client';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers });
}

describe('fetchAutoComplete', () => {
	it('resolves the parsed body on a 2xx response', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { status: true, data: [] }));
		const result = await fetchAutoComplete('barcelona', {
			apiKey: 'k',
			signal: new AbortController().signal,
			fetchImpl
		});
		expect(result).toEqual({ status: true, data: [] });
	});

	it('sends the RapidAPI headers, host and query param', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));
		await fetchAutoComplete('barcelona', { apiKey: 'the-key', signal: new AbortController().signal, fetchImpl });
		const [calledUrl, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(calledUrl).toBe('https://flights-sky.p.rapidapi.com/flights/auto-complete?query=barcelona');
		expect((init.headers as Record<string, string>)['x-rapidapi-key']).toBe('the-key');
		expect((init.headers as Record<string, string>)['x-rapidapi-host']).toBe('flights-sky.p.rapidapi.com');
	});

	// docs/PROVIDERS.md: measured, real shape of an unsubscribed RapidAPI key. Not this
	// adapter's own capture, since triggering it for real would mean deliberately breaking
	// the owner's subscription.
	it('throws a ProviderHttpError that classifies as not-subscribed for the documented 403 body', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse(403, { message: 'You are not subscribed to this API.' }));
		const error = await fetchAutoComplete('barcelona', {
			apiKey: 'bad',
			signal: new AbortController().signal,
			fetchImpl
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProviderHttpError);
		expect((error as ProviderHttpError).status).toBe(403);
		expect(classifyFlightsSkyError(error)).toBe('not-subscribed');
	});

	it('does not mislabel an unrelated 403 as not-subscribed', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403, { message: 'Forbidden origin' }));
		const error = await fetchAutoComplete('barcelona', {
			apiKey: 'k',
			signal: new AbortController().signal,
			fetchImpl
		}).catch((e: unknown) => e);
		expect(classifyFlightsSkyError(error)).toBe('unknown');
	});

	it('throws a ProviderHttpError carrying Retry-After on a 429', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse(429, { message: 'Too Many Requests' }, { 'retry-after': '30' }));
		const error = await fetchAutoComplete('barcelona', {
			apiKey: 'k',
			signal: new AbortController().signal,
			fetchImpl
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProviderHttpError);
		expect((error as ProviderHttpError).retryAfterSeconds).toBe(30);
		expect(classifyFlightsSkyError(error)).toBe('quota-exceeded');
	});

	it('maps invalid JSON on an otherwise-ok response to FlightsSkyMalformedResponseError', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>not json</html>', { status: 200 }));
		await expect(
			fetchAutoComplete('barcelona', { apiKey: 'k', signal: new AbortController().signal, fetchImpl })
		).rejects.toBeInstanceOf(FlightsSkyMalformedResponseError);
	});
});

describe('fetchPriceCalendar', () => {
	it('sends fromEntityId/toEntityId/departDate/currency as query params', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: { flights: { days: [] } } }));
		await fetchPriceCalendar(
			{ fromEntityId: 'BCN', toEntityId: 'VIE', departDate: '2026-10-15', currency: 'EUR' },
			{ apiKey: 'k', signal: new AbortController().signal, fetchImpl }
		);
		const [calledUrl] = fetchImpl.mock.calls[0] as [string];
		expect(calledUrl).toBe(
			'https://flights-sky.p.rapidapi.com/flights/price-calendar?fromEntityId=BCN&toEntityId=VIE&departDate=2026-10-15&currency=EUR'
		);
	});

	// Measured 2026-09-04: passing the numeric entityId instead of the letters-only skyId
	// answers this exact 400 shape (flights-sky-types.ts FlightsSkyEntity.skyId's doc
	// comment). `errors` here is a string, not RapidAPI's usual `message` field, which is
	// exactly why messageFrom (flights-sky-client.ts) tries both.
	it('surfaces the errors field as the ProviderHttpError message on a validation 400', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse(400, {
				data: null,
				errors: 'query param originRelevantFlightSkyId SkyId can contain only letters'
			})
		);
		const error = await fetchPriceCalendar(
			{ fromEntityId: '95565085', toEntityId: 'VIE', departDate: '2026-10-15', currency: 'EUR' },
			{ apiKey: 'k', signal: new AbortController().signal, fetchImpl }
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProviderHttpError);
		expect((error as ProviderHttpError).message).toContain('SkyId can contain only letters');
		expect(classifyFlightsSkyError(error)).toBe('unknown');
	});
});

describe('fetchSearchOneWay', () => {
	it('sends fromEntityId/toEntityId/departDate/currency as query params', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: { itineraries: [] } }));
		await fetchSearchOneWay(
			{ fromEntityId: 'BCN', toEntityId: 'VIE', departDate: '2026-09-19', currency: 'EUR' },
			{ apiKey: 'k', signal: new AbortController().signal, fetchImpl }
		);
		const [calledUrl] = fetchImpl.mock.calls[0] as [string];
		expect(calledUrl).toBe(
			'https://flights-sky.p.rapidapi.com/flights/search-one-way?fromEntityId=BCN&toEntityId=VIE&departDate=2026-09-19&currency=EUR'
		);
	});
});

describe('classifyFlightsSkyError', () => {
	it('classifies a cancelled fetch (AbortError) as cancelled', () => {
		expect(classifyFlightsSkyError(new DOMException('aborted', 'AbortError'))).toBe('cancelled');
	});

	it('classifies a bare network TypeError as network-error', () => {
		expect(classifyFlightsSkyError(new TypeError('Failed to fetch'))).toBe('network-error');
	});
});
