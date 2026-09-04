/**
 * Ryanair adapter — issue #6. Two jobs, per the issue: give the app something real to show
 * before any key is entered, and give the cross-price-check (issue #17) ground truth,
 * since these fares come from the airline itself rather than an aggregator's copy of them.
 *
 * No key, no signup, no quota (docs/PROVIDERS.md "Keyless sources"). That shapes two
 * choices below that would look wrong for a metered adapter: `estimateSearchOffersCost`
 * always answers 0 (there is no budget to protect), and every cached value here is
 * refetched no more than once per its TTL rather than on every call — see "Why not
 * staleWhileRevalidate" further down for why that still counts as "going through the
 * cache" (src/lib/cache/) even though it doesn't use that module's generator directly.
 *
 * One real limitation worth stating up front: `farfnd/v4/oneWayFares` is a fare *finder*,
 * not a timetable. Given an origin, a destination and a date range, it returns the single
 * cheapest fare in that range — not one row per day. Verified by hand 2026-09-04: widening
 * the range from 20 days to 60 days returned the same one fare. That is still real,
 * ground-truth pricing for a real flight number and date (exactly what issue #17 needs to
 * cross-check an aggregator), just not a full schedule.
 *
 * Issue #121 rewrote how the route graph gets here. It used to be one request per airport,
 * which a BCN->OTP search turned into 80 of them (measured, production, cold cache), for
 * data that changes seasonally. Now there is exactly one non-fare request this adapter can
 * make — the active-airports endpoint — and it answers both "which airports fly where" and
 * "what zone is each airport in" for the entire network at once. It is deduplicated across
 * a fan-out, cached for a day, and floored by a snapshot shipped with the app
 * (src/lib/data/ryanair-network.ts), so a cold search now spends nothing at all on routes.
 */

import { defineCacheKey, getDefaultStore, staleWhileRevalidate } from '../../cache';
import type { CacheKey, CacheStore, StaleWhileRevalidateResult } from '../../cache';
import { directDestinationsFrom, loadBundledRyanairNetwork, newerSnapshot } from '../../data/ryanair-network';
import type { RyanairNetworkSnapshot } from '../../data/ryanair-network';
import type { FlightOffer, IataAirportCode } from '../../domain';
import type {
	FlightProvider,
	FlightSearchQuery,
	ProviderContext,
	ProviderError,
	ProviderHealth,
	ProviderId,
	ProviderResult,
	ProviderSource
} from '../types';
import { fetchActiveAirports, fetchOneWayFares } from './ryanair-client';
import { buildNetworkSnapshot, mapFaresToFlightOffers } from './ryanair-mapper';
import type { RyanairFetchError } from './ryanair-types';

/** Keyless and unmetered — no `../budget` cap or wiring applies — but still a real
 * registered adapter id, so it is checked against `ProviderId` (../types.ts, issue #69)
 * like every other adapter's id. */
export const RYANAIR_PROVIDER_ID: ProviderId = 'ryanair';

/** Matches the `Cache-Control: max-age=60, s-maxage=300` Ryanair's own fare-finder
 * endpoint sends (observed 2026-09-04) — short, because a price is only ground truth for
 * as long as it is actually still on sale. */
const FARES_TTL_MS = 5 * 60_000;
/**
 * One TTL for the route graph and the airport timezone table, because they arrive in the
 * same response and there is no way to refresh one without the other. A day is the route
 * graph's number: a base opens or closes seasonally, not intraday. Timezones would happily
 * live for a week, but a second cache entry with its own TTL would only mean two entries
 * that can disagree about which airports exist, for no fewer requests.
 *
 * A day means at most one 278 KB response per device per day, and it is the only
 * `www.ryanair.com` request this adapter makes at all.
 */
const NETWORK_SNAPSHOT_TTL_MS = 24 * 60 * 60_000;

export interface RyanairProviderOptions {
	/** Overrides the shared IndexedDB-or-memory store. Tests inject a `MemoryCacheStore`
	 * so nothing here touches a real browser API. */
	store?: CacheStore;
	/** Overrides the global `fetch`. Tests inject a stub that resolves fixtures. */
	fetchImpl?: typeof fetch;
}

function source(): ProviderSource {
	return { providerId: RYANAIR_PROVIDER_ID, fetchedAt: new Date().toISOString() };
}

function toProviderError(error: RyanairFetchError): ProviderError {
	switch (error.code) {
		case 'cancelled':
			return { code: 'cancelled', message: error.message };
		case 'network-error':
			return { code: 'network-error', message: error.message, cause: error.cause };
		case 'malformed-response':
			return { code: 'malformed-response', message: error.message, cause: error.cause };
		case 'rate-limited':
			// Ryanair has no RapidAPI-style subscription quota, but its own WAF can still
			// 429 a client that hammers it — `quota-exceeded` is still the right UI
			// treatment ("back off"), even though the cause isn't a metered plan.
			return {
				code: 'quota-exceeded',
				message: error.message,
				status: 429,
				retryAfterSeconds: error.retryAfterSeconds
			};
		case 'http-error':
			return { code: 'unknown', message: error.message, cause: { status: error.status } };
	}
}

async function resolveStore(options: RyanairProviderOptions): Promise<CacheStore> {
	return options.store ?? (await getDefaultStore());
}

/**
 * Why not `staleWhileRevalidate` (src/lib/cache/stale-while-revalidate.ts) for the reads
 * below: that generator is built for progressive UI rendering — it always calls its
 * fetcher, using the cache only to decide whether it also gets to yield an instant
 * "stale" preview first. A `FlightProvider` method resolves a single `ProviderResult`,
 * with no consumer able to observe a first, provisional yield, so draining that generator
 * here would just mean paying for a fresh network call on every duplicate query within a
 * fan-out — the opposite of what caching an unmetered-but-still-real server call should
 * do. Cache-aside against `CacheStore` directly (this function, plus `writeCache` below)
 * still goes through src/lib/cache/ and honours the same TTL/eviction contract; it just
 * skips the "fetch every time" half of that module, which is specific to progressive
 * rendering. A future UI layer that wants the two-phase behaviour can call
 * `staleWhileRevalidate` itself around a query built from `FlightSearchQuery`.
 *
 * `refreshNetworkSnapshot` is the one exception, and it proves the rule: it runs only
 * after this function has already answered "no fresh entry", and only once per fan-out,
 * so "fetch every time" costs one request rather than one per caller.
 */
async function readCache<T>(store: CacheStore, key: CacheKey): Promise<T | undefined> {
	const entry = await store.get(key.raw);
	if (entry === undefined) return undefined;
	if (Date.now() - entry.storedAt >= entry.ttlMs) return undefined;
	return entry.value as T;
}

/** Reads whatever is cached under `key` regardless of freshness — used only as a
 * last-resort fallback when we are out of request budget, on the belief that an
 * out-of-season route graph beats having none at all. */
async function readCacheIgnoringTtl<T>(store: CacheStore, key: CacheKey): Promise<T | undefined> {
	const entry = await store.get(key.raw);
	return entry?.value as T | undefined;
}

// Mirrors cache/size.ts's own `estimateByteSize`, which is deliberately not exported from
// src/lib/cache/index.ts (it's an internal detail of the store implementations) — any
// `CacheStore.set` caller needs *some* number for `sizeBytes`, and this is the same
// approach the module uses internally: "close enough to bytes... not billing anyone."
function estimateSizeBytes(value: unknown): number {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return 0;
	}
}

async function writeCache<T>(store: CacheStore, key: CacheKey, value: T): Promise<void> {
	const now = Date.now();
	await store.set({
		key: key.raw,
		providerId: RYANAIR_PROVIDER_ID,
		value,
		storedAt: now,
		ttlMs: key.ttlMs,
		lastAccessedAt: now,
		sizeBytes: estimateSizeBytes(value)
	});
}

function networkSnapshotKey(): CacheKey {
	return defineCacheKey(RYANAIR_PROVIDER_ID, { op: 'networkSnapshot' }, NETWORK_SNAPSHOT_TTL_MS);
}

/**
 * Refetches the network snapshot and reports the best answer available afterwards, never
 * throwing and never leaving the caller with nothing.
 *
 * This is the one place the adapter does use `staleWhileRevalidate`, and the reason is the
 * three tiers it classifies (src/lib/cache/stale-while-revalidate.ts): a fresh fetch, the
 * previous snapshot re-served with a `revalidationError`, or that snapshot re-tagged
 * `expired-fallback` with its real age. The generator's "fetch every time" half, which is
 * why the reads above avoid it, is exactly what is wanted here — this function is only
 * ever called when the cached entry is already past its TTL or missing entirely, and only
 * once per fan-out (see `RefreshState` below).
 *
 * Below `expired-fallback` sits one more tier the cache module cannot know about: the
 * snapshot shipped with the app. `newerSnapshot` picks between it and the expired cached
 * one by `fetchedAt` rather than assuming either is the more recent.
 */
async function refreshNetworkSnapshot(
	ctx: ProviderContext,
	store: CacheStore,
	fetchImpl: typeof fetch | undefined
): Promise<RyanairNetworkSnapshot> {
	const fetcher = async (): Promise<RyanairNetworkSnapshot> => {
		const response = await fetchActiveAirports({ signal: ctx.signal, fetchImpl });
		if (!response.ok) {
			// Rejects with Ryanair's own code and verbatim message (AGENTS.md: "show the
			// error you got"), which is also the shape `classifyExpiredFallbackReason`
			// reads structurally to tell a 429 from being offline.
			throw toProviderError(response.error);
		}
		return buildNetworkSnapshot(response.data, new Date().toISOString());
	};

	let last: StaleWhileRevalidateResult<RyanairNetworkSnapshot> | undefined;
	try {
		for await (const result of staleWhileRevalidate(networkSnapshotKey(), fetcher, { store })) {
			last = result;
		}
	} catch {
		// Cold cache and the refetch failed, so the generator had nothing to fall back on
		// and rethrew. The bundled snapshot is what this adapter has instead of nothing.
		return loadBundledRyanairNetwork();
	}

	if (last === undefined) return loadBundledRyanairNetwork();
	if (last.state === 'expired-fallback') {
		return newerSnapshot(last.value, await loadBundledRyanairNetwork());
	}
	return last.value;
}

/**
 * Per-provider-instance state for the single refresh a fan-out is allowed to share.
 * Instance-scoped rather than module-scoped so two tests (or a test and the production
 * singleton) never join each other's in-flight request.
 *
 * The shared request carries whichever caller started it and therefore that caller's
 * `AbortSignal`. If that one is cancelled mid-flight, everyone waiting gets the shipped
 * snapshot instead of a fresh one — a slightly older route graph, never an error and never
 * a second request. Giving each joiner its own cancellable fetch would mean giving each
 * joiner its own request, which is the thing being removed.
 */
interface RefreshState {
	inFlight?: Promise<RyanairNetworkSnapshot>;
}

/**
 * Resolves Ryanair's route graph and timezone table, spending at most one network request
 * per TTL window across every concurrent caller.
 *
 * The deduplication is the point, not an optimisation. A search fans `searchOffers` out
 * across many candidate routes at once, and before issue #121 every one of those
 * simultaneous cache misses fetched the same 278 KB table for itself: twelve copies of it
 * in one measured search. A caller that joins an in-flight refresh reports
 * `requestsUsed: 0`, so the budget accounting stays honest — only the caller that actually
 * issued the request is charged for it.
 *
 * `remainingBudget === undefined` means "no caller-imposed cap"
 * (ProviderContext.maxRequests semantics). With the budget spent, this answers from the
 * shipped snapshot or an expired cached one rather than returning nothing: an
 * out-of-season route list beats dropping every offer in the search, and unlike the old
 * per-airport lookup there is no version of this that costs more requests.
 */
async function resolveNetworkSnapshot(
	ctx: ProviderContext,
	store: CacheStore,
	fetchImpl: typeof fetch | undefined,
	refreshState: RefreshState,
	remainingBudget: number | undefined
): Promise<{ snapshot: RyanairNetworkSnapshot; requestsUsed: number }> {
	const fresh = await readCache<RyanairNetworkSnapshot>(store, networkSnapshotKey());
	if (fresh) return { snapshot: fresh, requestsUsed: 0 };

	// Joining costs nothing, so this is checked before the budget: a caller with no budget
	// left still gets the fresher answer a sibling is already paying for.
	if (refreshState.inFlight) return { snapshot: await refreshState.inFlight, requestsUsed: 0 };

	if (remainingBudget !== undefined && remainingBudget < 1) {
		return { snapshot: await bestSnapshotWithoutFetching(store), requestsUsed: 0 };
	}

	// Assigned with no `await` between the check above and here, so a sibling that resumes
	// after this point joins rather than starting a second identical request.
	const refresh = refreshNetworkSnapshot(ctx, store, fetchImpl);
	refreshState.inFlight = refresh;
	try {
		return { snapshot: await refresh, requestsUsed: 1 };
	} finally {
		refreshState.inFlight = undefined;
	}
}

/** The best snapshot reachable without touching the network: whichever of the expired
 * cached entry and the shipped one was fetched more recently. */
async function bestSnapshotWithoutFetching(store: CacheStore): Promise<RyanairNetworkSnapshot> {
	const bundled = await loadBundledRyanairNetwork();
	const cached = await readCacheIgnoringTtl<RyanairNetworkSnapshot>(store, networkSnapshotKey());
	return cached ? newerSnapshot(cached, bundled) : bundled;
}

function createRyanairFlightProvider(options: RyanairProviderOptions = {}): FlightProvider {
	const refreshState: RefreshState = {};

	async function searchOffers(
		query: FlightSearchQuery,
		ctx: ProviderContext
	): Promise<ProviderResult<FlightOffer[]>> {
		if (ctx.signal.aborted) {
			return {
				ok: false,
				error: { code: 'cancelled', message: 'Ryanair search was cancelled before it started' },
				source: source(),
				requestsUsed: 0
			};
		}

		const store = await resolveStore(options);
		const cacheKey = defineCacheKey(RYANAIR_PROVIDER_ID, { op: 'searchOffers', ...query }, FARES_TTL_MS);

		const cached = await readCache<FlightOffer[]>(store, cacheKey);
		if (cached) {
			return { ok: true, data: cached, source: source(), requestsUsed: 0 };
		}

		if (ctx.maxRequests !== undefined && ctx.maxRequests < 1) {
			// Out of budget before spending anything: an empty ok result, not an error —
			// ProviderContext.maxRequests documents running out of budget as a partial
			// result, never a failure.
			return { ok: true, data: [], source: source(), requestsUsed: 0 };
		}

		const faresResponse = await fetchOneWayFares(
			{
				departureAirportIataCode: query.origin,
				arrivalAirportIataCode: query.destination,
				outboundDepartureDateFrom: query.earliestDeparture,
				outboundDepartureDateTo: query.latestDeparture,
				currency: query.currency
			},
			{ signal: ctx.signal, fetchImpl: options.fetchImpl }
		);
		if (!faresResponse.ok) {
			return { ok: false, error: toProviderError(faresResponse.error), source: source(), requestsUsed: 1 };
		}

		const remainingBudget = ctx.maxRequests === undefined ? undefined : ctx.maxRequests - 1;
		const { snapshot, requestsUsed: snapshotRequestsUsed } = await resolveNetworkSnapshot(
			ctx,
			store,
			options.fetchImpl,
			refreshState,
			remainingBudget
		);

		const offers = mapFaresToFlightOffers(faresResponse.data, snapshot.timeZonesByIataCode);
		await writeCache(store, cacheKey, offers);

		return { ok: true, data: offers, source: source(), requestsUsed: 1 + snapshotRequestsUsed };
	}

	async function listDirectDestinations(
		origin: IataAirportCode,
		ctx: ProviderContext
	): Promise<ProviderResult<IataAirportCode[]>> {
		if (ctx.signal.aborted) {
			return {
				ok: false,
				error: { code: 'cancelled', message: 'Ryanair route lookup was cancelled before it started' },
				source: source(),
				requestsUsed: 0
			};
		}

		// One lookup in the network snapshot, no per-airport request and no per-airport
		// cache entry. `algorithm/connections.ts` calls this once for the origin and once
		// per candidate airport — 80 distinct airports on a measured BCN->OTP search — so
		// anything that can issue a request here gets multiplied by the size of the
		// candidate list, which is what issue #121 is about.
		const store = await resolveStore(options);
		const { snapshot, requestsUsed } = await resolveNetworkSnapshot(
			ctx,
			store,
			options.fetchImpl,
			refreshState,
			ctx.maxRequests
		);

		// An airport Ryanair does not serve resolves to `[]` from the snapshot's own
		// absence of it, which is the same answer the deleted per-airport endpoint spent an
		// HTTP 404 on (issue #89). Never an error, and never a second request to re-learn
		// it: DUS is not in Ryanair's network today and will not be by the next candidate.
		return {
			ok: true,
			data: directDestinationsFrom(snapshot, origin),
			source: source(),
			requestsUsed
		};
	}

	async function healthCheck(ctx: ProviderContext): Promise<ProviderHealth> {
		if (ctx.signal.aborted) {
			return {
				ok: false,
				error: { code: 'cancelled', message: 'Ryanair health check was cancelled' },
				source: source(),
				requestsUsed: 0
			};
		}

		// Deliberately bypasses the cache: a health check exists to answer "is Ryanair
		// reachable right now," and a cached "yes" from an hour ago would defeat that.
		// Cheap enough to run rarely (per ProviderBase.healthCheck's own warning against
		// calling it before every search) since it is the same request this adapter would
		// make anyway on the first uncached call to either other method.
		const response = await fetchActiveAirports({ signal: ctx.signal, fetchImpl: options.fetchImpl });
		if (!response.ok) {
			return { ok: false, error: toProviderError(response.error), source: source(), requestsUsed: 1 };
		}
		if (response.data.length === 0) {
			return {
				ok: false,
				error: { code: 'malformed-response', message: 'Ryanair returned zero active airports' },
				source: source(),
				requestsUsed: 1
			};
		}
		return {
			ok: true,
			data: { message: `${response.data.length} active Ryanair airports reachable` },
			source: source(),
			requestsUsed: 1
		};
	}

	return {
		kind: 'flight',
		id: RYANAIR_PROVIDER_ID,
		label: 'Ryanair (no key required)',
		needsKey: false,
		keyFields: [],
		healthCheck,
		// Ryanair is keyless and has no published rate limit, so it never has a budget to
		// protect — reporting 0 is also the exact signal the search pipeline (issue #22)
		// uses to prefer this adapter over a metered one before spending any of its quota.
		estimateSearchOffersCost: () => 0,
		searchOffers,
		listDirectDestinations
	};
}

export { createRyanairFlightProvider };

/** The production singleton: real global `fetch`, the shared default cache store. Import
 * this to register the adapter; use `createRyanairFlightProvider` directly only to inject
 * test doubles. */
export const ryanairFlightProvider: FlightProvider = createRyanairFlightProvider();
