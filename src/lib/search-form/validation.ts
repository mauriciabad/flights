import { DEFAULT_TRAVELLERS } from '$lib/domain';
import type { SearchFormFields } from './model';

/**
 * Every way a search can be wrong, said in the field it is wrong in, before a single
 * provider request is spent on it.
 *
 * The owner's words, 2026-09-04: "I your UX standard was very low, you have to increase
 * it and add more validation on that." `buildSearchQuery` only ever answered one
 * question, "are the four required fields filled in", so a search from BCN to BCN, an
 * arrival before its own departure, a date last March and a party of zero people all
 * produced a valid-looking URL and an empty results page ten seconds later.
 *
 * This module is pure and framework-free so the rules can be tested without a browser.
 * The components decide when to show what.
 */

export type SearchFieldKey =
	| 'originAirport'
	| 'destinationAirport'
	| 'soonestDeparture'
	| 'latestArrival'
	| 'latestDepartureOverride'
	| 'soonestArrivalOverride'
	| 'travellers'
	| 'females'
	| 'minLayoverTime'
	| 'allowedConnectionAirports'
	| 'forbiddenConnectionAirports'
	| 'forbiddenConnectionCountries'
	| 'airlinesToAvoid';

/**
 * `blocking`: the query cannot describe a real trip whenever you run it. Two identical
 * airports never connect and an arrival before its own departure has no answer on any
 * date, so both the form and the results page refuse these.
 *
 * `advisory`: the query is well formed and the world has moved on. A date in the past is
 * the only one today. The form refuses to spend a search on it. The results page says so
 * and still runs, because a link shared last week going dead at midnight would surprise
 * its reader more than a sentence explaining what happened.
 */
export type IssueSeverity = 'blocking' | 'advisory';

export interface SearchFieldIssue {
	field: SearchFieldKey;
	message: string;
	severity: IssueSeverity;
}

/**
 * The four fields `buildSearchQuery` (model.ts) refuses to build a query without. Named
 * once here rather than re-derived at a call site, so "this link is missing its
 * destination" and "this link carries no search at all" can be told apart (issue #327).
 */
export const REQUIRED_SEARCH_FIELDS: ReadonlySet<SearchFieldKey> = new Set([
	'originAirport',
	'destinationAirport',
	'soonestDeparture',
	'latestArrival'
]);

/** The DOM id of each field's own input, so a caller can move focus to the first thing
 * that is wrong. These are set by hand on the components in `SearchForm.svelte`, and a
 * mismatch sends focus nowhere, which is why they live in one table. */
export const FIELD_INPUT_ID: Record<SearchFieldKey, string> = {
	originAirport: 'origin-airport',
	destinationAirport: 'destination-airport',
	soonestDeparture: 'soonest-departure',
	latestArrival: 'latest-arrival',
	latestDepartureOverride: 'latest-departure-override',
	soonestArrivalOverride: 'soonest-arrival-override',
	travellers: 'travellers',
	females: 'females',
	minLayoverTime: 'min-layover',
	allowedConnectionAirports: 'allowed-connection-airports',
	forbiddenConnectionAirports: 'forbidden-connection-airports',
	forbiddenConnectionCountries: 'forbidden-connection-countries',
	airlinesToAvoid: 'airlines-to-avoid'
};

const IATA_AIRPORT = /^[A-Z]{3}$/;
/** Airline codes are two characters and not always letters: U2 is easyJet, W6 is Wizz. */
const IATA_AIRLINE = /^[A-Z0-9]{2}$/;
const ISO_COUNTRY = /^[A-Z]{2}$/;

/** True only for a real calendar date written `YYYY-MM-DD`. `new Date('2026-02-31')`
 * rolls over to 3 March without complaining, so the round trip below is the check. */
export function isCalendarDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const [year, month, day] = value.split('-').map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	return (
		date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
	);
}

/** ISO dates sort as text, so comparing them needs no Date objects and no timezone. */
function isBefore(a: string, b: string): boolean {
	return a < b;
}

/**
 * Issue #327. Three letters that are not an airport is an ordinary thing to receive from
 * a URL, not a mistake somebody made today: a retired IATA code, a shared link with a
 * typo, an address bar someone edited. So it says which end of the trip the code was on
 * and how to replace it, rather than only that something is wrong.
 */
function unknownAirportMessage(code: string, end: 'from' | 'to'): string {
	return (
		`"${code}" is not an airport code we know. Check where you are flying ${end}, ` +
		'or type a city name and pick the airport from the list.'
	);
}

interface ValidateOptions {
	/** Today's calendar date where the traveller is, `YYYY-MM-DD`. Passed in rather than
	 * read off the clock so the rules stay pure and a test can sit on any date. */
	today: string;
	/**
	 * Whether a three-letter code names an airport in `$lib/data/airports`. Injected
	 * rather than imported so this module stays pure and synchronous, and so that a
	 * validator does not drag a 165KB generated dataset behind every caller
	 * (`results/search-dependencies.ts` keeps `resolveAirport` out of its own signature
	 * for the same reason). `$lib/data/known-airports.svelte.ts` is what components pass.
	 *
	 * Absent means "nobody can answer that here", never "not an airport". The dataset
	 * loads asynchronously, and a caller that read a missing answer as a failure would
	 * tell a traveller their real airport does not exist for as long as the download took.
	 */
	knowsAirport?: (code: string) => boolean;
}

/**
 * Every issue, in the order the form renders its fields, so "focus the first thing that
 * is wrong" and "read the list top to bottom" agree with what the eye sees.
 */
export function validateSearchFields(
	fields: SearchFormFields,
	{ today, knowsAirport }: ValidateOptions
): SearchFieldIssue[] {
	const issues: SearchFieldIssue[] = [];
	const add = (field: SearchFieldKey, message: string, severity: IssueSeverity = 'blocking') => {
		issues.push({ field, message, severity });
	};

	const origin = fields.originAirport.trim().toUpperCase();
	const destination = fields.destinationAirport.trim().toUpperCase();
	const soonestDeparture = fields.soonestDeparture.trim();
	const latestArrival = fields.latestArrival.trim();
	const latestDeparture = fields.latestDepartureOverride.trim();
	const soonestArrival = fields.soonestArrivalOverride.trim();

	if (!origin) {
		add('originAirport', 'Choose the airport you are flying from.');
	} else if (!IATA_AIRPORT.test(origin)) {
		add('originAirport', `An airport code is three letters, like BCN. "${origin}" is not one.`);
	} else if (knowsAirport && !knowsAirport(origin)) {
		add('originAirport', unknownAirportMessage(origin, 'from'));
	}

	if (!destination) {
		add('destinationAirport', 'Choose the airport you are flying to.');
	} else if (!IATA_AIRPORT.test(destination)) {
		add(
			'destinationAirport',
			`An airport code is three letters, like OTP. "${destination}" is not one.`
		);
	} else if (knowsAirport && !knowsAirport(destination)) {
		// Before "is it your origin too", so a link carrying the same retired code at both
		// ends says the useful thing twice rather than "ZZZ is also your origin".
		add('destinationAirport', unknownAirportMessage(destination, 'to'));
	} else if (destination === origin) {
		add('destinationAirport', `${origin} is also your origin. Pick somewhere else to fly to.`);
	}

	if (!soonestDeparture) {
		add('soonestDeparture', 'Pick the earliest date you could leave.');
	} else if (!isCalendarDate(soonestDeparture)) {
		add('soonestDeparture', 'Write the date as YYYY-MM-DD, for example 2026-10-06.');
	} else if (isBefore(soonestDeparture, today)) {
		add('soonestDeparture', `${soonestDeparture} has already passed. Pick a later date.`, 'advisory');
	}

	const departureUsable = Boolean(soonestDeparture) && isCalendarDate(soonestDeparture);

	if (!latestArrival) {
		add('latestArrival', 'Pick the latest date you need to have arrived by.');
	} else if (!isCalendarDate(latestArrival)) {
		add('latestArrival', 'Write the date as YYYY-MM-DD, for example 2026-10-12.');
	} else if (departureUsable && isBefore(latestArrival, soonestDeparture)) {
		add('latestArrival', `You cannot arrive before you leave. Pick ${soonestDeparture} or later.`);
	} else if (isBefore(latestArrival, today)) {
		add('latestArrival', `${latestArrival} has already passed. Pick a later date.`, 'advisory');
	}

	const arrivalUsable = Boolean(latestArrival) && isCalendarDate(latestArrival);

	if (latestDeparture) {
		if (!isCalendarDate(latestDeparture)) {
			add('latestDepartureOverride', 'Write the date as YYYY-MM-DD, for example 2026-10-08.');
		} else if (departureUsable && isBefore(latestDeparture, soonestDeparture)) {
			add(
				'latestDepartureOverride',
				`The latest departure cannot be before the soonest one, ${soonestDeparture}.`
			);
		} else if (arrivalUsable && isBefore(latestArrival, latestDeparture)) {
			add(
				'latestDepartureOverride',
				`You would still be leaving after ${latestArrival}, the day you need to have arrived.`
			);
		}
	}

	if (soonestArrival) {
		if (!isCalendarDate(soonestArrival)) {
			add('soonestArrivalOverride', 'Write the date as YYYY-MM-DD, for example 2026-10-10.');
		} else if (departureUsable && isBefore(soonestArrival, soonestDeparture)) {
			add(
				'soonestArrivalOverride',
				`You cannot arrive before you leave. Pick ${soonestDeparture} or later.`
			);
		} else if (arrivalUsable && isBefore(latestArrival, soonestArrival)) {
			add(
				'soonestArrivalOverride',
				`The soonest arrival cannot be after the latest one, ${latestArrival}.`
			);
		}
	}

	const travellers = fields.travellers;
	if (travellers !== undefined) {
		if (!Number.isInteger(travellers)) {
			add('travellers', 'Enter a whole number of people.');
		} else if (travellers < 1) {
			add('travellers', 'A trip needs at least one traveller.');
		}
	}

	const females = fields.females;
	if (females !== undefined) {
		if (!Number.isInteger(females)) {
			add('females', 'Enter a whole number, or leave this blank.');
		} else if (females < 0) {
			add('females', 'This cannot be negative.');
		} else {
			const partySize =
				travellers !== undefined && Number.isInteger(travellers) ? travellers : DEFAULT_TRAVELLERS;
			if (partySize >= 1 && females > partySize) {
				add(
					'females',
					`You listed ${females} female travellers in a party of ${partySize}. Raise the number of people, or lower this.`
				);
			}
		}
	}

	const minLayover = fields.minLayoverTime;
	if (minLayover !== undefined) {
		if (!Number.isInteger(minLayover)) {
			add('minLayoverTime', 'Enter a whole number of minutes.');
		} else if (minLayover < 0) {
			add('minLayoverTime', 'A layover cannot be shorter than no time at all.');
		}
	}

	const allowed = fields.allowedConnectionAirports.map((code) => code.toUpperCase());
	const forbiddenAirports = fields.forbiddenConnectionAirports.map((code) => code.toUpperCase());

	const badAllowed = allowed.find((code) => !IATA_AIRPORT.test(code));
	if (badAllowed) {
		add('allowedConnectionAirports', `"${badAllowed}" is not a three-letter airport code.`);
	} else {
		const endpoint = allowed.find((code) => code === origin || code === destination);
		const onBothLists = allowed.find((code) => forbiddenAirports.includes(code));
		if (endpoint) {
			add(
				'allowedConnectionAirports',
				`${endpoint} is already one end of this trip, so it cannot also be the stopover.`
			);
		} else if (onBothLists) {
			add(
				'allowedConnectionAirports',
				`${onBothLists} is on both lists, so nothing can match. Remove it from one of them.`
			);
		}
	}

	const badForbiddenAirport = forbiddenAirports.find((code) => !IATA_AIRPORT.test(code));
	if (badForbiddenAirport) {
		add(
			'forbiddenConnectionAirports',
			`"${badForbiddenAirport}" is not a three-letter airport code.`
		);
	}

	const badCountry = fields.forbiddenConnectionCountries
		.map((code) => code.toUpperCase())
		.find((code) => !ISO_COUNTRY.test(code));
	if (badCountry) {
		add(
			'forbiddenConnectionCountries',
			`"${badCountry}" is not a two-letter country code, like RU.`
		);
	}

	const badAirline = fields.airlinesToAvoid
		.map((code) => code.toUpperCase())
		.find((code) => !IATA_AIRLINE.test(code));
	if (badAirline) {
		add('airlinesToAvoid', `"${badAirline}" is not a two-character airline code, like FR or U2.`);
	}

	return issues;
}

/** One message per field, first issue wins, which is the shape a form binds to. */
export function issuesByField(issues: SearchFieldIssue[]): Partial<Record<SearchFieldKey, string>> {
	const map: Partial<Record<SearchFieldKey, string>> = {};
	for (const issue of issues) {
		if (map[issue.field] === undefined) map[issue.field] = issue.message;
	}
	return map;
}

/** Whether anything here makes the query impossible rather than merely stale. */
export function hasBlockingIssue(issues: SearchFieldIssue[]): boolean {
	return issues.some((issue) => issue.severity === 'blocking');
}
