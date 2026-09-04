/**
 * The only file in this adapter that touches the network. Every function resolves a
 * `HostelworldFetchResult` and never rejects, so hostelworld.ts needs no try/catch around a
 * fetch — the same contract ryanair-client.ts and kiwi-public-client.ts keep.
 *
 * ## Why this can be called from a browser at all, measured rather than assumed
 *
 * Everything here goes to `api.m.hostelworld.com/2.2`, which answers
 * `Access-Control-Allow-Origin: *` to an anonymous request carrying no headers at all.
 * Probed on 2026-09-04 with `tools/probe-cors.mjs`, which serves a page from a real
 * `http://` origin and calls `fetch` from that document — the three routes below each
 * resolved `type: "cors"`, `status: 200`, with real bodies.
 *
 * **No credential, anywhere in this file.** No key, no signup, no account, no token, no
 * quota belonging to anyone. Same standing as kiwi-public-client.ts's endpoint: somebody
 * else's website backend, used the way their own apps use it.
 *
 * ## Hostelworld has two hosts and they do not have the same access rules
 *
 * Worth stating plainly, because the obvious host is the worse one and picking it first
 * cost this adapter a rewrite. Hostelworld's website calls
 * `prod.apigee.hostelworld.com/legacy-hwapi-service/2.2/…`, which answers an anonymous
 * request with `401` and no CORS headers; it works only with an `api-key` header lifted
 * from their public JavaScript bundle, and it echoes the caller's origin. Its companion
 * `prod.apigee.hostelworld.com/autocomplete-service/…` needs that header too and, measured
 * from a real page, **sends no `Access-Control-Allow-Origin` at all to a foreign origin** —
 * it reflects `*` only to hostelworld.com itself. A first version of this adapter used it,
 * passed every unit test, and failed on the real page with "No 'Access-Control-Allow-Origin'
 * header is present". `curl` had reported `200` throughout, which is exactly the trap
 * `tools/probe-cors.mjs` exists to catch and exactly why AGENTS.md says to measure CORS
 * from a browser.
 *
 * `api.m.hostelworld.com` serves the same `/2.2` API to anybody, so it is the only host
 * this file talks to.
 *
 * ## City lookup is geographic, not textual, and that is not a stylistic preference
 *
 * The one route that could have resolved a city by name is the autocomplete above, and it
 * is unreachable. What is left is better anyway: `/2.2/continents/{1..6}/countries/` returns
 * every country with its full city list and REAL coordinates. Six requests cover the world
 * — 167 countries, 3541 cities, 83 KB gzipped — and hostelworld.ts caches that for a month,
 * after which matching an airport to a city is arithmetic with no request at all.
 *
 * Textual matching would not have worked regardless. Hostelworld files the acceptance
 * trip's own stopover under "England" while this app calls that country "United Kingdom",
 * and `text=London, United Kingdom` returns "Sorry, we cannot find anything that matches
 * your search term". Bare names are ambiguous in the direction that matters: "Boa Vista"
 * offers Brazil before Cape Verde.
 *
 * A sibling host, `api.skypicker.com`, answers a `HeadlessChrome` User-Agent with `403` and
 * no CORS headers at all (see kiwi-public-client.ts). Hostelworld does not do this — the
 * captures above were made with Playwright's own headless UA on one run and a real Chrome
 * UA on another, with identical results — but any probe of this file's host should still go
 * through `tools/probe-browser.mjs`'s `PROBE_USER_AGENT` rather than assume that holds.
 */

import type {
	HostelworldContinentCountriesResponse,
	HostelworldErrorResponse,
	HostelworldFetchResult,
	HostelworldPropertiesResponse
} from './hostelworld-types';

/** The keyless host. Same `/2.2` API as the one hostelworld.com's own search calls, without
 * its `401` — see this file's header. */
const ENDPOINT = 'https://api.m.hostelworld.com/2.2';

/** Hostelworld's whole world, and it really is only these six: `/2.2/continents/` lists
 * exactly `1=North America, 2=South America, 3=Europe, 4=Asia, 5=Oceania, 6=Africa`, and
 * `7` answers `400`. Hard-coded rather than discovered at runtime, because discovering it
 * would cost a seventh request to learn a fact that has a fixed answer. */
export const HOSTELWORLD_CONTINENT_IDS: readonly number[] = [1, 2, 3, 4, 5, 6];

export interface HostelworldHttpDeps {
	signal: AbortSignal;
	/** Overrides the global `fetch`. Tests inject a stub resolving the captured fixtures, so
	 * the whole adapter is exercised with no real network traffic. */
	fetchImpl?: typeof fetch;
}

/** Hostelworld's own sentence out of a 4xx body, or `undefined` when the body is not the
 * shape it uses for errors. Returned rather than logged, so the caller can put the
 * provider's wording in the message instead of inventing a cause for the status code. */
function describeErrorBody(body: unknown): string | undefined {
	const described = (body as HostelworldErrorResponse | null)?.description;
	if (!Array.isArray(described)) return undefined;
	const messages = described
		.map((entry) => entry?.message)
		.filter((text): text is string => typeof text === 'string' && text.length > 0);
	return messages.length > 0 ? messages.join('; ') : undefined;
}

/**
 * Every request this adapter makes, and it carries no headers at all.
 *
 * That is deliberate rather than merely tidy: any header outside the CORS safelist —
 * `api-key`, or even an `accept` of `application/json` — turns a simple cross-origin
 * request into a preflighted one, adding a round trip to the call this app makes on every
 * search. Header-free, the browser sends it straight out. A request that carries no
 * identifier also cannot be one.
 */
async function getJson<T>(url: string, deps: HostelworldHttpDeps): Promise<HostelworldFetchResult<T>> {
	const doFetch = deps.fetchImpl ?? fetch;

	let response: Response;
	try {
		response = await doFetch(url, { method: 'GET', signal: deps.signal });
	} catch (cause) {
		// A cancelled fetch rejects rather than resolving, so `signal.aborted` after the fact
		// is what separates "the user navigated away" from "the network is down" — two
		// failures that need completely different UI treatment.
		if (deps.signal.aborted) {
			return { ok: false, error: { code: 'cancelled', message: 'Hostelworld request was aborted' } };
		}
		return {
			ok: false,
			error: {
				code: 'network-error',
				message: cause instanceof Error ? cause.message : 'Hostelworld request failed',
				cause
			}
		};
	}

	if (!response.ok) {
		if (response.status === 429) {
			const header = response.headers.get('retry-after');
			const seconds = header ? Number(header) : undefined;
			return {
				ok: false,
				error: {
					code: 'rate-limited',
					message: 'Hostelworld rate-limited this request (HTTP 429)',
					retryAfterSeconds: Number.isFinite(seconds) ? seconds : undefined
				}
			};
		}
		// Read the body before deciding what to say. A `400` here carries Hostelworld's own
		// diagnosis ("please pass valid currency three letter code") and that sentence is
		// worth more than the status alone — AGENTS.md, and the Agoda `{"status":false,
		// "message":"The location cannot be empty"}` episode it is written from.
		let described: string | undefined;
		try {
			described = describeErrorBody(await response.json());
		} catch {
			described = undefined;
		}
		return {
			ok: false,
			error: {
				code: 'http-error',
				message: described
					? `Hostelworld returned HTTP ${response.status}: ${described}`
					: `Hostelworld returned HTTP ${response.status}`,
				status: response.status
			}
		};
	}

	try {
		return { ok: true, data: (await response.json()) as T };
	} catch (cause) {
		return {
			ok: false,
			error: {
				code: 'malformed-response',
				message: 'Hostelworld response was not valid JSON',
				cause
			}
		};
	}
}

/**
 * One continent's countries, each with its full city list and real coordinates.
 *
 * Measured gzipped, 2026-09-04: North America 11.5 KB, South America 12.4 KB, Europe
 * 29.0 KB, Asia 21.1 KB, Oceania 3.8 KB, Africa 5.0 KB — 83 KB for the world. hostelworld.ts
 * fetches all six once and caches the flattened result for a month, so this is a one-off
 * cost that buys request-free city lookups for every search after it.
 *
 * `/2.2/countries/{id}/cities/` returns the same cities one country at a time and would need
 * a country id this app has no way to derive (Hostelworld's country names disagree with
 * this app's). `/2.2/cities/` and `/2.2/countries/` are not indexes at all: both answer as
 * though the id were 1, which is Cork.
 */
export function fetchContinentCountries(
	continentId: number,
	deps: HostelworldHttpDeps
): Promise<HostelworldFetchResult<HostelworldContinentCountriesResponse>> {
	return getJson<HostelworldContinentCountriesResponse>(
		`${ENDPOINT}/continents/${continentId}/countries/`,
		deps
	);
}

export interface HostelworldPropertiesParams {
	cityId: number;
	/** ISO 4217. EUR, USD and GBP confirmed honoured live; an unsupported code earns a
	 * `400` carrying Hostelworld's own "please pass valid currency three letter code",
	 * which `getJson` above surfaces verbatim. */
	currency: string;
	/** Check-in, `YYYY-MM-DD`. There is no check-out parameter; the stay's length is
	 * `numNights` below. */
	dateStart: string;
	numNights: number;
	guests: number;
	perPage: number;
}

/**
 * Priced properties in one city for one stay.
 *
 * Three parameters here are load-bearing and were each settled by measurement on
 * 2026-09-04, London, 9-12 October 2026:
 *
 * - **`show-rooms=1` is mandatory, not an enrichment.** With `show-rooms=0` the endpoint
 *   answers `200` with an 84-byte body and NO `properties` array at all — not a shorter
 *   response, an empty one. It is also the only place a female-dorm price exists
 *   (hostelworld-mapper.ts).
 * - **`sort=price` is honoured** (`order-by=price` is silently ignored — the two were
 *   compared and only one changed the order). It matters because `per-page` truncates: the
 *   default ranking put a 39.68 dorm first and the city's real cheapest, 19.12, at no fixed
 *   position, so a truncated default-sorted page can miss the cheapest bed entirely, which
 *   is the one thing this adapter is asked for.
 * - **`per-page=30` costs about 53 KB gzipped** (533 KB uncompressed; omitting `per-page`
 *   returns the whole city, all 74 of London). With the page sorted by price, thirty is far
 *   more than enough to hold the cheapest bed within any plausible radius while staying a
 *   reasonable thing to send to a phone.
 *
 * Nothing else is sent. The website adds `application=web` and a `user-id` UUID; both were
 * tested as omitted against this host and change nothing, so they are not sent — a request
 * that carries no identifier cannot be one.
 */
export function fetchCityProperties(
	params: HostelworldPropertiesParams,
	deps: HostelworldHttpDeps
): Promise<HostelworldFetchResult<HostelworldPropertiesResponse>> {
	const query = new URLSearchParams({
		currency: params.currency,
		'date-start': params.dateStart,
		'num-nights': String(params.numNights),
		guests: String(params.guests),
		'per-page': String(params.perPage),
		'show-rooms': '1',
		sort: 'price'
	});
	const url = `${ENDPOINT}/cities/${params.cityId}/properties/?${query.toString()}`;
	return getJson<HostelworldPropertiesResponse>(url, deps);
}
