/**
 * The only file in this adapter that touches the network. Every function resolves a
 * `KiwiPublicFetchResult` and never rejects, so kiwi-public.ts needs no try/catch around a
 * fetch — the same contract ryanair-client.ts keeps, for the same reason.
 *
 * One measurement worth knowing before changing anything here, because it cost real time
 * to find and would otherwise be re-discovered as a phantom CORS failure:
 *
 * **`api.skypicker.com` answers a `HeadlessChrome` User-Agent with `403` and NO CORS
 * headers at all, while giving an ordinary Chrome User-Agent `200` with
 * `Access-Control-Allow-Origin: *`.** Measured 2026-09-04 from a real page origin. A
 * headless probe therefore reports "this endpoint has no CORS" for an endpoint every real
 * visitor's browser can call perfectly well. Real users are unaffected — their browser
 * sends a normal UA and a page cannot override its own User-Agent anyway — but any
 * automated check of this host must set a non-headless UA or it will measure the bot wall
 * instead of the API. tools/probe-cors.mjs does this by default and says why.
 */

import { describeProviderResponse, readProviderResponse, readRetryAfterSeconds } from '../response-evidence';
import { ONE_PER_CITY_FEATURE_NAME, ONE_WAY_FEATURE_NAME, ROUTE_CHECK_FEATURE_NAME } from './kiwi-public-queries';
import type {
	KiwiPublicFetchResult,
	KiwiPublicGraphQlResponse,
	KiwiPublicOnePerCityData,
	KiwiPublicOneWayData
} from './kiwi-public-types';

const ENDPOINT = 'https://api.skypicker.com/umbrella/v2/graphql';

/** This adapter's own registry label, spelled out rather than just "Kiwi" for the reason
 * kiwi-client.ts spells out its own: two different backends with different failure modes
 * both answer to that name, and a badge naming both of them the same sends the next reader
 * to the wrong file. */
const LABEL = 'Kiwi.com (no key required)';

export interface KiwiPublicHttpDeps {
	signal: AbortSignal;
	/** Overrides the global `fetch`. Tests inject a stub resolving the captured fixtures,
	 * so the whole adapter is exercised with no real network traffic. */
	fetchImpl?: typeof fetch;
}

async function postGraphQl<T>(
	featureName: string,
	query: string,
	variables: unknown,
	deps: KiwiPublicHttpDeps
): Promise<KiwiPublicFetchResult<T>> {
	const doFetch = deps.fetchImpl ?? fetch;
	const url = `${ENDPOINT}?featureName=${encodeURIComponent(featureName)}`;

	let response: Response;
	try {
		response = await doFetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ query, variables }),
			signal: deps.signal
		});
	} catch (cause) {
		// A cancelled fetch rejects rather than resolving, so `signal.aborted` after the
		// fact is what separates "the user navigated away" from "the network is down" —
		// two failures that need completely different UI treatment.
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

	// Issue #191, and this is the branch that costs something today: this adapter is the
	// keyless default, so it runs for every visitor with no keys configured. `Kiwi returned
	// HTTP 403` was our sentence over a response we never read, which left the bot-wall 403
	// described in this file's header looking identical to every other 403 this host can
	// send. Reading the body first does not diagnose it, and is not meant to; it just stops
	// us throwing away the only thing that could.
	if (!response.ok) {
		const evidence = await readProviderResponse(response);
		const message = describeProviderResponse(LABEL, evidence);

		if (response.status === 429) {
			return {
				ok: false,
				error: {
					code: 'rate-limited',
					message,
					retryAfterSeconds: readRetryAfterSeconds(response.headers)
				}
			};
		}
		return { ok: false, error: { code: 'http-error', message, status: response.status } };
	}

	let body: KiwiPublicGraphQlResponse<T>;
	try {
		body = (await response.json()) as KiwiPublicGraphQlResponse<T>;
	} catch (cause) {
		return {
			ok: false,
			error: { code: 'malformed-response', message: `${LABEL} response was not valid JSON`, cause }
		};
	}

	// GraphQL reports a rejected query with HTTP 200 and an `errors` array. Surfaced with
	// Kiwi's own wording rather than a summary of it — AGENTS.md: "show the error you got,
	// never the one you assumed."
	if (Array.isArray(body.errors) && body.errors.length > 0) {
		const message = body.errors
			.map((entry) => entry?.message)
			.filter((text): text is string => typeof text === 'string' && text.length > 0)
			.join('; ');
		return {
			ok: false,
			error: {
				code: 'malformed-response',
				message:
					message.length > 0
						? `${LABEL} returned HTTP ${response.status} with a GraphQL error: ${message}`
						: `${LABEL} returned HTTP ${response.status} with a GraphQL error carrying no message`
			}
		};
	}

	if (body.data === undefined || body.data === null) {
		return {
			ok: false,
			error: { code: 'malformed-response', message: `${LABEL} returned a response with no data` }
		};
	}

	return { ok: true, data: body.data };
}

export function fetchOneWayDirect(
	query: string,
	variables: unknown,
	deps: KiwiPublicHttpDeps
): Promise<KiwiPublicFetchResult<KiwiPublicOneWayData>> {
	return postGraphQl<KiwiPublicOneWayData>(ONE_WAY_FEATURE_NAME, query, variables, deps);
}

/**
 * Issue #340: the same document as `fetchOneWayDirect`, under its own `featureName`.
 *
 * Two reasons, and both matter. Kiwi reads that name in its own logs, and a route-existence
 * check is genuinely a different thing from a fare search, so telling them apart is the
 * polite half of an undocumented dependency — kiwi-public-queries.ts makes that argument for
 * the name it already sends.
 *
 * The half with teeth is ours. `tests/qa/route-graph-fanout.qa.ts` bounds how many airports
 * one search asks about by counting route-graph requests on the wire, and it recognises them
 * by their feature name. Sending these as `SearchOneWayItinerariesQuery` would have hidden
 * every one of them inside the fare traffic and quietly retired that ceiling.
 */
export function fetchDirectRouteCheck(
	query: string,
	variables: unknown,
	deps: KiwiPublicHttpDeps
): Promise<KiwiPublicFetchResult<KiwiPublicOneWayData>> {
	return postGraphQl<KiwiPublicOneWayData>(ROUTE_CHECK_FEATURE_NAME, query, variables, deps);
}

export function fetchOnePerCityDirect(
	query: string,
	variables: unknown,
	deps: KiwiPublicHttpDeps
): Promise<KiwiPublicFetchResult<KiwiPublicOnePerCityData>> {
	return postGraphQl<KiwiPublicOnePerCityData>(ONE_PER_CITY_FEATURE_NAME, query, variables, deps);
}
