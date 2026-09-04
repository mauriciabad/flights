/**
 * Issue #71: the sentences that keep this view honest, kept as pure functions next to the
 * numbers they describe rather than typed into a component.
 *
 * The reason they live here and are unit tested: the difference between this feature being
 * useful and being a lie is entirely in the wording. "The cheapest week is the third of
 * February" is a claim about a year. "The cheapest week we can price is the third of
 * February, out of 62 days priced from a possible 366, and we know nothing at all about
 * November onward" is a claim about our data. Only the second one is true, and a component
 * that builds its own string from a template is where the first one creeps back in.
 *
 * Dates are formatted by hand, the same way `search-history/summary.ts` argues for: a view
 * whose text has to be identical in a unit test, in a prerendered page and in a browser set
 * to any locale cannot use `Intl.DateTimeFormat` for the parts a person will compare
 * against a shared link.
 */

import type { IsoCalendarDate } from '../domain';
import { formatAge } from '../format';
import type { CoverageReport } from './aggregate';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "Oct 2026". */
export function monthLabel(monthStart: IsoCalendarDate): string {
	const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(monthStart);
	if (!match) return monthStart;
	return `${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

/** "Oct", for the grid's own row labels where the year is already established. */
export function shortMonthLabel(monthStart: IsoCalendarDate): string {
	const match = /^\d{4}-(\d{2})-\d{2}$/.exec(monthStart);
	return match ? MONTHS[Number(match[1]) - 1] : monthStart;
}

/** "3 Feb 2027". */
export function dayLabel(date: IsoCalendarDate): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (!match) return date;
	return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

/**
 * How much of the window is actually answerable. Always states the denominator: a bare "62
 * days priced" invites the reader to assume the rest is expensive rather than unknown.
 */
export function coverageSentence(report: CoverageReport): string {
	if (report.totalDays === 0) return 'No date range to cover.';
	if (report.pricedTripDays === 0) {
		return `No day in the next ${report.totalDays} has a price on both legs yet.`;
	}
	return `${report.pricedTripDays} of ${report.totalDays} days can be priced end to end.`;
}

/**
 * The months with nothing in them, named. Runs of consecutive months collapse into "Nov
 * 2026 to Mar 2027" so a mostly-empty year does not print thirteen month names.
 *
 * `undefined` when every month has something, which is what lets a caller omit the line
 * entirely rather than print "0 months missing".
 */
export function unknownMonthsSentence(report: CoverageReport): string | undefined {
	if (report.unknownMonths.length === 0) return undefined;

	const runs: IsoCalendarDate[][] = [];
	for (const monthStart of report.unknownMonths) {
		const current = runs[runs.length - 1];
		const previous = current?.[current.length - 1];
		if (current && previous !== undefined && isNextMonth(previous, monthStart)) current.push(monthStart);
		else runs.push([monthStart]);
	}

	const phrases = runs.map((run) =>
		run.length === 1 ? monthLabel(run[0]) : `${monthLabel(run[0])} to ${monthLabel(run[run.length - 1])}`
	);
	return `Nothing at all for ${joinList(phrases)}.`;
}

function isNextMonth(previous: IsoCalendarDate, candidate: IsoCalendarDate): boolean {
	const a = /^(\d{4})-(\d{2})-\d{2}$/.exec(previous);
	const b = /^(\d{4})-(\d{2})-\d{2}$/.exec(candidate);
	if (!a || !b) return false;
	const months = Number(a[1]) * 12 + Number(a[2]);
	return Number(b[1]) * 12 + Number(b[2]) === months + 1;
}

/**
 * When the numbers on screen were gathered. Two ages, not one, because "these three weeks,
 * from prices cached between the 2nd and the 14th" is a different claim to "cached 2 days
 * ago", and the spread is exactly what a reader needs to judge how much to trust a ranking.
 */
export function freshnessSentence(report: CoverageReport, now: number): string | undefined {
	if (report.oldestObservedAt === undefined || report.newestObservedAt === undefined) return undefined;
	const oldest = formatAge(now - report.oldestObservedAt);
	const newest = formatAge(now - report.newestObservedAt);
	if (oldest === newest) return `Every price here was fetched ${newest}.`;
	return `Prices fetched between ${oldest} and ${newest}.`;
}

/** "Priced by Ryanair and Kiwi.com." Names the sources rather than saying "cached data",
 * because which airline's own feed a number came from is the difference between a fare and
 * an aggregator's copy of one. */
export function sourcesSentence(providerLabels: readonly string[]): string | undefined {
	if (providerLabels.length === 0) return undefined;
	return `Priced by ${joinList([...providerLabels])}.`;
}

/**
 * What pressing the fill button will cost, said before it is pressed. Requests, not
 * "a moment": this app's whole budget discipline rests on a number being visible up front.
 */
export function fillCostSentence(months: number, legs: number): string {
	const requests = months;
	if (requests === 0) return 'Every month is already cached. Nothing to fetch.';
	const legWord = legs === 1 ? 'leg' : 'legs';
	return `${requests} keyless ${requests === 1 ? 'request' : 'requests'} to Ryanair, across ${legs} ${legWord}. No key, no quota, no cost.`;
}

function joinList(items: string[]): string {
	if (items.length === 0) return '';
	if (items.length === 1) return items[0];
	return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
