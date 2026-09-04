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
import type {
	FlightProvider,
	FlightSearchQuery,
	ProviderContext,
	ProviderError,
	ProviderHealth,
	ProviderResult,
	ProviderSource
} from '../types';
import { getCachedAirportEntity, setCachedAirportEntity } from './skyscanner-airport-cache';
import type { SkyscannerAirportEntity } from './skyscanner-airport-cache';
import { callSkyscanner } from './skyscanner-client';
import type { SkyscannerClientResult } from './skyscanner-client';
import { mapSearchFlightsToOffers, SkyscannerMalformedResponseError } from './skyscanner-map-offers';

const PROVIDER_ID = 'skyscanner';
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
}

/**
 * Builds one Skyscanner adapter instance. A factory rather than a bare object literal so
 * tests can inject a fake `fetchImpl` and an isolated `cacheStore`, and so the
 * "not-subscribed is permanent for the session" rule below (issue #5's brief) has
 * somewhere to live that resets between tests instead of leaking across them the way a
 * module-level singleton's state would.
 */
export function createSkyscannerFlightProvider(
	options: CreateSkyscannerFlightProviderOptions = {}
): FlightProvider {
	const { cacheStore, fetchImpl } = options;

	// Once a key has been seen answering "not subscribed," it stays marked for the life of
	// this instance: issue #5's brief calls this out explicitly as a permanent-for-the-
	// session failure, since a RapidAPI BASIC plan is per-API and retrying will not change
	// the answer (docs/PROVIDERS.md). Keyed by the API key's own value, not just a boolean,
	// so a user who pastes in a different, working key after a bad one is not blocked by
	// their previous mistake.
	const notSubscribedByApiKey = new Map<string, ProviderError & { code: 'not-subscribed' }>();

	function source(): ProviderSource {
		return { providerId: PROVIDER_ID, fetchedAt: new Date().toISOString() };
	}

	function ok<T>(data: T, requestsUsed: number): ProviderResult<T> {
		return { ok: true, data, source: source(), requestsUsed };
	}

	function fail<T>(error: ProviderError, requestsUsed: number): ProviderResult<T> {
		return { ok: false, error, source: source(), requestsUsed };
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

		const result = await callSkyscanner<unknown>(
			'/api/v1/flights/searchAirport',
			{ query: iataCode, locale: 'en-US' },
			{ apiKey, signal, fetchImpl }
		);
		const requestsSpent = costOf(result);
		if (!result.ok) return { ok: false, error: result.error, requestsSpent };

		const entity = extractExactAirportMatch(result.data, iataCode);
		if (entity === undefined) {
			return {
				ok: false,
				requestsSpent,
				error: {
					code: 'malformed-response',
					message: `Sky Scrapper's airport search for "${iataCode}" returned no exact match`
				}
			};
		}
		await setCachedAirportEntity(iataCode, entity, cacheStore);
		return { ok: true, entity, requestsSpent };
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
		const remembered = notSubscribedByApiKey.get(apiKey);
		if (remembered !== undefined) {
			return fail(remembered, 0);
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
		if (!originResolved.ok) {
			if (originResolved.error.code === 'not-subscribed') {
				notSubscribedByApiKey.set(apiKey, originResolved.error);
			}
			return fail(originResolved.error, requestsUsed);
		}
		const destinationResolved = await resolveAirportEntity(query.destination, apiKey, ctx.signal);
		requestsUsed += destinationResolved.requestsSpent;
		if (!destinationResolved.ok) {
			if (destinationResolved.error.code === 'not-subscribed') {
				notSubscribedByApiKey.set(apiKey, destinationResolved.error);
			}
			return fail(destinationResolved.error, requestsUsed);
		}

		const currency = query.currency ?? DEFAULT_CURRENCY;
		const travellers = query.travellers ?? DEFAULT_TRAVELLERS;
		const dates = enumerateDates(query.earliestDeparture, query.latestDeparture);

		const offers: FlightOffer[] = [];
		let sawMalformedDate = false;

		for (const date of dates) {
			if (requestsUsed >= budget) break; // out of budget: stop, keep whatever we have

			if (ctx.signal.aborted) {
				if (offers.length > 0) break; // keep the partial result, see the doc comment below
				return fail({ code: 'cancelled', message: 'Search was cancelled' }, requestsUsed);
			}

			const result = await callSkyscanner<unknown>(
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
			);
			requestsUsed += costOf(result);

			if (!result.ok) {
				if (result.error.code === 'not-subscribed') {
					notSubscribedByApiKey.set(apiKey, result.error);
				}
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
				offers.push(...mapSearchFlightsToOffers(result.data, { currency, travellers }));
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
		return ok(offers, requestsUsed);
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
		const remembered = notSubscribedByApiKey.get(apiKey);
		if (remembered !== undefined) return fail(remembered, 0);

		// No dedicated "ping" endpoint exists, so this spends one real request on the
		// cheapest real call available, same as any other adapter method would. Callers
		// are told (types.ts ProviderBase.healthCheck) to run this once, not per search.
		const result = await callSkyscanner<unknown>(
			'/api/v1/flights/searchAirport',
			{ query: 'london', locale: 'en-US' },
			{ apiKey, signal: ctx.signal, fetchImpl }
		);
		const requestsUsed = costOf(result);
		if (!result.ok) {
			if (result.error.code === 'not-subscribed') {
				notSubscribedByApiKey.set(apiKey, result.error);
			}
			return fail(result.error, requestsUsed);
		}
		return ok({ message: 'Sky Scrapper key is present and subscribed' }, requestsUsed);
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

/**
 * How many of Sky Scrapper's own metered requests one client call actually spent, so
 * `requestsUsed` on every `ProviderResult` this adapter returns is honest.
 *
 * `not-subscribed`, `network-error` and `cancelled` are counted as free: a 403
 * "not subscribed" is RapidAPI's gateway rejecting the call before it reaches Sky
 * Scrapper's own metering (that is the whole reason it exists as a distinct, permanent
 * failure rather than a transient one), and the other two never got a response at all.
 * Everything else, success included, got a real answer from the host and is billed.
 * This assumption about `not-subscribed` is not independently verified against RapidAPI's
 * own billing (doing so would mean deliberately unsubscribing the owner's live key), so it
 * is called out here for a future reviewer to confirm or correct.
 */
function costOf(result: SkyscannerClientResult<unknown>): number {
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
