import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	checkTransitousHealth,
	fetchTransitousPlan,
	GROUND_TRANSIT_MODES,
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

describe('fetchTransitousPlan', () => {
	const request = {
		from: { latitude: 41.3874, longitude: 2.1686 },
		to: { latitude: 41.2971, longitude: 2.0785 },
		departureUtc: new Date('2026-09-10T09:00:00Z'),
		arriveBy: false
	};

	it('sends arriveBy=true when the leg has to reach a deadline (issue #135)', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ itineraries: [] }));

		await fetchTransitousPlan({ ...request, arriveBy: true }, {
			signal: new AbortController().signal,
			fetchImpl
		});

		const [url] = fetchImpl.mock.calls[0] as [string];
		expect(url).toContain('arriveBy=true');
	});

	it('builds the documented query shape and returns the parsed body on 2xx', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ itineraries: [] }));

		const result = await fetchTransitousPlan(request, {
			signal: new AbortController().signal,
			fetchImpl
		});

		expect(result).toEqual({ itineraries: [] });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			'https://api.transitous.org/api/v1/plan?fromPlace=41.3874%2C2.1686&toPlace=41.2971%2C2.0785&time=2026-09-10T09%3A00%3A00Z&numItineraries=6&arriveBy=false&transitModes=TRAM%2CFERRY%2CBUS%2CCOACH%2CRAIL%2CODM%2CRIDE_SHARING%2CFUNICULAR%2CAERIAL_LIFT%2COTHER'
		);
		expect((init.headers as Record<string, string>)['User-Agent']).toContain('flights.mauri.app');
	});

	it('asks for ground transit only, so MOTIS never routes a transfer through a flight (issue #220)', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ itineraries: [] }));

		await fetchTransitousPlan(request, { signal: new AbortController().signal, fetchImpl });

		const [url] = fetchImpl.mock.calls[0] as [string];
		const modes = new URL(url).searchParams.get('transitModes')?.split(',') ?? [];
		expect(modes).not.toContain('AIRPLANE');
		// MOTIS's own definition of `TRANSIT`, minus AIRPLANE, not a hand-picked subset.
		// Losing one of these silently would delete real service from every search.
		expect(modes).toEqual([...GROUND_TRANSIT_MODES]);
		expect(modes).toContain('BUS');
		expect(modes).toContain('RAIL');
	});

	it('throws TransitousHttpError, carrying Retry-After, on a 429', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response('rate limited', {
				status: 429,
				headers: { 'Retry-After': '30' }
			})
		);

		await expect(
			fetchTransitousPlan(request, { signal: new AbortController().signal, fetchImpl })
		).rejects.toMatchObject({
			name: 'TransitousHttpError',
			status: 429,
			retryAfterSeconds: 30
		});
	});

	it('throws TransitousHttpError with no retryAfterSeconds for an unrelated non-2xx', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 404 }));

		const error = await fetchTransitousPlan(request, {
			signal: new AbortController().signal,
			fetchImpl
		}).catch((e) => e);

		expect(error).toBeInstanceOf(TransitousHttpError);
		expect(error.status).toBe(404);
		expect(error.retryAfterSeconds).toBeUndefined();
	});

	it('throws TransitousMalformedResponseError on a 2xx body that is not JSON', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response('<html>not json</html>', {
				status: 200,
				headers: { 'content-type': 'text/html' }
			})
		);

		await expect(
			fetchTransitousPlan(request, { signal: new AbortController().signal, fetchImpl })
		).rejects.toBeInstanceOf(TransitousMalformedResponseError);
	});

	it('throws TransitousMalformedResponseError on a 2xx body missing "itineraries"', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ somethingElse: true }));

		await expect(
			fetchTransitousPlan(request, { signal: new AbortController().signal, fetchImpl })
		).rejects.toBeInstanceOf(TransitousMalformedResponseError);
	});

	it('lets an AbortError propagate unchanged rather than wrapping it', async () => {
		const abortError = new DOMException('aborted', 'AbortError');
		const fetchImpl = vi.fn().mockRejectedValue(abortError);

		await expect(
			fetchTransitousPlan(request, { signal: new AbortController().signal, fetchImpl })
		).rejects.toBe(abortError);
	});

	it('lets a bare network TypeError propagate unchanged', async () => {
		const networkError = new TypeError('Failed to fetch');
		const fetchImpl = vi.fn().mockRejectedValue(networkError);

		await expect(
			fetchTransitousPlan(request, { signal: new AbortController().signal, fetchImpl })
		).rejects.toBe(networkError);
	});
});

describe('checkTransitousHealth', () => {
	it('resolves on a 2xx geocode response', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
		await expect(
			checkTransitousHealth({ signal: new AbortController().signal, fetchImpl })
		).resolves.toBeUndefined();
		expect(fetchImpl).toHaveBeenCalledWith(
			expect.stringContaining('/geocode?text=a'),
			expect.anything()
		);
	});

	it('throws TransitousHttpError on a non-2xx', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response('down', { status: 503 }));
		await expect(
			checkTransitousHealth({ signal: new AbortController().signal, fetchImpl })
		).rejects.toBeInstanceOf(TransitousHttpError);
	});
});
