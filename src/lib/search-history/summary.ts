import type { SearchQuery } from '$lib/domain';

/**
 * One search said in a line and a half: the route, the window, the party size. Used by
 * the history list, by the results page's query header and by the document title, so a
 * search reads the same wherever the traveller meets it again.
 *
 * Formatted by hand rather than through `Intl.DateTimeFormat` because the output has to
 * be identical in a unit test, in a prerendered page and in a browser set to any locale.
 * A shared search link that reads "10/6/2026" to one person and "6/10/2026" to another
 * is a booked-on-the-wrong-day bug waiting to happen.
 */

const MONTHS = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec'
] as const;

interface CalendarParts {
	year: number;
	month: number;
	day: number;
}

function parts(date: string): CalendarParts | undefined {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
	const [year, month, day] = date.split('-').map(Number);
	if (month < 1 || month > 12) return undefined;
	return { year, month, day };
}

function formatDay({ year, month, day }: CalendarParts, withYear: boolean): string {
	const base = `${day} ${MONTHS[month - 1]}`;
	return withYear ? `${base} ${year}` : base;
}

/**
 * "6 Oct 2026" for one day, "1 to 20 Oct 2026" inside a month, "28 Sep to 3 Oct 2026"
 * across one, "28 Dec 2026 to 3 Jan 2027" across a year. The year appears once when both
 * ends share it, because repeating it is noise on a phone.
 */
export function formatDateRange(from: string, to: string): string {
	const start = parts(from);
	const end = parts(to);
	if (!start || !end) return from === to ? from : `${from} to ${to}`;
	if (from === to) return formatDay(start, true);
	if (start.year !== end.year) return `${formatDay(start, true)} to ${formatDay(end, true)}`;
	return `${formatDay(start, false)} to ${formatDay(end, true)}`;
}

export function formatTravellers(count: number | undefined): string {
	const people = count ?? 1;
	return people === 1 ? '1 traveller' : `${people} travellers`;
}

export interface SearchSummary {
	/** "BCN to OTP", spoken. The screen renders the arrow separately so a screen reader
	 * never has to read a glyph out loud. */
	originAirport: string;
	destinationAirport: string;
	dates: string;
	travellers: string;
	/** So a caller can leave the party size out when it is the default of one, which is
	 * most searches and a whole line of nothing on a phone. */
	travellerCount: number;
	/** The whole thing on one line, for a document title or an aria-label. */
	label: string;
}

export function summarizeSearch(query: SearchQuery): SearchSummary {
	const dates = formatDateRange(query.soonestDeparture, query.latestArrival);
	const travellers = formatTravellers(query.travellers);
	return {
		originAirport: query.originAirport,
		destinationAirport: query.destinationAirport,
		dates,
		travellers,
		travellerCount: query.travellers ?? 1,
		label: `${query.originAirport} to ${query.destinationAirport}, ${dates}, ${travellers}`
	};
}
