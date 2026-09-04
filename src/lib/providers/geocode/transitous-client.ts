/**
 * HTTP layer for Transitous's `/geocode` (free text -> places) and `/reverse-geocode`
 * (coordinates -> places) endpoints (issue #64). transitous.ts is the only caller and
 * turns whatever this throws into a `ProviderResult`, same split as the transfers adapter.
 *
 * Deliberately reuses transfers/transitous-client.ts's `BASE_URL`, `TRANSITOUS_USER_AGENT`,
 * error classes and `parseRetryAfter`/`safeReadText` helpers rather than re-deriving them:
 * this is the same host, the same terms of use, and the same error shapes that file already
 * worked out and tested. See that file's header for the full explanation of why the
 * `User-Agent` header is set despite no browser today honouring it, and why the page's own
 * `Referer` is the contact signal that actually reaches Transitous.
 */

import type { Coordinates } from '../../domain';
import {
	BASE_URL,
	parseRetryAfter,
	safeReadText,
	TRANSITOUS_USER_AGENT,
	TransitousHttpError,
	TransitousMalformedResponseError
} from '../transfers/transitous-client';
import type { TransitousGeocodeResponse } from './transitous-types';

export { TransitousHttpError, TransitousMalformedResponseError };

export interface TransitousGeocodeFetchOptions {
	signal: AbortSignal;
	/** Overrides the global `fetch`, for tests only. */
	fetchImpl?: typeof fetch;
}

/**
 * Free-text search: `text` is whatever a person typed ("Sagrada Familia Barcelona"),
 * ranked results back, most relevant first per Transitous's own scoring.
 */
export async function fetchTransitousGeocode(
	text: string,
	options: TransitousGeocodeFetchOptions
): Promise<TransitousGeocodeResponse> {
	const url = new URL(`${BASE_URL}/geocode`);
	url.searchParams.set('text', text);
	return fetchPlaces(url, options);
}

/**
 * Reverse lookup: what is at (or nearest) this point. This is what makes "IATA code to
 * timezone" reliable — issue #64 found that querying `/geocode` with a bare IATA code or
 * "<code> Airport" text often matches an unrelated place sharing that string (e.g. text
 * "BCN" resolves to a hamlet in Switzerland, not Barcelona), while feeding this endpoint
 * the airport's own known coordinates (already in this app's OurAirports-derived dataset)
 * reliably returns the airport itself, or at worst a nearby place in the same time zone —
 * good enough, since a time zone is what this call is actually for.
 */
export async function fetchTransitousReverseGeocode(
	coordinates: Coordinates,
	options: TransitousGeocodeFetchOptions
): Promise<TransitousGeocodeResponse> {
	const url = new URL(`${BASE_URL}/reverse-geocode`);
	url.searchParams.set('place', `${coordinates.latitude},${coordinates.longitude}`);
	return fetchPlaces(url, options);
}

async function fetchPlaces(url: URL, options: TransitousGeocodeFetchOptions): Promise<TransitousGeocodeResponse> {
	const doFetch = options.fetchImpl ?? fetch;
	const response = await doFetch(url.toString(), {
		signal: options.signal,
		headers: { 'User-Agent': TRANSITOUS_USER_AGENT }
	});

	if (!response.ok) {
		const retryAfterSeconds = parseRetryAfter(response.headers.get('Retry-After'));
		const body = await safeReadText(response);
		throw new TransitousHttpError(
			response.status,
			retryAfterSeconds,
			`Transitous responded ${response.status}${body ? `: ${body}` : ''}`
		);
	}

	let json: unknown;
	try {
		json = await response.json();
	} catch (cause) {
		throw new TransitousMalformedResponseError('Transitous returned a body that was not valid JSON', cause);
	}

	if (!isGeocodeResponseShape(json)) {
		throw new TransitousMalformedResponseError(
			'Transitous geocode response was not the expected array of places'
		);
	}

	return json;
}

function isGeocodeResponseShape(value: unknown): value is TransitousGeocodeResponse {
	return Array.isArray(value) && value.every(isValidGeocodePlace);
}

/** Validates every field `transitous-mapper.ts`'s `mapPlace` actually reads: `name`/`lat`/
 * `lon` required, `country`/`tz`/`areas` optional but type-checked when present (issue #68
 * — a wrong-typed `tz` would otherwise flow straight through `place.tz` into
 * `GeocodeCandidate.timeZone`, since `??` only catches `null`/`undefined`, not a value of
 * the wrong type). `type` is deliberately not checked here: nothing in this adapter reads
 * it (transitous-types.ts's own header). */
function isValidGeocodePlace(row: unknown): boolean {
	if (typeof row !== 'object' || row === null) return false;
	const place = row as Record<string, unknown>;
	if (typeof place.name !== 'string' || typeof place.lat !== 'number' || typeof place.lon !== 'number') {
		return false;
	}
	if (place.country !== undefined && typeof place.country !== 'string') return false;
	if (place.tz !== undefined && typeof place.tz !== 'string') return false;
	if (place.areas !== undefined && !Array.isArray(place.areas)) return false;
	return true;
}
