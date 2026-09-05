/**
 * Issue #11: the OurAirports dataset, trimmed to what a phone should actually download,
 * plus the lookups the rest of the app needs (a fast IATA lookup, a typeahead search, a
 * size class, and a total city/country icon lookup).
 *
 * `src/lib/domain/airport.ts` (issue #1) already owns the `Airport` / `City` / `Country`
 * shapes and the `AirportSizeClass` union, and its own comments say this dataset is what
 * fills them in ("kept separate from Airport mainly so its name, coordinates and country
 * can back the city icon lookup"). So this file builds `Airport` values directly rather
 * than defining a competing shape — the only type local to this file is the raw row read
 * off disk, which nothing outside this module ever sees.
 */

import type {
	Airport,
	AirportSizeClass,
	City,
	Coordinates,
	Country,
	IataAirportCode
} from '$lib/domain';
import { citySearchAliases, cityCentreOf, displayCityName } from './airport-city-names';
import { loadCityCentres } from './city-centres';

/**
 * One row of the generated dataset: OurAirports filtered to airports with an IATA code
 * and scheduled service, keeping only the fields this app reads (issue #11: "keep only
 * the fields actually used: IATA, ICAO, name, city, country, coordinates, type").
 * Rebuilt by `scripts/prepare-airports.mjs`. Not exported — `toAirport` below is the only
 * thing that needs to know this shape.
 */
interface AirportDatasetRow {
	iataCode: string;
	/** Absent for a small number of scheduled-service airports OurAirports has no ICAO
	 * code for (mostly small US/Pacific strips) — kept explicit rather than guessed. */
	icaoCode: string | null;
	name: string;
	city: string;
	/** ISO 3166-1 alpha-2, as OurAirports reports it (a few unofficial codes for
	 * disputed territories pass through unchanged, e.g. "XK" for Kosovo). */
	countryCode: string;
	latitude: number;
	longitude: number;
	/** Raw OurAirports `type` column, e.g. "large_airport" — input to `deriveSizeClass`.
	 * `Airport` has no field for this: `sizeClass` is the value the rest of the app
	 * actually keys off, and the raw OurAirports vocabulary is an implementation detail
	 * of computing it. */
	type: string;
	/** Alternate names from OurAirports' `keywords` column — "Boa Vista" for BVC, "Pafos"
	 * for PFO — the names travellers actually type, which `name` and `city` often are
	 * not (issue #116). Absent, not `[]`, when OurAirports has none for this airport.
	 * Search-only: it never reaches the domain `Airport` type `toAirport` builds below,
	 * since nothing outside search needs it. `airport-city-names.ts` adds more of the
	 * same kind (issue #136), which is why the search index below merges the two. */
	keywords?: string[];
}

/**
 * OurAirports' own `type` field is the primary size signal. It occasionally
 * under-classifies airports that move enormous passenger volume relative to their
 * runway count, budget-carrier bases especially, so a `medium_airport` in this list is
 * still treated as `large`.
 *
 * This is a static snapshot of the busiest airports worldwide by passenger traffic (ACI
 * World / Wikipedia's "List of the busiest airports by passenger traffic", most recently
 * published full-year figures) — not live data, since nothing here has a backend to
 * refresh it from. It goes stale slowly; that is an acceptable trade for having a
 * passenger-volume signal at all in a static-site build. Most of these are already
 * `large_airport` in OurAirports and this list changes nothing for them; it only matters
 * for the few that would otherwise land on `medium`.
 */
const HIGH_VOLUME_HUB_IATA_CODES: ReadonlySet<string> = new Set([
	'ATL',
	'DXB',
	'HND',
	'DFW',
	'DEN',
	'ORD',
	'LHR',
	'IST',
	'PVG',
	'CAN',
	'LAX',
	'CDG',
	'DEL',
	'JFK',
	'PEK',
	'CGK',
	'AMS',
	'MEX',
	'FRA',
	'ICN',
	'LAS',
	'MIA',
	'MAD',
	'PHX',
	'MCO',
	'HKG',
	'BKK',
	'SEA',
	'CLT',
	'SIN',
	'EWR',
	'IAH',
	'KUL',
	'MUC',
	'SFO',
	'SYD',
	'BCN',
	'LGA',
	'FCO',
	'MNL',
	'GRU',
	'IAD',
	'DUB',
	'JED',
	'YYZ',
	'BOM',
	'DOH',
	'BOG',
	'MSP',
	'DTW'
]);

/**
 * Pure so it is trivial to test without loading the dataset (issue #11 acceptance:
 * "sizeClassOf('VIE') and sizeClassOf('AHO') return different classes" — VIE is
 * `large_airport` in OurAirports, AHO is `medium_airport`, so they already differ before
 * the hub override even applies).
 *
 * Returns `undefined` for `seaplane_base` / `heliport` / anything else OurAirports uses
 * outside its large/medium/small ladder — a real case, not just a hypothetical: 125 of
 * the airports in this dataset have scheduled service and an IATA code but are seaplane
 * bases or heliports. `toAirport` below defaults those to `'small'` since `Airport.sizeClass`
 * is not optional on the domain type, but this function stays honest about not knowing.
 */
export function deriveSizeClass(
	type: string | null | undefined,
	iataCode?: string | null
): AirportSizeClass | undefined {
	if (iataCode && HIGH_VOLUME_HUB_IATA_CODES.has(iataCode.toUpperCase())) {
		return 'large';
	}
	switch (type) {
		case 'large_airport':
			return 'large';
		case 'medium_airport':
			return 'medium';
		case 'small_airport':
			return 'small';
		default:
			return undefined;
	}
}

const regionNames =
	typeof Intl !== 'undefined' && 'DisplayNames' in Intl
		? new Intl.DisplayNames(['en'], { type: 'region' })
		: null;

function countryName(countryCode: string): string | null {
	if (!regionNames) return null;
	try {
		const name = regionNames.of(countryCode);
		return name && name !== countryCode ? name : null;
	} catch {
		// Intl.DisplayNames#of throws RangeError on a malformed code.
		return null;
	}
}

/**
 * `Intl.DisplayNames` gives the CLDR English short name, which for a handful of
 * countries is not the name most people search by. Cabo Verde is issue #116 itself:
 * `Intl.DisplayNames(['en']).of('CV')` returns "Cape Verde", but "Cabo Verde" (the
 * country's own 2013 renaming, and the name on Boa Vista's own tourism board) is how
 * someone disambiguates the island from Boa Vista, Roraima, Brazil — the only other
 * scheduled-service airport this dataset has for that name.
 *
 * Deliberately kept to this one entry rather than every ISO short-name change (Czechia,
 * Eswatini, Timor-Leste, ...): those either already round-trip through `Intl.DisplayNames`
 * as-is or are not the specific ambiguity this issue reported. Add another only against a
 * real reported miss, the same way this one was found.
 */
const COUNTRY_NAME_ALIASES: Readonly<Record<string, readonly string[]>> = {
	CV: ['Cabo Verde']
};

function toAirport(
	row: AirportDatasetRow,
	generatedCentres: ReadonlyMap<IataAirportCode, Coordinates>
): Airport {
	const coordinates: Coordinates = { latitude: row.latitude, longitude: row.longitude };
	const country: Country = {
		isoCode: row.countryCode,
		name: countryName(row.countryCode) ?? row.countryCode
	};
	const city: City = {
		// Issue #136: the name a traveller would say, not the municipality the runway
		// sits in. `airport-city-names.ts` is the one place that decides this, and the
		// search index below draws its alternates from the same module.
		name: displayCityName(row.iataCode, row.city),
		// Issue #162: this was `coordinates` — the airport's own point, handed over as if
		// it were the city's. It read fine as long as nothing measured against it, and
		// two stay cards did, printing "6.0 km from the airport" directly above "6.0 km
		// from the city centre" for the same hotel.
		//
		// Hand-checked first, generated second (issue #198). That order is load-bearing:
		// the ten curated airports exist because their municipality names a different
		// place from the city on the ticket, which is exactly where a name-matching rule
		// is most likely to be wrong — it answers Ferno for Malpensa and Zaventem for
		// Brussels if you let it. `city-centres.ts` has the whole argument.
		//
		// Still `undefined` for about a quarter of the dataset, and that is still the
		// honest answer rather than "the airport will do": every reader drops the line it
		// cannot state instead of restating the airport's own position under a second
		// label.
		coordinates: cityCentreOf(row.iataCode) ?? generatedCentres.get(row.iataCode),
		country
	};

	return {
		iataCode: row.iataCode,
		icaoCode: row.icaoCode ?? undefined,
		name: row.name,
		coordinates,
		city,
		country,
		// Airport.sizeClass is required, but a handful of scheduled-service airports
		// (seaplane bases, heliports) have no large/medium/small equivalent in
		// OurAirports. Defaulting to 'small' keeps them in the dataset — they are real
		// scheduled routes some travellers search for — rather than silently dropping
		// them for lack of a size classification.
		sizeClass: deriveSizeClass(row.type, row.iataCode) ?? 'small'
	};
}

let rowsPromise: Promise<AirportDatasetRow[]> | null = null;
let airportsPromise: Promise<Airport[]> | null = null;
let indexPromise: Promise<Map<string, Airport>> | null = null;

/**
 * Loads the raw dataset rows once. A dynamic `import()` of the same specifier resolves
 * to the same cached module record every time (this is the JS module loader's own
 * cache, not something this file manages), so `loadAirports` and the search index below
 * sharing this does not fetch or parse the JSON twice.
 */
function loadRows(): Promise<AirportDatasetRow[]> {
	rowsPromise ??= import('./airports.generated.json').then(
		(mod) => mod.default as AirportDatasetRow[]
	);
	return rowsPromise;
}

/**
 * Loads the compact dataset on first call and memoizes it for the lifetime of the page.
 * A dynamic `import()` of a JSON file is its own chunk under Vite/Rollup, so nothing
 * downloads until something actually calls this — the "compact JSON that lazy-loads"
 * issue #11 asks for, and testable directly under Node (no `fetch`, no dev server) since
 * it is still a module import rather than a network request.
 */
export function loadAirports(): Promise<Airport[]> {
	// Both chunks in parallel: the centres table is a fifth of the size of the airport
	// rows, so waiting for it costs nothing, and doing it here rather than inside
	// `cityCentreOf` keeps that function synchronous for the ten hand-checked entries.
	airportsPromise ??= Promise.all([loadRows(), loadCityCentres()]).then(([rows, centres]) =>
		rows.map((row) => toAirport(row, centres))
	);
	return airportsPromise;
}

function loadIndex(): Promise<Map<string, Airport>> {
	indexPromise ??= loadAirports().then(
		(list) => new Map(list.map((airport) => [airport.iataCode, airport]))
	);
	return indexPromise;
}

/** Fast lookup by IATA code (issue #11: "A fast lookup by IATA code"). O(1) after the
 * dataset has loaded once; `undefined` for a code this dataset doesn't have, never a
 * throw. */
export async function getAirport(iataCode: string): Promise<Airport | undefined> {
	const code = iataCode?.trim().toUpperCase();
	if (!code) return undefined;
	const index = await loadIndex();
	return index.get(code);
}

/**
 * Size class for a lookup by IATA code, straight off the `Airport` this resolves to.
 * `undefined` means only one thing here — the code isn't in this dataset — since every
 * `Airport` this module produces already has a concrete `sizeClass` (see `toAirport`).
 */
export async function sizeClassOf(iataCode: string): Promise<AirportSizeClass | undefined> {
	return (await getAirport(iataCode))?.sizeClass;
}

const MAX_SEARCH_RESULTS = 8;

/**
 * Strips a string down to a diacritic- and case-insensitive comparison key. `NFD`
 * decomposes an accented character into its base letter plus separate combining marks
 * (e.g. "á" → "a" + U+0301), and the regex then drops those marks, so "Málaga" and
 * "Malaga" — or "Πάφου" and a search that happened to carry its own accents — compare
 * equal (issue #116: "Malaga" must find Málaga without the accent).
 */
function normalizeForSearch(value: string): string {
	return value
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase();
}

/** One airport's search-relevant text, normalized once at load time rather than on
 * every keystroke of every search. */
interface SearchEntry {
	airport: Airport;
	iata: string;
	city: string;
	name: string;
	country: string;
	countryAliases: string[];
	keywords: string[];
	/** Every field above joined with spaces, for the multi-word fallback below — lets
	 * "Boa Vista Cabo Verde" find BVC even though no single field contains that whole
	 * phrase (issue #116: matching the country name is how an ambiguous place name like
	 * an island gets disambiguated). */
	haystack: string;
}

let searchIndexPromise: Promise<SearchEntry[]> | null = null;

function loadSearchIndex(): Promise<SearchEntry[]> {
	searchIndexPromise ??= Promise.all([loadRows(), loadAirports()]).then(([rows, airports]) =>
		rows.map((row, i) => {
			const airport = airports[i];
			const countryAliases = (COUNTRY_NAME_ALIASES[row.countryCode] ?? []).map(
				normalizeForSearch
			);
			// OurAirports' own alternates plus this app's (issue #136), deduped because
			// a re-run of `pnpm run data:airports` removes the marketed names from the
			// generated file while a dataset generated before that still carries them.
			const keywords = Array.from(
				new Set([...(row.keywords ?? []), ...citySearchAliases(row.iataCode, row.city)])
			).map(normalizeForSearch);
			const iata = normalizeForSearch(airport.iataCode);
			const city = normalizeForSearch(airport.city.name);
			const name = normalizeForSearch(airport.name);
			const country = normalizeForSearch(airport.country.name);

			return {
				airport,
				iata,
				city,
				name,
				country,
				countryAliases,
				keywords,
				haystack: [iata, city, name, country, ...countryAliases, ...keywords].join(' ')
			};
		})
	);
	return searchIndexPromise;
}

const SIZE_CLASS_RANK: Record<AirportSizeClass, number> = { large: 0, medium: 1, small: 2 };

/**
 * Typeahead search for the search form (issue #11: "a search matching IATA, city name and
 * airport name"; issue #116: also `keywords` and the country name, diacritic-insensitively).
 *
 * Ranks an exact IATA match first, then prefix matches — IATA, city, airport name,
 * keyword, country — then the same fields again as substring matches, so typing "vie"
 * surfaces Vienna before any airport that merely mentions Vienna in its full name, and a
 * `keywords` hit (a nickname or old name) never outranks a real city/name match: typing
 * "London" must not bury Gatwick (`city` "London") under Eday, a remote Orkney airfield
 * whose OurAirports `keywords` happens to include "London Airport" as an old alias.
 *
 * A multi-word query that no single field satisfies falls back to requiring every word
 * somewhere in the airport's combined text, which is what lets "Boa Vista Cabo Verde"
 * disambiguate the Cabo Verde island from Boa Vista, Roraima, Brazil — the only other
 * scheduled-service "Boa Vista" in this dataset — even though neither field alone
 * contains the whole phrase.
 *
 * Ties within a rank favour the larger airport, then IATA code alphabetically, so a
 * two-letter query like "sf" surfaces San Francisco ahead of the dozen smaller "SF*"
 * codes that also match as an IATA prefix.
 */
export async function searchAirports(
	query: string,
	limit = MAX_SEARCH_RESULTS
): Promise<Airport[]> {
	const q = normalizeForSearch(query?.trim() ?? '');
	if (!q) return [];

	const index = await loadSearchIndex();
	const ranked: { airport: Airport; rank: number }[] = [];

	for (const entry of index) {
		const { iata, city, name, keywords, country, countryAliases } = entry;
		const countryMatches = (test: (field: string) => boolean) =>
			test(country) || countryAliases.some(test);
		const keywordMatches = (test: (field: string) => boolean) => keywords.some(test);

		let rank: number;
		if (iata === q) rank = 0;
		else if (iata.startsWith(q)) rank = 1;
		else if (city.startsWith(q)) rank = 2;
		else if (name.startsWith(q)) rank = 3;
		else if (keywordMatches((k) => k.startsWith(q))) rank = 4;
		else if (countryMatches((c) => c.startsWith(q))) rank = 5;
		else if (city.includes(q)) rank = 6;
		else if (name.includes(q)) rank = 7;
		else if (keywordMatches((k) => k.includes(q))) rank = 8;
		else if (countryMatches((c) => c.includes(q))) rank = 9;
		else {
			// Nothing in the query, as a whole, is a prefix or substring of any single
			// field. A multi-word query might still identify this airport by combining
			// words that live in different fields (a city and a country, say).
			const words = q.split(/\s+/).filter(Boolean);
			if (words.length > 1 && words.every((word) => entry.haystack.includes(word))) {
				rank = 10;
			} else {
				continue;
			}
		}

		ranked.push({ airport: entry.airport, rank });
	}

	ranked.sort(
		(a, b) =>
			a.rank - b.rank ||
			SIZE_CLASS_RANK[a.airport.sizeClass] - SIZE_CLASS_RANK[b.airport.sizeClass] ||
			a.airport.iataCode.localeCompare(b.airport.iataCode)
	);
	return ranked.slice(0, limit).map((r) => r.airport);
}

/*
 * No icon lookup lives here any more. It used to build a regional-indicator emoji from
 * `country.isoCode`, and the owner asked for real flags instead: "dont use scrapy emojis
 * for the flags, use flags svgs". `$lib/components/Flag.svelte` takes an
 * `Airport['country']` off the records this module already returns and draws a vendored
 * SVG. A function here that only reformatted an ISO code would be a second place to ask
 * the same question, which is the duplication the owner called out.
 *
 * Issue #11's "never a broken one" still holds structurally, one layer out: `Flag`
 * renders an `<img>` only for a code that has a file, so there is no URL that can 404.
 */
