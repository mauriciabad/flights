/**
 * Issue #71: assemble one leg's year out of everything the browser already holds, and
 * nothing else.
 *
 * Two sources, both free, in this order:
 *
 * 1. **The ledger** (`observations.ts`). Fares from searches this browser already ran, any
 *    provider, any route. Sparse by nature: it only knows the days somebody looked at.
 * 2. **Ryanair's cached month grids** (`ryanair-month-grid.ts`). A whole calendar month per
 *    cache entry, already written by every ordinary search that touched those months.
 *    Dense, and only for routes Ryanair flies.
 *
 * `collectLegFares` makes zero requests. It is the function the view calls on every filter
 * change, which is what makes issue #71's "narrowing, widening or shifting the window must
 * cost zero additional requests" true by construction rather than by discipline.
 *
 * `fillLegMonths` is the one place a request can happen, it is driven by an explicit button,
 * and it spends exactly one keyless Ryanair request per month it was asked for.
 */

import type { CacheStore } from '../cache';
import type { IsoCalendarDate } from '../domain';
import {
	fetchRyanairMonthGrid,
	readCachedRyanairMonthGrid
} from '../providers/flights/ryanair-month-grid';
import { daysInMonth, monthStartOf } from './calendar';
import { readLedgerMonths, DEFAULT_MAX_OBSERVATION_AGE_MS } from './observations';
import type { LegKey } from './observations';
import { ryanairMonthFares } from './ryanair-source';
import type { BlankDay, DayFare, LegFares, MonthCoverage } from './types';

export interface CollectOptions {
	store?: CacheStore;
	/** Injected in tests so "how old is this observation" is deterministic. */
	now?: number;
	/** See `DEFAULT_MAX_OBSERVATION_AGE_MS`. */
	maxAgeMs?: number;
}

/** Cheapest surviving fare per departure date, across every source. Ties keep the newer
 * observation, because two sources quoting the same number is not a reason to show the
 * older one's age. */
function cheapestPerDay(fares: readonly DayFare[]): DayFare[] {
	const best = new Map<IsoCalendarDate, DayFare>();
	for (const fare of fares) {
		const existing = best.get(fare.departureDate);
		if (
			!existing ||
			fare.minorUnits < existing.minorUnits ||
			(fare.minorUnits === existing.minorUnits && fare.observedAt > existing.observedAt)
		) {
			best.set(fare.departureDate, fare);
		}
	}
	return [...best.values()].sort((a, b) => a.departureDate.localeCompare(b.departureDate));
}

/**
 * One leg's fares over the given calendar months. Zero requests, always.
 *
 * Days appear in exactly one of three states, and the third is the one this whole feature
 * turns on: priced, explicitly blank (a source said "nothing flies" or "sold out"), or
 * unknown (nobody has looked). A month full of unknown days renders as a hole, never as an
 * expensive month.
 */
export async function collectLegFares(
	leg: LegKey,
	monthStarts: readonly IsoCalendarDate[],
	options: CollectOptions = {}
): Promise<LegFares> {
	const now = options.now ?? Date.now();
	const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_OBSERVATION_AGE_MS;

	const ledgerFares = await readLedgerMonths(leg, monthStarts, {
		store: options.store,
		now,
		maxAgeMs
	});

	const allFares: DayFare[] = [...ledgerFares];
	const blankDays: BlankDay[] = [];
	/** Per month, which sources contributed anything at all. */
	const sourcesByMonth = new Map<IsoCalendarDate, Map<string, number>>();

	for (const fare of ledgerFares) {
		const month = monthStartOf(fare.departureDate);
		const sources = sourcesByMonth.get(month) ?? new Map<string, number>();
		sources.set(fare.providerId, Math.max(sources.get(fare.providerId) ?? 0, fare.observedAt));
		sourcesByMonth.set(month, sources);
	}

	for (const monthStart of monthStarts) {
		const grid = await readCachedRyanairMonthGrid(
			{ origin: leg.origin, destination: leg.destination, monthStart, currency: leg.currency },
			{ store: options.store }
		);
		if (!grid) continue;
		if (now - grid.observedAt > maxAgeMs) continue;

		const month = ryanairMonthFares(grid.response, {
			origin: leg.origin,
			destination: leg.destination,
			monthStart,
			currency: leg.currency,
			observedAt: grid.observedAt
		});
		allFares.push(...month.fares);
		blankDays.push(...month.blankDays);

		if (month.fares.length > 0 || month.blankDays.length > 0) {
			const sources = sourcesByMonth.get(monthStart) ?? new Map<string, number>();
			sources.set('ryanair', Math.max(sources.get('ryanair') ?? 0, grid.observedAt));
			sourcesByMonth.set(monthStart, sources);
		}
	}

	const fares = cheapestPerDay(allFares);

	// A day with a real fare is not also a blank day: a source saying "sold out" and another
	// selling a seat is a priced day, and the cheaper truth wins.
	const pricedDates = new Set(fares.map((fare) => fare.departureDate));
	const blanks = blankDays.filter((blank) => !pricedDates.has(blank.date));
	const blankDates = new Set(blanks.map((blank) => blank.date));

	const months: MonthCoverage[] = monthStarts.map((monthStart) => {
		const total = daysInMonth(monthStart);
		let priced = 0;
		let blank = 0;
		for (const date of pricedDates) if (monthStartOf(date) === monthStart) priced++;
		for (const date of blankDates) if (monthStartOf(date) === monthStart) blank++;
		const sources = [...(sourcesByMonth.get(monthStart) ?? new Map<string, number>())]
			.map(([providerId, observedAt]) => ({ providerId, observedAt }))
			.sort((a, b) => b.observedAt - a.observedAt);
		return {
			monthStart,
			pricedDays: priced,
			blankDays: blank,
			unknownDays: Math.max(0, total - priced - blank),
			sources
		};
	});

	return {
		origin: leg.origin,
		destination: leg.destination,
		currency: leg.currency,
		fares,
		blankDays: blanks,
		months
	};
}

/**
 * Months with no usable Ryanair grid cached, which is exactly what `fillLegMonths` would spend a
 * request on. Exported so a button can say "12 keyless requests" before anyone presses it,
 * rather than after.
 */
export async function missingRyanairMonths(
	leg: LegKey,
	monthStarts: readonly IsoCalendarDate[],
	options: CollectOptions = {}
): Promise<IsoCalendarDate[]> {
	const now = options.now ?? Date.now();
	const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_OBSERVATION_AGE_MS;
	const missing: IsoCalendarDate[] = [];
	for (const monthStart of monthStarts) {
		const grid = await readCachedRyanairMonthGrid(
			{ origin: leg.origin, destination: leg.destination, monthStart, currency: leg.currency },
			{ store: options.store }
		);
		if (!grid || now - grid.observedAt > maxAgeMs) missing.push(monthStart);
	}
	return missing;
}

export interface FillOutcome {
	monthStart: IsoCalendarDate;
	ok: boolean;
	/** Ryanair's own message, verbatim, when it failed. AGENTS.md: show the error you got. */
	error?: string;
	/** Requests actually spent on this month: 1 on an attempt, 0 when the loop stopped. */
	requestsUsed: number;
}

/**
 * Fetches the named months, one keyless request each, one at a time.
 *
 * Sequential on purpose. Ryanair has no subscription quota, but it does have a WAF that
 * will `429` a client that hammers it (`ryanair.ts`'s own `toProviderError` says so), and
 * thirteen parallel requests to somebody else's undocumented endpoint is how a keyless
 * source stops being available to everyone. It also means an abort actually stops the
 * spending, rather than cancelling twelve requests already in flight.
 */
export async function* fillLegMonths(
	leg: LegKey,
	monthStarts: readonly IsoCalendarDate[],
	signal: AbortSignal,
	options: { store?: CacheStore; fetchImpl?: typeof fetch } = {}
): AsyncGenerator<FillOutcome, void, void> {
	for (const monthStart of monthStarts) {
		if (signal.aborted) return;
		const result = await fetchRyanairMonthGrid(
			{ origin: leg.origin, destination: leg.destination, monthStart, currency: leg.currency },
			signal,
			options
		);
		yield result.ok
			? { monthStart, ok: true, requestsUsed: 1 }
			: { monthStart, ok: false, error: result.error.message, requestsUsed: 1 };
	}
}
