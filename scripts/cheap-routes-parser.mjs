// Issue #52: pure parsing/validation for the Travelpayouts `/v1/city-directions`
// response, kept separate from fetch-cheap-routes.mjs so it can be unit tested
// without a network call (see cheap-routes-parser.test.mjs).
//
// Response shape (docs/PROVIDERS.md):
// { "data": { "<IATA>": { "origin", "destination", "airline", "departure_at",
//   "return_at", "expires_at", "price", "flight_number", "transfers" } },
//   "currency": "eur", "success": true }

/** Thrown for a response that is malformed at the top level (not JSON, missing
 * `data`, `success: false`, ...) -- the caller cannot recover a partial result
 * from these, unlike a single bad row inside `data` (see toCheapRoute below). */
export class CheapRoutesResponseError extends Error {}

/**
 * Validates and flattens one origin's response into a plain array of routes.
 * Throws CheapRoutesResponseError for a malformed response as a whole. A single
 * malformed row inside `data` is skipped rather than failing the whole origin --
 * a decision. One bad destination entry (a future API field renamed, a null
 * slipped in) is no reason to also lose every other destination's real,
 * usable price for this origin.
 */
export function parseCityDirectionsResponse(origin, json) {
	if (!json || typeof json !== 'object') {
		throw new CheapRoutesResponseError(`Response for origin ${origin} was not a JSON object`);
	}
	if (json.success !== true) {
		throw new CheapRoutesResponseError(
			`Travelpayouts reported success=${JSON.stringify(json.success)} for origin ${origin}`
		);
	}
	if (typeof json.currency !== 'string' || json.currency.length === 0) {
		throw new CheapRoutesResponseError(`Response for origin ${origin} is missing a currency`);
	}
	if (!json.data || typeof json.data !== 'object' || Array.isArray(json.data)) {
		throw new CheapRoutesResponseError(`Response for origin ${origin} is missing a data object`);
	}

	const currency = json.currency.toUpperCase();
	const routes = [];
	for (const [destinationKey, raw] of Object.entries(json.data)) {
		const route = toCheapRoute(origin, destinationKey, raw, currency);
		if (route) routes.push(route);
	}
	return routes;
}

/** One entry of `data`, mapped to the row shape fetch-cheap-routes.mjs writes to
 * disk. Returns null for a row missing anything this app actually reads, rather
 * than throwing, so one bad row cannot take an entire origin's data with it. */
function toCheapRoute(origin, destinationKey, raw, currency) {
	if (!raw || typeof raw !== 'object') return null;

	const destination = typeof raw.destination === 'string' ? raw.destination : destinationKey;
	const hasRequiredFields =
		typeof destination === 'string' &&
		destination.length > 0 &&
		typeof raw.airline === 'string' &&
		raw.airline.length > 0 &&
		typeof raw.price === 'number' &&
		Number.isFinite(raw.price) &&
		typeof raw.departure_at === 'string' &&
		raw.departure_at.length > 0 &&
		// expires_at is the field this whole feature exists to preserve (AGENTS.md:
		// "never present an estimate as a fact") -- a row without it is not safe to
		// ship, no matter how good the price looks.
		typeof raw.expires_at === 'string' &&
		raw.expires_at.length > 0;

	if (!hasRequiredFields) return null;

	return {
		origin,
		destination,
		airline: raw.airline,
		flightNumber: raw.flight_number == null ? null : String(raw.flight_number),
		priceMajorUnits: raw.price,
		currency,
		departureAt: raw.departure_at,
		returnAt: typeof raw.return_at === 'string' && raw.return_at.length > 0 ? raw.return_at : null,
		transfers: typeof raw.transfers === 'number' ? raw.transfers : 0,
		expiresAt: raw.expires_at
	};
}
