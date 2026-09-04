/**
 * Issue #52: Travelpayouts city-directions cheap routes, fetched nightly in CI
 * (scripts/fetch-cheap-routes.mjs, .github/workflows/cheap-routes.yml) and
 * shipped as the static `cheap-routes.generated.json` this module lazy-loads --
 * the same shape as src/lib/data/airports.ts for the OurAirports dataset, and
 * for the same reason: no backend, so a build-time fetch is the only way to use
 * a provider that sends no CORS headers (docs/PROVIDERS.md).
 *
 * The honesty requirement this feature exists to satisfy: every price here is a
 * cached, dated fare, not a live search result. `expiresAt` is kept on the same
 * object as `price` rather than as a separate lookup, so nothing can read one
 * without the other sitting right next to it (AGENTS.md: "never present an
 * estimate as a fact" -- a stale price shown with its date is honest, the same
 * number shown as a fare is not).
 */

import type { IataAirlineCode, IataAirportCode, IsoCurrencyCode, Money } from '$lib/domain';

/**
 * One row of the generated dataset, written by scripts/fetch-cheap-routes.mjs.
 * Field names and the major-units price match the Travelpayouts API response
 * (docs/PROVIDERS.md) directly -- the only transform this module does at load
 * time is the Money conversion, kept here rather than baked into the JSON so it
 * stays a small, directly testable pure function (see moneyFromMajorUnits),
 * the same reasoning airports.ts gives for deriving sizeClass at load time
 * rather than pre-computing it.
 */
interface CheapRouteDatasetRow {
	origin: IataAirportCode;
	destination: IataAirportCode;
	airline: IataAirlineCode;
	/** Absent when Travelpayouts doesn't report one for this row. */
	flightNumber: string | null;
	priceMajorUnits: number;
	currency: IsoCurrencyCode;
	/** ISO datetime string exactly as Travelpayouts reports it. Not a domain
	 * `LocalDateTime`: that type needs an IANA zone name to be meaningful
	 * (AGENTS.md "Timezones"), and Travelpayouts gives only a numeric UTC
	 * offset, not a zone. Kept as an opaque string rather than guessing a zone
	 * this dataset does not actually know. */
	departureAt: string;
	/** `null` for a one-way route. */
	returnAt: string | null;
	transfers: number;
	/** When this cached price stops being safe to show at all. The reason this
	 * whole dataset exists in the shape it does -- see the module doc comment. */
	expiresAt: string;
}

/**
 * A single cached Travelpayouts fare. Never a bookable quote: it is hours old
 * by the time it ships (the free tier serves recently cached prices, not live
 * search -- docs/PROVIDERS.md), which is exactly why `expiresAt` sits on the
 * same object as `price` instead of being something a caller could drop.
 */
export interface CheapRoute {
	origin: IataAirportCode;
	destination: IataAirportCode;
	airline: IataAirlineCode;
	flightNumber: string | null;
	price: Money;
	departureAt: string;
	returnAt: string | null;
	transfers: number;
	expiresAt: string;
}

/**
 * Travelpayouts reports `price` as a float in major currency units (docs/
 * PROVIDERS.md: "price is a NUMBER in major units here"), while the domain
 * `Money` type wants integer minor units (AGENTS.md "Money"). A plain
 * `majorUnits * 100` is not safe: floating-point multiplication of, say, 19.99
 * produces 1998.9999999999998, and truncating that undercharges by a cent.
 * Rounding to the nearest integer is what makes the conversion exact for the
 * two-decimal currencies this dataset uses -- it only ever requests
 * `currency=eur` (see scripts/fetch-cheap-routes.mjs), so a zero-decimal
 * currency like JPY never reaches this function.
 */
export function moneyFromMajorUnits(majorUnits: number, currency: IsoCurrencyCode): Money {
	return {
		minorUnits: Math.round(majorUnits * 100),
		currency: currency.toUpperCase()
	};
}

function toCheapRoute(row: CheapRouteDatasetRow): CheapRoute {
	return {
		origin: row.origin,
		destination: row.destination,
		airline: row.airline,
		flightNumber: row.flightNumber,
		price: moneyFromMajorUnits(row.priceMajorUnits, row.currency),
		departureAt: row.departureAt,
		returnAt: row.returnAt,
		transfers: row.transfers,
		expiresAt: row.expiresAt
	};
}

let cheapRoutesPromise: Promise<CheapRoute[]> | null = null;

/**
 * Loads the generated dataset on first call and memoizes it for the lifetime of
 * the page. A dynamic `import()` of a JSON file is its own chunk under Vite/
 * Rollup, so nothing downloads until something actually calls this -- the same
 * lazy-load `loadAirports` in airports.ts uses, and for the same reason: it
 * stays testable directly under Node (no `fetch`, no dev server) since it is
 * still a module import rather than a network request.
 */
export function loadCheapRoutes(): Promise<CheapRoute[]> {
	cheapRoutesPromise ??= import('./cheap-routes.generated.json').then((mod) =>
		(mod.default as CheapRouteDatasetRow[]).map(toCheapRoute)
	);
	return cheapRoutesPromise;
}

/** Every cached route from a given origin, or `[]` if this dataset was never
 * fetched for that airport (scripts/cheap-routes.config.mjs controls which
 * origins exist at all) -- never a throw, matching `getAirport`'s "absent, not
 * an error" convention in airports.ts. */
export async function getCheapRoutesFrom(origin: IataAirportCode): Promise<CheapRoute[]> {
	const code = origin?.trim().toUpperCase();
	if (!code) return [];
	const routes = await loadCheapRoutes();
	return routes.filter((route) => route.origin === code);
}
