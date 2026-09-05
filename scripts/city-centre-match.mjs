// The rule that decides whether a GeoNames record is allowed to be an airport's city
// centre (issue #198). Pure and separately tested in city-centre-match.test.mjs, because
// this is where a wrong answer would hide: a table that quietly names the wrong city is
// worse than the eleven hand-checked entries it replaces, since nobody re-checks a row
// that looks confident.
//
// The runner (prepare-city-centres.mjs) does the downloading and indexing. Everything
// here is a function of its arguments.

/**
 * Case, accents and punctuation removed, so "Sankt Pölten", "sankt polten" and
 * "Sankt-Poelten" compare equal but "Aarhus" and "Århus" still do not — that second pair
 * is why the runner has an alternate-names pass. Deliberately NOT a fuzzy match: an edit
 * distance would start pairing Cork with Kork, and the whole point of this rule is that a
 * reviewer can say why any single row passed.
 */
export function normalizeCityName(value) {
	return value
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

/** Great-circle kilometres. Same formula as `src/lib/geo`, repeated here because a build
 * script cannot import a `$lib` alias and this is four lines. */
export function haversineKm(a, b) {
	const earthRadiusKm = 6371;
	const toRadians = (degrees) => (degrees * Math.PI) / 180;
	const dLat = toRadians(b.latitude - a.latitude);
	const dLon = toRadians(b.longitude - a.longitude);
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLon / 2) ** 2;
	return 2 * earthRadiusKm * Math.asin(Math.sqrt(h));
}

/**
 * How far a city centre is allowed to be from the runway that serves it.
 *
 * This is `DEFAULT_STAY_RADIUS_KM` from `src/lib/search/resources.ts`, and it has to be:
 * that constant is how far the app will look for a bed around a stopover, so a centre
 * further away than this is a point the stay search can never reach. `resources.test.ts`
 * already asserts the invariant against every airport that has a centre — "if a stay
 * search cannot reach the centre of a city whose name the app prints on the card, the
 * radius is too small" — and it is what caught a first draft of this rule that used 60.
 * Repeated as a literal because a build script cannot import a `$lib` module; that test
 * is what keeps the two in agreement, and it now checks three thousand rows rather than
 * ten.
 *
 * 50 is also the right number on this rule's own terms. The longest honest match in the
 * current dataset is Stansted to central London at 48.7 km. Above it the accepted matches
 * turn into prefecture-level Chinese airports whose municipality is the prefecture city —
 * `CNI "Dalian (Changhai)"` resolving to Dalian 100 km away, a different place from the
 * island the runway is on — and into the marketed-city lie `airport-city-names.ts` already
 * refuses to tell, Girona sold as Barcelona at 75.7 km.
 */
export const MAX_CENTRE_DISTANCE_KM = 50;

/**
 * Two candidates this close together are the same conurbation, not a choice between
 * cities, so the bigger one is the one a traveller means. This is what turns
 * `Orio al Serio (1,662 people, 4.1 km)` into `Bergamo (121,200 people, 4.4 km)`, and it
 * also settles the duplicate rows GeoNames carries for one city where one copy has a
 * population of zero.
 */
export const SAME_CONURBATION_KM = 5;

/** A GeoNames populated place, trimmed to the columns this rule reads. */
/**
 * @typedef {object} Place
 * @property {string} id GeoNames id, so any accepted row can be opened at geonames.org/<id>
 * @property {string} name
 * @property {number} latitude
 * @property {number} longitude
 * @property {number} population
 */

/**
 * Picks one city centre for an airport, or nothing.
 *
 * `tiers` is candidate places grouped by which of the airport's names found them, best
 * name first. The tiers matter: the name this app PRINTS for an airport is its own answer
 * to "what city is this", and it has to outrank the raw municipality rather than lose to
 * it on distance. Without that, Malpensa resolves to Ferno — the village of 6,000 next to
 * the runway, 2.8 km away — instead of Milan 35 km away, and the app would print a city
 * centre for a place it never calls the city. The first tier that yields anything wins,
 * even when a later tier holds something closer.
 *
 * Within one tier: nearest, then bigger when two are effectively in the same place.
 *
 * @param {{latitude: number, longitude: number}} airport
 * @param {readonly (readonly Place[])[]} tiers
 * @returns {{place: Place, km: number, tier: number} | null}
 */
export function chooseCityCentre(airport, tiers) {
	for (const [tier, places] of tiers.entries()) {
		const near = places
			.map((place) => ({ place, km: haversineKm(airport, place), tier }))
			.filter((candidate) => candidate.km <= MAX_CENTRE_DISTANCE_KM)
			.sort((a, b) => a.km - b.km);
		if (near.length === 0) continue;

		let best = near[0];
		for (const candidate of near) {
			if (
				candidate.km - best.km <= SAME_CONURBATION_KM &&
				candidate.place.population > best.place.population
			) {
				best = candidate;
			}
		}
		return best;
	}
	return null;
}

/** Four decimals is about 11 m, which is as precise as "the middle of a city" deserves to
 * be, and it is what the hand-checked entries in `airport-city-names.ts` already use. */
export function roundCoordinate(value) {
	return Number(value.toFixed(4));
}
