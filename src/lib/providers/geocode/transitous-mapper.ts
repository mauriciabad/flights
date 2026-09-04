/**
 * Pure mapping from Transitous's geocode/reverse-geocode wire shape to `GeocodeCandidate`.
 * No I/O, same split as transfers/transitous-mapper.ts, so the scientific-notation
 * coordinate handling and the multi-candidate behaviour are exercised by fixtures, not a
 * live call (issue #64 acceptance: both need a test).
 */

import type { GeocodeAdminArea, GeocodeCandidate } from './types';
import type { TransitousGeocodePlace, TransitousGeocodeResponse } from './transitous-types';

/** Every place Transitous returned, most relevant first per its own ranking — this
 * function does not re-rank or drop any of them. Issue #64: "Barcelona is a city in Spain
 * and also one in Venezuela... Return candidates and let the caller choose", so narrowing
 * to one is deliberately not this function's job. */
export function mapGeocodeResponseToCandidates(response: TransitousGeocodeResponse): GeocodeCandidate[] {
	return response.map(mapPlace);
}

function mapPlace(place: TransitousGeocodePlace): GeocodeCandidate {
	return {
		name: place.name,
		// `lat`/`lon` arrive as ordinary JSON numbers even when Transitous prints them in
		// scientific notation ("4.1403983999999994E1") — that is still valid JSON number
		// syntax, so `Response.json()`/`JSON.parse` already produced a correct `number`
		// by the time it gets here. Nothing left to parse; this comment (and
		// transitous-mapper.test.ts) exists so nobody "fixes" this with a manual regex
		// parse that would only break on the exact shape it was meant to handle.
		coordinates: { latitude: place.lat, longitude: place.lon },
		countryCode: place.country,
		timeZone: place.tz,
		areas: mapAreas(place.areas)
	};
}

function mapAreas(areas: TransitousGeocodePlace['areas']): GeocodeAdminArea[] {
	if (!areas) return [];
	// Broadest-first (lowest adminLevel) is what every response observed so far already
	// returns, but sorting here rather than trusting array order costs one comparison per
	// area and means a caller's "Barcelona, Catalunya, Spain" trail stays right even if
	// Transitous ever changes its own ordering.
	return [...areas]
		.sort((a, b) => a.adminLevel - b.adminLevel)
		.map((area) => ({ name: area.name, adminLevel: area.adminLevel, matched: area.matched ?? false }));
}
