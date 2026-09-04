/**
 * The only file in this adapter that touches the network. Every function here resolves a
 * `RyanairFetchResult`, never throws and never rejects except through a genuine bug — the
 * same "never fail the caller" contract `ProviderResult` asks of the adapter as a whole
 * (src/lib/providers/types.ts), kept one layer down so ryanair.ts never needs a try/catch
 * around a fetch call.
 */

import type {
	RyanairActiveAirportsResponse,
	RyanairFetchResult,
	RyanairOneWayFaresResponse
} from './ryanair-types';

const FARE_FINDER_URL = 'https://services-api.ryanair.com/farfnd/v4/oneWayFares';
const ACTIVE_AIRPORTS_URL = 'https://www.ryanair.com/api/views/locate/3/airports/en/active';

export interface RyanairHttpDeps {
	signal: AbortSignal;
	/** Overrides the global `fetch`. Tests inject a stub that resolves fixtures, so the
	 * whole adapter is exercised with zero real network traffic. */
	fetchImpl?: typeof fetch;
}

async function getJson<T>(
	url: string,
	deps: RyanairHttpDeps,
	isShapeValid: (value: unknown) => value is T
): Promise<RyanairFetchResult<T>> {
	const doFetch = deps.fetchImpl ?? fetch;
	let response: Response;
	try {
		response = await doFetch(url, { signal: deps.signal });
	} catch (cause) {
		// AbortController rejects the fetch itself, so cancellation surfaces here as a
		// thrown error rather than a resolved-but-unsuccessful response — checking
		// `signal.aborted` after the fact is how ryanair-client tells "the user cancelled"
		// apart from "the network genuinely failed," which need different UI treatment
		// (ProviderError's `cancelled` vs `network-error`).
		if (deps.signal.aborted) {
			return { ok: false, error: { code: 'cancelled', message: 'Ryanair request was aborted' } };
		}
		return {
			ok: false,
			error: {
				code: 'network-error',
				message: cause instanceof Error ? cause.message : 'Ryanair request failed',
				cause
			}
		};
	}

	if (!response.ok) {
		if (response.status === 429) {
			const retryAfterHeader = response.headers.get('retry-after');
			const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
			return {
				ok: false,
				error: {
					code: 'rate-limited',
					message: 'Ryanair rate-limited this request (HTTP 429)',
					status: 429,
					retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined
				}
			};
		}
		return {
			ok: false,
			error: { code: 'http-error', message: `Ryanair returned HTTP ${response.status}`, status: response.status }
		};
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch (cause) {
		return {
			ok: false,
			error: { code: 'malformed-response', message: 'Ryanair response was not valid JSON', cause }
		};
	}

	if (!isShapeValid(body)) {
		return {
			ok: false,
			error: {
				code: 'malformed-response',
				message: `Ryanair response for ${url} did not match the shape this adapter expects`
			}
		};
	}

	return { ok: true, data: body };
}

function isOneWayFaresResponse(value: unknown): value is RyanairOneWayFaresResponse {
	return (
		typeof value === 'object' &&
		value !== null &&
		Array.isArray((value as { fares?: unknown }).fares)
	);
}

function isActiveAirportsResponse(value: unknown): value is RyanairActiveAirportsResponse {
	return Array.isArray(value);
}

export interface OneWayFaresParams {
	departureAirportIataCode: string;
	/** Omitted, the fare finder returns the single cheapest fare per reachable
	 * destination within the date range. Given, it narrows to that one route (still just
	 * its cheapest fare in range, not one row per day — see ryanair.ts's header comment
	 * for why that shapes how this adapter models `searchOffers`). */
	arrivalAirportIataCode?: string;
	outboundDepartureDateFrom: string;
	outboundDepartureDateTo: string;
	currency?: string;
}

export function fetchOneWayFares(
	params: OneWayFaresParams,
	deps: RyanairHttpDeps
): Promise<RyanairFetchResult<RyanairOneWayFaresResponse>> {
	const url = new URL(FARE_FINDER_URL);
	url.searchParams.set('departureAirportIataCode', params.departureAirportIataCode);
	if (params.arrivalAirportIataCode) {
		url.searchParams.set('arrivalAirportIataCode', params.arrivalAirportIataCode);
	}
	url.searchParams.set('outboundDepartureDateFrom', params.outboundDepartureDateFrom);
	url.searchParams.set('outboundDepartureDateTo', params.outboundDepartureDateTo);
	if (params.currency) {
		url.searchParams.set('currency', params.currency);
	}
	return getJson(url.toString(), deps, isOneWayFaresResponse);
}

/**
 * Ryanair's ~220 active airports: every airport's IANA timezone AND every airport's
 * route list, in one response. Both of the adapter's non-fare needs are met here, which
 * is why this is now the only `www.ryanair.com` call it ever makes.
 *
 * There used to be a `fetchDirectDestinations` next to this one, hitting
 * `/views/locate/searchWidget/routes/en/airport/{IATA}` once per airport. Issue #121
 * measured a single BCN->OTP search spending 80 requests on it, and this endpoint's own
 * `routes` arrays answer the same question for the whole network at once (verified for
 * BCN: identical 64 destinations), so it was deleted rather than cached harder. Falling
 * back to it when this call fails would mean answering a rate limit with 80 more
 * requests, which is exactly backwards.
 */
export function fetchActiveAirports(
	deps: RyanairHttpDeps
): Promise<RyanairFetchResult<RyanairActiveAirportsResponse>> {
	return getJson(ACTIVE_AIRPORTS_URL, deps, isActiveAirportsResponse);
}
