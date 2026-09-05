/**
 * The only file in this adapter that touches the network. Every function here resolves a
 * `RyanairFetchResult`, never throws and never rejects except through a genuine bug — the
 * same "never fail the caller" contract `ProviderResult` asks of the adapter as a whole
 * (src/lib/providers/types.ts), kept one layer down so ryanair.ts never needs a try/catch
 * around a fetch call.
 */

import { describeProviderResponse, readProviderResponse, readRetryAfterSeconds } from '../response-evidence';
import type {
	RyanairActiveAirportsResponse,
	RyanairCheapestPerDayResponse,
	RyanairFetchResult,
	RyanairMonthlyScheduleResponse
} from './ryanair-types';

const FARE_FINDER_URL_PREFIX = 'https://services-api.ryanair.com/farfnd/v4/oneWayFares';
const SCHEDULES_URL_PREFIX = 'https://services-api.ryanair.com/timtbl/3/schedules';
const ACTIVE_AIRPORTS_URL = 'https://www.ryanair.com/api/views/locate/3/airports/en/active';

/** How every message out of this file names the host, so an error badge and a console line
 * agree about who was asked. */
const LABEL = 'Ryanair';

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
			return { ok: false, error: { code: 'cancelled', message: `${LABEL} request was aborted` } };
		}
		return {
			ok: false,
			error: {
				code: 'network-error',
				message: cause instanceof Error ? cause.message : `${LABEL} request failed`,
				cause
			}
		};
	}

	// Issue #191: the body is read before anything is decided, so the message carries
	// Ryanair's own sentence with its status code rather than our paraphrase of the status
	// alone. `Ryanair returned HTTP 429` and `Ryanair rate-limited this request (HTTP 429)`
	// were both our words standing where the host's belong.
	if (!response.ok) {
		const evidence = await readProviderResponse(response);
		const message = describeProviderResponse(LABEL, evidence);

		if (response.status === 429) {
			return {
				ok: false,
				error: {
					code: 'rate-limited',
					message,
					status: 429,
					retryAfterSeconds: readRetryAfterSeconds(response.headers)
				}
			};
		}
		return { ok: false, error: { code: 'http-error', message, status: response.status } };
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch (cause) {
		return {
			ok: false,
			error: { code: 'malformed-response', message: `${LABEL} response was not valid JSON`, cause }
		};
	}

	if (!isShapeValid(body)) {
		return {
			ok: false,
			error: {
				code: 'malformed-response',
				message: `${LABEL} response for ${url} did not match the shape this adapter expects`
			}
		};
	}

	return { ok: true, data: body };
}

function isCheapestPerDayResponse(value: unknown): value is RyanairCheapestPerDayResponse {
	if (typeof value !== 'object' || value === null) return false;
	const outbound = (value as { outbound?: unknown }).outbound;
	return typeof outbound === 'object' && outbound !== null && Array.isArray((outbound as { fares?: unknown }).fares);
}

function isMonthlyScheduleResponse(value: unknown): value is RyanairMonthlyScheduleResponse {
	return typeof value === 'object' && value !== null && Array.isArray((value as { days?: unknown }).days);
}

function isActiveAirportsResponse(value: unknown): value is RyanairActiveAirportsResponse {
	return Array.isArray(value);
}

export interface CheapestPerDayParams {
	origin: string;
	destination: string;
	/** Any date inside the wanted month; the response always covers that whole calendar
	 * month regardless of which day is passed. */
	monthStart: string;
	currency?: string;
}

/**
 * A whole month of dated fares for one route in one request — the cheapest sellable fare
 * per calendar day, with its real departure and arrival times.
 *
 * This replaced `farfnd/v4/oneWayFares` as the adapter's fare source in issue #137. That
 * endpoint is a fare *finder*: pinned to a single route it returns exactly one row for the
 * entire date range however wide the range is, and `limit`/`offset` do not change that
 * (measured 2026-09-04: `size: 1` with and without them). One row per route is one date
 * pair per stopover, which is why the flight picker had nothing to pick.
 */
export function fetchCheapestFaresPerDay(
	params: CheapestPerDayParams,
	deps: RyanairHttpDeps
): Promise<RyanairFetchResult<RyanairCheapestPerDayResponse>> {
	const path = `${FARE_FINDER_URL_PREFIX}/${encodeURIComponent(params.origin)}/${encodeURIComponent(params.destination)}/cheapestPerDay`;
	const url = new URL(path);
	url.searchParams.set('outboundMonthOfDate', params.monthStart);
	if (params.currency) {
		url.searchParams.set('currency', params.currency);
	}
	return getJson(url.toString(), deps, isCheapestPerDayResponse);
}

export interface MonthlyScheduleParams {
	origin: string;
	destination: string;
	/** Four-digit calendar year. */
	year: number;
	/** 1-12, not zero-based. */
	month: number;
}

/**
 * Every flight Ryanair has timetabled on one route in one month, each with the carrier
 * code and number that `cheapestPerDay` above omits entirely.
 *
 * Fetched alongside the fares rather than instead of them: the timetable has no prices and
 * the fares have no flight identity, so an offer that is both real and nameable needs
 * both. Kept as its own request because a schedule changes seasonally while a price
 * changes hourly, which lets ryanair.ts cache the two on wildly different TTLs.
 */
export function fetchMonthlySchedule(
	params: MonthlyScheduleParams,
	deps: RyanairHttpDeps
): Promise<RyanairFetchResult<RyanairMonthlyScheduleResponse>> {
	const url =
		`${SCHEDULES_URL_PREFIX}/${encodeURIComponent(params.origin)}/${encodeURIComponent(params.destination)}` +
		`/years/${params.year}/months/${params.month}`;
	return getJson(url, deps, isMonthlyScheduleResponse);
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
