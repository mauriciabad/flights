import {
	DEFAULT_LANDING_TO_TRANSPORT_RULES,
	DEFAULT_MIN_LAYOVER_TIME_MINUTES,
	DEFAULT_TRAVELLERS,
	DEFAULT_WAITING_TIME_RULES,
	type Duration,
	type IataAirportCode,
	type IsoCalendarDate,
	type LandingToTransportRule,
	type Location,
	type SearchQuery,
	type WaitingTimeRule
} from '$lib/domain';

/**
 * Everything issue #16's form collects, one field per row of the brief's Input list
 * (lines 24-39). This is deliberately a wider, rawer shape than `SearchQuery`:
 *
 * - The two cross-field pairs (lines 26 & 28) split into a required source field plus
 *   an *override*, e.g. `latestArrival` and `latestDepartureOverride`, rather than one
 *   field holding either a real value or a copied default. An empty override means
 *   "keep deriving this from the other field" (see `resolveLatestDeparture` below) -
 *   see issue #16: "implement those as derived values, not by copying a value into the
 *   other input on blur. Copying means editing one field silently stomps the other and
 *   the user cannot tell which value is real."
 * - Every other optional field is `undefined`/empty when the user hasn't touched it,
 *   which is also the wire shape of `SearchQuery` for anything whose brief default is
 *   "absent" (females, locations, forbidden/allowed lists - see the field comments on
 *   `SearchQuery`). Only `buildSearchQuery` below decides which of those emptinesses
 *   need a concrete fallback value and which stay absent.
 */
export interface SearchFormFields {
	soonestDeparture: string;
	/** Empty means "derive from `latestArrival`" (brief line 26). */
	latestDepartureOverride: string;
	latestArrival: string;
	/** Empty means "derive from `soonestDeparture`" (brief line 28). */
	soonestArrivalOverride: string;
	originAirport: string;
	originLocation: Location | undefined;
	destinationAirport: string;
	destinationLocation: Location | undefined;
	/** `undefined` means "use `DEFAULT_TRAVELLERS`", not 0 travellers. */
	travellers: number | undefined;
	/** `undefined` means "don't filter on this at all" - not the same as 0, see
	 * `SearchQuery.females`. */
	females: number | undefined;
	forbiddenConnectionCountries: string[];
	forbiddenConnectionAirports: string[];
	airlinesToAvoid: string[];
	/** `undefined` means "use `DEFAULT_MIN_LAYOVER_TIME_MINUTES`". */
	minLayoverTime: number | undefined;
	allowedConnectionAirports: string[];
	/** `undefined` means "the user hasn't customised this, use `DEFAULT_WAITING_TIME_RULES`".
	 * An empty array is treated the same way (see `buildSearchQuery`) since the tiered
	 * editor should never be able to produce a rule set with nothing in it. */
	waitingTimeRules: WaitingTimeRule[] | undefined;
	landingToTransportRules: LandingToTransportRule[] | undefined;
}

/** A blank form: every field either empty or its "derive/default" sentinel. Used both
 * as the form's initial state and as the base a URL's params get merged onto (issue
 * #16 acceptance: "leaving every optional field empty produces a valid search"). */
export function createDefaultFormFields(): SearchFormFields {
	return {
		soonestDeparture: '',
		latestDepartureOverride: '',
		latestArrival: '',
		soonestArrivalOverride: '',
		originAirport: '',
		originLocation: undefined,
		destinationAirport: '',
		destinationLocation: undefined,
		travellers: undefined,
		females: undefined,
		forbiddenConnectionCountries: [],
		forbiddenConnectionAirports: [],
		airlinesToAvoid: [],
		minLayoverTime: undefined,
		allowedConnectionAirports: [],
		waitingTimeRules: undefined,
		landingToTransportRules: undefined
	};
}

/**
 * Brief line 26's cross-field default, computed fresh every call rather than stored:
 * call this again after `latestArrival` changes and, so long as the override is still
 * blank, the answer moves with it. A component wraps this in `$derived` rather than an
 * effect that assigns into a second field, which is what keeps the two fields from
 * fighting each other when both change in the same tick.
 */
export function resolveLatestDeparture(
	fields: Pick<SearchFormFields, 'latestDepartureOverride' | 'latestArrival'>
): string {
	return fields.latestDepartureOverride.trim() || fields.latestArrival.trim();
}

/** Brief line 28's cross-field default. Same reasoning as `resolveLatestDeparture`. */
export function resolveSoonestArrival(
	fields: Pick<SearchFormFields, 'soonestArrivalOverride' | 'soonestDeparture'>
): string {
	return fields.soonestArrivalOverride.trim() || fields.soonestDeparture.trim();
}

/**
 * Turns raw form state into the `SearchQuery` the URL carries (issue #16's actual
 * deliverable - wiring it to a provider is the results issue's job). `null` means a
 * required field (brief lines 25, 27, 30, 31) is still missing; every other gap gets
 * either the brief's documented default value or is left out of the object entirely,
 * matching whichever behaviour `SearchQuery`'s own field comments describe:
 *
 * - travellers, minLayoverTime, waitingTimeRules, landingToTransportRules, and the two
 *   cross-field dates all have a concrete `DEFAULT_*` (or derived) value, so they are
 *   always present on the returned query.
 * - females, the two locations, the two forbidden lists, airlinesToAvoid and
 *   allowedConnectionAirports have no such constant: their brief default *is* absence
 *   ("do not filter", "all available"), so they stay unset unless the user gave one.
 */
export function buildSearchQuery(fields: SearchFormFields): SearchQuery | null {
	const soonestDeparture = fields.soonestDeparture.trim();
	const latestArrival = fields.latestArrival.trim();
	const originAirport = fields.originAirport.trim().toUpperCase();
	const destinationAirport = fields.destinationAirport.trim().toUpperCase();

	if (!soonestDeparture || !latestArrival || !originAirport || !destinationAirport) {
		return null;
	}

	const query: SearchQuery = {
		soonestDeparture: soonestDeparture as IsoCalendarDate,
		latestDeparture: resolveLatestDeparture(fields) as IsoCalendarDate,
		latestArrival: latestArrival as IsoCalendarDate,
		soonestArrival: resolveSoonestArrival(fields) as IsoCalendarDate,
		originAirport: originAirport as IataAirportCode,
		destinationAirport: destinationAirport as IataAirportCode,
		travellers: fields.travellers ?? DEFAULT_TRAVELLERS,
		minLayoverTime: (fields.minLayoverTime ?? DEFAULT_MIN_LAYOVER_TIME_MINUTES) as Duration,
		waitingTimeRules: fields.waitingTimeRules?.length ? fields.waitingTimeRules : DEFAULT_WAITING_TIME_RULES,
		landingToTransportRules: fields.landingToTransportRules?.length
			? fields.landingToTransportRules
			: DEFAULT_LANDING_TO_TRANSPORT_RULES
	};

	if (fields.originLocation) query.originLocation = fields.originLocation;
	if (fields.destinationLocation) query.destinationLocation = fields.destinationLocation;
	if (fields.females !== undefined) query.females = fields.females;
	if (fields.forbiddenConnectionCountries.length) {
		query.forbiddenConnectionCountries = fields.forbiddenConnectionCountries;
	}
	if (fields.forbiddenConnectionAirports.length) {
		query.forbiddenConnectionAirports = fields.forbiddenConnectionAirports;
	}
	if (fields.airlinesToAvoid.length) query.airlinesToAvoid = fields.airlinesToAvoid;
	if (fields.allowedConnectionAirports.length) {
		query.allowedConnectionAirports = fields.allowedConnectionAirports;
	}

	return query;
}
