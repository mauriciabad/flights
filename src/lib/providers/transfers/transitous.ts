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
import { defineCacheKey, getDefaultStore, readCachedEntry, revalidationSettled } from '../../cache';
import type { Transfer, TransitPlanMoment } from '../../domain';
import { greatCircleDistanceKm } from '../../domain';
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
 * How long a schedule stays current. Five minutes is short enough that a plan fetched well
 * ahead of the day of travel picks up any realtime update by the time it matters, and long
 * enough to absorb the repeat queries one search makes — an itinerary builder easily asks
 * about the same connection-airport-and-rough-time pair from several candidates. Issue #8's
 * "cache aggressively, do not hammer them", for a provider whose data is tied to a fixed
 * instant rather than a fluctuating price.
 *
 * Past it the entry is stale, not gone. This file used to read through a private
 * `readFreshCacheEntry` whose body was the exact line `cache/read-entry.ts` was written to
 * delete, and five minutes is short enough that almost every reload landed past it: a
 * search reloaded ninety minutes later re-asked Transitous for four plans it was already
 * holding and painted nothing until they came back. On the reasoning that a fixed-instant
 * schedule does not drift, serving the held answer while a refresh runs behind it is
 * strictly better than making the traveller wait for one.
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
	/** Keys with a refresh already running, so several candidate itineraries asking about
	 * one airport at one time start one request between them rather than one each. */
	const revalidating = new Set<string>();

	/**
	 * Refetches one plan behind an answer already given. Returns nothing and rejects never:
	 * nobody is awaiting it, so a rejection would be unhandled, and a failed refresh is not
	 * a failure of the call that started it. The traveller keeps the schedule they were
	 * shown, with its real age still on the card.
	 */
	async function revalidatePlan(
		query: TransferSearchQuery,
		plannedFor: TransitPlanMoment,
		departureUtc: Date,
		ctx: ProviderContext,
		store: CacheStore,
		cacheKey: CacheKey
	): Promise<void> {
		if (revalidating.has(cacheKey.raw)) return;
		revalidating.add(cacheKey.raw);
		try {
			const plan = await fetchTransitousPlan(
				{ from: query.from, to: query.to, departureUtc, arriveBy: plannedFor.arriveBy },
				{ signal: ctx.signal, fetchImpl }
			);
			const transfer = mapPlanResponseToTransfer(
				plan,
				plannedFor,
				greatCircleDistanceKm(query.from, query.to)
			);
			await writeCacheEntry(store, cacheKey, transfer ? [transfer] : [], Date.now());
			revalidationSettled(TRANSITOUS_PROVIDER_ID);
		} catch {
			// A malformed or failed refresh leaves the held schedule exactly as it was. The
			// next search tries again; overwriting it with nothing would turn a background
			// refresh into a silent loss of what is on screen.
		} finally {
			revalidating.delete(cacheKey.raw);
		}
	}

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

			// What this entry holds is a TIMETABLE, and it has to stay one.
			//
			// There is no shape version here, unlike `ROUTE_CACHE_SHAPE_VERSION` in osrm.ts,
			// and that is a claim rather than an oversight: every field of the `Transfer[]`
			// below is a function of the four key parts, so the same key can only ever mean
			// the same answer. Two things about this entry make that worth stating. It is
			// served at any age and never discarded for being stale (see the read below), so
			// nothing ages a wrong entry out; and `Transfer` is a type the whole app widens.
			//
			// So: anything computed per SEARCH rather than per journey — a fare in the
			// traveller's currency, a party size, a landing buffer — must be applied after
			// this cache rather than folded into it. Issue #407's transit fare estimate is
			// computed in `search/transit-schedule.ts` for exactly this reason, and
			// `transitous.test.ts` asserts the cached value carries none. Widen the cached
			// `Transfer` with anything the key does not determine and you owe this key a
			// shape version, or every returning visitor keeps the old answer forever.
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
			const cached = await readCachedEntry<Transfer[]>(store, cacheKey);
			if (cached) {
				// Served at any age, never discarded for being past its TTL. One adapter
				// awaiting one request is enough to hold the whole results page blank, because
				// the candidate graph waits on all of them, and at a five-minute TTL that was
				// nearly every reload.
				const revalidated = !cached.fresh;
				if (revalidated) {
					void revalidatePlan(query, plannedFor, departureUtc, ctx, store, cacheKey);
				}
				return {
					ok: true,
					data: cached.value,
					source: { providerId: TRANSITOUS_PROVIDER_ID, fetchedAt: new Date(cached.storedAt).toISOString() },
					requestsUsed: revalidated ? 1 : 0
				};
			}

			try {
				const plan = await fetchTransitousPlan(
					{ from: query.from, to: query.to, departureUtc, arriveBy: plannedFor.arriveBy },
					{ signal: ctx.signal, fetchImpl }
				);
				// Issue #220: the mapper measures Transitous's answer against how far apart
				// the two points actually are. Great-circle is a lower bound on any real
				// path (`domain/coordinates.ts`), so a journey already implausible against
				// this is implausible against the road too.
				const transfer = mapPlanResponseToTransfer(
					plan,
					plannedFor,
					greatCircleDistanceKm(query.from, query.to)
				);
				const data = transfer ? [transfer] : [];
				const fetchedAtMs = Date.now();
				await writeCacheEntry(store, cacheKey, data, fetchedAtMs);
				return {
					ok: true,
					data,
					source: {
						providerId: TRANSITOUS_PROVIDER_ID,
						fetchedAt: new Date(fetchedAtMs).toISOString()
					},
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

/** `storedAt` is the caller's own fetch instant rather than a fresh `Date.now()`. The two
 * used to differ by however long mapping took, so a fresh answer reported one millisecond
 * and the entry it wrote reported another, and a later stale read of that entry disagreed
 * with the response that created it. */
async function writeCacheEntry(
	store: CacheStore,
	key: CacheKey,
	value: Transfer[],
	fetchedAtMs: number
): Promise<void> {
	const now = fetchedAtMs;
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
