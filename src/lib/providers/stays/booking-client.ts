/**
 * The only file in this adapter that touches the network. Every function here resolves a
 * `BookingFetchResult`, never throws and never rejects except through a genuine bug — same
 * contract as ryanair-client.ts and agoda-client.ts.
 *
 * Unlike Agoda, Booking's RapidAPI wrapper genuinely supports coordinate+radius search
 * (`searchHotelsByCoordinates`, confirmed live 2026-09-04) — no reverse-geocoding shim
 * needed here, which is one of the two things Booking does more natively than Agoda even
 * though its 50-request/month quota (docs/PROVIDERS.md) is what keeps it the supplement
 * rather than the default.
 */

import type { BookingFetchError, BookingFetchResult, BookingRoomListResponse, BookingSearchResponse } from './booking-types';

const BOOKING_HOST = 'booking-com15.p.rapidapi.com';
const SEARCH_BY_COORDINATES_URL = `https://${BOOKING_HOST}/api/v1/hotels/searchHotelsByCoordinates`;
const GET_ROOM_LIST_URL = `https://${BOOKING_HOST}/api/v1/hotels/getRoomList`;

/**
 * Live testing found `radius=5` rejected as an "Invalid value" but `radius=10` accepted —
 * the true floor sits somewhere in between, not pinned down more precisely since each
 * attempt spends real, tightly-budgeted quota. Clamping up to this rather than letting a
 * small `radiusKm` fail the whole search outright means a caller asking for a tight radius
 * gets a wider-than-asked search instead of an error; booking-mapper.ts does not re-filter
 * the wider results back down, so a caller relying on an exact radius smaller than this
 * should know the effective floor is 10km, not whatever it requested.
 */
export const MIN_SEARCH_RADIUS_KM = 10;

export interface BookingHttpDeps {
	signal: AbortSignal;
	apiKey: string;
	/** Overrides the global `fetch`. Tests inject a stub that resolves fixtures, so the
	 * whole adapter is exercised with zero real network traffic. */
	fetchImpl?: typeof fetch;
}

async function getJson<T>(
	url: string,
	deps: BookingHttpDeps,
	isShapeValid: (value: unknown) => value is T
): Promise<BookingFetchResult<T>> {
	const doFetch = deps.fetchImpl ?? fetch;
	let response: Response;
	try {
		response = await doFetch(url, {
			signal: deps.signal,
			headers: { 'x-rapidapi-key': deps.apiKey, 'x-rapidapi-host': BOOKING_HOST }
		});
	} catch (cause) {
		if (deps.signal.aborted) {
			return { ok: false, error: { code: 'cancelled', message: 'Booking request was aborted' } };
		}
		return {
			ok: false,
			error: {
				code: 'network-error',
				message: cause instanceof Error ? cause.message : 'Booking request failed',
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

	// Booking's own wrapper answers a bad *parameter* with HTTP 200 and
	// `{"status":false,"message":[...]}` rather than a 4xx — confirmed live for both a bad
	// `languagecode` and a `radius` below its minimum — so this adapter checks the body's
	// own `status` field, not just the HTTP status code, same as agoda-client.ts.
	if (typeof body === 'object' && body !== null && (body as { status?: unknown }).status === false) {
		const message = (body as { message?: unknown }).message;
		return {
			ok: false,
			error: {
				code: 'malformed-response',
				message: `Booking rejected the request: ${typeof message === 'string' ? message : JSON.stringify(message)}`
			}
		};
	}

	if (!isShapeValid(body)) {
		return {
			ok: false,
			error: { code: 'malformed-response', message: `Response from ${url} did not match the shape this adapter expects` }
		};
	}
	return { ok: true, data: body };
}

function isSearchResponse(value: unknown): value is BookingSearchResponse {
	return typeof value === 'object' && value !== null;
}

function isRoomListResponse(value: unknown): value is BookingRoomListResponse {
	return typeof value === 'object' && value !== null;
}

export interface SearchByCoordinatesParams {
	latitude: number;
	longitude: number;
	radiusKm: number;
	checkinDate: string;
	checkoutDate: string;
	currencyCode?: string;
}

export function fetchSearchHotelsByCoordinates(
	params: SearchByCoordinatesParams,
	deps: BookingHttpDeps
): Promise<BookingFetchResult<BookingSearchResponse>> {
	const url = new URL(SEARCH_BY_COORDINATES_URL);
	url.searchParams.set('latitude', String(params.latitude));
	url.searchParams.set('longitude', String(params.longitude));
	url.searchParams.set('radius', String(Math.max(params.radiusKm, MIN_SEARCH_RADIUS_KM)));
	url.searchParams.set('arrival_date', params.checkinDate);
	url.searchParams.set('departure_date', params.checkoutDate);
	url.searchParams.set('room_qty', '1');
	url.searchParams.set('temperature_unit', 'c');
	// Booking's own validator only accepts full locale tags (rejected a bare "en" live
	// with "languagecode should be from en-gb,en-us,de,nl,..."), not the two-letter code
	// most of this app's other params use.
	url.searchParams.set('languagecode', 'en-us');
	url.searchParams.set('units', 'metric');
	if (params.currencyCode) url.searchParams.set('currency_code', params.currencyCode);
	return getJson(url.toString(), deps, isSearchResponse);
}

export interface GetRoomListParams {
	hotelId: number;
	checkinDate: string;
	checkoutDate: string;
	adults: number;
	currencyCode?: string;
}

export function fetchGetRoomList(
	params: GetRoomListParams,
	deps: BookingHttpDeps
): Promise<BookingFetchResult<BookingRoomListResponse>> {
	const url = new URL(GET_ROOM_LIST_URL);
	url.searchParams.set('hotel_id', String(params.hotelId));
	url.searchParams.set('arrival_date', params.checkinDate);
	url.searchParams.set('departure_date', params.checkoutDate);
	url.searchParams.set('adults', String(params.adults));
	url.searchParams.set('room_qty', '1');
	url.searchParams.set('units', 'metric');
	url.searchParams.set('temperature_unit', 'c');
	if (params.currencyCode) url.searchParams.set('currency_code', params.currencyCode);
	return getJson(url.toString(), deps, isRoomListResponse);
}
