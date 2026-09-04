import type { IataAirlineCode, IataAirportCode, IsoCountryCode } from './codes';
import type { IsoCalendarDate } from './datetime';
import type { Duration } from './duration';
import type { Location } from './location';
import type { LandingToTransportRule, WaitingTimeRule } from './waiting-time';

/** Brief line 33: "Number of people (default 1)." */
export const DEFAULT_TRAVELLERS = 1;

/** Brief line 37: "Min layover time (optional, default 30min)." */
export const DEFAULT_MIN_LAYOVER_TIME_MINUTES = 30 as Duration;

/**
 * Every input from the brief's Input list, lines 24-39. Field order matches that list.
 *
 * Kept flat and serialisable on purpose: the search form (issue #16) puts this in the URL
 * so a search can be shared and reloaded, which is also why airports and airlines are
 * plain codes here rather than embedded Airport/Carrier records — resolving a code to its
 * full dataset entry is a join the algorithm layer does, not something a shareable query
 * string should carry.
 */
export interface SearchQuery {
	/** Line 25. */
	soonestDeparture: IsoCalendarDate;
	/** Line 26. Default: latestArrival's value. This is a cross-field default, not a
	 * fixed value, so there is no DEFAULT_* constant for it — see issue #16's note that
	 * these defaults must be derived, not copied on blur. */
	latestDeparture?: IsoCalendarDate;
	/** Line 27. */
	latestArrival: IsoCalendarDate;
	/** Line 28. Default: soonestDeparture's value, same reasoning as latestDeparture
	 * above. */
	soonestArrival?: IsoCalendarDate;
	/** Line 29. */
	originLocation?: Location;
	/** Line 30. */
	originAirport: IataAirportCode;
	/** Line 31. */
	destinationAirport: IataAirportCode;
	/** Line 32. */
	destinationLocation?: Location;
	/** Line 33. Default: DEFAULT_TRAVELLERS. */
	travellers?: number;
	/** Line 34. No default: absent means "do not filter by female-only dorm
	 * availability", which is not the same thing as 0. Interpretation note lines
	 * 100-101: "It does not change pricing on its own, and it never gets used for
	 * anything else." */
	females?: number;
	/** Line 35 ("Forviden" in the brief is a typo for "Forbidden"). */
	forbiddenConnectionCountries?: IsoCountryCode[];
	forbiddenConnectionAirports?: IataAirportCode[];
	/** Line 36: still fetched and shown, just greyed out and scored down —
	 * interpretation note lines 102-103: never dropped from results. The actual
	 * scoring penalty is issue #14's concern, not this type's. */
	airlinesToAvoid?: IataAirlineCode[];
	/** Line 37. Default: DEFAULT_MIN_LAYOVER_TIME_MINUTES. */
	minLayoverTime?: Duration;
	/** Line 38. Absent means "all available" — issue #12: "an explicit allowed list of
	 * connection airports when the user gives one." */
	allowedConnectionAirports?: IataAirportCode[];
	/** Line 39, first half. Default: DEFAULT_WAITING_TIME_RULES (waiting-time.ts). */
	waitingTimeRules?: WaitingTimeRule[];
	/** Line 39, second half. Default: DEFAULT_LANDING_TO_TRANSPORT_RULES
	 * (waiting-time.ts). */
	landingToTransportRules?: LandingToTransportRule[];
}
