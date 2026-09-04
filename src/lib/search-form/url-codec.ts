import type {
	AirportSizeClass,
	Duration,
	FlightLengthClass,
	LandingToTransportRule,
	Location,
	WaitingTimeRule
} from '$lib/domain';
import { createDefaultFormFields, type SearchFormFields } from './model';

/**
 * Issue #16: "Serialise the query to the URL so a search can be shared and reloaded."
 *
 * This mirrors the *raw form fields* (`SearchFormFields`), not the resolved
 * `SearchQuery` from `model.ts`. That distinction matters for the two derived-default
 * pairs: if the URL stored the resolved `latestDeparture` value, reloading it would
 * populate the override input even when the user never set one, silently turning a
 * live derivation into a frozen copy the moment someone reloads the page - exactly the
 * bug the brief calls out for editing (see `model.ts`). Storing the override field
 * itself (present only when the user actually set one) keeps the derivation alive
 * across a reload: the resolved query still comes out identical, since deriving from
 * the reloaded `latestArrival` gives the same answer.
 *
 * One param per field, short but readable names. The two rule arrays get a compact
 * custom format rather than JSON, since `size:length:minutes` pairs stay legible in a
 * shared link where a URL-encoded JSON blob would not.
 */
const PARAM = {
	soonestDeparture: 'dep',
	latestDepartureOverride: 'depLatest',
	latestArrival: 'arr',
	soonestArrivalOverride: 'arrSoonest',
	originAirport: 'from',
	originLocation: 'fromLoc',
	destinationAirport: 'to',
	destinationLocation: 'toLoc',
	travellers: 'people',
	females: 'females',
	forbiddenConnectionCountries: 'avoidCountries',
	forbiddenConnectionAirports: 'avoidAirports',
	airlinesToAvoid: 'avoidAirlines',
	minLayoverTime: 'minLayover',
	allowedConnectionAirports: 'via',
	waitingTimeRules: 'wait',
	landingToTransportRules: 'transport'
} as const;

/** `label@lat,lon`, e.g. `Barcelona city centre@41.3851,2.1734`. `encodeURIComponent`
 * via `URLSearchParams` handles the spaces and punctuation in the label, so `@`/`,` are
 * safe to use as the internal separators here. */
function encodeLocation(location: Location): string {
	return `${location.label}@${location.coordinates.latitude},${location.coordinates.longitude}`;
}

function decodeLocation(value: string): Location | undefined {
	const at = value.lastIndexOf('@');
	if (at === -1) return undefined;
	const label = value.slice(0, at).trim();
	const [latRaw, lonRaw] = value.slice(at + 1).split(',');
	const latitude = Number(latRaw);
	const longitude = Number(lonRaw);
	if (!label || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
	return { label, coordinates: { latitude, longitude } };
}

const AIRPORT_SIZES = new Set<AirportSizeClass>(['small', 'medium', 'large']);
const FLIGHT_LENGTHS = new Set<FlightLengthClass>(['short', 'long']);

/** `*` marks "matches regardless of that dimension" (mirroring `WaitingTimeRule`'s own
 * optional fields), e.g. `*:*:120,large:long:180` for the brief's documented default. */
function encodeWaitingTimeRules(rules: WaitingTimeRule[]): string {
	return rules.map((r) => `${r.airportSize ?? '*'}:${r.flightLength ?? '*'}:${r.waitingTime}`).join(',');
}

/** Never throws on a malformed segment (a hand-edited or truncated URL is a real case,
 * not just a hypothetical) - it just drops that one segment and keeps the rest. */
function decodeWaitingTimeRules(value: string): WaitingTimeRule[] | undefined {
	const rules: WaitingTimeRule[] = [];
	for (const segment of value.split(',')) {
		if (!segment) continue;
		const [size, length, minutesRaw] = segment.split(':');
		const minutes = Number(minutesRaw);
		if (!Number.isFinite(minutes)) continue;
		const rule: WaitingTimeRule = { waitingTime: minutes as Duration };
		if (size && AIRPORT_SIZES.has(size as AirportSizeClass)) rule.airportSize = size as AirportSizeClass;
		if (length && FLIGHT_LENGTHS.has(length as FlightLengthClass)) rule.flightLength = length as FlightLengthClass;
		rules.push(rule);
	}
	return rules.length ? rules : undefined;
}

/** Same idea as `encodeWaitingTimeRules`, minus the flight-length axis: `*:15,large:30`. */
function encodeLandingToTransportRules(rules: LandingToTransportRule[]): string {
	return rules.map((r) => `${r.airportSize ?? '*'}:${r.time}`).join(',');
}

function decodeLandingToTransportRules(value: string): LandingToTransportRule[] | undefined {
	const rules: LandingToTransportRule[] = [];
	for (const segment of value.split(',')) {
		if (!segment) continue;
		const [size, minutesRaw] = segment.split(':');
		const minutes = Number(minutesRaw);
		if (!Number.isFinite(minutes)) continue;
		const rule: LandingToTransportRule = { time: minutes as Duration };
		if (size && AIRPORT_SIZES.has(size as AirportSizeClass)) rule.airportSize = size as AirportSizeClass;
		rules.push(rule);
	}
	return rules.length ? rules : undefined;
}

/** Every param is omitted rather than written empty, so a blank form round-trips to an
 * empty `URLSearchParams` instead of a URL full of `&foo=`. */
export function fieldsToSearchParams(fields: SearchFormFields): URLSearchParams {
	const params = new URLSearchParams();

	if (fields.soonestDeparture) params.set(PARAM.soonestDeparture, fields.soonestDeparture);
	if (fields.latestDepartureOverride) params.set(PARAM.latestDepartureOverride, fields.latestDepartureOverride);
	if (fields.latestArrival) params.set(PARAM.latestArrival, fields.latestArrival);
	if (fields.soonestArrivalOverride) params.set(PARAM.soonestArrivalOverride, fields.soonestArrivalOverride);
	if (fields.originAirport) params.set(PARAM.originAirport, fields.originAirport);
	if (fields.originLocation) params.set(PARAM.originLocation, encodeLocation(fields.originLocation));
	if (fields.destinationAirport) params.set(PARAM.destinationAirport, fields.destinationAirport);
	if (fields.destinationLocation) {
		params.set(PARAM.destinationLocation, encodeLocation(fields.destinationLocation));
	}
	if (fields.travellers !== undefined) params.set(PARAM.travellers, String(fields.travellers));
	if (fields.females !== undefined) params.set(PARAM.females, String(fields.females));
	if (fields.forbiddenConnectionCountries.length) {
		params.set(PARAM.forbiddenConnectionCountries, fields.forbiddenConnectionCountries.join(','));
	}
	if (fields.forbiddenConnectionAirports.length) {
		params.set(PARAM.forbiddenConnectionAirports, fields.forbiddenConnectionAirports.join(','));
	}
	if (fields.airlinesToAvoid.length) params.set(PARAM.airlinesToAvoid, fields.airlinesToAvoid.join(','));
	if (fields.minLayoverTime !== undefined) params.set(PARAM.minLayoverTime, String(fields.minLayoverTime));
	if (fields.allowedConnectionAirports.length) {
		params.set(PARAM.allowedConnectionAirports, fields.allowedConnectionAirports.join(','));
	}
	if (fields.waitingTimeRules?.length) {
		params.set(PARAM.waitingTimeRules, encodeWaitingTimeRules(fields.waitingTimeRules));
	}
	if (fields.landingToTransportRules?.length) {
		params.set(PARAM.landingToTransportRules, encodeLandingToTransportRules(fields.landingToTransportRules));
	}

	return params;
}

/** The inverse of `fieldsToSearchParams`, merged onto a blank form so a URL missing a
 * param (an old link, a hand-typed one) still yields a fully-shaped `SearchFormFields`
 * rather than a partial object callers have to null-check field by field. */
export function searchParamsToFields(params: URLSearchParams): SearchFormFields {
	const fields = createDefaultFormFields();
	const get = (key: string): string => params.get(key)?.trim() ?? '';

	fields.soonestDeparture = get(PARAM.soonestDeparture);
	fields.latestDepartureOverride = get(PARAM.latestDepartureOverride);
	fields.latestArrival = get(PARAM.latestArrival);
	fields.soonestArrivalOverride = get(PARAM.soonestArrivalOverride);
	fields.originAirport = get(PARAM.originAirport).toUpperCase();
	fields.destinationAirport = get(PARAM.destinationAirport).toUpperCase();

	const originLocation = params.get(PARAM.originLocation);
	if (originLocation) fields.originLocation = decodeLocation(originLocation);

	const destinationLocation = params.get(PARAM.destinationLocation);
	if (destinationLocation) fields.destinationLocation = decodeLocation(destinationLocation);

	const travellers = Number(params.get(PARAM.travellers));
	if (params.has(PARAM.travellers) && Number.isFinite(travellers)) fields.travellers = travellers;

	const females = Number(params.get(PARAM.females));
	if (params.has(PARAM.females) && Number.isFinite(females)) fields.females = females;

	const avoidCountries = get(PARAM.forbiddenConnectionCountries);
	if (avoidCountries) fields.forbiddenConnectionCountries = avoidCountries.split(',').filter(Boolean);

	const avoidAirports = get(PARAM.forbiddenConnectionAirports);
	if (avoidAirports) fields.forbiddenConnectionAirports = avoidAirports.split(',').filter(Boolean);

	const avoidAirlines = get(PARAM.airlinesToAvoid);
	if (avoidAirlines) fields.airlinesToAvoid = avoidAirlines.split(',').filter(Boolean);

	const minLayoverTime = Number(params.get(PARAM.minLayoverTime));
	if (params.has(PARAM.minLayoverTime) && Number.isFinite(minLayoverTime)) {
		fields.minLayoverTime = minLayoverTime;
	}

	const via = get(PARAM.allowedConnectionAirports);
	if (via) fields.allowedConnectionAirports = via.split(',').filter(Boolean);

	const wait = params.get(PARAM.waitingTimeRules);
	if (wait) fields.waitingTimeRules = decodeWaitingTimeRules(wait);

	const transport = params.get(PARAM.landingToTransportRules);
	if (transport) fields.landingToTransportRules = decodeLandingToTransportRules(transport);

	return fields;
}
