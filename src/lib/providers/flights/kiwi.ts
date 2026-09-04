/**
 * Kiwi.com adapter — issue #51. Kiwi invented virtual interlining (combining separate
 * tickets from unaffiliated airlines into one journey), which is this app's entire
 * concept for every other aggregator's edge case, and its listing passes CORS
 * (docs/PROVIDERS.md), so the browser can call it directly with no proxy.
 *
 * THE DESIGN QUESTION, ANSWERED: could a Kiwi self-transfer itinerary feed the itinerary
 * builder directly, instead of being reassembled from two independent searches? No, not
 * through this endpoint. The request accepts `allowOvernightStopover` but no minimum
 * connection duration — the only stopover-shaping knobs this API exposes are "how many
 * stops" (`maxStopsCount`, 0/1/2) and "may a stop run overnight" (a boolean). That is Kiwi
 * optimising a self-transfer combination for the SHORTEST workable connection, stretching
 * to a single overnight only when it saves money — the opposite of what this app wants,
 * which is a connection stay of *several days* on purpose. Kiwi does have a genuine
 * multi-day trip-building product (its own site's "Nomad"/multi-city planner, with an
 * explicit day count per city), but this RapidAPI listing exposes only "Round trip" and
 * "One-way" — neither is that endpoint. So a Kiwi self-transfer itinerary here is ordinary
 * connecting-flight ground truth (two real, individually priced flights, evidence that
 * Kiwi will combine those two carriers at that airport at all), not a ready-built stopover
 * trip. This adapter therefore maps every `route` segment to its own `FlightOffer` — see
 * kiwi-mapper.ts's header for the full reasoning and what is genuinely lost by not
 * modelling the bundle itself (domain has no type for one yet).
 *
 * A caveat every other file in this adapter repeats because it matters this much: the
 * response shape this adapter maps against was never confirmed live. This RapidAPI listing
 * (`kiwi-com-cheap-flights.p.rapidapi.com`) answered 403 "not subscribed" before this
 * issue's work began, proving it exists; after a real $0 BASIC-plan subscription
 * (docs/PROVIDERS.md: 300 requests/month, 1000/hour), every call this adapter made to
 * either endpoint returned `402 {"error":{"code":"402","message":"Payment required"}}`
 * with `x-vercel-error: DEPLOYMENT_DISABLED` — the listing owner's own backend, hosted on
 * Vercel, is currently down (see kiwi-types.ts for why that's an upstream outage, not a key
 * or subscription problem). The request shape below is real (RapidAPI's own generated
 * snippet); the response shape is reconstructed from Kiwi's historical public schema and
 * MUST be re-verified against a live payload before this adapter is trusted — see the PR.
 */

import { defineCacheKey, getDefaultStore } from '../../cache';
import type { CacheKey, CacheStore } from '../../cache';
import { getAirport } from '../../data/airports';
import { DEFAULT_TRAVELLERS } from '../../domain';
import type { FlightOffer, IataAirportCode } from '../../domain';
import type {
	FlightProvider,
	FlightSearchQuery,
	ProviderContext,
	ProviderError,
	ProviderHealth,
	ProviderKeyField,
	ProviderResult,
	ProviderSource
} from '../types';
import { fetchOneWay } from './kiwi-client';
import { collectIataCodes, mapResponseToDirectDestinations, mapResponseToFlightOffers } from './kiwi-mapper';
import type { KiwiFetchError, KiwiFetchResult, KiwiOneWayResponse } from './kiwi-types';

export const KIWI_PROVIDER_ID = 'kiwi';

/** docs/PROVIDERS.md: 300 requests/month, hard limit, measured 2026-09-04 straight off the
 * pricing page after subscribing. Every `searchOffers`/`listDirectDestinations` call below
 * spends exactly one of these — unlike Ryanair, Kiwi has real quota to protect. */
export const KIWI_FREE_TIER_MONTHLY_REQUEST_LIMIT = 300;

const KEY_FIELDS: readonly ProviderKeyField[] = [
	{
		id: 'apiKey',
		label: 'RapidAPI key',
		placeholder: 'Paste your RapidAPI key',
		helpUrl: 'https://rapidapi.com/emir12/api/kiwi-com-cheap-flights/pricing'
	}
];

/** A live search result is only ever as fresh as the fare it quotes; 15 minutes matches
 * the freshness window this app already uses for other live-search adapters and is
 * shorter than Ryanair's 5-minute fare TTL only because Ryanair's is ground-truth airline
 * pricing and this is an aggregator's copy of it. Unverified against this listing's actual
 * `Cache-Control` header, since no live response was ever received to read one off. */
const SEARCH_TTL_MS = 15 * 60_000;
/** Route existence doesn't change intraday, and every call here costs real quota, so this
 * is deliberately generous — same reasoning as Ryanair's ROUTES_TTL_MS. */
const DESTINATIONS_TTL_MS = 24 * 60 * 60_000;
/** How far ahead `listDirectDestinations` searches when it has no caller-given date range
 * — wide enough to surface seasonal routes, narrow enough to stay inside whatever window
 * limit the live endpoint enforces (unknown while it stays down; adjust once verified). */
const DESTINATIONS_WINDOW_DAYS = 90;

const DEFAULT_HANDBAGS = 1;
const DEFAULT_HOLDBAGS = 0;
const DEFAULT_SEARCH_LIMIT = 20;

export interface KiwiProviderOptions {
	/** Overrides the shared IndexedDB-or-memory store. Tests inject a `MemoryCacheStore`
	 * so nothing here touches a real browser API. */
	store?: CacheStore;
	/** Overrides the global `fetch`. Tests inject a stub that resolves fixtures. */
	fetchImpl?: typeof fetch;
}

function source(): ProviderSource {
	return { providerId: KIWI_PROVIDER_ID, fetchedAt: new Date().toISOString() };
}

function toProviderError(error: KiwiFetchError): ProviderError {
	switch (error.code) {
		case 'missing-key':
			return { code: 'missing-key', message: error.message };
		case 'cancelled':
			return { code: 'cancelled', message: error.message };
		case 'network-error':
			return { code: 'network-error', message: error.message, cause: error.cause };
		case 'malformed-response':
			return { code: 'malformed-response', message: error.message, cause: error.cause };
		case 'not-subscribed':
			return { code: 'not-subscribed', message: error.message, status: 403 };
		case 'rate-limited':
			return {
				code: 'quota-exceeded',
				message: error.message,
				status: 429,
				retryAfterSeconds: error.retryAfterSeconds
			};
		case 'http-error':
			// Covers the live 402/DEPLOYMENT_DISABLED this adapter actually observed, and
			// any other status this adapter hasn't seen — `unknown` is the documented
			// catch-all for exactly that (types.ts), not a mis-mapping.
			return { code: 'unknown', message: error.message, cause: { status: error.status } };
	}
}

/**
 * How many of Kiwi's own metered requests one client call actually spent, matching
 * skyscanner.ts's `costOf` — the more recently merged sibling adapter, also a metered
 * RapidAPI listing. `not-subscribed`, `network-error` and `cancelled` are free: a 403 is
 * RapidAPI's own gateway rejecting the call before it reaches this listing's backend at
 * all (that is the whole reason it is a distinct, permanent failure rather than a
 * transient one — docs/PROVIDERS.md), and the other two never got a response. This
 * adapter's own live 402/DEPLOYMENT_DISABLED test came back WITH a genuine
 * `x-rapidapi-request-id`, unlike what a gateway-level rejection would look like, which is
 * independent evidence for treating it (and every other unrecognised status) as billed,
 * same as a genuine success.
 */
function costOf(result: KiwiFetchResult<unknown>): number {
	if (result.ok) return 1;
	switch (result.error.code) {
		case 'not-subscribed':
		case 'network-error':
		case 'cancelled':
			return 0;
		default:
			return 1;
	}
}

async function resolveStore(options: KiwiProviderOptions): Promise<CacheStore> {
	return options.store ?? (await getDefaultStore());
}

async function readCache<T>(store: CacheStore, key: CacheKey): Promise<T | undefined> {
	const entry = await store.get(key.raw);
	if (entry === undefined) return undefined;
	if (Date.now() - entry.storedAt >= entry.ttlMs) return undefined;
	return entry.value as T;
}

// Mirrors ryanair.ts's own copy of this, which mirrors cache/size.ts's internal
// `estimateByteSize` — see that file's comment for why every `CacheStore.set` caller
// carries a small copy rather than importing an internal detail of the store modules.
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
		providerId: KIWI_PROVIDER_ID,
		value,
		storedAt: now,
		ttlMs: key.ttlMs,
		lastAccessedAt: now,
		sizeBytes: estimateSizeBytes(value)
	});
}

/** Resolves each IATA code appearing in a response to its ISO country code via this app's
 * own airport dataset (src/lib/data/airports.ts — already loaded application-wide, no
 * network) — what kiwi-timezone.ts's `resolveTimeZone` needs, and the reason
 * kiwi-mapper.ts stays I/O-free while still getting real country data instead of guessing
 * one. A code this dataset has no entry for is simply absent from the result, which
 * kiwi-timezone.ts already treats as "fall back to a fixed-offset zone," not as an error. */
async function resolveCountryCodes(iataCodes: readonly IataAirportCode[]): Promise<Record<string, string>> {
	const resolved = await Promise.all(
		iataCodes.map(async (code): Promise<readonly [string, string] | undefined> => {
			const airport = await getAirport(code);
			return airport ? ([code, airport.country.isoCode] as const) : undefined;
		})
	);
	const map: Record<string, string> = {};
	for (const entry of resolved) {
		if (entry) map[entry[0]] = entry[1];
	}
	return map;
}

function toDateTimeStart(isoCalendarDate: string): string {
	return `${isoCalendarDate}T00:00:00`;
}

function toDateTimeEnd(isoCalendarDate: string): string {
	return `${isoCalendarDate}T23:59:59`;
}

function createKiwiFlightProvider(options: KiwiProviderOptions = {}): FlightProvider {
	// Once a key has been seen answering "not subscribed," it stays marked for the life of
	// this instance — matching skyscanner.ts: a RapidAPI BASIC plan is per-API, so retrying
	// will not change the answer (docs/PROVIDERS.md). Keyed by the API key's own value, not
	// a boolean, so a user who pastes in a different, working key after a bad one isn't
	// blocked by their previous mistake.
	const notSubscribedByApiKey = new Map<string, ProviderError & { code: 'not-subscribed' }>();

	function rememberIfNotSubscribed(apiKey: string, error: ProviderError): void {
		if (error.code === 'not-subscribed') notSubscribedByApiKey.set(apiKey, error);
	}

	async function searchOffers(
		query: FlightSearchQuery,
		ctx: ProviderContext
	): Promise<ProviderResult<FlightOffer[]>> {
		if (ctx.signal.aborted) {
			return {
				ok: false,
				error: { code: 'cancelled', message: 'Kiwi search was cancelled before it started' },
				source: source(),
				requestsUsed: 0
			};
		}

		const apiKey = ctx.keys?.apiKey;
		if (!apiKey) {
			return {
				ok: false,
				error: { code: 'missing-key', message: 'No RapidAPI key configured for Kiwi.com Cheap Flights' },
				source: source(),
				requestsUsed: 0
			};
		}
		const remembered = notSubscribedByApiKey.get(apiKey);
		if (remembered !== undefined) {
			return { ok: false, error: remembered, source: source(), requestsUsed: 0 };
		}

		const store = await resolveStore(options);
		const cacheKey = defineCacheKey(KIWI_PROVIDER_ID, { op: 'searchOffers', ...query }, SEARCH_TTL_MS);

		const cached = await readCache<FlightOffer[]>(store, cacheKey);
		if (cached) {
			return { ok: true, data: cached, source: source(), requestsUsed: 0 };
		}

		if (ctx.maxRequests !== undefined && ctx.maxRequests < 1) {
			// Out of budget before spending anything: an empty ok result, not an error —
			// ProviderContext.maxRequests documents this as a partial result.
			return { ok: true, data: [], source: source(), requestsUsed: 0 };
		}

		const currency = (query.currency ?? 'eur').toLowerCase();
		const handbags = DEFAULT_HANDBAGS;
		const holdbags = DEFAULT_HOLDBAGS;

		const response = await fetchOneWay(
			{
				source: query.origin,
				destination: query.destination,
				outboundDepartmentDateStart: toDateTimeStart(query.earliestDeparture),
				outboundDepartmentDateEnd: toDateTimeEnd(query.latestDeparture),
				currency,
				adults: query.travellers ?? DEFAULT_TRAVELLERS,
				handbags,
				holdbags,
				enableSelfTransfer: true,
				allowOvernightStopover: true,
				limit: DEFAULT_SEARCH_LIMIT
			},
			{ signal: ctx.signal, apiKey, fetchImpl: options.fetchImpl }
		);

		if (!response.ok) {
			const error = toProviderError(response.error);
			rememberIfNotSubscribed(apiKey, error);
			return { ok: false, error, source: source(), requestsUsed: costOf(response) };
		}

		const countryCodeByIataCode = await resolveCountryCodes(collectIataCodes(response.data));
		const offers = mapResponseToFlightOffers(response.data, { handbags, holdbags }, countryCodeByIataCode);
		await writeCache(store, cacheKey, offers);

		return { ok: true, data: offers, source: source(), requestsUsed: costOf(response) };
	}

	async function listDirectDestinations(
		origin: IataAirportCode,
		ctx: ProviderContext
	): Promise<ProviderResult<IataAirportCode[]>> {
		if (ctx.signal.aborted) {
			return {
				ok: false,
				error: { code: 'cancelled', message: 'Kiwi route lookup was cancelled before it started' },
				source: source(),
				requestsUsed: 0
			};
		}

		const apiKey = ctx.keys?.apiKey;
		if (!apiKey) {
			return {
				ok: false,
				error: { code: 'missing-key', message: 'No RapidAPI key configured for Kiwi.com Cheap Flights' },
				source: source(),
				requestsUsed: 0
			};
		}
		const remembered = notSubscribedByApiKey.get(apiKey);
		if (remembered !== undefined) {
			return { ok: false, error: remembered, source: source(), requestsUsed: 0 };
		}

		const store = await resolveStore(options);
		const cacheKey = defineCacheKey(KIWI_PROVIDER_ID, { op: 'listDirectDestinations', origin }, DESTINATIONS_TTL_MS);

		const cached = await readCache<IataAirportCode[]>(store, cacheKey);
		if (cached) {
			return { ok: true, data: cached, source: source(), requestsUsed: 0 };
		}

		if (ctx.maxRequests !== undefined && ctx.maxRequests < 1) {
			return { ok: true, data: [], source: source(), requestsUsed: 0 };
		}

		const now = new Date();
		const windowEnd = new Date(now.getTime() + DESTINATIONS_WINDOW_DAYS * 24 * 60 * 60_000);
		const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

		const response = await fetchOneWay(
			{
				source: origin,
				// Omitted on purpose: this is Kiwi's "everywhere from this airport" search
				// (the endpoint's own docs mark `destination` optional) — see kiwi-types.ts
				// for why bare IATA codes and an absent `destination` are both accepted at
				// the request-validation stage, the only evidence available while the
				// backend stays down.
				outboundDepartmentDateStart: toDateTimeStart(isoDate(now)),
				outboundDepartmentDateEnd: toDateTimeEnd(isoDate(windowEnd)),
				currency: 'eur',
				adults: DEFAULT_TRAVELLERS,
				handbags: DEFAULT_HANDBAGS,
				holdbags: DEFAULT_HOLDBAGS,
				enableSelfTransfer: true,
				allowOvernightStopover: true,
				// Direct destinations only — nonstop itineraries, matching what
				// `listDirectDestinations` promises (types.ts: "a direct flight," not a
				// connection). mapResponseToDirectDestinations filters on route.length
				// too, so a response that ignores this param still comes out correct.
				maxStopsCount: 0,
				limit: 50
			},
			{ signal: ctx.signal, apiKey, fetchImpl: options.fetchImpl }
		);

		if (!response.ok) {
			const error = toProviderError(response.error);
			rememberIfNotSubscribed(apiKey, error);
			return { ok: false, error, source: source(), requestsUsed: costOf(response) };
		}

		const destinations = mapResponseToDirectDestinations(response.data);
		await writeCache(store, cacheKey, destinations);
		return { ok: true, data: destinations, source: source(), requestsUsed: costOf(response) };
	}

	async function healthCheck(ctx: ProviderContext): Promise<ProviderHealth> {
		if (ctx.signal.aborted) {
			return {
				ok: false,
				error: { code: 'cancelled', message: 'Kiwi health check was cancelled' },
				source: source(),
				requestsUsed: 0
			};
		}

		const apiKey = ctx.keys?.apiKey;
		if (!apiKey) {
			return {
				ok: false,
				error: { code: 'missing-key', message: 'No RapidAPI key configured for Kiwi.com Cheap Flights' },
				source: source(),
				requestsUsed: 0
			};
		}
		const remembered = notSubscribedByApiKey.get(apiKey);
		if (remembered !== undefined) {
			return { ok: false, error: remembered, source: source(), requestsUsed: 0 };
		}

		// Health here means "the key is accepted and the endpoint responds with the shape
		// this adapter expects" — NOT "flights exist for this pair today." A well-shaped
		// empty result is still healthy; only an error result (types.ts's warning that
		// this can itself spend real quota is exactly why callers must cache this rather
		// than run it before every search) means the adapter can't be used right now.
		const now = new Date();
		const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
		const windowEnd = new Date(now.getTime() + 7 * 24 * 60 * 60_000);

		const response = await fetchOneWay(
			{
				source: 'LHR',
				destination: 'CDG',
				outboundDepartmentDateStart: toDateTimeStart(isoDate(now)),
				outboundDepartmentDateEnd: toDateTimeEnd(isoDate(windowEnd)),
				currency: 'eur',
				adults: 1,
				handbags: DEFAULT_HANDBAGS,
				holdbags: DEFAULT_HOLDBAGS,
				enableSelfTransfer: true,
				allowOvernightStopover: true,
				limit: 1
			},
			{ signal: ctx.signal, apiKey, fetchImpl: options.fetchImpl }
		);

		if (!response.ok) {
			const error = toProviderError(response.error);
			rememberIfNotSubscribed(apiKey, error);
			return { ok: false, error, source: source(), requestsUsed: costOf(response) };
		}
		return {
			ok: true,
			data: { message: `Kiwi responded with ${response.data.data.length} itinerary(ies) for a test query` },
			source: source(),
			requestsUsed: costOf(response)
		};
	}

	return {
		kind: 'flight',
		id: KIWI_PROVIDER_ID,
		label: 'Kiwi.com (RapidAPI)',
		needsKey: true,
		keyFields: KEY_FIELDS,
		healthCheck,
		// A native date-range endpoint, same reasoning as Ryanair's fare finder: one
		// logical search costs exactly one of this adapter's own requests, regardless of
		// how wide the date range is.
		estimateSearchOffersCost: () => 1,
		searchOffers,
		listDirectDestinations
	};
}

export { createKiwiFlightProvider };

/** The production singleton: real global `fetch`, the shared default cache store. Import
 * this to register the adapter; use `createKiwiFlightProvider` directly only to inject
 * test doubles. */
export const kiwiFlightProvider: FlightProvider = createKiwiFlightProvider();

// Re-exported for tests and for a future crosscheck/investigation script that wants to
// reason about a raw response without importing kiwi-mapper.ts's internals directly.
export type { KiwiOneWayResponse };
