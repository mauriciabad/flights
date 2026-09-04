/**
 * Issue #71, "when should I go". The public face of this directory. Import from
 * `$lib/flexible-dates`, not from the files inside it.
 *
 * The shape of the answer, in one paragraph, because it is the part that is easy to get
 * wrong: this view never fetches to answer a question. It reads what the browser already
 * holds (searches this app already ran, plus Ryanair's keyless month grids that those
 * searches cached along the way), ranks the weeks it can actually price, and states in
 * numbers what it cannot. Changing the stopover length or the date window re-runs the
 * ranking in memory and costs nothing. The single button that spends anything spends
 * keyless Ryanair requests, one per calendar month, after saying how many.
 */

export {
	bandOf,
	cheapestByDeparture,
	coverageReport,
	FLEXIBLE_DATES_DISCLAIMER,
	inclusiveDayCount,
	priceBands,
	rankWeeks,
	tripWindows
} from './aggregate';
export type { CoverageReport, RankedWeek, TripWindow, WindowConstraints } from './aggregate';

export {
	addDays,
	datesInMonth,
	daysBetween,
	daysInMonth,
	isoWeekStart,
	monthStartOf,
	monthStartsBetween,
	weekdayIndex
} from './calendar';

export { collectLegFares, fillLegMonths, missingRyanairMonths } from './collect';
export {
	coverageSentence,
	dayLabel,
	fillCostSentence,
	freshnessSentence,
	monthLabel,
	shortMonthLabel,
	sourcesSentence,
	unknownMonthsSentence
} from './copy';
export type { CollectOptions, FillOutcome } from './collect';

export {
	DEFAULT_MAX_OBSERVATION_AGE_MS,
	LEDGER_NAMESPACE,
	readLedgerMonths,
	recordLedgerFares
} from './observations';
export type { LegKey } from './observations';

export { ledgerSignature, legObservationsFromGroup, recordItineraryGroup } from './record-results';
export type { LegObservation } from './record-results';

export { ryanairMonthFares } from './ryanair-source';
export type { RyanairMonthFares } from './ryanair-source';

export type { BlankDay, BlankDayReason, DayFare, LegFares, MonthCoverage } from './types';
