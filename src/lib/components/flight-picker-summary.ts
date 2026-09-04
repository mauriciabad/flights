/**
 * The one-line caption under a flight picker's heading, saying how wide the list of
 * alternatives actually is and which airlines it came from.
 *
 * Issue #137 asked for this by name: "The picker says where its list comes from and how
 * wide it is, so an empty or short list is understood rather than mistaken for 'this is the
 * only flight'." Before that issue, Ryanair returned exactly one fare per route however
 * wide the window, so every picker had a single row in it and read as a statement about the
 * route rather than about the search.
 *
 * Everything here is derived from the offers the picker already holds. It deliberately does
 * NOT claim which provider was asked or how many days were searched: the component is given
 * `FlightOffer[]` and nothing else, and a caption that invented a number would be exactly
 * the confident wrong sentence AGENTS.md warns against under "Show the error you got".
 */

import type { FlightOffer } from '../domain';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "1 Oct" from a wall-clock local string. Built from a fixed table rather than
 * `Intl.DateTimeFormat` for the same reason `itinerary-timeline-format.ts` does it: so the
 * abbreviation this app ships does not change with whatever ICU data the runtime carries. */
function formatShortDate(isoLocalDateTime: string): string {
	const month = Number(isoLocalDateTime.slice(5, 7));
	const day = Number(isoLocalDateTime.slice(8, 10));
	if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12) return '';
	return `${day} ${MONTH_NAMES[month - 1]}`;
}

function joinAirlines(names: string[]): string {
	if (names.length === 1) return names[0];
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names.length} airlines`;
}

/**
 * A sentence describing the alternatives on offer, or `undefined` when there is nothing
 * worth saying (no flights at all — the picker renders its rows and needs no caption).
 *
 * A single row gets the sentence that matters most: it says the search found one flight,
 * which is a fact about this search, rather than leaving the row to imply the route has one
 * flight, which would be a claim nobody checked.
 */
export function describeFlightOptions(flights: readonly FlightOffer[]): string | undefined {
	if (flights.length === 0) return undefined;

	const airlines = [...new Set(flights.map((flight) => flight.carrier.name).filter(Boolean))].sort();
	const from = airlines.length > 0 ? ` from ${joinAirlines(airlines)}` : '';

	if (flights.length === 1) return `Only one flight found on this route${from}.`;

	const dates = [...new Set(flights.map((flight) => flight.departure.local.slice(0, 10)))].sort();
	const flightCount = `${flights.length} flights`;

	if (dates.length === 1) return `${flightCount} on ${formatShortDate(dates[0])}${from}.`;

	const span = `${formatShortDate(dates[0])} to ${formatShortDate(dates[dates.length - 1])}`;
	return `${flightCount} across ${dates.length} dates, ${span}${from}.`;
}
