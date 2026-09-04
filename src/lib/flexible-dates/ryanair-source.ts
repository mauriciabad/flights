/**
 * Issue #71: a Ryanair `cheapestPerDay` month, read as a row of calendar days.
 *
 * Pure. `ryanair-month-grid.ts` does the cache read and the (single, opt-in) request; this
 * turns the response into the vocabulary in `types.ts`, and it is where the two traps
 * `ryanair-types.ts` documents get handled once instead of at every call site:
 *
 * - A route Ryanair does not fly answers `200` with a whole month of `unavailable: true`
 *   rows. Those become `BlankDay`s with reason `'no-service'`, never absent days. "Ryanair
 *   does not sell this" and "nobody has looked" have to stay tellable apart, because only
 *   the second one is worth spending a request on.
 * - The response always covers the whole calendar month whatever was asked for, and a row
 *   for the wrong month is dropped rather than trusted.
 *
 * The price is read through `ryanair-mapper.ts`'s own `toMoney`, not re-parsed here: it
 * reads `valueMainUnit`/`valueFractionalUnit` as decimal strings precisely because
 * `14.99 * 100` is not reliably `1499` in floating point, and a second parser would be a
 * second chance to get that wrong.
 */

import type { IataAirportCode, IsoCalendarDate, IsoCurrencyCode } from '../domain';
import { RYANAIR_PROVIDER_ID } from '../providers/flights/ryanair';
import { toMoney } from '../providers/flights/ryanair-mapper';
import type { RyanairCheapestPerDayResponse, RyanairDailyFare } from '../providers/flights/ryanair-types';
import { monthStartOf } from './calendar';
import type { BlankDay, DayFare } from './types';

export interface RyanairMonthFares {
	fares: DayFare[];
	blankDays: BlankDay[];
	/** True when every row in the month said `unavailable`. Measured behaviour for a route
	 * Ryanair does not serve at all, so a caller can say "Ryanair does not fly BVC to LGW"
	 * instead of showing an empty month that looks like missing data. */
	everyDayUnavailable: boolean;
}

/** The calendar date part of Ryanair's local wall-clock strings ("2026-10-01T15:45:00").
 * Kept as a date, never turned into an instant: the arrival date is what decides how many
 * nights a stopover has, and normalising it through UTC is how one gets lost. */
function calendarDateOf(localDateTime: string | null): IsoCalendarDate | undefined {
	if (typeof localDateTime !== 'string') return undefined;
	const date = localDateTime.slice(0, 10);
	return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function faresOf(response: RyanairCheapestPerDayResponse): RyanairDailyFare[] {
	// Re-validated rather than trusted: this value can come straight out of a cache entry
	// written by an older build of the app, which is exactly the shape-drift #131's
	// post-mortem is about.
	if (!isRecord(response) || !isRecord(response.outbound)) return [];
	const fares = (response.outbound as { fares?: unknown }).fares;
	return Array.isArray(fares) ? (fares as RyanairDailyFare[]) : [];
}

/**
 * One month of one leg. `observedAt` is the instant the response came off the wire, which
 * the caller took from the cache entry rather than from its own clock, so every `DayFare`
 * this produces carries it so the view can print a real age.
 */
export function ryanairMonthFares(
	response: RyanairCheapestPerDayResponse,
	context: {
		origin: IataAirportCode;
		destination: IataAirportCode;
		monthStart: IsoCalendarDate;
		currency: IsoCurrencyCode;
		observedAt: number;
	}
): RyanairMonthFares {
	const fares: DayFare[] = [];
	const blankDays: BlankDay[] = [];
	let rowsInMonth = 0;
	let unavailableRows = 0;

	for (const row of faresOf(response)) {
		if (!isRecord(row)) continue;
		const day = calendarDateOf(typeof row.day === 'string' ? row.day : null);
		if (day === undefined || monthStartOf(day) !== context.monthStart) continue;
		rowsInMonth += 1;

		if (row.unavailable === true) {
			unavailableRows += 1;
			blankDays.push({
				date: day,
				reason: 'no-service',
				providerId: RYANAIR_PROVIDER_ID,
				observedAt: context.observedAt
			});
			continue;
		}
		if (row.soldOut === true) {
			blankDays.push({
				date: day,
				reason: 'sold-out',
				providerId: RYANAIR_PROVIDER_ID,
				observedAt: context.observedAt
			});
			continue;
		}

		const money = toMoney(row.price ?? null);
		// A currency mismatch is dropped, not converted. This app has no exchange-rate
		// source and inventing one would put a made-up number next to real ones.
		if (!money || money.currency.toUpperCase() !== context.currency.toUpperCase()) continue;

		const departureDate = calendarDateOf(row.departureDate ?? null) ?? day;
		const arrivalDate = calendarDateOf(row.arrivalDate ?? null) ?? departureDate;
		fares.push({
			departureDate,
			arrivalDate,
			minorUnits: money.minorUnits,
			providerId: RYANAIR_PROVIDER_ID,
			observedAt: context.observedAt
		});
	}

	return {
		fares,
		blankDays,
		everyDayUnavailable: rowsInMonth > 0 && unavailableRows === rowsInMonth
	};
}
