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
import { moneyFromMajorUnits } from '$lib/domain';

/**
 * One row of the generated dataset, written by scripts/fetch-cheap-routes.mjs.
 * Field names and the major-units price match the Travelpayouts API response
 * (docs/PROVIDERS.md) directly -- the only transform this module does at load
 * time is the Money conversion (`moneyFromMajorUnits`, domain/money.ts), done
 * here rather than baked into the JSON for the same reason airports.ts derives
 * sizeClass at load time rather than pre-computing it.
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
 * The generated file as a whole, issue #169. Two instants live in it and they
 * answer different questions:
 *
 * - `fetchedAt` is when WE asked Travelpayouts. Our clock, written by
 *   scripts/fetch-cheap-routes.mjs at the moment of the fetch.
 * - each row's `expiresAt` is what TRAVELPAYOUTS says about its own cached fare.
 *   Their clock, their claim, carried verbatim.
 *
 * Before #169 only the second existed, so `search/providers-adapter.ts` answered
 * "when was this fetched" with `new Date()` -- a dataset compiled into the bundle
 * weeks earlier reporting itself as seconds old. Neither instant substitutes for
 * the other, and deriving one from the other (an expiry is not a fetch) would be
 * the same invention in a different disguise.
 */
interface CheapRoutesDatasetFile {
	fetchedAt: string;
	routes: CheapRouteDatasetRow[];
}

/** The loaded dataset: every route, plus the instant the build actually retrieved
 * them. Callers that only want the rows can keep using `loadCheapRoutes`. */
export interface CheapRoutesDataset {
	/** ISO instant scripts/fetch-cheap-routes.mjs read these rows from
	 * Travelpayouts. Not "now", and not when a caller reads this module -- see
	 * `CheapRoutesDatasetFile` above. */
	fetchedAt: string;
	routes: CheapRoute[];
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
 * `Money` type wants integer minor units (AGENTS.md "Money"), so every row
 * converts through `moneyFromMajorUnits` (domain/money.ts) -- the same function
 * every provider adapter uses, scaling by the row's own currency rather than
 * assuming cents (issue #179). The dataset only ever requests `currency=eur`
 * (scripts/fetch-cheap-routes.mjs), but a row that arrives in something else
 * still converts correctly instead of silently by a factor of 100.
 *
 * A row whose price does not parse is dropped rather than carried with a `NaN`
 * or a fabricated 0: this whole dataset exists to show a dated cached fare
 * honestly, and a route with no readable price has nothing to show.
 */
function toCheapRoute(row: CheapRouteDatasetRow): CheapRoute | undefined {
	const price = moneyFromMajorUnits(row.priceMajorUnits, row.currency);
	if (price === undefined) return undefined;
	return {
		origin: row.origin,
		destination: row.destination,
		airline: row.airline,
		flightNumber: row.flightNumber,
		price,
		departureAt: row.departureAt,
		returnAt: row.returnAt,
		transfers: row.transfers,
		expiresAt: row.expiresAt
	};
}

let cheapRoutesPromise: Promise<CheapRoutesDataset> | null = null;

/**
 * Loads the generated dataset on first call and memoizes it for the lifetime of
 * the page. A dynamic `import()` of a JSON file is its own chunk under Vite/
 * Rollup, so nothing downloads until something actually calls this -- the same
 * lazy-load `loadAirports` in airports.ts uses, and for the same reason: it
 * stays testable directly under Node (no `fetch`, no dev server) since it is
 * still a module import rather than a network request.
 *
 * Cast rather than validated, matching `loadBundledRyanairNetwork` next door:
 * this file is written by our own generator, not by a provider, so the guard
 * that belongs on it is a test over the committed artefact
 * (cheap-routes.test.ts) rather than a runtime branch on every read.
 */
export function loadCheapRoutesDataset(): Promise<CheapRoutesDataset> {
	cheapRoutesPromise ??= import('./cheap-routes.generated.json').then((mod) => {
		const file = mod.default as unknown as CheapRoutesDatasetFile;
		return {
			fetchedAt: file.fetchedAt,
			routes: file.routes.map(toCheapRoute).filter((route) => route !== undefined)
		};
	});
	return cheapRoutesPromise;
}

/** Just the rows, for callers with no use for the dataset's fetch instant. */
export async function loadCheapRoutes(): Promise<CheapRoute[]> {
	return (await loadCheapRoutesDataset()).routes;
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
