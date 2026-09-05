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
 * ## Where the fares come from, and why it takes two endpoints (issue #137)
 *
 * This adapter used to ask `farfnd/v4/oneWayFares` for one route over the whole search
 * window. That endpoint is a fare *finder*, not a timetable: pinned to a single route it
 * answers with exactly one fare however wide the range, and `limit`/`offset` do not change
 * that (measured 2026-09-04, `size: 1` either way). One fare per leg meant one date pair
 * per stopover, so the flight picker had a single row in it and the traveller could not
 * choose how many nights the stopover lasted — docs/ACCEPTANCE.md condition 4.
 *
 * `cheapestPerDay` answers the same question per calendar day: one request, a whole month
 * of dated fares. What it does not carry is any flight identity — no number, no carrier
 * code, not even the airport objects. `timtbl/3/schedules` carries exactly that and no
 * prices. So one leg-month costs two requests, joined in `ryanair-mapper.ts` on the
 * departure minute, and a day the timetable cannot confirm never becomes an offer.
 *
 * That is one more request per leg-month than before on a cold cache, which matters to
 * issue #121. Two things pull the other way. The schedule is cached for a week against the
 * fares' hour, because a timetable changes seasonally and a price changes hourly, so every
 * refetch inside that week costs what the old code cost. And both caches are keyed by
 * calendar month rather than by the search's exact dates, so nudging a date no longer
 * misses the cache the way the old whole-query key did.
 *
 * Issue #121 rewrote how the route graph gets here. It used to be one request per airport,
 * which a BCN->OTP search turned into 80 of them (measured, production, cold cache), for
 * data that changes seasonally. Now there is exactly one non-fare request this adapter can
 * make — the active-airports endpoint — and it answers both "which airports fly where" and
 * "what zone is each airport in" for the entire network at once. It is deduplicated across
 * a fan-out, cached for a day, and floored by a snapshot shipped with the app
 * (src/lib/data/ryanair-network.ts), so a cold search now spends nothing at all on routes.
 */

import { defineCacheKey, getDefaultStore, revalidationSettled, staleWhileRevalidate } from '../../cache';
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
import { fetchActiveAirports, fetchCheapestFaresPerDay, fetchMonthlySchedule } from './ryanair-client';
import { buildNetworkSnapshot, buildScheduleIndex, mapDailyFaresToFlightOffers } from './ryanair-mapper';
import type {
	RyanairCheapestPerDayResponse,
	RyanairFetchError,
	RyanairMonthlyScheduleResponse
} from './ryanair-types';

/** Keyless and unmetered — no `../budget` cap or wiring applies — but still a real
 * registered adapter id, so it is checked against `ProviderId` (../types.ts, issue #69)
 * like every other adapter's id. */
export const RYANAIR_PROVIDER_ID: ProviderId = 'ryanair';

/**
 * How long a fare counts as current enough to paint with no caveat.
 *
 * This was 5 minutes, matching the `Cache-Control: max-age=60, s-maxage=300` Ryanair's own
 * fare endpoints send. Issue #147 is what that cost: the owner said "loading takes a lot of
 * time every time i reload", and he was right — a search reloaded 5 minutes later spent 48
 * fresh fare requests, because past the TTL the cached answer was thrown away rather than
 * shown. Coming back to a search after lunch was a cold search.
 *
 * An hour is the trade, stated plainly: a fare that moved in the last hour is now shown at
 * its old price for as long as the refresh takes, labelled with its real age (`source()`
 * below, rendered as "fetched 40 minutes ago" by ResultCard). An hour-old price the
 * traveller can see immediately, and can see the age of, beats a blank screen while 48
 * requests go out. Ryanair's own cache header is about its CDN's economics, not about how
 * fast its prices actually move.
 */
const FARES_TTL_MS = 60 * 60_000;
/** A published timetable is a schedule, not a price: it moves when a season changes, not
 * when a seat sells. Holding it for a week is what keeps the second request issue #137
 * added per leg-month off every refetch after the first. */
const SCHEDULE_TTL_MS = 7 * 24 * 60 * 60_000;
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

/**
 * `storedAt` is the epoch millis this data actually came off Ryanair's wire. Omitted means
 * "just now", i.e. this call did the fetch.
 *
 * Passing it matters more than it looks. `ProviderSource.fetchedAt` is documented as "the
 * instant the adapter finished fetching this, NOT when a caller later reads it out of a
 * cache", and ResultCard already renders it as "via Ryanair · fetched 2 minutes ago".
 * Stamping `new Date()` on a cache hit, which is what this function used to do
 * unconditionally, made that footer say "fetched just now" about an hour-old price —
 * AGENTS.md's "never present an estimate as a fact", in the one place the UI was already
 * built to be honest. Issue #147. The same pattern as transfers/transitous.ts.
 */
function source(storedAt?: number): ProviderSource {
	return {
		providerId: RYANAIR_PROVIDER_ID,
		fetchedAt: new Date(storedAt ?? Date.now()).toISOString()
	};
}

/**
 * How many calendar months of fares one `searchOffers` call will ever fetch.
 *
 * `cheapestPerDay` is priced per month, so a departure window is a request multiplier in a
 * way the old whole-range endpoint was not. Three months is well past any real departure
 * window — the brief's window is "soonest departure to latest arrival" for one trip — and
 * it puts a hard ceiling on what a pasted-in or malformed URL can make this adapter spend
 * against Ryanair's own rate limiter (issue #121). A wider range is not rejected; it just
 * gets its first three months answered.
 */
export const MAX_FARE_MONTHS_PER_SEARCH = 3;

interface CalendarMonth {
	year: number;
	/** 1-12, matching the schedule endpoint's own path segment, not `Date`'s 0-11. */
	month: number;
	/** "2026-10-01", what `cheapestPerDay` wants as `outboundMonthOfDate`. */
	monthStart: string;
}

function parseYearMonth(isoDate: string): { year: number; month: number } | undefined {
	const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(isoDate ?? '');
	if (!match) return undefined;
	const year = Number(match[1]);
	const month = Number(match[2]);
	if (month < 1 || month > 12) return undefined;
	return { year, month };
}

/**
 * Every calendar month an inclusive date range touches, oldest first.
 *
 * Parsed straight out of the ISO strings rather than through `Date`, deliberately: these
 * are calendar dates a traveller picked, and running them through an instant would make
 * the month this returns depend on the browser's timezone — a search starting "2026-10-01"
 * must ask for October in Auckland and in Los Angeles alike.
 */
export function monthsSpanned(earliestDeparture: string, latestDeparture: string): CalendarMonth[] {
	const start = parseYearMonth(earliestDeparture);
	const end = parseYearMonth(latestDeparture);
	if (!start || !end) return [];

	const months: CalendarMonth[] = [];
	let { year, month } = start;
	while (
		(year < end.year || (year === end.year && month <= end.month)) &&
		months.length < MAX_FARE_MONTHS_PER_SEARCH
	) {
		months.push({ year, month, monthStart: `${year}-${String(month).padStart(2, '0')}-01` });
		month += 1;
		if (month > 12) {
			month = 1;
			year += 1;
		}
	}
	return months;
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
	return (await readCachedEntry<T>(store, key))?.fresh;
}

/**
 * One cached value and the two facts a caller needs about it: when it was really fetched,
 * and whether that is still inside its TTL.
 *
 * `fresh` is deliberately a separate field rather than a boolean beside `value`, so
 * "give me this only if it is current" (`readCache` above) and "give me this whatever its
 * age" (`searchOffers`) are different property accesses rather than a flag someone can
 * forget to check. Issue #147: the old `readCache` returned `undefined` for an expired
 * entry, which threw away data the app already held and sent the user to the network for
 * it. Nothing could serve it, and nothing could say how old it was, because `storedAt`
 * never left this function.
 */
interface CachedEntry<T> {
	value: T;
	/** Epoch millis the value came off the wire — `ProviderSource.fetchedAt`'s input. */
	storedAt: number;
	/** The same value when it is still within its TTL, `undefined` once it is not. */
	fresh: T | undefined;
}

async function readCachedEntry<T>(
	store: CacheStore,
	key: CacheKey
): Promise<CachedEntry<T> | undefined> {
	const entry = await store.get(key.raw);
	if (entry === undefined) return undefined;
	const value = entry.value as T;
	const isFresh = Date.now() - entry.storedAt < entry.ttlMs;
	return { value, storedAt: entry.storedAt, fresh: isFresh ? value : undefined };
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
 * The cache entry one leg-month of `cheapestPerDay` lives under. Exported, and used by
 * `fetchOffers` below rather than duplicated there, because a second reader now exists:
 * `ryanair-month-grid.ts` (issue #71) reads exactly these entries to answer "what does this
 * route cost across the next year" out of what previous searches already paid for, at zero
 * requests. Two modules deriving the same key by hand is how #131's cache-shape bug
 * happened. One place, one shape, or the reader silently sees nothing forever.
 *
 * Keyed by calendar month rather than by a search's exact dates, so two searches over the
 * same month share one entry and nudging a date is a cache hit.
 */
export function cheapestPerDayCacheKey(params: {
	origin: string;
	destination: string;
	monthStart: string;
	currency?: string;
}): CacheKey {
	return defineCacheKey(
		RYANAIR_PROVIDER_ID,
		{
			op: 'cheapestPerDay',
			origin: params.origin,
			destination: params.destination,
			monthStart: params.monthStart,
			currency: params.currency
		},
		FARES_TTL_MS
	);
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
	/** Cache keys with a background fare refresh already running. Without this, two
	 * searches for the same route a second apart each issue their own, and neither is
	 * waiting on the other to notice. */
	const revalidating = new Set<string>();

	/**
	 * Refetches one route's fares and writes them to the cache. Issue #147's other half:
	 * `searchOffers` answers from an expired entry immediately, and this is what stops
	 * that entry from being the answer forever.
	 *
	 * Returns nothing and rejects never. The caller deliberately does not await it — the
	 * awaiting is the wait being removed — so a rejection here would be unhandled, and a
	 * failed refresh is not a failure of the call that started it. The user keeps the
	 * price they were already shown, with its age still on the card.
	 */
	/**
	 * Everything one query costs against Ryanair: a month of fares and a month of timetable
	 * per calendar month the window touches, joined into offers.
	 *
	 * Shared by the cold path and the background refresh below rather than written twice,
	 * so a stale entry is always replaced by something built exactly the way the entry it
	 * replaces was built.
	 */
	async function fetchOffers(
		query: FlightSearchQuery,
		ctx: ProviderContext,
		store: CacheStore,
		limits: { maxRequests: number | undefined; allowSnapshotRefresh: boolean }
	): Promise<{
		offers: FlightOffer[];
		requestsUsed: number;
		error?: RyanairFetchError;
		/** Issue #359: airports a fare was sellable out of or into and this app had no zone
		 * for, gathered across every month the window touches so one bad month cannot hide
		 * behind another's offers. */
		unresolvedTimeZoneAirports: ReadonlySet<IataAirportCode>;
	}> {
		let requestsUsed = 0;
		/** `undefined` keeps ProviderContext.maxRequests' own "no caller-imposed cap"
		 * meaning all the way down to `resolveNetworkSnapshot`, rather than smuggling an
		 * Infinity into a parameter typed `number | undefined`. */
		const budgetLeft = (): number | undefined =>
			limits.maxRequests === undefined ? undefined : limits.maxRequests - requestsUsed;

		// Fetched now, mapped after the loop, because mapping needs the timezone table and
		// the whole point of resolving that AFTER the fares is that the budget goes on the
		// data only Ryanair has. The snapshot has a floor shipped with the app, so it can
		// always answer without a request; a month of fares cannot.
		const months: { year: number; month: number; fares: RyanairCheapestPerDayResponse }[] = [];
		const schedulesByMonth = new Map<string, RyanairMonthlyScheduleResponse>();
		// Remembered rather than returned on the spot: with a multi-month window, one month
		// failing should not throw away the months that worked. This only becomes the
		// caller's answer if nothing at all could be mapped (see `searchOffers` below).
		let firstError: RyanairFetchError | undefined;

		for (const { year, month, monthStart } of monthsSpanned(query.earliestDeparture, query.latestDeparture)) {
			if (ctx.signal.aborted) break;

			// Keyed by calendar month, not by this query's exact dates, so two searches over
			// the same month share one entry and nudging a date is a cache hit rather than a
			// fresh sweep.
			const faresKey = cheapestPerDayCacheKey({
				origin: query.origin,
				destination: query.destination,
				monthStart,
				currency: query.currency
			});
			const scheduleKey = defineCacheKey(
				RYANAIR_PROVIDER_ID,
				{ op: 'monthlySchedule', origin: query.origin, destination: query.destination, year, month },
				SCHEDULE_TTL_MS
			);

			let fares = await readCache<RyanairCheapestPerDayResponse>(store, faresKey);
			let schedule = await readCache<RyanairMonthlyScheduleResponse>(store, scheduleKey);

			// Both are needed to name a single flight, so a month that can only afford one
			// of the two missing halves is a month worth skipping rather than half-spending.
			const stillNeeded = (fares ? 0 : 1) + (schedule ? 0 : 1);
			const remaining = budgetLeft();
			if (remaining !== undefined && stillNeeded > remaining) break;

			if (!fares) {
				const response = await fetchCheapestFaresPerDay(
					{ origin: query.origin, destination: query.destination, monthStart, currency: query.currency },
					{ signal: ctx.signal, fetchImpl: options.fetchImpl }
				);
				requestsUsed += 1;
				if (!response.ok) {
					firstError ??= response.error;
					continue;
				}
				fares = response.data;
				await writeCache(store, faresKey, fares);
			}

			if (!schedule) {
				const response = await fetchMonthlySchedule(
					{ origin: query.origin, destination: query.destination, year, month },
					{ signal: ctx.signal, fetchImpl: options.fetchImpl }
				);
				requestsUsed += 1;
				if (!response.ok) {
					firstError ??= response.error;
					continue;
				}
				schedule = response.data;
				await writeCache(store, scheduleKey, schedule);
			}

			months.push({ year, month, fares });
			schedulesByMonth.set(`${year}-${month}`, schedule);
		}

		// Skipped outright when no month came back: a zone table with nothing to date is a
		// request spent on nothing.
		if (months.length === 0) {
			return { offers: [], requestsUsed, error: firstError, unresolvedTimeZoneAirports: new Set() };
		}

		// The timezone table, last, with whatever budget the fares left. Every offer needs
		// both airports' zones to become a `LocalDateTime` at all (AGENTS.md "Timezones"),
		// and unlike the fares this can always answer for free: out of budget or off the
		// network it falls back to the snapshot shipped with the app.
		const { snapshot, requestsUsed: snapshotRequestsUsed } = await resolveNetworkSnapshot(
			ctx,
			store,
			options.fetchImpl,
			refreshState,
			limits.allowSnapshotRefresh ? budgetLeft() : 0
		);
		requestsUsed += snapshotRequestsUsed;

		const offers: FlightOffer[] = [];
		const unresolvedTimeZoneAirports = new Set<IataAirportCode>();
		for (const { year, month, fares } of months) {
			const schedule = schedulesByMonth.get(`${year}-${month}`);
			if (!schedule) continue;
			const mapped = mapDailyFaresToFlightOffers(fares, buildScheduleIndex(schedule, year, month), {
				origin: query.origin,
				destination: query.destination,
				timeZoneByIataCode: snapshot.timeZonesByIataCode,
				earliestDeparture: query.earliestDeparture,
				latestDeparture: query.latestDeparture
			});
			offers.push(...mapped.offers);
			for (const code of mapped.unresolvedTimeZoneAirports) unresolvedTimeZoneAirports.add(code);
		}

		return { offers, requestsUsed, error: firstError, unresolvedTimeZoneAirports };
	}

	async function revalidateFares(
		query: FlightSearchQuery,
		ctx: ProviderContext,
		store: CacheStore,
		cacheKey: CacheKey
	): Promise<void> {
		if (revalidating.has(cacheKey.raw)) return;
		revalidating.add(cacheKey.raw);
		try {
			// `allowSnapshotRefresh: false` so this never triggers a network snapshot
			// refresh of its own: this is a background task nobody is waiting for, and it
			// can map its fares against whatever timezone table is already to hand.
			const { offers, error, unresolvedTimeZoneAirports } = await fetchOffers(query, ctx, store, {
				maxRequests: undefined,
				allowSnapshotRefresh: false
			});
			// Never replace real prices with nothing. An empty result paired with an error
			// means the fares failed, not that the route stopped selling, and overwriting
			// the cached answer would turn a background refresh into a silent loss of the
			// results already on screen.
			if (error && offers.length === 0) return;
			// Issue #359, for the same reason: a fare Ryanair still sells and this app could
			// not date is not the route going quiet either, and the zone table it needs is a
			// snapshot that refreshes on its own schedule.
			if (offers.length === 0 && unresolvedTimeZoneAirports.size > 0) return;
			await writeCache(store, cacheKey, offers);
			revalidationSettled(RYANAIR_PROVIDER_ID);
		} catch {
			// A background refresh that fails changes nothing the user can see. The cached
			// fares and their age stay exactly as they were, and the next search tries again.
		} finally {
			revalidating.delete(cacheKey.raw);
		}
	}

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
		// `op` names the fare calendar, not just "searchOffers", so an entry written by the
		// old fare-finder path can never resolve here. Those entries hold one offer for a
		// whole window where this one holds a month of dated ones — the same `FlightOffer[]`
		// type carrying a different answer, which is exactly the case AGENTS.md's #131
		// lesson says needs a key that no longer reaches the old value. The orphans expire
		// on their own TTL and are evicted like any other stale entry.
		const cacheKey = defineCacheKey(
			RYANAIR_PROVIDER_ID,
			{ op: 'searchOffersFromFareCalendar', ...query },
			FARES_TTL_MS
		);

		const cached = await readCachedEntry<FlightOffer[]>(store, cacheKey);
		if (cached) {
			// Served at any age, never discarded for being past its TTL. Issue #147: the
			// owner's "loading takes a lot of time every time i reload" was an expired
			// entry being thrown away and the user made to wait on 48 fare requests for
			// prices the app was already holding. `source(cached.storedAt)` is what keeps
			// that honest — the card says how old this price is, in the footer the UI
			// already had.
			const canRevalidate = ctx.maxRequests === undefined || ctx.maxRequests >= 1;
			const revalidated = !cached.fresh && canRevalidate;
			if (revalidated) {
				// Past its TTL, so refresh it behind the answer rather than instead of it.
				// Not awaited on purpose: awaiting is the wait this whole change removes.
				// When it lands it announces itself (`cache/revalidation.ts`), the results
				// page runs the search again off the warmed cache, and the second snapshot
				// replaces this card in place through `results/stream-order.ts`. Issue #293:
				// until that existed the fresher fares reached the next reload and never the
				// page that was already on screen asking for them.
				void revalidateFares(query, ctx, store, cacheKey);
			}
			return {
				ok: true,
				data: cached.value,
				source: source(cached.storedAt),
				// A request WAS issued on this call's behalf, even though this call did not
				// wait for it. Reporting 0 here would quietly under-count against
				// `ProviderContext.maxRequests`, which is the one number a caller uses to
				// reason about what a search costs.
				requestsUsed: revalidated ? 1 : 0
			};
		}

		if (ctx.maxRequests !== undefined && ctx.maxRequests < 1) {
			// Out of budget before spending anything: an empty ok result, not an error —
			// ProviderContext.maxRequests documents running out of budget as a partial
			// result, never a failure.
			return { ok: true, data: [], source: source(), requestsUsed: 0 };
		}

		const { offers, requestsUsed, error, unresolvedTimeZoneAirports } = await fetchOffers(query, ctx, store, {
			maxRequests: ctx.maxRequests,
			allowSnapshotRefresh: true
		});

		// Nothing mapped AND something genuinely failed: report the failure Ryanair actually
		// gave us, rather than an empty list that reads as "this route has no flights"
		// (AGENTS.md, "Show the error you got, never the one you assumed"). An empty list
		// with no error is the honest answer for a route Ryanair simply does not fly —
		// `cheapestPerDay` says that with a month of `unavailable` rows, not an HTTP error.
		if (offers.length === 0 && error) {
			return { ok: false, error: toProviderError(error), source: source(), requestsUsed };
		}

		// Issue #359: Ryanair sold a flight on a day in this window, named it, priced it, and
		// this app could not say when it lands. An empty ok result here would reach the
		// connections map as "Nothing flies here", which is a false sentence about a real
		// flight, so say which airports blocked it instead.
		//
		// Returned before `writeCache` deliberately. `FARES_TTL_MS` is an hour, but
		// `readCachedEntry`'s caller above serves an entry at any age (issue #147), so
		// caching this empty array would re-serve today's missing zone forever — including
		// after the network snapshot refreshes and this app finally knows the airport.
		if (offers.length === 0 && unresolvedTimeZoneAirports.size > 0) {
			const airports = [...unresolvedTimeZoneAirports].sort();
			return {
				ok: false,
				error: {
					code: 'no-time-zone',
					message: `Ryanair had a fare and a flight number for ${query.origin} to ${query.destination} on a day in this window, and this app has no time zone for ${airports.join(', ')}, so it could not say when the flight lands.`,
					airports
				},
				source: source(),
				requestsUsed
			};
		}

		await writeCache(store, cacheKey, offers);
		return { ok: true, data: offers, source: source(), requestsUsed };
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
		// `fetchedAt` is the snapshot's own, not now: this answer can come from a graph
		// fetched yesterday or from the one shipped with the build, and saying "just now"
		// about either would be the same lie issue #147 fixed on the fare path.
		const snapshotFetchedAt = Date.parse(snapshot.fetchedAt);
		return {
			ok: true,
			data: directDestinationsFrom(snapshot, origin),
			source: source(Number.isFinite(snapshotFetchedAt) ? snapshotFetchedAt : undefined),
			requestsUsed
		};
	}

	/**
	 * Issue #340. Ryanair is one of the two adapters that can answer this exactly, because
	 * the snapshot is Ryanair's whole network rather than a sample of it: if BGY to PFO is
	 * not in the snapshot, Ryanair does not fly it.
	 *
	 * Reads the same snapshot `listDirectDestinations` does, so it costs the same nothing,
	 * and that is what makes it worth asking first. A candidate the snapshot already
	 * confirms never needs the keyless-but-real Kiwi request that would otherwise be spent
	 * settling the same question — which is how #340's wider candidate set pays for itself.
	 *
	 * `false` is scoped to this airline and says so in `providers/types.ts`. Ryanair not
	 * flying Munich to Paphos is not evidence that Lufthansa does not.
	 */
	async function hasDirectRoute(
		origin: IataAirportCode,
		destination: IataAirportCode,
		ctx: ProviderContext
	): Promise<ProviderResult<boolean>> {
		const listed = await listDirectDestinations(origin, ctx);
		if (!listed.ok) return listed;
		return { ...listed, data: listed.data.includes(destination) };
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
		listDirectDestinations,
		hasDirectRoute
	};
}

export { createRyanairFlightProvider };

/** The production singleton: real global `fetch`, the shared default cache store. Import
 * this to register the adapter; use `createRyanairFlightProvider` directly only to inject
 * test doubles. */
export const ryanairFlightProvider: FlightProvider = createRyanairFlightProvider();
