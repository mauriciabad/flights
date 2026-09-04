/**
 * The only file in this adapter that touches the network. Every function here either
 * resolves the parsed JSON body or throws — the shape `callProviderWithBudget`
 * (../budget/call-with-budget.ts) expects from an `execute` callback, since that function,
 * not this one, is what turns "what actually happened" into the `ProviderResult` a
 * `FlightProvider` method is contracted to resolve (../types.ts). This mirrors
 * ryanair-client.ts and skyscanner-client.ts in spirit — one file owns every real `fetch`
 * call — but not their exact return shape, because this issue's brief asks this adapter to
 * "route through … the budget module," and that module's own contract is "throw, don't
 * return a result" (see `CallProviderWithBudgetOptions.execute`'s doc comment).
 */

import { ProviderHttpError, recordRateLimitHeaders } from '../budget';
import type { ProviderErrorCode } from '../budget';
import { defaultClassifyError } from '../budget';
import type { ProviderId } from '../types';
import type {
	FlightsSkyAutoCompleteResponse,
	FlightsSkyPriceCalendarResponse,
	FlightsSkySearchOneWayResponse
} from './flights-sky-types';

/** The only host this adapter is built and verified against (this issue's brief;
 * docs/PROVIDERS.md). */
const PROVIDER_ID: ProviderId = 'flights-sky';
const HOST = 'flights-sky.p.rapidapi.com';
const BASE_URL = `https://${HOST}`;

/** Thrown when a 2xx response's body is not valid JSON, or is valid JSON but missing the one
 * top-level shape every caller in this file already checked for. Distinct from
 * `ProviderHttpError` (../budget/classify-error.ts), which is for a non-2xx status —  this is
 * "the host said success but the body cannot be trusted." */
export class FlightsSkyMalformedResponseError extends Error {}

/** `defaultClassifyError` (../budget) already understands `ProviderHttpError`, an aborted
 * fetch, and a bare `TypeError`/`SyntaxError` — everything a plain `fetch` call can throw on
 * its own. This adds the one error shape specific to this file. Pass this as
 * `CallProviderWithBudgetOptions.classifyError` on every call this adapter makes, so a
 * shape mismatch is reported as `malformed-response` rather than falling through to
 * `unknown`. */
export function classifyFlightsSkyError(error: unknown): ProviderErrorCode {
	if (error instanceof FlightsSkyMalformedResponseError) return 'malformed-response';
	return defaultClassifyError(error);
}

export interface FlightsSkyHttpDeps {
	apiKey: string;
	signal: AbortSignal;
	/** Overrides the global `fetch`. Tests inject a stub that resolves fixtures, so this
	 * adapter's tests reach the network exactly zero times. */
	fetchImpl?: typeof fetch;
}

async function getJson<T>(
	path: string,
	params: Readonly<Record<string, string>>,
	deps: FlightsSkyHttpDeps
): Promise<T> {
	const url = new URL(BASE_URL + path);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}

	const doFetch = deps.fetchImpl ?? fetch;
	// A rejected fetch (offline, DNS, a CORS rejection, or `deps.signal` firing mid-flight)
	// is left to propagate uncaught: `callProviderWithBudget` catches whatever `execute`
	// throws and `classifyFlightsSkyError` — via `defaultClassifyError` — already handles a
	// bare `TypeError` and an aborted-signal `AbortError` correctly. Wrapping it here would
	// only re-derive that same classification a second time.
	const response = await doFetch(url.toString(), {
		headers: {
			'x-rapidapi-key': deps.apiKey,
			'x-rapidapi-host': HOST
		},
		signal: deps.signal
	});

	// Before the ok/not-ok branch: RapidAPI sends its quota headers on a 429 and a 403 too,
	// and those are exactly the responses where the real remaining count matters (#146).
	recordRateLimitHeaders(PROVIDER_ID, response.headers);

	if (!response.ok) {
		const body = await safeReadJson(response);
		const message = messageFrom(body) ?? `Flights Sky responded with HTTP ${response.status}`;
		const retryAfterSeconds =
			response.status === 429 ? parseRetryAfter(response.headers.get('retry-after')) : undefined;
		throw new ProviderHttpError(response.status, message, retryAfterSeconds);
	}

	const body = await safeReadJson(response);
	if (body === undefined) {
		throw new FlightsSkyMalformedResponseError('Flights Sky response body was not valid JSON');
	}
	return body as T;
}

async function safeReadJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return undefined;
	}
}

/**
 * RapidAPI's own error shape carries `message` (the "not subscribed" 403,
 * docs/PROVIDERS.md). `price-calendar`'s validation failures carry `errors` instead, as
 * either a string or an object keyed by field name (confirmed 2026-09-04 for both a missing
 * `departDate` and a wrongly-shaped id — see flights-sky-types.ts
 * `FlightsSkyPriceCalendarResponse.errors`'s doc comment). Trying both, in this order, means
 * a validation failure surfaces its real reason instead of a bare "HTTP 400".
 */
function messageFrom(body: unknown): string | undefined {
	if (body === null || typeof body !== 'object') return undefined;
	const record = body as Record<string, unknown>;
	if (typeof record.message === 'string') return record.message;
	if (typeof record.errors === 'string') return record.errors;
	if (record.errors !== null && typeof record.errors === 'object') {
		try {
			return JSON.stringify(record.errors);
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function parseRetryAfter(header: string | null): number | undefined {
	if (header === null) return undefined;
	const seconds = Number(header);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** Maps a free-text place name or an IATA code to the `skyId`/`entityId` pair
 * `price-calendar` and `search-one-way` need. Callers must not take the first result — see
 * flights-sky-entity.ts `extractExactEntityMatch` for the Barcelona/Barcelona-Venezuela trap
 * this issue and docs/PROVIDERS.md both call out. */
export function fetchAutoComplete(
	query: string,
	deps: FlightsSkyHttpDeps
): Promise<FlightsSkyAutoCompleteResponse> {
	return getJson<FlightsSkyAutoCompleteResponse>('/flights/auto-complete', { query }, deps);
}

export interface PriceCalendarParams {
	/** A `skyId` (letters only), not the numeric `entityId` — see flights-sky-types.ts
	 * `FlightsSkyEntity.skyId`'s doc comment for the live 400 that proves it. */
	fromEntityId: string;
	toEntityId: string;
	departDate: string;
	currency: string;
}

export function fetchPriceCalendar(
	params: PriceCalendarParams,
	deps: FlightsSkyHttpDeps
): Promise<FlightsSkyPriceCalendarResponse> {
	return getJson<FlightsSkyPriceCalendarResponse>('/flights/price-calendar', { ...params }, deps);
}

export interface SearchOneWayParams {
	fromEntityId: string;
	toEntityId: string;
	departDate: string;
	currency: string;
}

export function fetchSearchOneWay(
	params: SearchOneWayParams,
	deps: FlightsSkyHttpDeps
): Promise<FlightsSkySearchOneWayResponse> {
	return getJson<FlightsSkySearchOneWayResponse>('/flights/search-one-way', { ...params }, deps);
}
