/**
 * Issue #65: a coordinate-anchored, network-free alternative to reverse-geocoding for the
 * one case this app cares about most — "what city should a stay search near this airport
 * actually search for" — which both Nominatim and Transitous get wrong for a satellite
 * airport (agoda-client.ts's header: VIE resolves to "Fischamend", not "Vienna", because a
 * reverse geocoder returns the administrative area that literally contains the point, not
 * the notable city the airport is known to serve).
 *
 * The fix is not a smarter geocode call. It is not calling one at all when the coordinate
 * is already a known airport: `src/lib/data/airports.ts` (issue #11) already carries
 * OurAirports' own `municipality` column as `Airport.city.name` for every scheduled-service
 * airport, built at compile time from a source this app already ships. That field answers
 * "which city is this airport registered under" directly, for free, with no request spent —
 * and for the canonical satellite cases this issue names, it already says the right thing:
 * VIE -> "Vienna", Ciampino (CIA) -> "Rome", Charleroi (CRL) -> "Charleroi" (the airport's
 * real host city, not a Brussels rebrand), Girona (GRO) -> "Girona", Luton (LTN) -> "Luton".
 * Checked live against Transitous's reverse-geocode on 2026-09-04 — see this file's test and
 * the PR body for the full comparison table.
 *
 * ## The admin-level heuristic was tried and rejected — do not reintroduce it
 *
 * Issue #65 asked whether Transitous's `areas[]` trail (`adminLevel` plus `unique`/`default`
 * flags — see transitous-types.ts's `TransitousArea`) could pick a better level than the
 * deepest one, rather than trusting whichever name a geocoder hands back first. Tested live
 * against seven satellite airports (VIE, BGY, CIA, STN, LTN, CRL, GRO) on 2026-09-04: it
 * fixes some of them by pure coincidence and is unusable as a general rule.
 *
 * The scheme that looked promising — walk up from the `default`/`unique` leaf until the name
 * changes — needs a DIFFERENT number of levels for each airport: 0 for LTN (its containing
 * municipality already IS Luton, no satellite problem there), 1 for BGY (level 6, "Bergamo"
 * province, happens to share the city's name) and CRL (level 7/8, both literally
 * "Charleroi"), 2 for GRO (level 6, "Girona" province — level 7 "la Selva" is a comarca that
 * shares nobody's name). Blindly climbing a fixed number of levels makes LTN worse (jumps
 * straight to "England"), while doing nothing at all for VIE or STN, or for BGY and MXP's
 * real target, Milan: in every one of those, the served city is not an admin ancestor of the
 * containing municipality AT ANY LEVEL, because Vienna, London and Milan are disjoint
 * neighbouring jurisdictions, not parents of Fischamend, Uttlesford or Ferno. No amount of
 * climbing the SAME point's own hierarchy will ever produce a name that was never in it. See
 * the PR body for the full nine-airport transcript this conclusion is based on.
 *
 * So this file does not touch `areas[]` at all. It is a static-data lookup, nothing more;
 * `agoda.ts` still falls through to the existing Nominatim reverse-geocode
 * (agoda-client.ts) for any coordinate that is not one of this app's own known airports —
 * that path keeps its original, already-documented Fischamend-style limitation unchanged.
 *
 * ## The known remaining gap: Milan's satellite airports
 *
 * OurAirports' own `city` field is not always the marketed "serves this metro area" name —
 * it is the literal municipality the airport sits in, same failure mode as a geocoder's
 * default leaf. Bergamo (BGY) reads "Orio al Serio (BG)"; Malpensa (MXP) reads "Ferno (VA)";
 * Linate (LIN) reads "Segrate (MI)". None says "Milano". Transitous's own admin trail
 * confirms Milan is not an ancestor of any of the three at any level either (Ferno sits in
 * Varese province, not Milano's) — so this is not a parsing bug this file could fix by
 * reading a different field, it is a real, product-level "Milan's satellite airports have no
 * available signal pointing at Milan" gap. `docs/PROVIDERS.md` documents it rather than
 * hiding it behind a heuristic that only sometimes works; closing it for real needs the small
 * curated airport-to-city table issue #65 named as an alternative, which is out of scope
 * here (this file's job was the coordinate-driven mechanism, not a hand-maintained list).
 */

import { loadAirports } from '../../data/airports';
import type { Coordinates } from '../../domain';

/** OurAirports coordinates are given to 4-6 decimal places; a caller building
 * `StaySearchQuery.near` from `Airport.coordinates` copies that value through unchanged, so
 * this only needs to tolerate float noise, not real distance — ~11m at the equator, tight
 * enough that no two distinct scheduled-service airports in this dataset are ever this close
 * to each other. */
const COORDINATE_MATCH_TOLERANCE_DEGREES = 1e-4;

/**
 * OurAirports' `municipality` column, as shipped through `Airport.city.name`, sometimes
 * carries more than a bare city name:
 *
 * - A parenthetical qualifier: "Paris (Roissy-en-France, Val-d'Oise)", "Orio al Serio (BG)".
 *   The real name always comes before the paren.
 * - A "City, Region" pair: "Birmingham, West Midlands", "London, Essex". The real name
 *   always comes before the comma.
 *
 * Both conventions were checked against the 241 of 4,133 rows that use either (issue #65's
 * PR body has the full list) before trusting this as a general rule rather than something
 * fitted to the seven airports this issue names — the first segment is the city in every one
 * of them. A parenthetical is stripped before the comma split, not after, because at least
 * one real row (`CDG`: "Paris (Roissy-en-France, Val-d'Oise)") has its only comma INSIDE the
 * parenthetical — splitting on comma first would cut "Paris (Roissy-en-France" in half.
 */
export function primaryCityName(rawCityName: string): string {
	const withoutParenthetical = rawCityName.replace(/\s*\(.*$/, '');
	const [primary] = withoutParenthetical.split(',');
	return primary.trim();
}

/**
 * The "City, Country" text Agoda's free-text search wants (agoda-mapper.ts
 * `resolveLocationLabel`'s comment on the same format), built entirely from this app's own
 * OurAirports-derived dataset when `coordinates` matches a known airport — `undefined`
 * otherwise, so `agoda.ts` can fall through to its existing Nominatim reverse-geocode for a
 * coordinate that isn't a known airport (a landmark a person searched for, say). Doing this
 * lookup first also means an airport-anchored search never spends the Nominatim request at
 * all, not just that it gets a better answer than the request would have returned.
 */
export async function resolveAirportCityLabel(coordinates: Coordinates): Promise<string | undefined> {
	const airports = await loadAirports();
	const match = airports.find(
		(airport) =>
			Math.abs(airport.coordinates.latitude - coordinates.latitude) < COORDINATE_MATCH_TOLERANCE_DEGREES &&
			Math.abs(airport.coordinates.longitude - coordinates.longitude) < COORDINATE_MATCH_TOLERANCE_DEGREES
	);
	if (!match) return undefined;

	const city = primaryCityName(match.city.name);
	return city ? `${city}, ${match.country.name}` : undefined;
}
