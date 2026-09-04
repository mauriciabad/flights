/**
 * Issue #136: what this app calls the place an airport serves, in one place, for both
 * the name it prints and the names it searches.
 *
 * OurAirports' `municipality` column is not a city name. It is the administrative unit
 * the runway sits in, which for a satellite airport is a village nobody has heard of:
 * BGY reads "Orio al Serio (BG)" (population 1,700), MXP reads "Ferno (VA)", MRS reads
 * "Marignane, Bouches-du-Rhône", BVC reads "Rabil". Shipped straight through as
 * `Airport.city.name` that produced "Nights in Orio al Serio (BG)" on a result card and
 * "no route out of Rabil (BVC)" in the empty-results copy, on a screen whose whole pitch
 * is a second city for free.
 *
 * ## Why this lives here and not in `scripts/prepare-airports.mjs`
 *
 * Issue #133 put a marketed-city table in the generator so "Paris" would find Beauvais.
 * Naming what we display is the same question asked once more, and answering it in a
 * second table would leave two lists to keep in agreement. This module is the single
 * answer, and it feeds both readers:
 *
 *   - `data/airports.ts` `toAirport` -> `Airport.city.name`, which every renderer reads
 *     (result card, map labels, filter chips, the empty-results sentences)
 *     and which `providers/geocode/airport-city.ts` hands to Agoda's free-text search.
 *   - `data/airports.ts` `loadSearchIndex` -> the typeahead's alternate names.
 *
 * It sits in `src/` rather than the generator so it is unit-tested with the rest of the
 * app, and so re-running `pnpm run data:airports` against a fresh upstream CSV cannot
 * quietly drop the editorial decisions below. The generated dataset stays a faithful
 * projection of OurAirports; the judgement about what to call a place is ours.
 *
 * ## Two rules, in order
 *
 * 1. A structural cleanup that needs no curation, applied to every airport.
 * 2. A short hand-checked list of airports the cleanup cannot reach.
 *
 * The cleanup alone fixes STN ("London, Essex"), PSA ("Pisa (PI)"), CDG
 * ("Paris (Roissy-en-France, Val-d'Oise)") and the other 240-odd rows that carry a
 * qualifier. The list below only exists for the airports whose municipality names a
 * genuinely different place from the one a traveller would say.
 */

import type { IataAirportCode } from '$lib/domain';

/**
 * One airport's naming, when OurAirports' own column is not enough.
 *
 * `city` and `alsoFoundAs` answer two different questions on purpose, and conflating
 * them is how an airport ends up claiming to be somewhere it is not. Girona is marketed
 * as "Barcelona" and is 100 km from it: a traveller must be able to FIND it by typing
 * Barcelona, and must never be TOLD they are spending six nights in Barcelona. So
 * `alsoFoundAs` reaches the search index only, and `city` is the only thing that gets
 * printed.
 */
interface AirportCityNaming {
	/** The city a traveller would name, when the (cleaned) municipality is not it.
	 * Omitted when OurAirports already gets it right and only search needs help. */
	city?: string;
	/** Extra names the typeahead should match. A city the airport is sold under but is
	 * not in, and nothing that ever reaches the screen. */
	alsoFoundAs?: readonly string[];
}

/**
 * Checked one airport at a time against a real report, the way issue #116 added
 * "Boa Vista" and "Pafos" and issue #129 added "Paris" for Beauvais. Every `city` below
 * is corroborated by the airport's own OurAirports `name` and by what the airline
 * selling the route calls it, both quoted per entry. This is deliberately not a rule
 * about airports within some radius of a hub: that would rename real regional airports
 * no carrier markets that way, which is the mistake the display name has to avoid.
 *
 * Airports NOT listed here, on purpose:
 *
 * - CRL (Brussels South Charleroi), GRO (Girona), REU (Reus), BVA (Beauvais),
 *   TRF (Sandefjord), FMM (Memmingen), NYO (Stockholm Skavsta). Each is a real town far
 *   from the city on the ticket, and its municipality already names that town correctly.
 *   Displaying the marketed city would be the same lie in the other direction. They keep
 *   `alsoFoundAs` so search still works, which is exactly what issue #133 established.
 * - PSA, STN, CDG, LTN and everything else with a parenthetical or a region suffix.
 *   `cleanMunicipality` below already handles them.
 */
const AIRPORT_CITY_NAMING: Readonly<Record<IataAirportCode, AirportCityNaming>> = {
	// "Il Caravaggio International Airport", OurAirports keyword "Milan Bergamo Airport";
	// Ryanair's own fare payload says `city: { name: "Bergamo" }`. Bergamo is 5 km away
	// and is a city people actually visit, so it is the name, with Milan searchable.
	BGY: { city: 'Bergamo', alsoFoundAs: ['Milan'] },
	// "Milan Malpensa International Airport". Ferno is a village next to the runway;
	// Malpensa is Milan's main long-haul airport and nobody calls it anything else.
	MXP: { city: 'Milan' },
	// "Milano Linate Airport", inside Milan's own urban area. Named alongside MXP because
	// a Milan search returns all three of these and naming them inconsistently would read
	// worse than either choice on its own.
	LIN: { city: 'Milan' },
	// "Marseille Provence Airport". Marignane is the commune; the airport is Marseille's.
	MRS: { city: 'Marseille' },
	// "Bucharest Henri Coandă International Airport", OurAirports keyword "BUH";
	// Ryanair's payload says `city: { name: "Bucharest" }`. Otopeni is the commune.
	OTP: { city: 'Bucharest' },
	// "Aristides Pereira International Airport" on Boa Vista island, municipality "Rabil".
	// docs/ACCEPTANCE.md's reference trip starts here, and the empty-results copy said
	// "no route out of Rabil (BVC)" for an airport the owner searched for as Boa Vista.
	// "Rabil" stays searchable without being listed: `citySearchAliases` keeps every
	// municipality it renames.
	BVC: { city: 'Boa Vista' },
	// "Frankfurt-Hahn Airport", 120 km from Frankfurt. Its municipality reads
	// "Frankfurt am Main (Lautzenhausen)", so the cleanup alone would promise the city
	// itself. The airport's own name is the honest middle: findable under Frankfurt,
	// never claiming to be in it.
	HHN: { city: 'Frankfurt Hahn' },

	// Search-only, moved here verbatim from `MARKETED_CITY_KEYWORDS` in
	// scripts/prepare-airports.mjs (issue #133) so one table answers both questions.
	// Each is a secondary airport a budget carrier sells under a big city's name while
	// the airport sits a real distance away.
	BVA: { alsoFoundAs: ['Paris'] }, // Beauvais-Tillé, ~85 km from Paris
	GRO: { alsoFoundAs: ['Barcelona'] }, // Girona-Costa Brava, ~100 km from Barcelona
	REU: { alsoFoundAs: ['Barcelona'] }, // Reus, ~100 km from Barcelona
	TRF: { alsoFoundAs: ['Oslo'] }, // Sandefjord Torp, ~110 km; booked as "Oslo Torp"
	FMM: { alsoFoundAs: ['Munich'] }, // Memmingen Allgäu, ~120 km; "Munich West"
	FRL: { alsoFoundAs: ['Bologna'] } // Forlì, ~70 km; long-standing "Forlì-Bologna"
};

/**
 * OurAirports' `municipality` sometimes carries more than a bare city name:
 *
 * - A parenthetical qualifier: "Orio al Serio (BG)", "Pisa (PI)",
 *   "Paris (Roissy-en-France, Val-d'Oise)". The real name comes before the paren.
 * - A "City, Region" pair: "London, Essex", "Birmingham, West Midlands", and the
 *   duplicated "Luton, Luton". The real name comes before the comma.
 *
 * Both conventions were checked against the 241 rows that use either (issue #65's PR
 * body has the full list) before being trusted as a general rule. The parenthetical is
 * stripped BEFORE the comma split, not after, because at least one real row (CDG) has
 * its only comma inside the parenthetical, and splitting on comma first would cut
 * "Paris (Roissy-en-France" in half.
 *
 * This function moved here from `providers/geocode/airport-city.ts`, where it was
 * `primaryCityName` and ran on the way out to Agoda only. Running it once, at the point
 * the dataset becomes `Airport` values, is what stopped the result card and the stay
 * search disagreeing about the same airport.
 */
export function cleanMunicipality(municipality: string): string {
	const withoutParenthetical = municipality.replace(/\s*\(.*$/, '');
	const [primary] = withoutParenthetical.split(',');
	return primary.trim();
}

/**
 * The one name this app prints for an airport's city. Falls back through the cleaned
 * municipality to the raw value, so a row with an unusual municipality still gets
 * something rather than an empty label.
 */
export function displayCityName(iataCode: IataAirportCode, municipality: string): string {
	const curated = AIRPORT_CITY_NAMING[iataCode]?.city;
	if (curated) return curated;
	return cleanMunicipality(municipality) || municipality;
}

/**
 * Extra strings the typeahead should match for this airport, beyond OurAirports' own
 * `keywords` and the name this app displays.
 *
 * The raw municipality is included whenever it differs from the display name, so
 * renaming an airport's city can never make it harder to find: "Orio al Serio (BG)" and
 * "London, Essex" both keep matching after their cards start reading Bergamo and London.
 */
export function citySearchAliases(
	iataCode: IataAirportCode,
	municipality: string
): readonly string[] {
	const display = displayCityName(iataCode, municipality);
	const marketed = AIRPORT_CITY_NAMING[iataCode]?.alsoFoundAs ?? [];
	if (!municipality || municipality === display) return marketed;
	return Array.from(new Set([municipality, ...marketed]));
}
