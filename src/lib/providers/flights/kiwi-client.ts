/**
 * The only file in this adapter that touches the network. Every function here resolves a
 * `KiwiFetchResult`, never throws and never rejects except through a genuine bug — same
 * contract as ryanair-client.ts, so kiwi.ts never needs a try/catch around a fetch call.
 */

import { recordRateLimitHeaders } from '../budget';
import { describeProviderResponse, readProviderResponse, readRetryAfterSeconds } from '../response-evidence';
import type { ProviderId } from '../types';
import type { KiwiFetchResult, KiwiOneWayResponse, KiwiOneWaySearchParams } from './kiwi-types';

const KIWI_PROVIDER_ID: ProviderId = 'kiwi';
const BASE_URL = 'https://kiwi-com-cheap-flights.p.rapidapi.com';
const HOST_HEADER = 'kiwi-com-cheap-flights.p.rapidapi.com';
/** Matches this adapter's registry label (kiwi.ts). Spelled out rather than just "Kiwi"
 * because the keyless `kiwi-public` adapter is a different backend with different failure
 * modes, and an error badge naming both of them "Kiwi" sends the reader to the wrong file. */
const LABEL = 'Kiwi.com (RapidAPI)';

export interface KiwiHttpDeps {
	signal: AbortSignal;
	/** The user's own RapidAPI key, pasted into settings — never a value this adapter
	 * hardcodes or falls back to (AGENTS.md "Keys belong to the user"). */
	apiKey: string;
	/** Overrides the global `fetch`. Tests inject a stub that resolves fixtures, so the
	 * whole adapter is exercised with zero real network traffic. */
	fetchImpl?: typeof fetch;
}

function buildOneWayUrl(params: KiwiOneWaySearchParams): string {
	const url = new URL(`${BASE_URL}/one-way`);
	url.searchParams.set('source', params.source);
	if (params.destination) url.searchParams.set('destination', params.destination);
	url.searchParams.set('outboundDepartmentDateStart', params.outboundDepartmentDateStart);
	url.searchParams.set('outboundDepartmentDateEnd', params.outboundDepartmentDateEnd);
	url.searchParams.set('currency', params.currency);
	url.searchParams.set('adults', String(params.adults));
	url.searchParams.set('handbags', String(params.handbags));
	url.searchParams.set('holdbags', String(params.holdbags));
	url.searchParams.set('enableSelfTransfer', String(params.enableSelfTransfer));
	url.searchParams.set('allowOvernightStopover', String(params.allowOvernightStopover));
	if (params.maxStopsCount !== undefined) {
		url.searchParams.set('maxStopsCount', String(params.maxStopsCount));
	}
	url.searchParams.set('limit', String(params.limit));
	return url.toString();
}

async function getJson<T>(
	url: string,
	deps: KiwiHttpDeps,
	isShapeValid: (value: unknown) => value is T
): Promise<KiwiFetchResult<T>> {
	const doFetch = deps.fetchImpl ?? fetch;
	let response: Response;
	try {
		response = await doFetch(url, {
			signal: deps.signal,
			headers: {
				'x-rapidapi-host': HOST_HEADER,
				'x-rapidapi-key': deps.apiKey
			}
		});
	} catch (cause) {
		// AbortController rejects the fetch itself, so cancellation surfaces here as a
		// thrown error rather than a resolved-but-unsuccessful response — checking
		// `signal.aborted` is how this is told apart from a genuine network failure,
		// mirroring ryanair-client.ts.
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

	// Before any status branching: RapidAPI sends its quota headers on a 429 and a 403 too,
	// and those are exactly the responses where the real remaining count matters (#146).
	recordRateLimitHeaders(KIWI_PROVIDER_ID, response.headers);

	// Issue #171: the body is read before anything is decided, so what reaches the traveller
	// and the console is this listing's own sentence with its status code, not our paraphrase
	// of the status code alone. The failure this adapter has actually measured is the one that
	// makes the point: `402 {"error":{"code":"402","message":"Payment required"}}` with
	// `x-vercel-error: DEPLOYMENT_DISABLED`, which used to arrive as "Kiwi returned HTTP 402"
	// with both the sentence and the header thrown away.
	if (!response.ok) {
		const evidence = await readProviderResponse(response);
		const message = describeProviderResponse(LABEL, evidence);

		// A 403 alone is not "not subscribed". That code is permanent for the session
		// (budget/permanent-failures.ts marks the provider off for good), and AGENTS.md is
		// explicit after issue #122 that it must only ever come from a real 403 carrying
		// RapidAPI's own literal sentence. Any other 403 is a failure nobody here has
		// profiled, so it stays an `http-error` and keeps its own words.
		if (response.status === 403 && /not subscribed/i.test(evidence.message ?? '')) {
			return { ok: false, error: { code: 'not-subscribed', message, status: 403 } };
		}
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
		return {
			ok: false,
			error: { code: 'http-error', message, status: response.status, cause: evidence }
		};
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch (cause) {
		return { ok: false, error: { code: 'malformed-response', message: `${LABEL} response was not valid JSON`, cause } };
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

function isOneWayResponse(value: unknown): value is KiwiOneWayResponse {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { currency?: unknown }).currency === 'string' &&
		Array.isArray((value as { data?: unknown }).data)
	);
}

export function fetchOneWay(
	params: KiwiOneWaySearchParams,
	deps: KiwiHttpDeps
): Promise<KiwiFetchResult<KiwiOneWayResponse>> {
	return getJson(buildOneWayUrl(params), deps, isOneWayResponse);
}
