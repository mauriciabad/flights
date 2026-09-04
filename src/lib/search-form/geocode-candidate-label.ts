/**
 * Turns a geocode candidate into the text LocationField's suggestion list and committed
 * input show. Issue #64: "Barcelona is a city in Spain and also one in Venezuela, so
 * returning one silent guess is wrong" — the reason a search resolves to a list rather
 * than one picked point only holds if the list actually reads differently per candidate,
 * which is this function's whole job. Kept as a plain function, not inlined in the
 * component, so the disambiguation wording has its own unit test rather than only being
 * exercised through the component.
 */

import type { GeocodeCandidate } from '$lib/providers/geocode/types';

const regionNames =
	typeof Intl !== 'undefined' && 'DisplayNames' in Intl ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;

function countryDisplayName(countryCode: string | undefined): string | undefined {
	if (!countryCode) return undefined;
	if (!regionNames) return countryCode;
	try {
		const name = regionNames.of(countryCode);
		return name && name !== countryCode ? name : countryCode;
	} catch {
		// Intl.DisplayNames#of throws RangeError on a malformed code.
		return countryCode;
	}
}

/**
 * The most specific area below country level that actually matched the query, e.g.
 * "Catalunya" for a Barcelona (ES) result versus "Anzoátegui" for Barcelona (VE) — the
 * detail that separates two same-named candidates when the country alone still leaves
 * more than one place with that name. `undefined` is the common case (the country already
 * disambiguates), not a failure.
 */
function matchedRegion(candidate: GeocodeCandidate): string | undefined {
	return candidate.areas.find((area) => area.matched && area.adminLevel > 2 && area.name !== candidate.name)?.name;
}

/** e.g. "Barcelona — Catalunya, Spain", or "Barcelona — Venezuela" absent a matched
 * region, or bare "Somewhere" when even the country is unknown. */
export function describeGeocodeCandidate(candidate: GeocodeCandidate): string {
	const trail = [matchedRegion(candidate), countryDisplayName(candidate.countryCode)].filter(
		(part): part is string => Boolean(part)
	);
	return trail.length ? `${candidate.name} — ${trail.join(', ')}` : candidate.name;
}
