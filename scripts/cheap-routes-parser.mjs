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

/**
 * Issue #169: assembles the file the generator writes -- the routes, sorted, plus the
 * instant they were fetched.
 *
 * Lives here rather than inline in fetch-cheap-routes.mjs for the same reason
 * `parseCityDirectionsResponse` does: this module is the testable half, and "does the
 * dataset carry a real timestamp" should fail a unit test rather than be discovered
 * months later on a card claiming a build artefact is seconds old.
 *
 * `fetchedAt` is a required argument, deliberately not defaulted to `new Date()` in
 * here. A default would let a caller build a dataset without deciding what its
 * timestamp means, and "nobody decided" is how the stamp came to be missing at all.
 */
export function buildCheapRoutesDataset(routes, fetchedAt) {
	if (typeof fetchedAt !== 'string' || Number.isNaN(Date.parse(fetchedAt))) {
		throw new CheapRoutesResponseError(
			`buildCheapRoutesDataset needs a parseable ISO instant, got ${JSON.stringify(fetchedAt)}`
		);
	}
	// Sorted here so the caller cannot forget: a stable `routes` order is what lets a
	// reviewer read one of the nightly commits and see at a glance whether a price
	// moved or only the stamp did.
	const sorted = [...routes].sort(
		(a, b) => a.origin.localeCompare(b.origin) || a.destination.localeCompare(b.destination)
	);
	return { fetchedAt, routes: sorted };
}
