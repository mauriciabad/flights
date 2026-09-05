/**
 * Skyscanner flight adapter, via RapidAPI's Sky Scrapper (`sky-scrapper.p.rapidapi.com`).
 * Issue #5: docs/prompts/002-setup-answers.md quotes the owner calling Skyscanner
 * non-negotiable ("in my experience skyscanner has always the cheapest price"), and
 * docs/PROVIDERS.md measured this exact host's CORS headers, its 403 shape, and its free
 * tier: 20 requests a month, hard limit, shared with every other feature that touches it.
 *
 * Everything in this file assumes the real response shapes captured for issue #5
 * (fixtures/search-airport-bcn.json, fixtures/search-airport-vie.json,
 * fixtures/search-flights-bcn-vie.json), not the API's own documentation, which does not
 * exist in a form worth trusting (see the PR description for what was verified and what
 * was not, within a five-request budget).
 */

import type {
	FlightOffer,
	IataAirportCode,
	IsoCalendarDate,
	IsoCurrencyCode
} from '../../domain';
import { DEFAULT_TRAVELLERS } from '../../domain';
import type { CacheStore } from '../../cache';
import { callProviderWithBudget } from '../budget';
import { classifyClientResultError, unwrapOrThrow } from '../client-result-budget';
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
import { getCachedAirportEntity, setCachedAirportEntity } from './skyscanner-airport-cache';
import type { SkyscannerAirportEntity } from './skyscanner-airport-cache';
import { callSkyscanner } from './skyscanner-client';
import { mapSearchFlightsToOffers, SkyscannerMalformedResponseError } from './skyscanner-map-offers';
import { resolveAirportTimeZone } from './airport-timezone';

/** Also the id `../budget/caps.ts`'s `DEFAULT_PROVIDER_CAPS` is keyed by — enforced at
 * compile time by `ProviderId` (../types.ts, issue #69), not by convention. */
const PROVIDER_ID: ProviderId = 'skyscanner';
const DEFAULT_CURRENCY: IsoCurrencyCode = 'EUR';
/** Used when `ctx.maxRequests` is not given, so a caller that forgets to set a budget
 * cannot accidentally drain a whole month's quota (20) in one `searchOffers` call spanning
 * a wide date range. `ProviderContext.maxRequests`'s own doc: an adapter must have its own
 * default when the caller does not impose one. */
const DEFAULT_MAX_REQUESTS_PER_CALL = 3;

export interface CreateSkyscannerFlightProviderOptions {
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
 * Builds one Skyscanner adapter instance. A factory rather than a bare object literal so
 * tests can inject a fake `fetchImpl` and an isolated `cacheStore`.
 *
 * Issue #69: every real request here routes through `callProviderWithBudget` (../budget),
 * which now owns the monthly hard quota stop, in-flight dedup, and the "not-subscribed is
 * permanent for the session" rule issue #5's brief originally asked this file to hand-roll
 * (a per-instance `Map` keyed by API key). That per-key nuance is gone: the shared budget
 * module tracks "not subscribed" per `ProviderId`, not per key, the same as every other
 * adapter wired to it — one consistent rule across adapters beats a bespoke one here,
 * which is the whole point of connecting to the module rather than keeping a parallel one.
 */
export function createSkyscannerFlightProvider(
	options: CreateSkyscannerFlightProviderOptions = {}
): FlightProvider {
	const { cacheStore, fetchImpl, cap, sleep, now } = options;
	/** The same clock `callProviderWithBudget` stamps its own `ProviderSource` with
	 * (../budget/call-with-budget.ts), so a test that injects one gets a deterministic
	 * `fetchedAt` here too instead of whatever the wall clock said mid-run. */
	const clock = now ?? Date.now;

	/**
	 * `fetchedAtMs` is the epoch millis Sky Scrapper actually answered. Omitted means "just
	 * now", which is what every path but `searchOffers` wants, since nothing else here
	 * returns anything it did not fetch on this call.
	 *
	 * `ProviderSource.fetchedAt` is documented as "the instant the adapter finished fetching
	 * this, NOT when a caller later reads it out of a cache" (issue #151), and ResultCard
	 * renders it as "via Skyscanner · fetched 2 minutes ago".
	 */
	function source(fetchedAtMs?: number): ProviderSource {
		return { providerId: PROVIDER_ID, fetchedAt: new Date(fetchedAtMs ?? clock()).toISOString() };
	}

	function ok<T>(data: T, requestsUsed: number, fetchedAtMs?: number): ProviderResult<T> {
		return { ok: true, data, source: source(fetchedAtMs), requestsUsed };
	}

	function fail<T>(error: ProviderError, requestsUsed: number): ProviderResult<T> {
		return { ok: false, error, source: source(), requestsUsed };
	}

	function budgetCall<T>(dedupeKey: string, execute: () => Promise<T>): Promise<ProviderResult<T>> {
		return callProviderWithBudget({
			providerId: PROVIDER_ID,
			dedupeKey,
			execute,
			classifyError: classifyClientResultError,
			cap,
			sleep,
			now
		});
	}

	/** Threads this adapter's own `fetchImpl`/`cacheStore` test overrides into the geocode
	 * module's timezone lookup, so a test that injects an isolated `cacheStore` here (every
	 * test in skyscanner.test.ts does) gets that same isolation for timezone lookups rather
	 * than silently falling through to the real default IndexedDB-or-memory store. In
	 * production both `cacheStore` and `fetchImpl` are undefined here, and geocode/transitous.ts
	 * already defaults to the same `getDefaultStore()`/global `fetch` this adapter's own
	 * airport-entity cache uses when left unset. */
	function geocodeOptions(): GeocodeProviderOptions {
		return {
			fetchImpl,
			resolveStore: cacheStore ? async () => cacheStore : undefined
		};
	}

	async function resolveAirportEntity(
		iataCode: IataAirportCode,
		apiKey: string,
		signal: AbortSignal
	): Promise<
		{ ok: true; entity: SkyscannerAirportEntity; requestsSpent: number }
		| { ok: false; error: ProviderError; requestsSpent: number }
	> {
		const cached = await getCachedAirportEntity(iataCode, cacheStore);
		if (cached !== undefined) return { ok: true, entity: cached, requestsSpent: 0 };

		const result = await budgetCall(`${PROVIDER_ID}:searchAirport:${iataCode.toUpperCase()}`, () =>
			unwrapOrThrow(
				callSkyscanner<unknown>(
					'/api/v1/flights/searchAirport',
					{ query: iataCode, locale: 'en-US' },
					{ apiKey, signal, fetchImpl }
				),
				identityProviderError
			)
		);
		if (!result.ok) return { ok: false, error: result.error, requestsSpent: result.requestsUsed };

		const entity = extractExactAirportMatch(result.data, iataCode);
		if (entity === undefined) {
			return {
				ok: false,
				requestsSpent: result.requestsUsed,
				error: {
					code: 'malformed-response',
					message: `Sky Scrapper's airport search for "${iataCode}" returned no exact match`
				}
			};
		}
		await setCachedAirportEntity(iataCode, entity, cacheStore);
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
			return fail({ code: 'missing-key', message: 'No Sky Scrapper (RapidAPI) key configured' }, 0);
		}

		const budget = ctx.maxRequests ?? DEFAULT_MAX_REQUESTS_PER_CALL;
		let requestsUsed = 0;

		// Resolving both airports is not gated by `budget`: on a cold cache it costs at
		// most 2 requests, those requests are the ones this adapter caches hardest against
		// ever repeating (skyscanner-airport-cache.ts), and skipping the search entirely
		// because the budget could not afford both a lookup and a fare search would waste
		// the lookup's long-lived value for every future call on the same route.
		const originResolved = await resolveAirportEntity(query.origin, apiKey, ctx.signal);
		requestsUsed += originResolved.requestsSpent;
		if (!originResolved.ok) return fail(originResolved.error, requestsUsed);

		const destinationResolved = await resolveAirportEntity(query.destination, apiKey, ctx.signal);
		requestsUsed += destinationResolved.requestsSpent;
		if (!destinationResolved.ok) return fail(destinationResolved.error, requestsUsed);

		const currency = query.currency ?? DEFAULT_CURRENCY;
		const travellers = query.travellers ?? DEFAULT_TRAVELLERS;
		const dates = enumerateDates(query.earliestDeparture, query.latestDeparture);

		// A one-way searchFlights response only ever contains itineraries for the queried
		// origin and destination (confirmed against the real fixture: every leg's
		// origin.id/destination.id equals the queried route), so both zones are resolved
		// once here rather than per itinerary or per date. Neither lookup spends any of
		// this adapter's own `requestsUsed` budget above: Transitous is a separate, keyless
		// provider with its own long-lived cache (geocode/transitous.ts), not part of
		// Skyscanner's metered RapidAPI quota. A code that resolves to `undefined` here
		// (seed miss and a failed or empty live lookup — airport-timezone.ts's own
		// comment on `resolveAirportTimeZone` has a real example, DXB) makes every
		// itinerary touching that airport get dropped below rather than mistimed.
		const geocode = geocodeOptions();
		const [originTimeZone, destinationTimeZone] = await Promise.all([
			resolveAirportTimeZone(query.origin, ctx, geocode),
			resolveAirportTimeZone(query.destination, ctx, geocode)
		]);
		const timeZones = new Map<string, string>();
		if (originTimeZone !== undefined) timeZones.set(query.origin.toUpperCase(), originTimeZone);
		if (destinationTimeZone !== undefined) {
			timeZones.set(query.destination.toUpperCase(), destinationTimeZone);
		}

		const offers: FlightOffer[] = [];
		let sawMalformedDate = false;
		// Issue #370: airports that were the one thing standing between a real, nonstop,
		// priced Skyscanner itinerary and a `FlightOffer`. Tracked across every date in this
		// call, so `offers.length === 0` at the end can be told apart from "this route
		// genuinely has nothing" — the distinction #130/#144's provider-answer states carry
		// to the screen, and the one this adapter was the last of three still losing.
		const unresolvedTimeZoneAirports = new Set<string>();
		/**
		 * When the first fare response of this call landed, and the age this result is
		 * stamped with. One date per request means a range is answered over as many round
		 * trips as it has days, so the first day's prices are already older than the last
		 * day's by the time they are merged into one array under one `ProviderSource`. The
		 * oldest contributing part is the only claim true of all of it, which is the rule
		 * results/types.ts applies when it ages an itinerary. The loop is strictly
		 * sequential, so the first response recorded is the oldest.
		 *
		 * The cached airport entity deliberately does NOT count, even though issue #151
		 * lists that cache read. `skyId`/`entityId` is a lookup key that gets a fare search
		 * to the right route, never part of the answer, and it is cached for six months. If
		 * it contributed, every freshly fetched price would be dated half a year old, and
		 * results/types.ts would drop whole itineraries into `expired-fallback` over an
		 * airport code that has not changed since the airport was built.
		 */
		let oldestResponseAt: number | undefined;

		for (const date of dates) {
			if (requestsUsed >= budget) break; // out of budget: stop, keep whatever we have

			if (ctx.signal.aborted) {
				if (offers.length > 0) break; // keep the partial result, see the doc comment below
				return fail({ code: 'cancelled', message: 'Search was cancelled' }, requestsUsed);
			}

			const result = await budgetCall(
				`${PROVIDER_ID}:searchFlights:${originResolved.entity.skyId}:${destinationResolved.entity.skyId}:${date}:${currency}:${travellers}`,
				() =>
					unwrapOrThrow(
						callSkyscanner<unknown>(
							'/api/v1/flights/searchFlights',
							{
								originSkyId: originResolved.entity.skyId,
								destinationSkyId: destinationResolved.entity.skyId,
								originEntityId: originResolved.entity.entityId,
								destinationEntityId: destinationResolved.entity.entityId,
								date,
								adults: String(travellers),
								cabinClass: 'economy',
								currency,
								market: 'en-US',
								countryCode: 'US'
							},
							{ apiKey, signal: ctx.signal, fetchImpl }
						),
						identityProviderError
					)
			);
			requestsUsed += result.requestsUsed;

			if (!result.ok) {
				if (result.error.code === 'malformed-response') {
					// One day's response failing to parse does not mean the whole range
					// should: the other days may well be fine. Keep going, and only
					// surface this as the final error if nothing at all came back.
					sawMalformedDate = true;
					continue;
				}
				// not-subscribed, quota-exceeded, network-error, cancelled, unknown: every
				// one of these will fail identically for the remaining dates in this loop
				// (same key, same host, same outage), so looping further would only spend
				// more of the budget on a guaranteed repeat. Stop, but prefer real offers
				// already in hand over surfacing the error, the same "partial result, not
				// a failure" rule `ctx.maxRequests` runs on.
				if (offers.length > 0) break;
				return fail(result.error, requestsUsed);
			}

			try {
				const mapped = mapSearchFlightsToOffers(result.data, { currency, travellers, timeZones });
				offers.push(...mapped.offers);
				oldestResponseAt ??= clock();
				for (const code of mapped.unresolvedTimeZoneAirports) unresolvedTimeZoneAirports.add(code);
			} catch (cause) {
				if (cause instanceof SkyscannerMalformedResponseError) {
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
					message: 'Sky Scrapper responses for every requested date had an unrecognised shape'
				},
				requestsUsed
			);
		}
		// Issue #370, the third and last adapter to get this. Skyscanner sold a nonstop on a
		// day in this window, named the carrier and priced it, and this app could not say when
		// it lands. An empty ok result reaches the connections map as "Nothing flies here",
		// which is a false sentence about a real flight, so name the airports that blocked it.
		if (offers.length === 0 && unresolvedTimeZoneAirports.size > 0) {
			const airports = [...unresolvedTimeZoneAirports].sort();
			return fail(
				{
					// `no-time-zone`, not `malformed-response`: Skyscanner's answer parsed fine
					// and this app's zone table did not. AGENTS.md, "show the error you got,
					// never the one you assumed" — these are the codes that actually blocked
					// mapping, not a guess at the cause.
					code: 'no-time-zone',
					message: `Sky Scrapper returned a real, nonstop itinerary this app could not price: no known time zone for ${airports.join(', ')}`,
					airports
				},
				requestsUsed
			);
		}
		return ok(offers, requestsUsed, oldestResponseAt);
	}

	async function listDirectDestinations(): Promise<ProviderResult<IataAirportCode[]>> {
		// Verified for issue #5, within its five-request budget: v1's searchFlightEverywhere
		// answers `{"status":false,"message":"Deprecated version."}`, and the v2 replacement
		// (same params) returns country-level results (`skyCode` values like "IT", "UK",
		// "PT") with a `directFlightsAvailable` flag, never a per-airport IATA code. Turning
		// that into an actual destination list would need a further drill-down call per
		// country this adapter cannot afford as a routine part of every connection-graph
		// query. Reporting failure here rather than guessing lets the search pipeline (issue
		// #12/#22) fall back to a provider that does answer this, such as Ryanair's own
		// published route graph (docs/PROVIDERS.md).
		return fail(
			{
				code: 'unknown',
				message:
					'Sky Scrapper has no working airport-level destinations endpoint: v1 is deprecated ' +
					'and v2 returns country-level results only'
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
			return fail({ code: 'missing-key', message: 'No Sky Scrapper (RapidAPI) key configured' }, 0);
		}

		// No dedicated "ping" endpoint exists, so this spends one real request on the
		// cheapest real call available, same as any other adapter method would. Callers
		// are told (types.ts ProviderBase.healthCheck) to run this once, not per search.
		const result = await budgetCall(`${PROVIDER_ID}:healthCheck`, () =>
			unwrapOrThrow(
				callSkyscanner<unknown>(
					'/api/v1/flights/searchAirport',
					{ query: 'london', locale: 'en-US' },
					{ apiKey, signal: ctx.signal, fetchImpl }
				),
				identityProviderError
			)
		);
		if (!result.ok) return fail(result.error, result.requestsUsed);
		return ok({ message: 'Sky Scrapper key is present and subscribed' }, result.requestsUsed);
	}

	return {
		kind: 'flight',
		id: PROVIDER_ID,
		label: 'Skyscanner (RapidAPI)',
		needsKey: true,
		keyFields: [
			{
				id: 'apiKey',
				label: 'RapidAPI key',
				placeholder: 'Paste your RapidAPI key',
				helpUrl: 'https://rapidapi.com/apiheya/api/sky-scrapper'
			}
		],
		healthCheck,
		estimateSearchOffersCost(query: FlightSearchQuery): number {
			// Sky Scrapper's searchFlights takes exactly one date per call (confirmed for
			// issue #5), never a range, so a caller's date span costs one request per day
			// in it. This is the number types.ts's own doc gives as the worked example for
			// exactly this kind of adapter, and it does not add the (at most 2) airport
			// lookup requests on top, since those are usually already cached and this
			// estimate is a pre-flight budget check, not an exact prediction.
			return enumerateDates(query.earliestDeparture, query.latestDeparture).length;
		},
		searchOffers,
		listDirectDestinations
	};
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

/** `unwrapOrThrow`'s `toProviderError` for this adapter: `callSkyscanner` already resolves
 * a real `ProviderError` on failure (../client-result-budget.ts), so there is nothing to
 * translate. */
function identityProviderError(error: ProviderError): ProviderError {
	return error;
}

function extractExactAirportMatch(raw: unknown, iataCode: string): SkyscannerAirportEntity | undefined {
	if (!isRecord(raw) || !Array.isArray(raw.data)) return undefined;
	for (const item of raw.data) {
		if (!isRecord(item) || !isRecord(item.navigation)) continue;
		if (item.navigation.entityType !== 'AIRPORT') continue;
		const params = item.navigation.relevantFlightParams;
		if (!isRecord(params)) continue;
		const { skyId, entityId } = params;
		if (
			typeof skyId === 'string' &&
			skyId.toUpperCase() === iataCode.toUpperCase() &&
			typeof entityId === 'string'
		) {
			return { skyId, entityId };
		}
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object';
}
