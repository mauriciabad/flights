/**
 * Hostelworld's own web backend, used the way their website uses it. **The keyless baseline
 * for beds** — the only stay adapter in this app that answers with nothing configured.
 *
 * ## Why this exists
 *
 * `docs/ACCEPTANCE.md` condition 3 is "A bed is priced into the total." Until this adapter,
 * that condition could only pass for someone who had paid: Agoda and Booking.com both reach
 * their data through RapidAPI and both are `needsKey: true`, so a visitor with no key got
 * "No bed priced for this stopover" on every result, forever. Flights stopped needing a key
 * when kiwi-public.ts found Kiwi's own public endpoint; this is the same move for the bed,
 * and it closes the last leg of the trip that was standing behind somebody's credit card.
 *
 * Measured against the acceptance trip on 2026-09-04: BVC to PFO via London, 9-12 October
 * 2026, one traveller, EUR. Hostelworld priced 74 London properties, cheapest dorm 19.07 a
 * night, from a real browser page origin with no key of any kind present.
 *
 * ## What it costs
 *
 * Nothing, to anyone. No signup, no account, no quota belonging to this app's owner —
 * which is the whole point, since 85% of one month's Booking.com allowance went in a single
 * morning of agents testing. So this follows kiwi-public.ts's shape rather than booking.ts's:
 * `estimateSearchStaysCost` reports 0, which `search/cost-aware.ts` reads as the `free`
 * tier and therefore always runs, and reads go through the cache directly rather than
 * through `providers/budget`, which exists to enforce monthly caps this adapter does not
 * have. Not one request this adapter makes carries a key, a token, a cookie or a header of
 * any kind — see hostelworld-client.ts, which also records the host that does want one and
 * why it is not used.
 *
 * ## The endpoint is keyed by city; the query is keyed by a point
 *
 * `StaySearchQuery.near` is a coordinate; `/cities/{id}/properties/` wants a city id. The
 * bridge is Hostelworld's own geography: six keyless requests return every country with its
 * full city list and real coordinates (3541 cities, 83 KB gzipped), cached for a month, and
 * after that matching an airport to a city is arithmetic costing no request at all. A search
 * on a warm index spends exactly one request.
 *
 * Matching is geographic first and textual only as a tie-break, which is the opposite of
 * how it started and the reason it works. Distance alone is not enough: the nearest
 * Hostelworld city to London Gatwick is "Gatwick", 2 km away, with London sixth at 39 km.
 * A name alone is not enough either: Hostelworld has a London in Ontario and puts Brazil's
 * Boa Vista ahead of Cape Verde's. So `rankCitiesNear` prefers, among the cities inside the
 * search radius, the one this app already decided the airport serves — and falls back to
 * the nearest when it has never heard of it. See that function for the measurements.
 *
 * An earlier version resolved the city through Hostelworld's autocomplete instead. It
 * passed every unit test and failed on the real page: that host sends no
 * `Access-Control-Allow-Origin` to a foreign origin, which `curl` cannot see.
 * hostelworld-client.ts's header has the details.
 *
 * File split mirrors booking.ts and kiwi-public.ts: hostelworld-client.ts (network),
 * hostelworld-types.ts (raw shapes), hostelworld-mapper.ts (pure translation), this file
 * (orchestration and caching).
 *
 * ## What it does not do
 *
 * Hostels and budget hotels, not the whole accommodation market. Hostelworld's inventory is
 * what it is, and in a city it does not cover this adapter returns nothing rather than
 * something — which is why agoda.ts and booking.ts stay registered alongside it for anyone
 * who does hold a key. This is a floor under the feature, not a replacement for them.
 */

import { defineCacheKey, getDefaultStore, readCachedEntry } from '../../cache';
import type { CacheKey, CacheStore } from '../../cache';
import { DEFAULT_SEARCH_CURRENCY, DEFAULT_TRAVELLERS } from '../../domain';
import type { IsoCurrencyCode, Stay } from '../../domain';
import { resolveAirportCityLabel } from '../geocode/airport-city';
import type {
	ProviderContext,
	ProviderError,
	ProviderHealth,
	ProviderId,
	ProviderResult,
	ProviderSource,
	StayProvider,
	StaySearchQuery
} from '../types';
import {
	fetchCityProperties,
	fetchContinentCountries,
	HOSTELWORLD_CONTINENT_IDS
} from './hostelworld-client';
import {
	flattenGeoCities,
	mapPropertiesToStays,
	nightsBetweenDates,
	rankCitiesNear
} from './hostelworld-mapper';
import type { HostelworldCity } from './hostelworld-mapper';
import type { HostelworldFetchError } from './hostelworld-types';

/** Also the id `../budget/caps.ts`'s `DEFAULT_PROVIDER_CAPS` is keyed by — though this
 * adapter deliberately has no entry there, because it is not metered. */
export const HOSTELWORLD_PROVIDER_ID: ProviderId = 'hostelworld';

/** Live rates, so cached about as long as one stays true. The same window agoda.ts and
 * booking.ts settled on for their own searches. */
const PROPERTIES_TTL_MS = 60 * 60_000;

/** Where Hostelworld's cities are is geography, not tonight's prices. A month makes every
 * search after the first one a single request, and a city that genuinely moved into the
 * index would be picked up within one. */
const CITY_INDEX_TTL_MS = 30 * 24 * 60 * 60_000;

/** See hostelworld-client.ts's `fetchCityProperties` for the measurement behind this: the
 * page is sorted by price, and thirty of those is about 53 KB gzipped. */
const PROPERTIES_PER_PAGE = 30;

/**
 * How many cities near the airport to price. Every one of them, not the first that answers
 * — see `searchStays` for why that early return was issue #204.
 *
 * Three, and the number is load-bearing rather than cautious. `rankCitiesNear` lists the
 * city this app named for the airport first and then everything else by distance, so three
 * is the smallest window that holds both the walkable town and the real city for every
 * airport this app has been measured against (2026-09-04, against the live index):
 *
 * | Airport | Cities inside 50 km, nearest first | The three asked |
 * | --- | --- | --- |
 * | LGW | Gatwick 2.0, Crawley 3.6, Guildford 28.6, Lewes 33.5, Brighton 35.2, London 39.3 | London (named), Gatwick, Crawley |
 * | STN | Harlow 15.1, Cambridge 35.9, London 49.2 | London (named), Harlow, Cambridge |
 * | MXP | Novara 22.3, Lake Como 34.1, Milan 39.7 | Novara, Lake Como, Milan |
 * | BGY | Bergamo 4.0, Lake Iseo 28.7, Lecco 32.0 | Bergamo, Lake Iseo, Lecco |
 *
 * Two would be enough for Gatwick and would lose Milan, whose name this app writes as
 * "Ferno (VA)" so nothing matches it and it only arrives third by distance. Four costs a
 * request per stopover to reach cities nobody would stop in. So: three.
 */
const MAX_CITY_CANDIDATES = 3;

/** `healthCheck`'s sample. See `HOSTELWORLD_CONTINENT_IDS` in hostelworld-client.ts. */
const EUROPE_CONTINENT_ID = 3;

export interface HostelworldProviderOptions {
	/** Overrides the shared IndexedDB-or-memory store. Tests inject a `MemoryCacheStore` so
	 * nothing here touches a real browser API. */
	store?: CacheStore;
	/** Overrides the global `fetch`. Tests inject a stub that resolves the captured
	 * fixtures, so the whole adapter is exercised with zero real network traffic. */
	fetchImpl?: typeof fetch;
	/** Overrides `MAX_CITY_CANDIDATES`, so a test can reach the ceiling without stubbing
	 * three cities' worth of properties. */
	maxCityCandidates?: number;
}

/**
 * `storedAt` is the epoch millis this data actually came off Hostelworld's wire. Omitted
 * means "just now", i.e. this call did the fetch.
 *
 * `ProviderSource.fetchedAt` is documented as "the instant the adapter finished fetching
 * this, NOT when a caller later reads it out of a cache", and the result card renders it as
 * "via Hostelworld · fetched 2 minutes ago". Stamping `new Date()` on a cache hit would say
 * an hour-old price came off the wire this second — issue #151, the same shape ryanair.ts,
 * booking.ts and kiwi-public.ts each carry.
 */
function source(storedAt?: number): ProviderSource {
	return {
		providerId: HOSTELWORLD_PROVIDER_ID,
		fetchedAt: new Date(storedAt ?? Date.now()).toISOString()
	};
}

function ok<T>(data: T, requestsUsed: number, storedAt?: number): ProviderResult<T> {
	return { ok: true, data, source: source(storedAt), requestsUsed };
}

function fail<T>(error: ProviderError, requestsUsed: number): ProviderResult<T> {
	return { ok: false, error, source: source(), requestsUsed };
}

function toProviderError(error: HostelworldFetchError): ProviderError {
	switch (error.code) {
		case 'cancelled':
			return { code: 'cancelled', message: error.message };
		case 'network-error':
			return { code: 'network-error', message: error.message, cause: error.cause };
		case 'malformed-response':
			return { code: 'malformed-response', message: error.message, cause: error.cause };
		case 'rate-limited':
			// Keyless, so no monthly plan is being exceeded — but Hostelworld's own edge can
			// still throttle a client that hammers it, and "back off and try later" is the
			// right thing to tell a user either way. Same call kiwi-public.ts makes.
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

async function resolveStore(options: HostelworldProviderOptions): Promise<CacheStore> {
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

/**
 * `storedAt` is passed in rather than read here so a caller can stamp the cache entry and
 * its own `ProviderSource.fetchedAt` with the SAME instant. Two `Date.now()` calls a few
 * statements apart straddle a millisecond boundary often enough to matter: the fresh result
 * then claimed one instant, its own cached replay claimed another, and issue #151's rule
 * that both report when the data came off the wire quietly stopped holding.
 */
async function writeCache<T>(
	store: CacheStore,
	key: CacheKey,
	value: T,
	storedAt: number
): Promise<void> {
	await store.set({
		key: key.raw,
		providerId: HOSTELWORLD_PROVIDER_ID,
		value,
		storedAt,
		ttlMs: key.ttlMs,
		lastAccessedAt: storedAt,
		sizeBytes: estimateSizeBytes(value)
	});
}

/** "London, United Kingdom" reduced to "London". `resolveAirportCityLabel` builds that label
 * as `${city}, ${country}` and nothing else, so one split on the first comma is exact rather
 * than a guess at a format. The country half is dropped rather than used: Hostelworld files
 * this one under "England", and every attempt to match country names across the two
 * vocabularies failed on the acceptance trip's own stopover. Geography decides instead
 * (`rankCitiesNear`). */
function cityNameOf(label: string): string {
	const comma = label.indexOf(',');
	return (comma < 0 ? label : label.slice(0, comma)).trim();
}

/** What one continent's fetch produced: its cities, and whether it cost a request. */
interface ContinentOutcome {
	cities: HostelworldCity[];
	requestsUsed: number;
	error?: ProviderError;
}

function createHostelworldStayProvider(options: HostelworldProviderOptions = {}): StayProvider {
	const maxCityCandidates = options.maxCityCandidates ?? MAX_CITY_CANDIDATES;

	/**
	 * The six continent fetches, deduplicated across concurrent searches.
	 *
	 * `search/resources.ts` prices every stopover candidate at once, so three connections on
	 * a cold cache would otherwise start three identical index builds and spend eighteen
	 * requests to learn the same geography. One in-flight promise per provider instance —
	 * which is per app session, since `hostelworldStayProvider` is a module singleton —
	 * makes it six, once.
	 */
	let cityIndexInFlight: Promise<{ cities: HostelworldCity[]; requestsUsed: number; error?: ProviderError }> | undefined;

	/** Keys with a refresh already running. Three stopover candidates sharing a city ask for
	 * the same beds at the same moment, and a background refresh each would spend three
	 * requests to learn one price. */
	const revalidating = new Set<string>();

	/**
	 * Refetches behind an answer already given. Returns nothing and rejects never: nobody is
	 * awaiting it, so a rejection would be unhandled, and a failed refresh is not a failure
	 * of the call that started it. The traveller keeps the beds they were shown, with the
	 * real age of those prices still on the card.
	 *
	 * Never writes an empty or failed response over a real one. An error paired with no
	 * properties means the request failed, not that the city sold out, and overwriting would
	 * turn a background refresh into a silent loss of what is on screen.
	 */
	async function revalidate(key: CacheKey, fetchValue: () => Promise<unknown | undefined>, store: CacheStore): Promise<void> {
		if (revalidating.has(key.raw)) return;
		revalidating.add(key.raw);
		try {
			const value = await fetchValue();
			if (value === undefined) return;
			await writeCache(store, key, value, Date.now());
		} catch {
			// The held answer stays exactly as it was; the next search tries again.
		} finally {
			revalidating.delete(key.raw);
		}
	}

	function revalidateContinent(
		store: CacheStore,
		key: CacheKey,
		continentId: number,
		ctx: ProviderContext
	): Promise<void> {
		return revalidate(
			key,
			async () => {
				const response = await fetchContinentCountries(continentId, {
					signal: ctx.signal,
					fetchImpl: options.fetchImpl
				});
				return response.ok ? flattenGeoCities(response.data) : undefined;
			},
			store
		);
	}

	function revalidateProperties(
		store: CacheStore,
		key: CacheKey,
		cityId: number,
		currency: IsoCurrencyCode,
		checkIn: string,
		nights: number,
		guests: number,
		ctx: ProviderContext
	): Promise<void> {
		return revalidate(
			key,
			async () => {
				const response = await fetchCityProperties(
					{ cityId, currency, dateStart: checkIn, numNights: nights, guests, perPage: PROPERTIES_PER_PAGE },
					{ signal: ctx.signal, fetchImpl: options.fetchImpl }
				);
				return response.ok ? response.data : undefined;
			},
			store
		);
	}

	/** One continent, cache-aside. A failure is returned rather than thrown so a single
	 * unreachable continent costs its own cities and nothing else. */
	async function loadContinent(
		store: CacheStore,
		continentId: number,
		ctx: ProviderContext
	): Promise<ContinentOutcome> {
		const key = defineCacheKey(
			HOSTELWORLD_PROVIDER_ID,
			{ op: 'continentCities', continentId },
			CITY_INDEX_TTL_MS
		);
		const cached = await readCachedEntry<HostelworldCity[]>(store, key);
		if (cached) {
			// Served at any age. Where Hostelworld's cities are is geography, so a month-old
			// answer is still the right one, and refreshing it behind the traveller costs them
			// nothing where making them wait for it costs them the whole page.
			if (!cached.fresh) void revalidateContinent(store, key, continentId, ctx);
			return { cities: cached.value, requestsUsed: cached.fresh ? 0 : 1 };
		}

		const response = await fetchContinentCountries(continentId, {
			signal: ctx.signal,
			fetchImpl: options.fetchImpl
		});
		if (!response.ok) {
			return { cities: [], requestsUsed: 1, error: toProviderError(response.error) };
		}
		const cities = flattenGeoCities(response.data);
		await writeCache(store, key, cities, Date.now());
		return { cities, requestsUsed: 1 };
	}

	/** Every Hostelworld city with coordinates, from cache or from six requests. */
	async function loadCityIndex(
		store: CacheStore,
		ctx: ProviderContext
	): Promise<{ cities: HostelworldCity[]; requestsUsed: number; error?: ProviderError }> {
		const startedTheBuild = cityIndexInFlight === undefined;
		cityIndexInFlight ??= (async () => {
			const outcomes = await Promise.all(
				HOSTELWORLD_CONTINENT_IDS.map((continentId) => loadContinent(store, continentId, ctx))
			);
			return {
				cities: outcomes.flatMap((outcome) => outcome.cities),
				requestsUsed: outcomes.reduce((sum, outcome) => sum + outcome.requestsUsed, 0),
				// Only reported when the whole index came back empty — one continent failing
				// while the rest answered is not a failure of this search, and the airport is
				// on exactly one continent anyway.
				error: outcomes.find((outcome) => outcome.error !== undefined)?.error
			};
		})();
		try {
			const index = await cityIndexInFlight;
			// The build is shared, so its cost must not be. Three stopovers priced at once
			// waited on ONE set of six requests; charging all three for six would report 21
			// requests against a network log showing 9, which is the kind of number this repo
			// keeps honest on purpose (`ProviderSource.fetchedAt` has the same rule).
			return startedTheBuild ? index : { ...index, requestsUsed: 0 };
		} finally {
			// Cleared only by the caller that set it, so a late joiner cannot discard a build
			// somebody else is still waiting on. Not memoised past completion either: the
			// cache is the memo, and a resolved promise held here would keep a month-old index
			// alive for the whole session after its TTL expired.
			if (startedTheBuild) cityIndexInFlight = undefined;
		}
	}

	async function searchStays(
		query: StaySearchQuery,
		ctx: ProviderContext
	): Promise<ProviderResult<Stay[]>> {
		if (ctx.signal.aborted) {
			return fail(
				{ code: 'cancelled', message: 'Hostelworld search was cancelled before it started' },
				0
			);
		}

		const nights = nightsBetweenDates(query.checkIn, query.checkOut);
		// A stay of no nights is not a stay. `search/resources.ts` never builds one, so this
		// is a guard rather than a case: reported as "found nothing", because there was
		// nothing to look for, not as a provider failure it would be dishonest to blame
		// Hostelworld for.
		if (nights === undefined || nights <= 0) return ok([], 0);

		const store = await resolveStore(options);
		const index = await loadCityIndex(store, ctx);
		let requestsUsed = index.requestsUsed;
		if (index.cities.length === 0) {
			return index.error ? fail(index.error, requestsUsed) : ok([], requestsUsed);
		}

		// The city this app already decided the airport serves — a preference, not a
		// requirement. `undefined` for a coordinate that is not one of this app's known
		// airports, which just means `rankCitiesNear` falls back to pure distance instead of
		// this adapter having nothing to go on. That is why it does NOT fall through to
		// Nominatim the way agoda.ts does: there is nothing here that needs a name.
		const preferredCity = await resolveAirportCityLabel(query.near);
		const cityIds = rankCitiesNear(
			index.cities,
			query.near,
			query.radiusKm,
			preferredCity ? cityNameOf(preferredCity) : undefined
		).slice(0, maxCityCandidates);

		const currency: IsoCurrencyCode = query.currency ?? DEFAULT_SEARCH_CURRENCY;
		const guests = query.travellers ?? DEFAULT_TRAVELLERS;

		/** The last real failure seen while walking the candidate cities. Held rather than
		 * returned immediately: a `404` on a wrong same-named city is not the search
		 * failing, it is that candidate being wrong, and the next one may well answer. It
		 * only becomes the result if no candidate produces a stay — reporting Hostelworld's
		 * own words then rather than a bare empty list that hides why. */
		let lastError: ProviderError | undefined;

		/**
		 * Every candidate city's beds, merged — issue #204, and the whole point of this loop.
		 *
		 * This used to return on the first city that produced a stay. `rankCitiesNear` lists
		 * the city this app named for the airport FIRST, so for Gatwick that was London: it
		 * answered, the loop returned, and Hostelworld's own "Gatwick" city (id 3671, region
		 * Horley) was never asked at all — even though it was already second on the list.
		 * The owner found beds there himself, a thirty-minute walk from the terminal, while
		 * the app offered him one 39 km up the line and called it the cheapest. It was the
		 * cheapest of the one city it looked in.
		 *
		 * No radius fixes that: LGW to London is 39.3 km and MXP to Milan is 39.7, so any
		 * radius tight enough to drop the London bed also throws away Milan (PR #212 measured
		 * exactly this and deferred it here). The near city has to be ASKED, which means not
		 * stopping at the first answer.
		 *
		 * Merging rather than choosing is also the honest division of labour. This adapter
		 * knows which beds exist and what they cost, and nothing about how far the traveller
		 * will walk. `search/resources.ts` ranks, and since PR #212 it ranks with the transfer
		 * to each bed priced in, so a walkable Horley room can now beat a cheaper London dorm
		 * 39 km away on the number that decides it.
		 */
		const merged: Stay[] = [];
		/** The OLDEST contributing fetch, because part of a merged answer really is that old
		 * and `ProviderSource.fetchedAt` is rendered as "fetched 2 minutes ago". Understating
		 * freshness is the safe direction; calling the whole merge as new as its newest half
		 * is issue #151's lie in miniature. */
		let oldestFetchedAt: number | undefined;
		const noteFetchedAt = (at: number): void => {
			oldestFetchedAt = oldestFetchedAt === undefined ? at : Math.min(oldestFetchedAt, at);
		};

		for (const cityId of cityIds) {
			if (ctx.signal.aborted) {
				return fail({ code: 'cancelled', message: 'Hostelworld search was cancelled' }, requestsUsed);
			}

			const key = defineCacheKey(
				HOSTELWORLD_PROVIDER_ID,
				{ op: 'properties', cityId, checkIn: query.checkIn, nights, guests, currency },
				PROPERTIES_TTL_MS
			);
			const cached = await readCachedEntry<{ properties?: unknown[] }>(store, key);
			if (cached) {
				// Served at any age, never discarded for being past its hour. Three cities per
				// candidate stopover, each refetched in sequence, is what held the results page
				// blank for a traveller who reloaded a search the next morning. The age of what
				// they are shown reaches the card through `noteFetchedAt`, so a stale bed is
				// labelled rather than passed off as tonight's price.
				if (!cached.fresh) {
					requestsUsed += 1;
					void revalidateProperties(store, key, cityId, currency, query.checkIn, nights, guests, ctx);
				}
				merged.push(
					...mapPropertiesToStays(
						cached.value.properties as Parameters<typeof mapPropertiesToStays>[0],
						query.near,
						query.radiusKm,
						guests
					)
				);
				noteFetchedAt(cached.storedAt);
				continue;
			}

			const response = await fetchCityProperties(
				{
					cityId,
					currency,
					dateStart: query.checkIn,
					numNights: nights,
					guests,
					perPage: PROPERTIES_PER_PAGE
				},
				{ signal: ctx.signal, fetchImpl: options.fetchImpl }
			);
			requestsUsed += 1;
			if (!response.ok) {
				const error = toProviderError(response.error);
				// A cancelled search must stop rather than work through the remaining
				// candidates: the caller has already gone.
				if (error.code === 'cancelled') return fail(error, requestsUsed);
				lastError = error;
				continue;
			}

			// One instant for both, so this result and its own cached replay agree to the
			// millisecond about when Hostelworld answered — see `writeCache`.
			const fetchedAt = Date.now();
			await writeCache(store, key, response.data, fetchedAt);
			merged.push(
				...mapPropertiesToStays(response.data.properties, query.near, query.radiusKm, guests)
			);
			noteFetchedAt(fetchedAt);
		}

		if (merged.length > 0) {
			// Cheapest first, so a caller reading only the head still gets the cheapest bed.
			// `search/resources.ts` sorts again for itself; sorting here too makes the merge
			// order deterministic rather than dependent on which city came back first, which
			// is the difference between an assertion and a coin toss.
			merged.sort((a, b) => a.pricePerNight.minorUnits - b.pricePerNight.minorUnits);
			return ok(merged, requestsUsed, oldestFetchedAt);
		}

		if (lastError) return fail(lastError, requestsUsed);
		// Every candidate answered and none had a bed within the radius. A real, honest
		// "nothing here" — Hostelworld simply has no inventory near this airport.
		return ok([], requestsUsed);
	}

	async function healthCheck(ctx: ProviderContext): Promise<ProviderHealth> {
		if (ctx.signal.aborted) {
			return fail({ code: 'cancelled', message: 'Hostelworld health check was cancelled' }, 0);
		}

		// Deliberately bypasses the cache and asks a real question rather than pinging: the
		// failure worth catching is this undocumented endpoint starting to refuse traffic,
		// and only a real request reveals that. Europe because it is the largest of the six
		// and therefore the most likely to notice a truncated or reshaped response.
		const response = await fetchContinentCountries(EUROPE_CONTINENT_ID, {
			signal: ctx.signal,
			fetchImpl: options.fetchImpl
		});
		if (!response.ok) return fail(toProviderError(response.error), 1);

		const cities = flattenGeoCities(response.data);
		if (cities.length === 0) {
			return fail(
				{
					code: 'malformed-response',
					message: 'Hostelworld answered but listed no European cities with coordinates'
				},
				1
			);
		}
		return ok({ message: `${cities.length} European cities with coordinates` }, 1);
	}

	return {
		kind: 'stay',
		id: HOSTELWORLD_PROVIDER_ID,
		label: 'Hostelworld (no key required)',
		needsKey: false,
		keyFields: [],
		healthCheck,
		// Keyless and unmetered, so there is no budget to protect — and reporting 0 is what
		// makes `search/cost-aware.ts` classify this as a `free` source, which is what makes
		// it run for a visitor who has configured nothing. That is the entire feature.
		estimateSearchStaysCost: () => 0,
		searchStays
	};
}

export { createHostelworldStayProvider };

/** The production singleton: real global `fetch`, the shared default cache store. Import
 * this to register the adapter; use `createHostelworldStayProvider` directly only to inject
 * test doubles. */
export const hostelworldStayProvider: StayProvider = createHostelworldStayProvider();
