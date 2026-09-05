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
 * failure (no such endpoint); Ryanair's answers only for the 224 airports in its own
 * bundled network snapshot, which does not include Boa Vista, Sal or Praia — Ryanair does
 * not serve Cape Verde; and the build-time Travelpayouts dataset held exactly ONE route for
 * Boa Vista. So for the owner's own trip, BVC to PFO, the connection graph had no candidate
 * to rank, produced nothing, and the search reported "No itineraries found" — with every
 * RapidAPI key correctly configured, because no key was ever the problem. This adapter
 * answers that question for any airport, so the pipeline finally has somewhere to start.
 *
 * Worth noting which half fails, since it is not the obvious one: Ryanair reaches Pafos
 * from a dozen airports, so the inbound leg was always answerable. It is the outbound leg
 * from an airport outside its network that returns nothing, and one missing half is enough
 * to produce no candidate at all.
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

import { defineCacheKey, getDefaultStore, readCachedEntry, revalidationSettled } from '../../cache';
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
import { fetchDirectRouteCheck, fetchOnePerCityDirect, fetchOneWayDirect } from './kiwi-public-client';
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

/**
 * How many airports this adapter will look routes up for before it stops answering and
 * lets cheaper sources carry the rest of a search.
 *
 * Measured, not guessed. `algorithm/connections.ts` asks `listDirectDestinations` once for
 * the origin and then once per candidate it found, and it caps the candidate list at six
 * only AFTER that loop. So the cost is one request per outbound edge across every free
 * source unioned together, which for a hub is hundreds of edges to keep six candidates.
 *
 * That is the exact shape issue #121 measured for Ryanair (80 requests for one route) and
 * issue #145 then fixed by shipping its whole network as one snapshot. Kiwi has no
 * "entire network in one response" endpoint, so the fix here is a ceiling instead: past
 * it, this source answers "I do not know" rather than continuing to hammer an undocumented
 * endpoint that belongs to someone else and can start refusing traffic at any time.
 *
 * The number was 40, and 40 turned out to be the whole per-load cost rather than a rare
 * limit. Issue #165 measured one BCN to TLL search at 46 requests; on `origin/main` at
 * 49bd622 the same search measured 52, of which 40 were this endpoint. A reload cost
 * another 40, because the ceiling resets with the page while the candidate order does not,
 * so load two simply asks about airports 41 to 80. Every load pays the ceiling in full
 * until a hub's entire candidate set is cached, which is not what a ceiling is for.
 *
 * 20 is where it sits now, and both halves of that were measured against a real build:
 *
 * - BVC to PFO, the thin-network route this adapter exists for, fits inside 20 and is
 *   held there by `algorithm/connections.ts` rather than by this number. An instrumented
 *   production build ranks 21 candidate airports for that search (issue #255); one lookup
 *   goes on the origin and 18 on the top of the ranking, and the rest are answered by
 *   Ryanair's bundled snapshot at no request. An earlier version of this comment said the
 *   search "uses 19 route lookups for its whole search, so it never reaches the ceiling",
 *   and #248 built an argument on that number. 19 was the count of a search that asked
 *   about every candidate, not the count of the candidates.
 * - BCN to TLL returns the same 6 of 6 itineraries at 20 as it did at 40. Three loads of
 *   that search on `origin/main` spent 40, 40 and 27 route lookups against three different
 *   sets of airports and returned the same six itineraries every time, because Ryanair's
 *   bundled snapshot and the build-time dataset already cover a hub like BCN. Kiwi's route
 *   graph is what makes a thin origin work, and a thin origin fits well inside 20.
 *
 * Counted per provider instance, which is per app session (`kiwiPublicFlightProvider` is a
 * module singleton), and cache hits do not count against it, only real requests do. A
 * second search over the same airports is free and unaffected.
 */
export const MAX_ROUTE_LOOKUPS_PER_SESSION = 20;

export interface KiwiPublicProviderOptions {
	/** Overrides the shared IndexedDB-or-memory store. Tests inject a `MemoryCacheStore`. */
	store?: CacheStore;
	/** Overrides the global `fetch`. Tests inject a stub that resolves fixtures. */
	fetchImpl?: typeof fetch;
	/** Overrides `Date.now`, so the derived destinations window above is deterministic in
	 * tests instead of moving with the calendar. */
	now?: () => number;
	/** Overrides `MAX_ROUTE_LOOKUPS_PER_SESSION`. Tests set it low enough to reach without
	 * stubbing forty responses. */
	maxRouteLookups?: number;
}

/**
 * `storedAt` is the epoch millis this data actually came off Kiwi's wire. Omitted means
 * "just now", i.e. this call did the fetch.
 *
 * `ProviderSource.fetchedAt` is documented as "the instant the adapter finished fetching
 * this, NOT when a caller later reads it out of a cache", and ResultCard renders it as
 * "via Kiwi · fetched 2 minutes ago". Stamping `new Date()` on a cache hit says a fare
 * read out of a fifteen-minute-old entry came off the wire this second — AGENTS.md's
 * "never present an estimate as a fact", in the one place the UI was already built to be
 * honest. Issue #151, the same shape as ryanair.ts (#147) and transfers/transitous.ts.
 */
function source(storedAt?: number): ProviderSource {
	return {
		providerId: KIWI_PUBLIC_PROVIDER_ID,
		fetchedAt: new Date(storedAt ?? Date.now()).toISOString()
	};
}

function ok<T>(data: T, requestsUsed: number, storedAt?: number): ProviderResult<T> {
	return { ok: true, data, source: source(storedAt), requestsUsed };
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
	const maxRouteLookups = options.maxRouteLookups ?? MAX_ROUTE_LOOKUPS_PER_SESSION;
	/** Real route requests spent by this instance. See `MAX_ROUTE_LOOKUPS_PER_SESSION`. */
	let routeLookupsSpent = 0;
	/** Cache keys with a background refresh already running, so two callers a second apart
	 * do not each issue their own without either noticing the other. */
	const revalidating = new Set<string>();

	async function searchOffers(
		query: FlightSearchQuery,
		ctx: ProviderContext
	): Promise<ProviderResult<FlightOffer[]>> {
		if (ctx.signal.aborted) {
			return fail({ code: 'cancelled', message: 'Kiwi search was cancelled before it started' }, 0);
		}

		const currency = query.currency ?? DEFAULT_CURRENCY;
		const store = await resolveStore(options);
		// Keyed on the four things that actually change the response, not on the whole
		// `query`. `travellers` is the one that matters: this adapter always asks Kiwi to
		// price a single adult (kiwi-public-queries.ts explains why), so a party of one and
		// a party of four produce byte-identical requests. Spreading `...query` into the key
		// would make changing the traveller count re-fetch every leg for an answer already
		// on disk — the "loading takes a lot of time every time i reload" complaint issue
		// #147 is about, arriving by a different route.
		const cacheKey = defineCacheKey(
			KIWI_PUBLIC_PROVIDER_ID,
			{
				op: 'searchOffers',
				origin: query.origin,
				destination: query.destination,
				earliestDeparture: query.earliestDeparture,
				latestDeparture: query.latestDeparture,
				currency
			},
			OFFERS_TTL_MS
		);

		const cached = await readCachedEntry<FlightOffer[]>(store, cacheKey);
		if (cached) {
			// Served at any age, never discarded for being past its TTL. This is what #155
			// established for Ryanair and what this adapter was throwing away: the owner's
			// "loading takes a lot of time every time i reload" is an expired entry being
			// dropped and the user made to wait on the network for prices the app already
			// holds. One provider doing that is enough to leave the whole page blank, since
			// the candidate graph waits on this source. `source(cached.storedAt)` is what
			// keeps it honest — the card says how old the price is.
			const canRevalidate = ctx.maxRequests === undefined || ctx.maxRequests >= 1;
			const revalidated = !cached.fresh && canRevalidate;
			if (revalidated) {
				// Not awaited on purpose: the awaiting is the wait being removed. The fresher
				// fares land in the cache for the next search or reload.
				void revalidateOffers(query, currency, ctx, store, cacheKey);
			}
			return {
				ok: true,
				data: cached.value,
				source: source(cached.storedAt),
				// A request WAS issued on this call's behalf even though this call did not
				// wait for it. Reporting 0 would under-count against `ctx.maxRequests`.
				requestsUsed: revalidated ? 1 : 0
			};
		}

		if (ctx.maxRequests !== undefined && ctx.maxRequests < 1) {
			// Out of budget before spending anything. An empty ok result, never an error —
			// `ProviderContext.maxRequests` documents running out mid-search as a partial
			// result.
			return ok([], 0);
		}

		const fetched = await fetchOffers(query, currency, ctx);
		if (fetched.error !== undefined) return fail(fetched.error, 1);

		await writeCache(store, cacheKey, fetched.offers);
		return ok(fetched.offers, 1);
	}

	/**
	 * One fare lookup, shared by the cold path and the background refresh so a stale entry
	 * is always replaced by something built exactly the way the entry it replaces was.
	 */
	async function fetchOffers(
		query: FlightSearchQuery,
		currency: IsoCurrencyCode,
		ctx: ProviderContext
	): Promise<{ offers: FlightOffer[]; error?: ProviderError }> {
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
		if (!response.ok) return { offers: [], error: toProviderError(response.error) };

		const result = response.data.onewayItineraries;
		const appError = appErrorOf(result);
		if (appError !== undefined) {
			// Kiwi's own words, verbatim, per AGENTS.md — never replaced by a guess at what
			// it must have meant.
			return {
				offers: [],
				error: { code: 'unknown', message: `Kiwi returned an error: ${appError}` }
			};
		}

		return { offers: mapOneWayResultToOffers(result) };
	}

	/**
	 * Refetches one route's fares behind an answer already given. Returns nothing and
	 * rejects never: nobody is awaiting it, so a rejection would be unhandled, and a failed
	 * refresh is not a failure of the call that started it. The user keeps the price they
	 * were shown, with its real age still on the card.
	 */
	async function revalidateOffers(
		query: FlightSearchQuery,
		currency: IsoCurrencyCode,
		ctx: ProviderContext,
		store: CacheStore,
		cacheKey: CacheKey
	): Promise<void> {
		if (revalidating.has(cacheKey.raw)) return;
		revalidating.add(cacheKey.raw);
		try {
			const { offers, error } = await fetchOffers(query, currency, ctx);
			// Never replace real prices with nothing. An empty result paired with an error
			// means the request failed, not that the route stopped selling, and overwriting
			// would turn a background refresh into a silent loss of what is on screen.
			if (error && offers.length === 0) return;
			await writeCache(store, cacheKey, offers);
			revalidationSettled(KIWI_PUBLIC_PROVIDER_ID);
		} catch {
			// Changes nothing the user can see; the next search tries again.
		} finally {
			revalidating.delete(cacheKey.raw);
		}
	}

	/**
	 * Issue #340. One request, one pair, an exact answer.
	 *
	 * `listDirectDestinations` below cannot answer this, and the shape of what it returns
	 * hides that. `onewayOnePerCityItineraries` gives ONE itinerary per destination *city*
	 * sorted by price, so Boa Vista's twenty-row answer names Milan once — as Malpensa —
	 * and Bergamo is not in it, though Kiwi sells Neos NO3865 BVC to BGY on 7 October 2026
	 * for EUR 262. London is Gatwick only, Rome is Fiumicino only, Paris is Orly only. Then
	 * the far side: Paphos is missing from Munich's, Orly's, Amsterdam's, Brussels' and
	 * Fiumicino's lists, all five of which Kiwi will sell you on a direct pair query.
	 *
	 * So the everywhere query answers "name me somewhere cheap you fly", and the connection
	 * graph was reading it as "here is your entire network". This asks the question the
	 * graph actually has, which Kiwi answers precisely, for the same one request the list
	 * costs.
	 *
	 * Same departure window as `listDirectDestinations`, and for the same reason: this is a
	 * question about a route rather than about a day, and the window is how an adapter with
	 * only a fare search can approximate one. `false` therefore means "no direct flight in
	 * that window", never "no such route" — `providers/types.ts` states that contract and
	 * `results/no-results.ts` is written to respect it.
	 */
	async function hasDirectRoute(
		origin: IataAirportCode,
		destination: IataAirportCode,
		ctx: ProviderContext
	): Promise<ProviderResult<boolean>> {
		if (ctx.signal.aborted) {
			return fail({ code: 'cancelled', message: 'Kiwi route check was cancelled before it started' }, 0);
		}

		const earliestDeparture = isoDateAfterDays(now(), DESTINATIONS_WINDOW_START_DAYS);
		const latestDeparture = isoDateAfterDays(
			now(),
			DESTINATIONS_WINDOW_START_DAYS + DESTINATIONS_WINDOW_LENGTH_DAYS
		);

		const store = await resolveStore(options);
		const cacheKey = defineCacheKey(
			KIWI_PUBLIC_PROVIDER_ID,
			{ op: 'hasDirectRoute', origin, destination, earliestDeparture, latestDeparture },
			DESTINATIONS_TTL_MS
		);

		const cached = await readCachedEntry<boolean>(store, cacheKey);
		// Served at any age, like every other read here. A route that existed yesterday is
		// the best answer available while a refresh runs, and making the graph wait on the
		// network for it is the reload cost #147 is about.
		if (cached) {
			const canRevalidate =
				(ctx.maxRequests === undefined || ctx.maxRequests >= 1) &&
				routeLookupsSpent < maxRouteLookups;
			const revalidated = !cached.fresh && canRevalidate;
			if (revalidated) {
				routeLookupsSpent += 1;
				void revalidateDirectRoute(origin, destination, earliestDeparture, latestDeparture, ctx, store, cacheKey);
			}
			return {
				ok: true,
				data: cached.value,
				source: source(cached.storedAt),
				requestsUsed: revalidated ? 1 : 0
			};
		}

		// Out of budget, or past this session's ceiling: `false` for the same reason
		// `listDirectDestinations` returns an empty ok rather than an error. Stopping on
		// purpose is not a failure, and reporting one would put a red "Kiwi failed" on a
		// search where Kiwi did exactly what it was told.
		//
		// This is the one place a `false` from here does not mean "I looked and found
		// nothing". It is safe only because `providers/types.ts` forbids any caller from
		// printing a `false` as "there is no route" — `connections.ts` declines to propose
		// the candidate and `results/no-results.ts` never turns a decline into a claim. If
		// that contract ever weakens, this line has to become a failure.
		if (ctx.maxRequests !== undefined && ctx.maxRequests < 1) return ok(false, 0);
		if (routeLookupsSpent >= maxRouteLookups) return ok(false, 0);

		routeLookupsSpent += 1;
		const found = await fetchDirectRoute(origin, destination, earliestDeparture, latestDeparture, ctx);
		if (found.error !== undefined) return fail(found.error, 1);

		await writeCache(store, cacheKey, found.exists);
		return ok(found.exists, 1);
	}

	/**
	 * Asks Kiwi for one pair and decides whether anything it returned is a single flight
	 * this app could actually offer. `limit: 1` because the question is existence, not
	 * price — but it goes through `mapOneWayResultToOffers` rather than counting raw
	 * itineraries, so a self-transfer or a multi-segment chain that slipped past the filter
	 * is rejected here exactly as it would be if the fare stage had asked. Counting rows
	 * would confirm a route this app cannot sell.
	 */
	async function fetchDirectRoute(
		origin: IataAirportCode,
		destination: IataAirportCode,
		earliestDeparture: IsoCalendarDate,
		latestDeparture: IsoCalendarDate,
		ctx: ProviderContext
	): Promise<{ exists: boolean; error?: ProviderError }> {
		const response = await fetchDirectRouteCheck(
			ONE_WAY_DIRECT_QUERY,
			buildOneWayVariables({
				origin,
				destination,
				earliestDeparture,
				latestDeparture,
				currency: DEFAULT_CURRENCY,
				limit: 1
			}),
			{ signal: ctx.signal, fetchImpl: options.fetchImpl }
		);
		if (!response.ok) return { exists: false, error: toProviderError(response.error) };

		const result = response.data.onewayItineraries;
		const appError = appErrorOf(result);
		if (appError !== undefined) {
			return {
				exists: false,
				error: { code: 'unknown', message: `Kiwi returned an error: ${appError}` }
			};
		}
		return { exists: mapOneWayResultToOffers(result).length > 0 };
	}

	/** The background half of the stale-first read above. Never rejects, never replaces a
	 * known route with the silence of a failed request. */
	async function revalidateDirectRoute(
		origin: IataAirportCode,
		destination: IataAirportCode,
		earliestDeparture: IsoCalendarDate,
		latestDeparture: IsoCalendarDate,
		ctx: ProviderContext,
		store: CacheStore,
		cacheKey: CacheKey
	): Promise<void> {
		if (revalidating.has(cacheKey.raw)) return;
		revalidating.add(cacheKey.raw);
		try {
			const found = await fetchDirectRoute(origin, destination, earliestDeparture, latestDeparture, ctx);
			if (found.error !== undefined) return;
			await writeCache(store, cacheKey, found.exists);
			revalidationSettled(KIWI_PUBLIC_PROVIDER_ID);
		} catch {
			// The next search asks again.
		} finally {
			revalidating.delete(cacheKey.raw);
		}
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

		const cached = await readCachedEntry<IataAirportCode[]>(store, cacheKey);
		if (cached) {
			// The route-graph half of this adapter, and the half issue #145 solved for
			// Ryanair by shipping a snapshot. Kiwi has no whole-network endpoint to snapshot,
			// so the equivalent is to hold each airport's answer for a day and keep serving
			// it past that day while a refresh runs behind. A route network changes when a
			// season turns; making a reload wait on it is the expensive mistake.
			const canRevalidate =
				(ctx.maxRequests === undefined || ctx.maxRequests >= 1) &&
				routeLookupsSpent < maxRouteLookups;
			const revalidated = !cached.fresh && canRevalidate;
			if (revalidated) {
				routeLookupsSpent += 1;
				void revalidateDestinations(origin, earliestDeparture, latestDeparture, ctx, store, cacheKey);
			}
			return {
				ok: true,
				data: cached.value,
				source: source(cached.storedAt),
				requestsUsed: revalidated ? 1 : 0
			};
		}

		if (ctx.maxRequests !== undefined && ctx.maxRequests < 1) return ok([], 0);

		if (routeLookupsSpent >= maxRouteLookups) {
			// An empty ok, not an error: `connections.ts` documents an empty answer and a
			// failed one as the same thing ("this source doesn't know") and falls through to
			// the next source either way, and `ProviderContext.maxRequests` already
			// establishes that running out of budget mid-search is a partial result rather
			// than a failure. Reporting it as an error instead would put a red "Kiwi failed"
			// on a search where Kiwi did not fail — it stopped on purpose.
			return ok([], 0);
		}
		routeLookupsSpent += 1;

		const { destinations, error } = await fetchDestinations(
			origin,
			earliestDeparture,
			latestDeparture,
			ctx
		);
		if (error !== undefined) return fail(error, 1);
		// An airport Kiwi sells nothing from returns an empty list, not an error — measured:
		// a nonexistent code answers `{"itineraries":[]}` with HTTP 200. Cached like any
		// other answer so a dead-end origin is not re-asked on every search.
		await writeCache(store, cacheKey, destinations);
		return ok(destinations, 1);
	}

	/** One route-graph lookup, shared by the cold path and the background refresh. */
	async function fetchDestinations(
		origin: IataAirportCode,
		earliestDeparture: IsoCalendarDate,
		latestDeparture: IsoCalendarDate,
		ctx: ProviderContext
	): Promise<{ destinations: IataAirportCode[]; error?: ProviderError }> {
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
		if (!response.ok) return { destinations: [], error: toProviderError(response.error) };

		const result = response.data.onewayOnePerCityItineraries;
		const appError = appErrorOf(result);
		if (appError !== undefined) {
			return {
				destinations: [],
				error: { code: 'unknown', message: `Kiwi returned an error: ${appError}` }
			};
		}

		return { destinations: mapOnePerCityResultToDestinations(result) };
	}

	/**
	 * Refreshes one airport's route graph behind an answer already served from an expired
	 * entry. Rejects never, for the same reason `revalidateOffers` does.
	 *
	 * An empty answer paired with an error never overwrites a real route list: losing the
	 * graph is losing every candidate stopover, which is the whole search.
	 */
	async function revalidateDestinations(
		origin: IataAirportCode,
		earliestDeparture: IsoCalendarDate,
		latestDeparture: IsoCalendarDate,
		ctx: ProviderContext,
		store: CacheStore,
		cacheKey: CacheKey
	): Promise<void> {
		if (revalidating.has(cacheKey.raw)) return;
		revalidating.add(cacheKey.raw);
		try {
			const { destinations, error } = await fetchDestinations(
				origin,
				earliestDeparture,
				latestDeparture,
				ctx
			);
			if (error && destinations.length === 0) return;
			await writeCache(store, cacheKey, destinations);
			revalidationSettled(KIWI_PUBLIC_PROVIDER_ID);
		} catch {
			// The expired graph stays exactly as it was; the next search tries again.
		} finally {
			revalidating.delete(cacheKey.raw);
		}
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
		listDirectDestinations,
		hasDirectRoute
	};
}

export { createKiwiPublicFlightProvider };

/** The production singleton: real global `fetch`, the shared default cache store. Import
 * this to register the adapter; use `createKiwiPublicFlightProvider` directly only to
 * inject test doubles. */
export const kiwiPublicFlightProvider: FlightProvider = createKiwiPublicFlightProvider();
