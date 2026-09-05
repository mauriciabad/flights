import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryCacheStore } from '../../cache';
import type { LocalDateTime } from '../../domain';
import type { ProviderContext } from '../types';
import { createTransitousTransferProvider } from './transitous';

/**
 * Fixture reused from transitous-mapper.test.ts's rural-night case, trimmed further since
 * this file only checks that the envelope (ProviderResult, caching, error mapping) around
 * the mapper is wired correctly — not the mapping logic itself.
 */
function nightGapPlanBody() {
	return {
		itineraries: [
			{
				duration: 2700,
				startTime: '2026-09-10T04:56:00Z',
				endTime: '2026-09-10T05:41:00Z',
				transfers: 0,
				legs: [
					{
						mode: 'BUS',
						duration: 1980,
						startTime: '2026-09-10T05:03:00Z',
						endTime: '2026-09-10T05:36:00Z',
						routeShortName: 'L0163',
						agencyName: 'TEISA',
						from: { name: 'Besalú', lat: 42.200294, lon: 2.697596, tz: 'Europe/Madrid' },
						to: { name: 'Olot', lat: 42.180717, lon: 2.491254, tz: 'Europe/Madrid' }
					}
				]
			}
		]
	};
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
}

function ctx(signal: AbortSignal = new AbortController().signal): ProviderContext {
	return { signal };
}

const REQUESTED_LATE_NIGHT_DEPARTURE: LocalDateTime = {
	// 03:00 local — the query time from the rural fixture above, well before the 07:03
	// local bus this fixture's data actually returns.
	local: '2026-09-10T03:00:00',
	timeZone: 'Europe/Madrid',
	utcOffsetMinutes: 120
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe('createTransitousTransferProvider', () => {
	it('declares itself keyless, per docs/PROVIDERS.md', () => {
		const provider = createTransitousTransferProvider();
		expect(provider.kind).toBe('transfer');
		expect(provider.id).toBe('transitous');
		expect(provider.needsKey).toBe(false);
		expect(provider.keyFields).toEqual([]);
	});

	it('the last-bus problem surfaces as ok:true, not an error', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(nightGapPlanBody()));
		const provider = createTransitousTransferProvider({
			fetchImpl,
			resolveStore: async () => new MemoryCacheStore()
		});

		const result = await provider.searchTransfers(
			{
				from: { latitude: 42.199, longitude: 2.6975 },
				to: { latitude: 42.1818, longitude: 2.4901 },
				departure: REQUESTED_LATE_NIGHT_DEPARTURE
			},
			ctx()
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toHaveLength(1);
		const [transfer] = result.data;
		expect(transfer.transitSchedule?.intended.local).toBe('2026-09-10T07:03:00');
		// The caller (not this adapter) computes "no service for 4h 03m" by diffing the
		// query's requested departure against this — both values survive intact for it to
		// do that with.
		expect(REQUESTED_LATE_NIGHT_DEPARTURE.local < transfer.transitSchedule!.intended.local).toBe(true);
		expect(result.source.providerId).toBe('transitous');
		expect(result.requestsUsed).toBe(1);
	});

	it('returns ok:true with an empty array, not an error, when no transit route exists at all', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ itineraries: [] }));
		const provider = createTransitousTransferProvider({
			fetchImpl,
			resolveStore: async () => new MemoryCacheStore()
		});

		const result = await provider.searchTransfers(
			{
				from: { latitude: 0, longitude: -30 },
				to: { latitude: 0.5, longitude: -30.5 },
				departure: REQUESTED_LATE_NIGHT_DEPARTURE
			},
			ctx()
		);

		expect(result).toMatchObject({ ok: true, data: [], requestsUsed: 1 });
	});

	it('declines rather than planning for the moment the search ran (issue #135)', async () => {
		// The whole defect: with no journey moment this used to substitute `new Date()` and
		// hand back a real timetable for today, which the results page then presented as the
		// plan for a flight weeks away. Nothing goes on the wire now, and the caller gets an
		// empty answer that cost no request rather than a confident wrong one.
		const fetchImpl = vi.fn();
		const provider = createTransitousTransferProvider({
			fetchImpl,
			resolveStore: async () => new MemoryCacheStore()
		});

		const result = await provider.searchTransfers(
			{ from: { latitude: 41, longitude: 2 }, to: { latitude: 41.1, longitude: 2.1 } },
			ctx()
		);

		expect(result).toMatchObject({ ok: true, data: [], requestsUsed: 0 });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('asks arriveBy for a leg that has to reach a deadline, and caches the two questions apart', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(nightGapPlanBody()));
		const store = new MemoryCacheStore();
		const provider = createTransitousTransferProvider({ fetchImpl, resolveStore: async () => store });
		const query = {
			from: { latitude: 42.199, longitude: 2.6975 },
			to: { latitude: 42.1818, longitude: 2.4901 },
			departure: REQUESTED_LATE_NIGHT_DEPARTURE
		};

		await provider.searchTransfers({ ...query, arriveBy: true }, ctx());
		expect(fetchImpl.mock.calls[0][0]).toContain('arriveBy=true');

		// Same coordinates, same instant, opposite question: a cache that ignored `arriveBy`
		// would serve the deadline answer to the depart-after query.
		await provider.searchTransfers({ ...query, arriveBy: false }, ctx());
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(fetchImpl.mock.calls[1][0]).toContain('arriveBy=false');
	});

	it('skips the network call when the caller only wants modes this adapter cannot supply', async () => {
		const fetchImpl = vi.fn();
		const provider = createTransitousTransferProvider({
			fetchImpl,
			resolveStore: async () => new MemoryCacheStore()
		});

		const result = await provider.searchTransfers(
			{
				from: { latitude: 41, longitude: 2 },
				to: { latitude: 41, longitude: 2 },
				modes: ['taxi', 'drive']
			},
			ctx()
		);

		expect(result).toMatchObject({ ok: true, data: [], requestsUsed: 0 });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('caches an identical query and reports the second call as free', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(nightGapPlanBody()));
		const store = new MemoryCacheStore();
		const provider = createTransitousTransferProvider({ fetchImpl, resolveStore: async () => store });
		const query = {
			from: { latitude: 42.199, longitude: 2.6975 },
			to: { latitude: 42.1818, longitude: 2.4901 },
			departure: REQUESTED_LATE_NIGHT_DEPARTURE
		};

		const first = await provider.searchTransfers(query, ctx());
		const second = await provider.searchTransfers(query, ctx());

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(first.requestsUsed).toBe(1);
		expect(second.requestsUsed).toBe(0);
		expect(second.ok).toBe(true);
		if (second.ok) expect(second.data).toEqual(first.ok ? first.data : undefined);
	});

	it('answers from an expired schedule without waiting for the refresh (issue #194)', async () => {
		// The refresh never resolves. That is the whole assertion: if this call awaited it,
		// the test would hang, which is exactly what the results page did — blank for 24
		// seconds while four cities were refetched in sequence. Before #194 this adapter read
		// through a private `readFreshCacheEntry` that returned `undefined` past the TTL, so
		// there was nothing to answer with and the await was unavoidable.
		let refreshStarted = false;
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(nightGapPlanBody()))
			.mockImplementation(() => {
				refreshStarted = true;
				return new Promise<Response>(() => {});
			});
		const store = new MemoryCacheStore();
		const provider = createTransitousTransferProvider({ fetchImpl, resolveStore: async () => store });
		const query = {
			from: { latitude: 42.199, longitude: 2.6975 },
			to: { latitude: 42.1818, longitude: 2.4901 },
			departure: REQUESTED_LATE_NIGHT_DEPARTURE
		};

		const first = await provider.searchTransfers(query, ctx());
		expect(first.ok).toBe(true);

		// Past the five-minute TTL, which is where almost every reload lands.
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60 * 1000);
		const second = await provider.searchTransfers(query, ctx());

		expect(second.ok).toBe(true);
		if (second.ok && first.ok) expect(second.data).toEqual(first.data);
		expect(second.requestsUsed).toBe(1);
		expect(refreshStarted).toBe(true);
	});

	it('starts one refresh for several callers asking about the same plan at once', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(nightGapPlanBody()))
			.mockImplementation(() => new Promise<Response>(() => {}));
		const store = new MemoryCacheStore();
		const provider = createTransitousTransferProvider({ fetchImpl, resolveStore: async () => store });
		const query = {
			from: { latitude: 42.199, longitude: 2.6975 },
			to: { latitude: 42.1818, longitude: 2.4901 },
			departure: REQUESTED_LATE_NIGHT_DEPARTURE
		};

		await provider.searchTransfers(query, ctx());
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60 * 1000);
		// Three candidate itineraries can share one connection airport at one time. A refresh
		// each would spend three requests to learn one schedule.
		await Promise.all([
			provider.searchTransfers(query, ctx()),
			provider.searchTransfers(query, ctx()),
			provider.searchTransfers(query, ctx())
		]);

		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('dates a stale answer by when it was fetched, not by when it was read', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(nightGapPlanBody()));
		const store = new MemoryCacheStore();
		const provider = createTransitousTransferProvider({ fetchImpl, resolveStore: async () => store });
		const query = {
			from: { latitude: 42.199, longitude: 2.6975 },
			to: { latitude: 42.1818, longitude: 2.4901 },
			departure: REQUESTED_LATE_NIGHT_DEPARTURE
		};

		const fetchedAt = Date.now();
		const first = await provider.searchTransfers(query, ctx());
		vi.spyOn(Date, 'now').mockReturnValue(fetchedAt + 90 * 60 * 1000);
		const second = await provider.searchTransfers(query, ctx());

		// Issue #151's rule, applied to the stale tier: a schedule read out of a 90-minute-old
		// entry must not claim it came off the wire this second.
		expect(first.ok && second.ok && second.source.fetchedAt).toBe(first.ok ? first.source.fetchedAt : '');
	});

	it('maps a well-formed 200 whose itineraries have no readable fields to malformed-response, not ok:true empty (issue #68)', async () => {
		// Distinct from the "no route" test above: the client-level shape check
		// (transitous-client.ts) passes — `itineraries` really is an array — but nothing
		// inside a single itinerary has fields this adapter can read. Reporting this as
		// ok:true/[] would look identical to a genuine "no service" result to a caller.
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse({
				itineraries: [
					{
						duration: 600,
						startTime: 'not-a-real-instant',
						endTime: 'not-a-real-instant',
						transfers: 0,
						legs: [
							{
								mode: 'BUS',
								duration: 600,
								startTime: 'not-a-real-instant',
								endTime: 'not-a-real-instant',
								from: { name: 'A', lat: 0, lon: 0 },
								to: { name: 'B', lat: 0, lon: 0 }
							}
						]
					}
				]
			})
		);
		const provider = createTransitousTransferProvider({
			fetchImpl,
			resolveStore: async () => new MemoryCacheStore()
		});

		const result = await provider.searchTransfers(
			{ from: { latitude: 41, longitude: 2 }, to: { latitude: 41.1, longitude: 2.1 }, departure: REQUESTED_LATE_NIGHT_DEPARTURE },
			ctx()
		);

		expect(result).toMatchObject({ ok: false, error: { code: 'malformed-response' }, requestsUsed: 1 });
	});

	it('maps a 429 to quota-exceeded and still reports the request as spent', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response('slow down', { status: 429, headers: { 'Retry-After': '20' } }));
		const provider = createTransitousTransferProvider({
			fetchImpl,
			resolveStore: async () => new MemoryCacheStore()
		});

		const result = await provider.searchTransfers(
			{ from: { latitude: 41, longitude: 2 }, to: { latitude: 41.1, longitude: 2.1 }, departure: REQUESTED_LATE_NIGHT_DEPARTURE },
			ctx()
		);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatchObject({ code: 'quota-exceeded', status: 429, retryAfterSeconds: 20 });
		expect(result.requestsUsed).toBe(1);
	});

	it('maps a connectivity failure to network-error with requestsUsed 0', async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
		const provider = createTransitousTransferProvider({
			fetchImpl,
			resolveStore: async () => new MemoryCacheStore()
		});

		const result = await provider.searchTransfers(
			{ from: { latitude: 41, longitude: 2 }, to: { latitude: 41.1, longitude: 2.1 }, departure: REQUESTED_LATE_NIGHT_DEPARTURE },
			ctx()
		);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('network-error');
		expect(result.requestsUsed).toBe(0);
	});

	it('resolves with a typed cancelled result instead of rejecting when the signal aborts', async () => {
		const controller = new AbortController();
		const fetchImpl = vi.fn().mockImplementation(() => {
			const abortError = new DOMException('aborted', 'AbortError');
			return Promise.reject(abortError);
		});
		const provider = createTransitousTransferProvider({
			fetchImpl,
			resolveStore: async () => new MemoryCacheStore()
		});

		const result = await provider.searchTransfers(
			{ from: { latitude: 41, longitude: 2 }, to: { latitude: 41.1, longitude: 2.1 }, departure: REQUESTED_LATE_NIGHT_DEPARTURE },
			ctx(controller.signal)
		);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('cancelled');
		expect(result.requestsUsed).toBe(0);
	});

	it('healthCheck resolves ok on a reachable service', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
		const provider = createTransitousTransferProvider({ fetchImpl });
		const result = await provider.healthCheck(ctx());
		expect(result.ok).toBe(true);
		expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('/geocode'), expect.anything());
	});

	it('healthCheck reports a typed error rather than throwing when the service is down', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response('down', { status: 503 }));
		const provider = createTransitousTransferProvider({ fetchImpl });
		const result = await provider.healthCheck(ctx());
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('malformed-response');
	});
});
