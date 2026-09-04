/**
 * `TransferProvider` implementation for Transitous (issue #8: "the last bus problem").
 * Orchestration only — HTTP lives in transitous-client.ts, response shaping in
 * transitous-mapper.ts, timezone arithmetic in transitous-datetime.ts. This file's own
 * job is the `ProviderResult` envelope: caching, request accounting, and turning whatever
 * the client throws into one of `ProviderError`'s cases.
 *
 * Scope, deliberately narrow: this adapter only ever returns `mode: 'transit'` transfers.
 * Transitous's `/plan` response also carries walk-only `direct` itineraries, but
 * docs/PROVIDERS.md already assigns walking/driving duration to a future OSRM adapter —
 * duplicating that here would be two sources of truth for the same number. If a caller's
 * `TransferSearchQuery.modes` excludes `'transit'`, this adapter has nothing to contribute
 * and returns an empty, still-`ok`, result without making a request.
 */

import type { CacheKey, CacheStore } from '../../cache';
import { defineCacheKey, getDefaultStore } from '../../cache';
import type { Transfer, TransitPlanMoment } from '../../domain';
import type {
	ProviderContext,
	ProviderError,
	ProviderHealth,
	ProviderResult,
	ProviderSource,
	TransferProvider,
	TransferSearchQuery
} from '../types';
import {
	checkTransitousHealth,
	fetchTransitousPlan,
	TransitousHttpError,
	TransitousMalformedResponseError,
	TRANSITOUS_PROVIDER_ID
} from './transitous-client';
import { localDateTimeToUtcInstant } from './transitous-datetime';
import { mapPlanResponseToTransfer, TransitousMapMalformedResponseError } from './transitous-mapper';

/**
 * A schedule fetched for a specific instant doesn't need "stale-while-revalidate" — unlike
 * a price, it won't drift while sitting in the cache, so there is nothing to show-then-
 * refresh. What it needs is simply not being re-fetched for a query the app just made:
 * an itinerary builder can easily ask about the same connection-airport-and-rough-time
 * pair from several candidate itineraries in one search. Five minutes is short enough that
 * a schedule fetched well ahead of the actual day of travel still gets refreshed with any
 * realtime update by the time it matters, and long enough to absorb that kind of repeat
 * query without a second real request — the concrete form issue #8's "cache aggressively,
 * do not hammer them" takes for a provider whose data is tied to a fixed point in time
 * rather than a fluctuating price.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface CreateTransitousTransferProviderOptions {
	/** Overrides the global `fetch`, for tests only. */
	fetchImpl?: typeof fetch;
	/** Overrides the default IndexedDB-or-memory cache store, for tests only. */
	resolveStore?: () => Promise<CacheStore>;
}

export function createTransitousTransferProvider(
	options: CreateTransitousTransferProviderOptions = {}
): TransferProvider {
	const fetchImpl = options.fetchImpl;
	const resolveStore = options.resolveStore ?? getDefaultStore;

	return {
		kind: 'transfer',
		id: TRANSITOUS_PROVIDER_ID,
		label: 'Transitous',
		needsKey: false,
		keyFields: [],
		// Timetables only, deliberately — see this file's header for why walking and driving
		// durations belong to OSRM rather than being read out of the same `/plan` response.
		modes: ['transit'],

		async healthCheck(ctx: ProviderContext): Promise<ProviderHealth> {
			const fetchedAt = new Date().toISOString();
			try {
				await checkTransitousHealth({ signal: ctx.signal, fetchImpl });
				return {
					ok: true,
					data: {},
					source: { providerId: TRANSITOUS_PROVIDER_ID, fetchedAt },
					requestsUsed: 1
				};
			} catch (cause) {
				return mapThrownToResult(cause, fetchedAt);
			}
		},

		async searchTransfers(
			query: TransferSearchQuery,
			ctx: ProviderContext
		): Promise<ProviderResult<Transfer[]>> {
			const fetchedAt = new Date().toISOString();
			const source: ProviderSource = { providerId: TRANSITOUS_PROVIDER_ID, fetchedAt };

			if (query.modes && !query.modes.includes('transit')) {
				return { ok: true, data: [], source, requestsUsed: 0 };
			}

			// Issue #135. This used to fall back to `new Date()`, so a search run at 11:07 on
			// a Thursday in September asked for the timetable of 11:07 on a Thursday in
			// September and the results page presented it as the plan for a 06:15 Sunday
			// check-in three weeks later. A different day of the week is exactly where bus
			// and train timetables diverge most, so the wrong answer looked entirely
			// plausible. Declining costs a caller its transit option; guessing costs the
			// traveller a flight.
			if (!query.departure) {
				return { ok: true, data: [], source, requestsUsed: 0 };
			}

			const plannedFor: TransitPlanMoment = {
				time: query.departure,
				arriveBy: query.arriveBy ?? false
			};
			const departureUtc = localDateTimeToUtcInstant(query.departure);

			const cacheKey = defineCacheKey(
				TRANSITOUS_PROVIDER_ID,
				{
					from: query.from,
					to: query.to,
					departureUtc: departureUtc.toISOString(),
					// Same instant, opposite question, entirely different answer — so it needs
					// its own key. AGENTS.md's own #131 lesson: a cached value whose shape or
					// meaning changed needs a key that no longer resolves to the old one.
					arriveBy: plannedFor.arriveBy
				},
				CACHE_TTL_MS
			);

			const store = await resolveStore();
			const cached = await readFreshCacheEntry(store, cacheKey);
			if (cached) {
				return {
					ok: true,
					data: cached.value,
					source: { providerId: TRANSITOUS_PROVIDER_ID, fetchedAt: new Date(cached.storedAt).toISOString() },
					requestsUsed: 0
				};
			}

			try {
				const plan = await fetchTransitousPlan(
					{ from: query.from, to: query.to, departureUtc, arriveBy: plannedFor.arriveBy },
					{ signal: ctx.signal, fetchImpl }
				);
				const transfer = mapPlanResponseToTransfer(plan, plannedFor);
				const data = transfer ? [transfer] : [];
				await writeCacheEntry(store, cacheKey, data);
				return {
					ok: true,
					data,
					source: { providerId: TRANSITOUS_PROVIDER_ID, fetchedAt: new Date().toISOString() },
					requestsUsed: 1
				};
			} catch (cause) {
				return mapThrownToResult(cause, fetchedAt);
			}
		}
	};
}

/** Ready-to-register default instance — most callers want this, not the factory above.
 * The factory stays exported for tests that need to inject `fetchImpl`/`resolveStore`. */
export const transitousTransferProvider = createTransitousTransferProvider();

async function readFreshCacheEntry(
	store: CacheStore,
	key: CacheKey
): Promise<{ value: Transfer[]; storedAt: number } | undefined> {
	const entry = await store.get(key.raw);
	if (!entry) return undefined;
	if (Date.now() - entry.storedAt >= entry.ttlMs) return undefined;
	return { value: entry.value as Transfer[], storedAt: entry.storedAt };
}

async function writeCacheEntry(store: CacheStore, key: CacheKey, value: Transfer[]): Promise<void> {
	const now = Date.now();
	await store.set({
		key: key.raw,
		providerId: key.providerId,
		value,
		storedAt: now,
		ttlMs: key.ttlMs,
		lastAccessedAt: now,
		// cache/size.ts's own `estimateByteSize` is a private implementation detail behind
		// cache/index.ts (not re-exported) — this stays a rough, self-contained estimate
		// rather than reaching past that module's public surface for a number the store
		// only needs to be approximately right (types.ts `StoredCacheEntry.sizeBytes`:
		// "Approximate serialised size").
		sizeBytes: JSON.stringify(value).length
	});
}

function mapThrownToResult<T>(cause: unknown, fetchedAt: string): ProviderResult<T> {
	const source: ProviderSource = { providerId: TRANSITOUS_PROVIDER_ID, fetchedAt };

	if (isAbortError(cause)) {
		return {
			ok: false,
			error: { code: 'cancelled', message: 'The request was cancelled' },
			source,
			requestsUsed: 0
		};
	}

	if (cause instanceof TransitousHttpError) {
		const error: ProviderError =
			cause.status === 429
				? {
						code: 'quota-exceeded',
						message: cause.message,
						status: 429,
						retryAfterSeconds: cause.retryAfterSeconds
					}
				: { code: 'malformed-response', message: cause.message };
		// A request did reach Transitous and got an HTTP response back, whatever it was —
		// that is real load on their server, unlike the network-error case below where
		// none was ever received (types.ts: "No HTTP status, because none was ever
		// received"), so this counts against request budgets even though Transitous is
		// itself unmetered.
		return { ok: false, error, source, requestsUsed: 1 };
	}

	if (cause instanceof TransitousMalformedResponseError) {
		return {
			ok: false,
			error: { code: 'malformed-response', message: cause.message, cause: cause.cause },
			source,
			requestsUsed: 1
		};
	}

	if (cause instanceof TransitousMapMalformedResponseError) {
		// A request DID reach Transitous and come back as valid JSON with a real
		// `itineraries` array — transitous-client.ts's own shape check passed — but
		// transitous-mapper.ts couldn't read the fields inside it (issue #68). Same
		// requestsUsed accounting as the client-level TransitousMalformedResponseError case
		// just above: this counts as one real, already-spent request.
		return {
			ok: false,
			error: { code: 'malformed-response', message: cause.message },
			source,
			requestsUsed: 1
		};
	}

	if (cause instanceof TypeError) {
		// fetch's own connectivity failure (offline, DNS, a CORS rejection) surfaces as a
		// bare TypeError with no response ever received.
		return {
			ok: false,
			error: { code: 'network-error', message: cause.message, cause },
			source,
			requestsUsed: 0
		};
	}

	return {
		ok: false,
		error: {
			code: 'unknown',
			message: cause instanceof Error ? cause.message : String(cause),
			cause
		},
		source,
		requestsUsed: 1
	};
}

function isAbortError(cause: unknown): boolean {
	return (
		(cause instanceof DOMException && cause.name === 'AbortError') ||
		(cause instanceof Error && cause.name === 'AbortError')
	);
}
