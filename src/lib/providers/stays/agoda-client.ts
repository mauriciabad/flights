/**
 * The only file in this adapter that touches the network. Every function here resolves an
 * `AgodaFetchResult`, never throws and never rejects except through a genuine bug — same
 * contract as ryanair-client.ts, kept one layer below agoda.ts so it never needs a
 * try/catch around a fetch call.
 *
 * Two unrelated hosts get called from here, which is unusual enough to spell out:
 *
 * 1. `agoda-com.p.rapidapi.com` — the metered API this adapter exists for.
 * 2. `nominatim.openstreetmap.org` — a free, keyless reverse-geocoder.
 *
 * Why (2) exists at all: issue #10 asks for "search by coordinate and radius," but a live
 * call against Agoda's own search endpoint with `latitude`/`longitude` params instead of
 * `location` came back `{"status":false,"message":"The location cannot be empty"}`
 * (checked 2026-09-04). Agoda's RapidAPI wrapper only takes a free-text place name — there
 * is no coordinate or radius parameter anywhere in its four Hotels & Homes endpoints (the
 * full list is in the PR body). Nominatim turns this adapter's `Coordinates` into a place
 * name Agoda can search on; agoda-mapper.ts then re-applies the radius client-side against
 * each result's own coordinates, since Agoda's text search has no radius concept to honour
 * in the first place.
 *
 * Nominatim's usage policy (https://operations.osmfoundation.org/policies/nominatim/) asks
 * for a maximum of one request per second and an identifying User-Agent — impossible to
 * set from a browser `fetch`, which is why agoda.ts caches every reverse-geocode result for
 * 30 days keyed by a rounded coordinate: a repeat search near the same point costs zero
 * Nominatim requests, not just zero Agoda ones. The browser's own `Referer` header still
 * identifies this app's origin, which is the closest a client-side app can get to that
 * policy's spirit without a backend (AGENTS.md rule 1: no backend, ever).
 *
 * Considered and rejected: routing this through Transitous instead, since issue #64
 * ("Geocoding via Transitous") adds forward geocoding for the search form and this project
 * already depends on that host for transfers. Its undocumented
 * `/api/v1/reverse-geocode?place=lat,lon` does answer (found live 2026-09-04, not in
 * Transitous's public API docs), but it has the exact same underlying limitation Nominatim
 * has: it too resolves VIE's coordinates to "Fischamend", via an `areas[]` list keyed by
 * raw OSM admin-level numbers that mean different things in different countries, which is
 * less directly usable than Nominatim's semantic `address.city`/`town`/`village` fields.
 * Swapping geocoders would not fix the satellite-airport problem below, only trade one
 * unofficial API for another — worth revisiting if issue #64 lands and this app wants to
 * depend on one fewer external host, not because Transitous solves anything this doesn't.
 */

import type {
	AgodaFetchError,
	AgodaFetchResult,
	AgodaGetPricesResponse,
	AgodaSearchResponse,
	NominatimReverseResponse
} from './agoda-types';

const AGODA_HOST = 'agoda-com.p.rapidapi.com';
const SEARCH_URL = `https://${AGODA_HOST}/hotels-homes/overnight-stays/search`;
const GET_PRICES_URL = `https://${AGODA_HOST}/hotels-homes/get-prices`;
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';

export interface AgodaHttpDeps {
	signal: AbortSignal;
	apiKey: string;
	/** Overrides the global `fetch`. Tests inject a stub that resolves fixtures, so the
	 * whole adapter is exercised with zero real network traffic. */
	fetchImpl?: typeof fetch;
}

/** Nominatim needs no key, so this omits `apiKey` — kept as a separate type rather than
 * `Omit<AgodaHttpDeps, 'apiKey'>` so a caller can't accidentally pass an API key deps
 * object where a keyless one is expected and have it silently work. */
export interface GeocodeHttpDeps {
	signal: AbortSignal;
	fetchImpl?: typeof fetch;
}

async function getJson<T>(
	url: string,
	init: RequestInit,
	deps: { signal: AbortSignal; fetchImpl?: typeof fetch },
	isShapeValid: (value: unknown) => value is T
): Promise<AgodaFetchResult<T>> {
	const doFetch = deps.fetchImpl ?? fetch;
	let response: Response;
	try {
		response = await doFetch(url, { ...init, signal: deps.signal });
	} catch (cause) {
		// Mirrors ryanair-client.ts: AbortController rejects the fetch itself, so
		// cancellation surfaces as a thrown error rather than a resolved-but-unsuccessful
		// response.
		if (deps.signal.aborted) {
			return { ok: false, error: { code: 'cancelled', message: 'Agoda request was aborted' } };
		}
		return {
			ok: false,
			error: {
				code: 'network-error',
				message: cause instanceof Error ? cause.message : 'Agoda request failed',
				cause
			}
		};
	}

	if (response.status === 403) {
		return {
			ok: false,
			error: { code: 'not-subscribed', message: 'Not subscribed to this API on RapidAPI', status: 403 }
		};
	}
	if (response.status === 429) {
		const retryAfterHeader = response.headers.get('retry-after');
		const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
		return {
			ok: false,
			error: {
				code: 'rate-limited',
				message: 'Rate-limited (HTTP 429)',
				status: 429,
				retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined
			}
		};
	}
	if (!response.ok) {
		return {
			ok: false,
			error: { code: 'http-error', message: `Request to ${url} returned HTTP ${response.status}`, status: response.status }
		};
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch (cause) {
		return { ok: false, error: { code: 'malformed-response', message: 'Response was not valid JSON', cause } };
	}

	if (!isShapeValid(body)) {
		return {
			ok: false,
			error: { code: 'malformed-response', message: `Response from ${url} did not match the shape this adapter expects` }
		};
	}
	return { ok: true, data: body };
}

// Agoda's own wrapper answers a bad request with HTTP 200 and `{"status":false,...}`
// rather than a 4xx (seen live for a bad `languagecode`-style typo on the sibling Booking
// API, and for `get-prices` with an unknown `currency_id`) — this adapter therefore checks
// `status`/`data` shape rather than trusting the HTTP status code alone for these two
// endpoints. Both response shapes are permissive (every field optional) precisely because
// a validation failure comes back with `data` absent rather than an HTTP error.
function isAgodaSearchResponse(value: unknown): value is AgodaSearchResponse {
	return typeof value === 'object' && value !== null;
}

function isAgodaGetPricesResponse(value: unknown): value is AgodaGetPricesResponse {
	return typeof value === 'object' && value !== null;
}

function isNominatimReverseResponse(value: unknown): value is NominatimReverseResponse {
	return typeof value === 'object' && value !== null;
}

export interface SearchParams {
	location: string;
	checkinDate: string;
	checkoutDate: string;
}

export function fetchOvernightStaysSearch(
	params: SearchParams,
	deps: AgodaHttpDeps
): Promise<AgodaFetchResult<AgodaSearchResponse>> {
	const url = new URL(SEARCH_URL);
	url.searchParams.set('location', params.location);
	url.searchParams.set('checkin_date', params.checkinDate);
	url.searchParams.set('checkout_date', params.checkoutDate);
	return getJson(
		url.toString(),
		{ headers: { 'x-rapidapi-key': deps.apiKey, 'x-rapidapi-host': AGODA_HOST } },
		deps,
		isAgodaSearchResponse
	);
}

export interface GetPricesParams {
	propertyId: number;
	checkinDate: string;
	checkoutDate: string;
	adults: number;
	/** Agoda's own numeric currency id (e.g. 1 for EUR) — see agoda-mapper.ts
	 * `AGODA_CURRENCY_IDS` for where this comes from and why it is a small static table
	 * rather than a live lookup. Omitted falls back to Agoda's own default, USD (verified
	 * live 2026-09-04: `/currencies` never lists USD at all, yet omitting `currency_id`
	 * consistently returns USD prices). */
	currencyId?: number;
}

export function fetchGetPrices(
	params: GetPricesParams,
	deps: AgodaHttpDeps
): Promise<AgodaFetchResult<AgodaGetPricesResponse>> {
	const url = new URL(GET_PRICES_URL);
	url.searchParams.set('property_id', String(params.propertyId));
	url.searchParams.set('checkin_date', params.checkinDate);
	url.searchParams.set('checkout_date', params.checkoutDate);
	url.searchParams.set('rooms', '1');
	url.searchParams.set('adults', String(params.adults));
	if (params.currencyId !== undefined) {
		url.searchParams.set('currency_id', String(params.currencyId));
	}
	return getJson(
		url.toString(),
		{ headers: { 'x-rapidapi-key': deps.apiKey, 'x-rapidapi-host': AGODA_HOST } },
		deps,
		isAgodaGetPricesResponse
	);
}

/**
 * Reverse-geocodes a coordinate to the name of the place it falls inside, at roughly
 * city/town granularity (Nominatim's `zoom=10`) — see this file's header for why this
 * adapter needs a place name at all.
 *
 * One real limitation, found live and worth stating rather than quietly working around
 * (issue #10: "report honestly... rather than papering over it with a guess"): Nominatim
 * returns the administrative area that literally contains the point, not the nearest
 * well-known city. Vienna International Airport (48.1103, 16.5697) reverse-geocodes to
 * "Fischamend" — a small separate town Vienna Airport happens to sit inside — not
 * "Vienna," because Fischamend's municipal boundary, not Vienna's, contains that exact
 * point. A search built from that name will look for hostels in a town of a few thousand
 * people instead of the city 18km away that actually has them. There is no reliable,
 * keyless way to ask Nominatim for "the nearest notable city" instead of "the containing
 * administrative area" — its `/search` endpoint needs a text query to rank against, not a
 * bare point. Recorded here rather than silently patched around; see the PR body.
 */
export function fetchReverseGeocode(
	coordinates: { latitude: number; longitude: number },
	deps: GeocodeHttpDeps
): Promise<AgodaFetchResult<NominatimReverseResponse>> {
	const url = new URL(NOMINATIM_REVERSE_URL);
	url.searchParams.set('lat', String(coordinates.latitude));
	url.searchParams.set('lon', String(coordinates.longitude));
	url.searchParams.set('format', 'jsonv2');
	url.searchParams.set('zoom', '10');
	url.searchParams.set('accept-language', 'en');
	return getJson(url.toString(), {}, deps, isNominatimReverseResponse);
}

/** Re-exported for agoda.ts's `toProviderError` — kept here rather than duplicated, since
 * both this file and agoda.ts need the same union. */
export type { AgodaFetchError };
