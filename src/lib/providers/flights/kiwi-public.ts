/**
 * Kiwi.com's own public GraphQL endpoint (`api.skypicker.com/umbrella/v2/graphql`), the
 * backend its website runs on. No key, no signup, no quota, and — measured from a real
 * browser page origin on 2026-09-04, not from curl — `Access-Control-Allow-Origin: *` with
 * a clean preflight. See docs/PROVIDERS.md for the full evidence table and for the eleven
 * aggregators that were measured and rejected before this one.
 *
 * Why this adapter exists at all, in one sentence: it is the only source in this codebase
 * that can answer "which airports does an arbitrary airport fly to directly", and that
 * question is what the whole search dies on.
 *
 * The failure it fixes, precisely. `algorithm/connections.ts` builds its candidate stopover
 * list from `listDirectDestinations`. Sky Scrapper's implementation returns a failure (its
 * v1 endpoint is deprecated and v2 answers at country level); Flights Sky's returns a
 * failure (no such endpoint); Ryanair's answers for Ryanair's ~220 airports and `404`s
 * everything else; the build-time Travelpayouts dataset held exactly ONE route for Boa
 * Vista. So for the owner's own trip, BVC to PFO, the connection graph had no candidate to
 * rank, produced nothing, and the search reported "No itineraries found" — with every
 * RapidAPI key correctly configured, because no key was ever the problem. This adapter
 * answers that question for any airport, so the pipeline finally has somewhere to start.
 *
 * Keyless and unmetered, so it follows ryanair.ts's shape rather than flights-sky.ts's:
 * `estimateSearchOffersCost` reports 0 (there is no quota to protect, and 0 is the exact
 * signal `connections.ts` uses to classify a provider as free and therefore usable for
 * broad discovery), and reads go through the cache directly rather than through
 * `providers/budget`, which exists to enforce monthly caps this adapter does not have.
 *
 * Two limits worth stating plainly rather than discovering later:
 *
 * 1. **This is an undocumented endpoint that belongs to someone else's website.** It can
 *    change shape or start refusing traffic without warning, which is why every field is
 *    re-validated in kiwi-public-mapper.ts and why a failure here degrades to "this source
 *    does not know" instead of failing a search.
 * 2. **Direct flights only.** Kiwi's speciality is stitching several carriers into one
 *    self-transfer itinerary, and it does that for BVC to PFO. But a `FlightOffer` is one
 *    flight with one flight number, and this app builds the connection itself so it can put
 *    a night in the stopover city. Asking Kiwi for connections and flattening them would
 *    describe a flight nobody sells. See kiwi-public-queries.ts.
 */

import { defineCacheKey, getDefaultStore } from '../../cache';
import type { CacheKey, CacheStore } from '../../cache';
import type { FlightOffer, IataAirportCode, IsoCalendarDate, IsoCurrencyCode } from '../../domain';
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
import { fetchOnePerCityDirect, fetchOneWayDirect } from './kiwi-public-client';
import {
	ONE_PER_CITY_DIRECT_QUERY,
	ONE_WAY_DIRECT_QUERY,
	buildOnePerCityVariables,
	buildOneWayVariables
} from './kiwi-public-queries';
import {
	appErrorOf,
	mapOnePerCityResultToDestinations,
	mapOneWayResultToOffers
} from './kiwi-public-mapper';
import type { KiwiPublicFetchError } from './kiwi-public-types';

/** Distinct from `'kiwi'`, which is the RapidAPI listing `kiwi-com-cheap-flights` whose
 * backend has been answering `402 DEPLOYMENT_DISABLED` since before this adapter was
 * written (docs/PROVIDERS.md). Same company, completely different endpoint, different
 * failure modes, so a separate id rather than a takeover of that one. */
export const KIWI_PUBLIC_PROVIDER_ID: ProviderId = 'kiwi-public';

const DEFAULT_CURRENCY: IsoCurrencyCode = 'EUR';

/** A live fare, so cached about as long as one stays true. Matches the window
 * flights-sky.ts settled on for its own per-itinerary search results. */
const OFFERS_TTL_MS = 15 * 60_000;
/** A route network changes when a season turns, not during a shopping session. A day is
 * long enough to make repeated searches free and short enough to notice a new base. */
const DESTINATIONS_TTL_MS = 24 * 60 * 60_000;

/** Caps the response size, not the request count — one request either way. Enough to cover
 * a fortnight of departures on a busy route without shipping a megabyte of JSON to a phone. */
const OFFERS_LIMIT = 50;
/** Kiwi returns one itinerary per destination city, so this is a ceiling on distinct
 * destination airports. London Gatwick, one of the busiest origins this app will ever ask
 * about, returned 63. */
const DESTINATIONS_LIMIT = 100;

/**
 * `listDirectDestinations` is handed an airport and nothing else — the interface has no
 * date parameter, because "which airports does this one fly to" reads like a property of
 * the airport rather than of a day. Kiwi cannot answer it that way: its only route
 * information is a fare search, so it has to be asked about a specific window.
 *
 * These two constants are that window, and they are a real, documented limitation. Starting
 * a fortnight out skips the last-minute dates where a route can look missing simply because
 * every seat on it is sold; a 30-day span is wide enough that a route flying twice a week
 * still shows up. A route that only operates in another season will not appear, which is
 * the honest answer for a search happening now rather than a phantom edge that costs a real
 * request downstream to disprove.
 */
const DESTINATIONS_WINDOW_START_DAYS = 14;
const DESTINATIONS_WINDOW_LENGTH_DAYS = 30;

export interface KiwiPublicProviderOptions {
	/** Overrides the shared IndexedDB-or-memory store. Tests inject a `MemoryCacheStore`. */
	store?: CacheStore;
	/** Overrides the global `fetch`. Tests inject a stub that resolves fixtures. */
	fetchImpl?: typeof fetch;
	/** Overrides `Date.now`, so the derived destinations window above is deterministic in
	 * tests instead of moving with the calendar. */
	now?: () => number;
}

function source(): ProviderSource {
	return { providerId: KIWI_PUBLIC_PROVIDER_ID, fetchedAt: new Date().toISOString() };
}

function ok<T>(data: T, requestsUsed: number): ProviderResult<T> {
	return { ok: true, data, source: source(), requestsUsed };
}

function fail<T>(error: ProviderError, requestsUsed: number): ProviderResult<T> {
	return { ok: false, error, source: source(), requestsUsed };
}

function toProviderError(error: KiwiPublicFetchError): ProviderError {
	switch (error.code) {
		case 'cancelled':
			return { code: 'cancelled', message: error.message };
		case 'network-error':
			return { code: 'network-error', message: error.message, cause: error.cause };
		case 'malformed-response':
			return { code: 'malformed-response', message: error.message, cause: error.cause };
		case 'rate-limited':
			// Keyless, so there is no monthly plan being exceeded — but Kiwi's own edge can
			// still throttle a client that hammers it, and "back off and try later" is the
			// right thing to tell a user either way.
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

function isoDateAfterDays(now: number, days: number): IsoCalendarDate {
	return new Date(now + days * 24 * 60 * 60_000).toISOString().slice(0, 10);
}

async function resolveStore(options: KiwiPublicProviderOptions): Promise<CacheStore> {
	return options.store ?? (await getDefaultStore());
}

/** Cache-aside against `CacheStore` directly, for the reason ryanair.ts's own `readCache`
 * spells out: `staleWhileRevalidate` always calls its fetcher, which is the wrong shape for
 * a method resolving one `ProviderResult` with no consumer able to see a provisional yield. */
async function readCache<T>(store: CacheStore, key: CacheKey): Promise<T | undefined> {
	const entry = await store.get(key.raw);
	if (entry === undefined) return undefined;
	if (Date.now() - entry.storedAt >= entry.ttlMs) return undefined;
	return entry.value as T;
}

// Mirrors cache/size.ts's internal `estimateByteSize`, which that module deliberately does
// not export — every `CacheStore.set` caller needs some number here, and this is the same
// approach the store implementations use internally.
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
		providerId: KIWI_PUBLIC_PROVIDER_ID,
		value,
		storedAt: now,
		ttlMs: key.ttlMs,
		lastAccessedAt: now,
		sizeBytes: estimateSizeBytes(value)
	});
}

function createKiwiPublicFlightProvider(options: KiwiPublicProviderOptions = {}): FlightProvider {
	const now = options.now ?? Date.now;

	async function searchOffers(
		query: FlightSearchQuery,
		ctx: ProviderContext
	): Promise<ProviderResult<FlightOffer[]>> {
		if (ctx.signal.aborted) {
			return fail({ code: 'cancelled', message: 'Kiwi search was cancelled before it started' }, 0);
		}

		const currency = query.currency ?? DEFAULT_CURRENCY;
		const store = await resolveStore(options);
		const cacheKey = defineCacheKey(
			KIWI_PUBLIC_PROVIDER_ID,
			{ op: 'searchOffers', ...query, currency },
			OFFERS_TTL_MS
		);

		const cached = await readCache<FlightOffer[]>(store, cacheKey);
		if (cached) return ok(cached, 0);

		if (ctx.maxRequests !== undefined && ctx.maxRequests < 1) {
			// Out of budget before spending anything. An empty ok result, never an error —
			// `ProviderContext.maxRequests` documents running out mid-search as a partial
			// result.
			return ok([], 0);
		}

		const response = await fetchOneWayDirect(
			ONE_WAY_DIRECT_QUERY,
			buildOneWayVariables({
				origin: query.origin,
				destination: query.destination,
				earliestDeparture: query.earliestDeparture,
				latestDeparture: query.latestDeparture,
				currency,
				limit: OFFERS_LIMIT
			}),
			{ signal: ctx.signal, fetchImpl: options.fetchImpl }
		);
		if (!response.ok) return fail(toProviderError(response.error), 1);

		const result = response.data.onewayItineraries;
		const appError = appErrorOf(result);
		if (appError !== undefined) {
			// Kiwi's own words, verbatim, per AGENTS.md — never replaced by a guess at what
			// it must have meant.
			return fail({ code: 'unknown', message: `Kiwi returned an error: ${appError}` }, 1);
		}

		const offers = mapOneWayResultToOffers(result);
		await writeCache(store, cacheKey, offers);
		return ok(offers, 1);
	}

	async function listDirectDestinations(
		origin: IataAirportCode,
		ctx: ProviderContext
	): Promise<ProviderResult<IataAirportCode[]>> {
		if (ctx.signal.aborted) {
			return fail(
				{ code: 'cancelled', message: 'Kiwi route lookup was cancelled before it started' },
				0
			);
		}

		const earliestDeparture = isoDateAfterDays(now(), DESTINATIONS_WINDOW_START_DAYS);
		const latestDeparture = isoDateAfterDays(
			now(),
			DESTINATIONS_WINDOW_START_DAYS + DESTINATIONS_WINDOW_LENGTH_DAYS
		);

		const store = await resolveStore(options);
		// The window is part of the key, not just the origin: it moves with the calendar, so
		// yesterday's answer must not be served for today's question once the TTL is longer
		// than the window's own step. Issue #131's post-mortem is the reason this is spelled
		// out — a cached value whose inputs changed needs a key that no longer resolves to it.
		const cacheKey = defineCacheKey(
			KIWI_PUBLIC_PROVIDER_ID,
			{ op: 'listDirectDestinations', origin, earliestDeparture, latestDeparture },
			DESTINATIONS_TTL_MS
		);

		const cached = await readCache<IataAirportCode[]>(store, cacheKey);
		if (cached) return ok(cached, 0);

		if (ctx.maxRequests !== undefined && ctx.maxRequests < 1) return ok([], 0);

		const response = await fetchOnePerCityDirect(
			ONE_PER_CITY_DIRECT_QUERY,
			buildOnePerCityVariables({
				origin,
				earliestDeparture,
				latestDeparture,
				currency: DEFAULT_CURRENCY,
				limit: DESTINATIONS_LIMIT
			}),
			{ signal: ctx.signal, fetchImpl: options.fetchImpl }
		);
		if (!response.ok) return fail(toProviderError(response.error), 1);

		const result = response.data.onewayOnePerCityItineraries;
		const appError = appErrorOf(result);
		if (appError !== undefined) {
			return fail({ code: 'unknown', message: `Kiwi returned an error: ${appError}` }, 1);
		}

		const destinations = mapOnePerCityResultToDestinations(result);
		// An airport Kiwi sells nothing from returns an empty list, not an error — measured:
		// a nonexistent code answers `{"itineraries":[]}` with HTTP 200. Cached like any
		// other answer so a dead-end origin is not re-asked on every search.
		await writeCache(store, cacheKey, destinations);
		return ok(destinations, 1);
	}

	async function healthCheck(ctx: ProviderContext): Promise<ProviderHealth> {
		if (ctx.signal.aborted) {
			return fail({ code: 'cancelled', message: 'Kiwi health check was cancelled' }, 0);
		}

		// Deliberately bypasses the cache: the question is whether Kiwi answers right now,
		// and a cached yes from an hour ago does not answer it. Uses a real route lookup
		// from a busy airport rather than a synthetic ping, because the failure this needs
		// to catch is Kiwi's bot wall turning a 200 into a 403, which only a real request
		// reveals.
		const earliestDeparture = isoDateAfterDays(now(), DESTINATIONS_WINDOW_START_DAYS);
		const latestDeparture = isoDateAfterDays(
			now(),
			DESTINATIONS_WINDOW_START_DAYS + DESTINATIONS_WINDOW_LENGTH_DAYS
		);
		const response = await fetchOnePerCityDirect(
			ONE_PER_CITY_DIRECT_QUERY,
			buildOnePerCityVariables({
				origin: 'LGW',
				earliestDeparture,
				latestDeparture,
				currency: DEFAULT_CURRENCY,
				limit: DESTINATIONS_LIMIT
			}),
			{ signal: ctx.signal, fetchImpl: options.fetchImpl }
		);
		if (!response.ok) return fail(toProviderError(response.error), 1);

		const result = response.data.onewayOnePerCityItineraries;
		const appError = appErrorOf(result);
		if (appError !== undefined) {
			return fail({ code: 'unknown', message: `Kiwi returned an error: ${appError}` }, 1);
		}

		const destinations = mapOnePerCityResultToDestinations(result);
		if (destinations.length === 0) {
			return fail(
				{
					code: 'malformed-response',
					message: 'Kiwi answered but listed no direct destinations from London Gatwick'
				},
				1
			);
		}
		return ok(
			{ message: `${destinations.length} direct destinations reachable from London Gatwick` },
			1
		);
	}

	return {
		kind: 'flight',
		id: KIWI_PUBLIC_PROVIDER_ID,
		label: 'Kiwi.com (no key required)',
		needsKey: false,
		keyFields: [],
		healthCheck,
		// Keyless and unmetered, so there is no budget to protect — and reporting 0 is what
		// makes `connections.ts` classify this as a free source and use it for broad
		// candidate discovery, which is the entire point of registering it.
		estimateSearchOffersCost: () => 0,
		searchOffers,
		listDirectDestinations
	};
}

export { createKiwiPublicFlightProvider };

/** The production singleton: real global `fetch`, the shared default cache store. Import
 * this to register the adapter; use `createKiwiPublicFlightProvider` directly only to
 * inject test doubles. */
export const kiwiPublicFlightProvider: FlightProvider = createKiwiPublicFlightProvider();
