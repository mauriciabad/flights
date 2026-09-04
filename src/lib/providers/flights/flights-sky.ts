/**
 * Flights Sky adapter, via RapidAPI's `flights-sky.p.rapidapi.com` (ntd119) — issue #61.
 *
 * The headline finding this issue exists to capture: `price-calendar` returns a price for
 * every day across roughly a month — measured for real, actually a full year, see
 * `getPriceCalendar`'s doc comment — in ONE request, versus Sky Scrapper's one request per
 * day (docs/PROVIDERS.md). That is the entire reason this adapter exposes
 * `getPriceCalendar` as its own capability (flights-sky-types.ts
 * `FlightPriceCalendarProvider`) instead of folding it into `searchOffers`: the two answer
 * different questions at wildly different prices, and `estimateSearchOffersCost` /
 * `estimatePriceCalendarCost` need to say so honestly for issue #56's search pipeline to
 * choose between them.
 *
 * Structured like ryanair.ts / skyscanner.ts: network (flights-sky-client.ts), types
 * (flights-sky-types.ts), timezone maths (airport-timezone.ts, shared with skyscanner.ts
 * since issue #124 unified what used to be two near-identical copies) and mapping
 * (flights-sky-map-offers.ts, flights-sky-map-calendar.ts) each in their own file. Unlike
 * either of those, every real request here routes through
 * `callProviderWithBudget` (../budget), per this issue's brief — that module owns the
 * monthly hard quota stop, in-flight dedup, permanent-"not-subscribed" short-circuit and
 * 429 backoff, so this file only has to decide *what* to call and *how many times*, not
 * *whether it is currently safe to*.
 *
 * Everything here assumes the real response shapes captured for issue #61 (see
 * fixtures/flights-sky-*.json and the PR description for exactly which five live RapidAPI
 * calls produced them), not any published documentation, which does not exist in a form
 * worth trusting.
 */

import { defineCacheKey, getDefaultStore } from '../../cache';
import type { CacheStore } from '../../cache';
import type { FlightOffer, IataAirportCode, IsoCalendarDate, IsoCurrencyCode } from '../../domain';
import { DEFAULT_TRAVELLERS } from '../../domain';
import { callProviderWithBudget } from '../budget';
import type { GeocodeProviderOptions } from '../geocode/transitous';
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
import { resolveAirportTimeZone } from './airport-timezone';
import { classifyFlightsSkyError, fetchAutoComplete, fetchPriceCalendar, fetchSearchOneWay } from './flights-sky-client';
import { extractExactEntityMatch, getCachedEntity, setCachedEntity } from './flights-sky-entity-cache';
import { mapPriceCalendarDays } from './flights-sky-map-calendar';
import { mapSearchOneWayToOffers } from './flights-sky-map-offers';
import { FlightsSkyMalformedOfferResponseError } from './flights-sky-map-offers';
import { FlightsSkyMalformedCalendarResponseError } from './flights-sky-map-calendar';
import type { FlightsSkyEntity, PriceCalendarDay, PriceCalendarQuery } from './flights-sky-types';
import type { FlightsSkyProvider } from './flights-sky-types';

export { hasPriceCalendar } from './flights-sky-types';
export type { FlightPriceCalendarProvider, FlightsSkyProvider, PriceCalendarDay, PriceCalendarQuery } from './flights-sky-types';

/** Also the id `../budget/caps.ts`'s `DEFAULT_PROVIDER_CAPS` is keyed by (40, 20% held back
 * from the measured 50/month, docs/PROVIDERS.md) — enforced at compile time by `ProviderId`
 * (../types.ts, issue #69), not by convention, so a drifted id here would fail to compile
 * rather than quietly fall back to `FALLBACK_PROVIDER_CAP` (10). */
export const FLIGHTS_SKY_PROVIDER_ID: ProviderId = 'flights-sky';

const DEFAULT_CURRENCY: IsoCurrencyCode = 'EUR';

/** Used when `ctx.maxRequests` is not given for `searchOffers`, so a caller that forgets to
 * set one cannot accidentally spend a third of this adapter's whole monthly cap in a single
 * call spanning a wide date range — same reasoning and same value as skyscanner.ts's own
 * default, since `search-one-way` has the identical one-request-per-day shape. */
const DEFAULT_MAX_REQUESTS_PER_CALL = 3;

/** `search-one-way` fares are a live, per-itinerary search result, closer in spirit to
 * Ryanair's fare-finder than to reference data — cached briefly so a UI re-render or a
 * fast-retried search does not re-spend quota, but short enough that a shown price is still
 * close to real. */
const OFFERS_TTL_MS = 15 * 60_000;
/** `price-calendar` is this adapter's whole reason to exist: one request standing in for
 * what would otherwise be a request per day. A calendar view re-rendered a dozen times in a
 * session, or reopened an hour later, must not spend a dozen more requests confirming
 * numbers that have not meaningfully moved — six hours balances that against still noticing
 * a real price swing well within a single day of shopping around. */
const PRICE_CALENDAR_TTL_MS = 6 * 60 * 60_000;

export interface CreateFlightsSkyFlightProviderOptions {
	/** Overrides the default IndexedDB-or-memory cache store. Mainly for tests. */
	cacheStore?: CacheStore;
	/** Overrides the global `fetch`. Mainly for tests, so none of them touch the network. */
	fetchImpl?: typeof fetch;
	/** Overrides `callProviderWithBudget`'s stored/default monthly cap. Mainly for tests —
	 * see `CallProviderWithBudgetOptions.cap` (../budget/call-with-budget.ts). */
	cap?: number;
	/** Overrides the real timer-based backoff delay. Tests pass an instant no-op so a
	 * 429-retry test doesn't take real seconds. */
	sleep?: (ms: number) => Promise<void>;
	/** Overrides `Date.now`. Mainly for tests. */
	now?: () => number;
}

/**
 * `storedAt` is the epoch millis this data actually came off Flights Sky's wire. Omitted
 * means "just now", i.e. this call did the fetch.
 *
 * `ProviderSource.fetchedAt` is documented as "the instant the adapter finished fetching
 * this, NOT when a caller later reads it out of a cache", and ResultCard already renders it
 * as "via Flights Sky · fetched 2 minutes ago". Stamping `new Date()` on a cache hit, which
 * is what this function used to do unconditionally, made that footer say "fetched just now"
 * about a price served out of a six-hour-old calendar entry. That breaks AGENTS.md's "never
 * present an estimate as a fact" in the one place the UI was already built to be honest.
 * Issue #151, the same shape as ryanair.ts (#147) and transfers/transitous.ts.
 */
function source(storedAt?: number): ProviderSource {
	return {
		providerId: FLIGHTS_SKY_PROVIDER_ID,
		fetchedAt: new Date(storedAt ?? Date.now()).toISOString()
	};
}

function ok<T>(data: T, requestsUsed: number, storedAt?: number): ProviderResult<T> {
	return { ok: true, data, source: source(storedAt), requestsUsed };
}

function fail<T>(error: ProviderError, requestsUsed: number): ProviderResult<T> {
	return { ok: false, error, source: source(), requestsUsed };
}

async function resolveStore(options: CreateFlightsSkyFlightProviderOptions): Promise<CacheStore> {
	return options.cacheStore ?? (await getDefaultStore());
}

/** One cached value and the instant it came off the wire, which is `source()`'s input and
 * the thing `readCache` used to throw away by returning `entry.value` alone (issue #151). */
interface FreshCacheEntry<T> {
	value: T;
	storedAt: number;
}

/** Cache-aside against `CacheStore` directly, same reasoning as ryanair.ts's own
 * `readCache`/`writeCache`: `staleWhileRevalidate` (../../cache) always calls its fetcher,
 * which is exactly wrong for a metered adapter answering one `ProviderResult` per call with
 * no consumer able to observe a first "stale" yield. */
async function readCache<T>(
	store: CacheStore,
	key: ReturnType<typeof defineCacheKey>
): Promise<FreshCacheEntry<T> | undefined> {
	const entry = await store.get(key.raw);
	if (entry === undefined) return undefined;
	if (Date.now() - entry.storedAt >= entry.ttlMs) return undefined;
	return { value: entry.value as T, storedAt: entry.storedAt };
}

async function writeCache<T>(
	store: CacheStore,
	key: ReturnType<typeof defineCacheKey>,
	value: T
): Promise<void> {
	const now = Date.now();
	await store.set({
		key: key.raw,
		providerId: FLIGHTS_SKY_PROVIDER_ID,
		value,
		storedAt: now,
		ttlMs: key.ttlMs,
		lastAccessedAt: now,
		sizeBytes: estimateSizeBytes(value)
	});
}

// Mirrors cache/size.ts's own internal `estimateByteSize`, not exported from
// src/lib/cache/index.ts — same approach ryanair.ts and skyscanner-airport-cache.ts each
// keep a local copy of: "close enough to bytes, not billing anyone."
function estimateSizeBytes(value: unknown): number {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return 0;
	}
}

function enumerateDates(
	earliestDeparture: IsoCalendarDate,
	latestDeparture: IsoCalendarDate
): IsoCalendarDate[] {
	const start = Date.parse(`${earliestDeparture}T00:00:00Z`);
	const end = Date.parse(`${latestDeparture}T00:00:00Z`);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
	const dates: IsoCalendarDate[] = [];
	for (let t = start; t <= end; t += 24 * 60 * 60 * 1000) {
		dates.push(new Date(t).toISOString().slice(0, 10));
	}
	return dates;
}

function createFlightsSkyFlightProvider(
	options: CreateFlightsSkyFlightProviderOptions = {}
): FlightsSkyProvider {
	const { cacheStore: cacheStoreOverride, fetchImpl, cap, sleep, now } = options;

	function budgetCall<T>(dedupeKey: string, execute: () => Promise<T>): Promise<ProviderResult<T>> {
		return callProviderWithBudget({
			providerId: FLIGHTS_SKY_PROVIDER_ID,
			dedupeKey,
			execute,
			classifyError: classifyFlightsSkyError,
			cap,
			sleep,
			now
		});
	}

	/** Threads this adapter's own `fetchImpl`/`cacheStore` test overrides into
	 * `airport-timezone.ts`'s live Transitous fallback, the same reasoning
	 * skyscanner.ts's own `geocodeOptions` gives: a test injecting an isolated
	 * `cacheStore` here gets that same isolation for timezone lookups, and production
	 * (both undefined) falls through to the real default store/global `fetch` this
	 * adapter's own airport-entity cache already uses. */
	function geocodeOptions(): GeocodeProviderOptions {
		return {
			fetchImpl,
			resolveStore: cacheStoreOverride ? async () => cacheStoreOverride : undefined
		};
	}

	/**
	 * Resolves `iataCode` to the `skyId`/`entityId` pair `price-calendar` and
	 * `search-one-way` need. Not gated by the caller's `ctx.maxRequests`, same reasoning as
	 * skyscanner.ts's own `resolveAirportEntity`: on a cold cache this costs at most one
	 * request, that request is cached for ~six months (flights-sky-entity-cache.ts), and
	 * skipping it because the current call's budget could not also afford the main request
	 * would throw away a lookup whose value outlives this call by months.
	 */
	async function resolveEntity(
		iataCode: IataAirportCode,
		apiKey: string,
		ctx: ProviderContext,
		cacheStore: CacheStore
	): Promise<
		| { ok: true; entity: FlightsSkyEntity; requestsSpent: number }
		| { ok: false; error: ProviderError; requestsSpent: number }
	> {
		const cached = await getCachedEntity(iataCode, cacheStore);
		if (cached !== undefined) return { ok: true, entity: cached, requestsSpent: 0 };

		const result = await budgetCall(`${FLIGHTS_SKY_PROVIDER_ID}:autoComplete:${iataCode.toUpperCase()}`, () =>
			fetchAutoComplete(iataCode, { apiKey, signal: ctx.signal, fetchImpl })
		);
		if (!result.ok) return { ok: false, error: result.error, requestsSpent: result.requestsUsed };

		const entity = extractExactEntityMatch(result.data, iataCode);
		if (entity === undefined) {
			return {
				ok: false,
				requestsSpent: result.requestsUsed,
				error: {
					code: 'malformed-response',
					message: `Flights Sky's auto-complete for "${iataCode}" returned no exact skyId match`
				}
			};
		}
		await setCachedEntity(iataCode, entity, cacheStore);
		return { ok: true, entity, requestsSpent: result.requestsUsed };
	}

	async function searchOffers(
		query: FlightSearchQuery,
		ctx: ProviderContext
	): Promise<ProviderResult<FlightOffer[]>> {
		if (ctx.signal.aborted) {
			return fail({ code: 'cancelled', message: 'Search was cancelled before it started' }, 0);
		}
		const apiKey = ctx.keys?.apiKey;
		if (!apiKey) {
			return fail({ code: 'missing-key', message: 'No Flights Sky (RapidAPI) key configured' }, 0);
		}

		const cacheStore = await resolveStore(options);
		let requestsUsed = 0;

		const originResolved = await resolveEntity(query.origin, apiKey, ctx, cacheStore);
		requestsUsed += originResolved.requestsSpent;
		if (!originResolved.ok) return fail(originResolved.error, requestsUsed);

		const destinationResolved = await resolveEntity(query.destination, apiKey, ctx, cacheStore);
		requestsUsed += destinationResolved.requestsSpent;
		if (!destinationResolved.ok) return fail(destinationResolved.error, requestsUsed);

		const currency = query.currency ?? DEFAULT_CURRENCY;
		const travellers = query.travellers ?? DEFAULT_TRAVELLERS;
		const budget = ctx.maxRequests ?? DEFAULT_MAX_REQUESTS_PER_CALL;
		const dates = enumerateDates(query.earliestDeparture, query.latestDeparture);

		// A one-way search-one-way response only ever contains itineraries for the queried
		// origin and destination (same confirmed shape as skyscanner.ts's own comment on this
		// exact pattern), so both zones are resolved once here rather than per itinerary or
		// per date. Neither lookup spends any of this adapter's own `requestsUsed` budget:
		// Transitous is a separate, keyless provider with its own long-lived cache
		// (geocode/transitous.ts), not part of Flights Sky's metered RapidAPI quota.
		const geocode = geocodeOptions();
		const [originTimeZone, destinationTimeZone] = await Promise.all([
			resolveAirportTimeZone(query.origin, ctx, geocode),
			resolveAirportTimeZone(query.destination, ctx, geocode)
		]);
		const timeZones = new Map<string, string>();
		if (originTimeZone !== undefined) timeZones.set(query.origin.toUpperCase(), originTimeZone);
		if (destinationTimeZone !== undefined) timeZones.set(query.destination.toUpperCase(), destinationTimeZone);

		const offers: FlightOffer[] = [];
		let sawMalformedDate = false;
		// Issue #124: airports that blocked an otherwise-real, otherwise-bookable itinerary
		// from becoming an offer — BVC's own case, a genuine nonstop TUI fare this adapter
		// could not time. Tracked across every date in this call so `offers.length === 0`
		// at the end can be told apart from "this route genuinely has nothing," which is the
		// distinction issue #130/#144's provider-answer states exist to carry to the screen.
		const unresolvedTimeZoneAirports = new Set<string>();
		/**
		 * The oldest day that ends up in `offers`, and the only age that is true of the
		 * whole array. This loop merges days re-served from cache with days fetched on this
		 * call, and one `ProviderSource` has to speak for all of them. A day served out of a
		 * ten-minute-old entry contributes that instant, a day fetched here contributes now,
		 * and the minimum is the claim the caller can rely on. Nothing in the array is older
		 * than the stamp. It is also the rule results/types.ts already applies when it ages
		 * an itinerary by its oldest contributing part. `Date.now()`, which is what this
		 * function used to stamp unconditionally, says the cached days were just read off
		 * the wire (issue #151), and the newest contribution would say the same thing more
		 * quietly.
		 *
		 * A cached day holding no offers still counts. The result asserts "these are that
		 * day's prices" either way, and that assertion is exactly as old as the entry it
		 * came from. `undefined` means nothing contributed at all, an empty range or every
		 * day failing, and the empty answer is then dated now, there being no earlier moment
		 * to point at.
		 */
		let oldestContributingDay: number | undefined;
		function contributeDay(fetchedAt: number): void {
			if (oldestContributingDay === undefined || fetchedAt < oldestContributingDay) {
				oldestContributingDay = fetchedAt;
			}
		}

		for (const date of dates) {
			if (requestsUsed >= budget) break; // out of budget: stop, keep whatever we have

			if (ctx.signal.aborted) {
				if (offers.length > 0) break; // keep the partial result, same rule as below
				return fail({ code: 'cancelled', message: 'Search was cancelled' }, requestsUsed);
			}

			const cacheKey = defineCacheKey(
				FLIGHTS_SKY_PROVIDER_ID,
				{ op: 'searchOneWay', origin: originResolved.entity.skyId, destination: destinationResolved.entity.skyId, date, currency },
				OFFERS_TTL_MS
			);
			const cached = await readCache<FlightOffer[]>(cacheStore, cacheKey);
			if (cached) {
				offers.push(...cached.value);
				contributeDay(cached.storedAt);
				continue; // a cache hit costs nothing, so it never touches `requestsUsed` or the budget
			}

			const result = await budgetCall(
				`${FLIGHTS_SKY_PROVIDER_ID}:searchOneWay:${originResolved.entity.skyId}:${destinationResolved.entity.skyId}:${date}:${currency}`,
				() =>
					fetchSearchOneWay(
						{ fromEntityId: originResolved.entity.skyId, toEntityId: destinationResolved.entity.skyId, departDate: date, currency },
						{ apiKey, signal: ctx.signal, fetchImpl }
					)
			);
			requestsUsed += result.requestsUsed;

			if (!result.ok) {
				if (result.error.code === 'malformed-response') {
					// One day's response failing to parse does not mean the whole range should.
					sawMalformedDate = true;
					continue;
				}
				// not-subscribed, quota-exceeded, network-error, cancelled, unknown: every one
				// of these fails identically for the remaining dates (same key, same host,
				// same outage), so looping further only spends more budget on a guaranteed
				// repeat. Prefer real offers already in hand over surfacing the error.
				if (offers.length > 0) break;
				return fail(result.error, requestsUsed);
			}

			try {
				const mapped = mapSearchOneWayToOffers(result.data, { currency, travellers, timeZones });
				await writeCache(cacheStore, cacheKey, mapped.offers);
				offers.push(...mapped.offers);
				contributeDay(Date.now());
				for (const code of mapped.unresolvedTimeZoneAirports) unresolvedTimeZoneAirports.add(code);
			} catch (cause) {
				if (cause instanceof FlightsSkyMalformedOfferResponseError) {
					sawMalformedDate = true;
					continue;
				}
				throw cause;
			}
		}

		if (offers.length === 0 && sawMalformedDate) {
			return fail(
				{
					code: 'malformed-response',
					message: 'Flights Sky responses for every requested date had an unrecognised shape'
				},
				requestsUsed
			);
		}
		// Issue #124/#130: a real, priceable itinerary existed and got dropped only because
		// this app does not know one of its airports' time zones — never silently equivalent
		// to "this route has nothing." AGENTS.md: "show the actual errors received, not
		// invent our own" — the airport codes named here are exactly the ones that blocked
		// mapping, not a guess at the cause.
		if (offers.length === 0 && unresolvedTimeZoneAirports.size > 0) {
			const codes = [...unresolvedTimeZoneAirports].sort().join(', ');
			return fail(
				{
					code: 'malformed-response',
					message: `Flights Sky returned a real, nonstop itinerary this app could not price: no known time zone for ${codes}`
				},
				requestsUsed
			);
		}
		return ok(offers, requestsUsed, oldestContributingDay);
	}

	/**
	 * Measured 2026-09-04 against a real BCN-VIE call (fixtures/flights-sky-price-calendar-
	 * bcn-vie.json, 366 rows, verified contiguous with no gaps): the returned calendar ran
	 * from *today* through exactly a year forward, not "roughly a month" from the requested
	 * `departDate` as this issue's own brief assumed going in. That is one measurement
	 * against one route, not a guarantee every route or every call date behaves identically
	 * — re-verify before hard-coding "always 366 days" anywhere downstream. What is
	 * guaranteed by construction is this method's cost: exactly one request (plus, on a cold
	 * cache, at most two long-lived entity lookups) regardless of how wide a window the
	 * caller asked about, which is the entire point of exposing this apart from
	 * `searchOffers`.
	 */
	async function getPriceCalendar(
		query: PriceCalendarQuery,
		ctx: ProviderContext
	): Promise<ProviderResult<PriceCalendarDay[]>> {
		if (ctx.signal.aborted) {
			return fail({ code: 'cancelled', message: 'Price calendar lookup was cancelled before it started' }, 0);
		}
		const apiKey = ctx.keys?.apiKey;
		if (!apiKey) {
			return fail({ code: 'missing-key', message: 'No Flights Sky (RapidAPI) key configured' }, 0);
		}

		const cacheStore = await resolveStore(options);
		let requestsUsed = 0;

		const originResolved = await resolveEntity(query.origin, apiKey, ctx, cacheStore);
		requestsUsed += originResolved.requestsSpent;
		if (!originResolved.ok) return fail(originResolved.error, requestsUsed);

		const destinationResolved = await resolveEntity(query.destination, apiKey, ctx, cacheStore);
		requestsUsed += destinationResolved.requestsSpent;
		if (!destinationResolved.ok) return fail(destinationResolved.error, requestsUsed);

		const currency = query.currency ?? DEFAULT_CURRENCY;
		const cacheKey = defineCacheKey(
			FLIGHTS_SKY_PROVIDER_ID,
			{
				op: 'priceCalendar',
				origin: originResolved.entity.skyId,
				destination: destinationResolved.entity.skyId,
				departDate: query.departDate,
				currency
			},
			PRICE_CALENDAR_TTL_MS
		);
		const cached = await readCache<PriceCalendarDay[]>(cacheStore, cacheKey);
		if (cached) return ok(cached.value, requestsUsed, cached.storedAt);

		if (ctx.maxRequests !== undefined && requestsUsed + 1 > ctx.maxRequests) {
			// Out of budget for the calendar call itself: an empty ok result, not an error —
			// same "partial result, not a failure" rule as ProviderContext.maxRequests
			// documents and ryanair.ts / skyscanner.ts both already follow.
			return ok([], requestsUsed);
		}

		const result = await budgetCall(
			`${FLIGHTS_SKY_PROVIDER_ID}:priceCalendar:${originResolved.entity.skyId}:${destinationResolved.entity.skyId}:${query.departDate}:${currency}`,
			() =>
				fetchPriceCalendar(
					{
						fromEntityId: originResolved.entity.skyId,
						toEntityId: destinationResolved.entity.skyId,
						departDate: query.departDate,
						currency
					},
					{ apiKey, signal: ctx.signal, fetchImpl }
				)
		);
		requestsUsed += result.requestsUsed;
		if (!result.ok) return fail(result.error, requestsUsed);

		try {
			const days = mapPriceCalendarDays(result.data, currency);
			await writeCache(cacheStore, cacheKey, days);
			return ok(days, requestsUsed);
		} catch (cause) {
			if (cause instanceof FlightsSkyMalformedCalendarResponseError) {
				return fail({ code: 'malformed-response', message: cause.message }, requestsUsed);
			}
			throw cause;
		}
	}

	async function listDirectDestinations(): Promise<ProviderResult<IataAirportCode[]>> {
		// This issue's brief lists `auto-complete`, `price-calendar`, `search-one-way` and
		// `search-roundtrip` as the confirmed-live endpoints — none of them answer "every
		// airport reachable direct from X." Reporting failure here, honestly, lets the search
		// pipeline (issue #12/#22) fall back to a provider that does (Ryanair's own published
		// route graph, docs/PROVIDERS.md) rather than this adapter guessing at one.
		return fail(
			{
				code: 'unknown',
				message: 'Flights Sky has no confirmed airport-level direct-destinations endpoint'
			},
			0
		);
	}

	async function healthCheck(ctx: ProviderContext): Promise<ProviderHealth> {
		if (ctx.signal.aborted) {
			return fail({ code: 'cancelled', message: 'Health check was cancelled' }, 0);
		}
		const apiKey = ctx.keys?.apiKey;
		if (!apiKey) {
			return fail({ code: 'missing-key', message: 'No Flights Sky (RapidAPI) key configured' }, 0);
		}

		// No dedicated "ping" endpoint exists, so this spends one real request on the
		// cheapest real call available — the same auto-complete call `resolveEntity` would
		// make anyway on a cold cache. Callers are told (types.ts ProviderBase.healthCheck)
		// to run this once, not per search.
		const result = await budgetCall(`${FLIGHTS_SKY_PROVIDER_ID}:healthCheck`, () =>
			fetchAutoComplete('london', { apiKey, signal: ctx.signal, fetchImpl })
		);
		if (!result.ok) return fail(result.error, result.requestsUsed);
		return ok({ message: 'Flights Sky key is present and subscribed' }, result.requestsUsed);
	}

	return {
		kind: 'flight',
		id: FLIGHTS_SKY_PROVIDER_ID,
		label: 'Flights Sky (RapidAPI)',
		needsKey: true,
		keyFields: [
			{
				id: 'apiKey',
				label: 'RapidAPI key',
				placeholder: 'Paste your RapidAPI key',
				helpUrl: 'https://rapidapi.com/ntd119/api/flights-sky'
			}
		],
		healthCheck,
		estimateSearchOffersCost(query: FlightSearchQuery): number {
			// `search-one-way` takes exactly one date per call, never a range (confirmed for
			// this issue), so a caller's date span costs one request per day in it — same
			// shape, and same reasoning, as skyscanner.ts's own estimate.
			return enumerateDates(query.earliestDeparture, query.latestDeparture).length;
		},
		searchOffers,
		listDirectDestinations,
		estimatePriceCalendarCost(): number {
			// Always 1: see getPriceCalendar's own doc comment for the measurement this
			// constant rests on, and flights-sky-types.ts's FlightPriceCalendarProvider doc
			// comment for why this is the entire point of this capability existing.
			return 1;
		},
		getPriceCalendar
	};
}

export { createFlightsSkyFlightProvider };

/** The production singleton: real global `fetch`, the shared default cache store, the
 * shared budget module's real quota/backoff. Import this to register the adapter; use
 * `createFlightsSkyFlightProvider` directly only to inject test doubles. */
export const flightsSkyFlightProvider: FlightsSkyProvider = createFlightsSkyFlightProvider();
