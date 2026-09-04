/**
 * Issue #71: the keyless month grid, read as a grid rather than as one search's fares.
 *
 * `services-api.ryanair.com/farfnd/v4/oneWayFares/{from}/{to}/cheapestPerDay` answers with
 * the cheapest sellable fare for EVERY day of a calendar month in one request, keyless,
 * CORS-open, with no quota (docs/PROVIDERS.md, "Fares are a calendar plus a timetable").
 * Thirteen of those cover a year on one route. That is the only source in this codebase
 * that can fill a year of daily prices without a key and without spending the owner's
 * RapidAPI allowance, which is why the flexible-dates view is built on it.
 *
 * This module is deliberately NOT a second `FlightProvider`. `ryanair.ts` owns the fare
 * search, and it already writes these exact month responses into the shared cache as a side
 * effect of every ordinary search, under the key `cheapestPerDayCacheKey` defines. Here
 * there are two entry points and nothing else:
 *
 * - `readCachedRyanairMonthGrid`. Zero requests, ever. Reads what previous searches
 *   already paid for, INCLUDING entries past their one-hour TTL, and hands back the real
 *   `observedAt` so the caller can print the age instead of implying freshness. A year of
 *   month grids that expire in an hour would otherwise be unusable for this feature five
 *   minutes after it was fetched, which is not what "the cache already has it" should mean.
 * - `fetchRyanairMonthGrid`. Exactly one request for exactly one leg-month, on an explicit
 *   user gesture, writing the same cache entry `ryanair.ts` reads. Never called in a loop
 *   by this module: the caller decides how many months it is filling and says so on screen
 *   first.
 *
 * What it cannot do, stated once here so the UI can repeat it honestly: Ryanair flies
 * Ryanair's own network and nothing else, so a route it does not serve answers `200` with a
 * month of `unavailable: true` rows rather than a `404`. That is a real answer ("no service
 * on any day"), not a gap, and `ryanair-types.ts` explains why treating it as anything else
 * invents a month of flights on a route with no service.
 */

import { getDefaultStore, readCachedEntry } from '../../cache';
import type { CacheStore } from '../../cache';
import { fetchCheapestFaresPerDay } from './ryanair-client';
import type { CheapestPerDayParams } from './ryanair-client';
import { cheapestPerDayCacheKey, RYANAIR_PROVIDER_ID } from './ryanair';
import type { RyanairCheapestPerDayResponse, RyanairFetchError } from './ryanair-types';

/** One leg-month as it came off Ryanair's wire, plus when that was. */
export interface RyanairMonthGrid {
	monthStart: string;
	response: RyanairCheapestPerDayResponse;
	/** Epoch millis the response was fetched, not read. */
	observedAt: number;
	/** False for a value this call fetched itself. */
	fromCache: boolean;
}

export interface RyanairMonthGridOptions {
	/** Overrides the shared IndexedDB-or-memory store. Tests inject a `MemoryCacheStore`. */
	store?: CacheStore;
	/** Overrides the global `fetch`. Tests inject a stub that resolves fixtures. */
	fetchImpl?: typeof fetch;
}

async function resolveStore(options: RyanairMonthGridOptions): Promise<CacheStore> {
	return options.store ?? (await getDefaultStore());
}

// Mirrors `cache/size.ts`'s internal `estimateByteSize`, which that module deliberately
// does not export, and every `CacheStore.set` caller needs some number for `sizeBytes`, and
// `ryanair.ts` and `kiwi-public.ts` both already do exactly this.
function estimateSizeBytes(value: unknown): number {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return 0;
	}
}

/**
 * Whatever is cached for this leg-month, at a cost of zero requests, regardless of age.
 *
 * Ignoring the TTL is the deliberate part. `ryanair.ts` treats an expired fare as absent
 * because its job is to answer "what does this flight cost right now" and a stale answer
 * there would be a wrong quote. This module's job is "which weeks are worth looking at",
 * where a fare from this morning is still evidence, and `observedAt` travels with it so the
 * screen can say how old it is. AGENTS.md's rule is that an estimate must never be
 * presented as a fact, not that old data must be thrown away.
 */
export async function readCachedRyanairMonthGrid(
	params: CheapestPerDayParams,
	options: RyanairMonthGridOptions = {}
): Promise<RyanairMonthGrid | undefined> {
	const store = await resolveStore(options);
	const entry = await readCachedEntry<RyanairCheapestPerDayResponse>(
		store,
		cheapestPerDayCacheKey(params)
	);
	if (entry === undefined) return undefined;
	return {
		monthStart: params.monthStart,
		response: entry.value,
		observedAt: entry.storedAt,
		fromCache: true
	};
}

export type RyanairMonthGridResult =
	| { ok: true; grid: RyanairMonthGrid }
	| { ok: false; error: RyanairFetchError };

/**
 * One request. Writes the result into the same cache entry `ryanair.ts`'s own fare search
 * reads, so filling the calendar also warms every future search over those dates rather
 * than building a private pile of duplicate data.
 *
 * Returns Ryanair's own failure verbatim (`RyanairFetchError` carries its message and
 * status) rather than a classification of ours. AGENTS.md, "Show the error you got, never
 * the one you assumed".
 */
export async function fetchRyanairMonthGrid(
	params: CheapestPerDayParams,
	signal: AbortSignal,
	options: RyanairMonthGridOptions = {}
): Promise<RyanairMonthGridResult> {
	const response = await fetchCheapestFaresPerDay(params, { signal, fetchImpl: options.fetchImpl });
	if (!response.ok) return { ok: false, error: response.error };

	const observedAt = Date.now();
	const store = await resolveStore(options);
	const key = cheapestPerDayCacheKey(params);
	await store.set({
		key: key.raw,
		providerId: RYANAIR_PROVIDER_ID,
		value: response.data,
		storedAt: observedAt,
		ttlMs: key.ttlMs,
		lastAccessedAt: observedAt,
		sizeBytes: estimateSizeBytes(response.data)
	});

	return {
		ok: true,
		grid: { monthStart: params.monthStart, response: response.data, observedAt, fromCache: false }
	};
}
