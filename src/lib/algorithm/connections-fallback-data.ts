/**
 * Issue #12: "A bundled fallback route table so first paint and offline both work."
 *
 * A hand-curated snapshot of short-haul, low-cost routes across a couple dozen European
 * airports. It exists so `findConnectionCandidates` in `./connections.ts` can answer
 * "which cities could sit in the middle" before any network call has resolved (first
 * paint) and when there is no network at all (AGENTS.md rule 1: no backend, so "offline"
 * here means the browser itself has no connection, not a server being down).
 *
 * Not live data, not authoritative, and not a substitute for Ryanair's own route graph or
 * a real aggregator — both rank ahead of this table in `connections.ts`'s default source
 * order. This only has to be good enough to make "nothing yet" not the first thing a user
 * sees; it goes stale slowly, and that is an acceptable trade for a static site with no
 * backend to refresh it from.
 */

import type { AirportSizeClass, Coordinates, IataAirportCode, IsoCountryCode } from '../domain';

export interface FallbackAirportInfo {
	coordinates: Coordinates;
	sizeClass: AirportSizeClass;
	countryCode: IsoCountryCode;
}

/**
 * One entry per undirected pair. A budget-carrier short-haul route operates in both
 * directions in every case worth modelling here, so the adjacency map below is built by
 * mirroring this list rather than typing each direction separately — typing both ways by
 * hand is exactly how one direction of a pair quietly goes missing after an edit.
 */
const EDGES: ReadonlyArray<readonly [IataAirportCode, IataAirportCode]> = [
	['BCN', 'STN'],
	['BCN', 'LTN'],
	['BCN', 'CRL'],
	['BCN', 'DUB'],
	['BCN', 'FCO'],
	['BCN', 'CIA'],
	['BCN', 'MXP'],
	['BCN', 'BGY'],
	['BCN', 'VIE'],
	['BCN', 'WAW'],
	['BCN', 'KRK'],
	['BCN', 'BUD'],
	['MAD', 'STN'],
	['MAD', 'LTN'],
	['MAD', 'CRL'],
	['MAD', 'DUB'],
	['MAD', 'FCO'],
	['MAD', 'MXP'],
	['MAD', 'BUD'],
	['MAD', 'WAW'],
	['STN', 'DUB'],
	['STN', 'FCO'],
	['STN', 'CIA'],
	['STN', 'MXP'],
	['STN', 'BGY'],
	['STN', 'VIE'],
	['STN', 'WAW'],
	['STN', 'WMI'],
	['STN', 'BUD'],
	['STN', 'KRK'],
	['STN', 'OTP'],
	['STN', 'SOF'],
	['STN', 'ATH'],
	['LTN', 'DUB'],
	['LTN', 'FCO'],
	['LTN', 'MXP'],
	['LTN', 'BUD'],
	['LTN', 'WAW'],
	['LTN', 'ATH'],
	['CRL', 'DUB'],
	['CRL', 'FCO'],
	['CRL', 'CIA'],
	['CRL', 'MXP'],
	['CRL', 'BGY'],
	['CRL', 'BUD'],
	['CRL', 'WAW'],
	['CRL', 'KRK'],
	['CRL', 'SOF'],
	['CRL', 'ATH'],
	['CRL', 'OTP'],
	['DUB', 'FCO'],
	['DUB', 'MXP'],
	['DUB', 'BUD'],
	['DUB', 'WAW'],
	['DUB', 'KRK'],
	['FCO', 'VIE'],
	['FCO', 'WAW'],
	['FCO', 'BUD'],
	['FCO', 'ATH'],
	['CIA', 'BUD'],
	['CIA', 'WAW'],
	['CIA', 'KRK'],
	['CIA', 'SOF'],
	['MXP', 'VIE'],
	['MXP', 'BUD'],
	['MXP', 'WAW'],
	['MXP', 'ATH'],
	['BGY', 'BUD'],
	['BGY', 'WAW'],
	['BGY', 'KRK'],
	['VIE', 'WAW'],
	['VIE', 'BUD'],
	['VIE', 'OTP'],
	['VIE', 'SOF'],
	['VIE', 'ATH'],
	['VIE', 'KRK'],
	['WAW', 'BUD'],
	['WAW', 'KRK'],
	['BUD', 'ATH'],
	['SOF', 'ATH'],
	['KRK', 'BUD']
];

function buildAdjacency(
	edges: ReadonlyArray<readonly [IataAirportCode, IataAirportCode]>
): ReadonlyMap<IataAirportCode, readonly IataAirportCode[]> {
	const adjacency = new Map<IataAirportCode, IataAirportCode[]>();
	const addDirected = (from: IataAirportCode, to: IataAirportCode) => {
		const existing = adjacency.get(from);
		if (existing) existing.push(to);
		else adjacency.set(from, [to]);
	};
	for (const [a, b] of edges) {
		addDirected(a, b);
		addDirected(b, a);
	}
	return adjacency;
}

/** `IataAirportCode -> the codes it has a bundled direct route to`. Built once at module
 * load; the table above is small enough that this costs nothing worth memoizing further. */
export const FALLBACK_ROUTES = buildAdjacency(EDGES);

/**
 * Coordinates, size class and country for every airport referenced in `FALLBACK_ROUTES`.
 * `connections.ts` needs this alongside the route table itself: ranking a stopover by
 * detour distance and filtering by forbidden country both require it, and neither works
 * offline without a geography source of its own.
 */
export const FALLBACK_AIRPORTS: ReadonlyMap<IataAirportCode, FallbackAirportInfo> = new Map([
	['BCN', { coordinates: { latitude: 41.2971, longitude: 2.0785 }, sizeClass: 'large', countryCode: 'ES' }],
	['MAD', { coordinates: { latitude: 40.4936, longitude: -3.5668 }, sizeClass: 'large', countryCode: 'ES' }],
	['STN', { coordinates: { latitude: 51.885, longitude: 0.2389 }, sizeClass: 'large', countryCode: 'GB' }],
	['LTN', { coordinates: { latitude: 51.8747, longitude: -0.3683 }, sizeClass: 'medium', countryCode: 'GB' }],
	['CRL', { coordinates: { latitude: 50.4592, longitude: 4.4538 }, sizeClass: 'medium', countryCode: 'BE' }],
	['DUB', { coordinates: { latitude: 53.4213, longitude: -6.2701 }, sizeClass: 'large', countryCode: 'IE' }],
	['FCO', { coordinates: { latitude: 41.8003, longitude: 12.2389 }, sizeClass: 'large', countryCode: 'IT' }],
	['CIA', { coordinates: { latitude: 41.7994, longitude: 12.5949 }, sizeClass: 'medium', countryCode: 'IT' }],
	['MXP', { coordinates: { latitude: 45.6306, longitude: 8.7281 }, sizeClass: 'large', countryCode: 'IT' }],
	['BGY', { coordinates: { latitude: 45.6739, longitude: 9.7042 }, sizeClass: 'medium', countryCode: 'IT' }],
	['VIE', { coordinates: { latitude: 48.1103, longitude: 16.5697 }, sizeClass: 'large', countryCode: 'AT' }],
	['WAW', { coordinates: { latitude: 52.1657, longitude: 20.9671 }, sizeClass: 'large', countryCode: 'PL' }],
	['WMI', { coordinates: { latitude: 52.4511, longitude: 20.6518 }, sizeClass: 'small', countryCode: 'PL' }],
	['KRK', { coordinates: { latitude: 50.0777, longitude: 19.7848 }, sizeClass: 'medium', countryCode: 'PL' }],
	['BUD', { coordinates: { latitude: 47.4298, longitude: 19.2611 }, sizeClass: 'large', countryCode: 'HU' }],
	['OTP', { coordinates: { latitude: 44.5711, longitude: 26.085 }, sizeClass: 'medium', countryCode: 'RO' }],
	['SOF', { coordinates: { latitude: 42.6952, longitude: 23.4062 }, sizeClass: 'medium', countryCode: 'BG' }],
	['ATH', { coordinates: { latitude: 37.9364, longitude: 23.9445 }, sizeClass: 'large', countryCode: 'GR' }]
]);
