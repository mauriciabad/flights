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

import type { Airport, AirportSizeClass, City, Coordinates, Country } from '$lib/domain';

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

function toAirport(row: AirportDatasetRow): Airport {
	const coordinates: Coordinates = { latitude: row.latitude, longitude: row.longitude };
	const country: Country = {
		isoCode: row.countryCode,
		name: countryName(row.countryCode) ?? row.countryCode
	};
	const city: City = {
		name: row.city,
		// OurAirports has no separate city geometry, only the airport's. That is close
		// enough for this app's proximity checks (e.g. "hotels within 100km" in the
		// brief), which already operate at city/airport granularity rather than needing
		// a precise city-centre point.
		coordinates,
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

let airportsPromise: Promise<Airport[]> | null = null;
let indexPromise: Promise<Map<string, Airport>> | null = null;

/**
 * Loads the compact dataset on first call and memoizes it for the lifetime of the page.
 * A dynamic `import()` of a JSON file is its own chunk under Vite/Rollup, so nothing
 * downloads until something actually calls this — the "compact JSON that lazy-loads"
 * issue #11 asks for, and testable directly under Node (no `fetch`, no dev server) since
 * it is still a module import rather than a network request.
 */
export function loadAirports(): Promise<Airport[]> {
	airportsPromise ??= import('./airports.generated.json').then((mod) =>
		(mod.default as AirportDatasetRow[]).map(toAirport)
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
 * Typeahead search for the search form (issue #11: "a search matching IATA, city name and
 * airport name"). Ranks an exact IATA match first, then IATA/city/name prefix matches,
 * then substring matches, so typing "vie" surfaces Vienna before any airport that merely
 * mentions Vienna in its full name.
 */
export async function searchAirports(
	query: string,
	limit = MAX_SEARCH_RESULTS
): Promise<Airport[]> {
	const q = query?.trim().toLowerCase();
	if (!q) return [];

	const list = await loadAirports();
	const ranked: { airport: Airport; rank: number }[] = [];

	for (const airport of list) {
		const iata = airport.iataCode.toLowerCase();
		const city = airport.city.name.toLowerCase();
		const name = airport.name.toLowerCase();

		let rank: number;
		if (iata === q) rank = 0;
		else if (iata.startsWith(q)) rank = 1;
		else if (city.startsWith(q)) rank = 2;
		else if (name.startsWith(q)) rank = 3;
		else if (city.includes(q)) rank = 4;
		else if (name.includes(q)) rank = 5;
		else continue;

		ranked.push({ airport, rank });
	}

	ranked.sort((a, b) => a.rank - b.rank || a.airport.iataCode.localeCompare(b.airport.iataCode));
	return ranked.slice(0, limit).map((r) => r.airport);
}

/**
 * What `iconForCity`/`iconForAirport` return. `glyph` is always plain text (an emoji,
 * never an `<img src>`), which is what makes the lookup structurally total: there is no
 * URL to 404, so "renders a broken image" is not a failure mode this type can even
 * represent (issue #11 acceptance: "Every airport in a result renders an icon or a
 * deliberate placeholder, never a broken one").
 */
export interface LocationIcon {
	kind: 'flag' | 'placeholder';
	glyph: string;
	label: string;
}

const PLACEHOLDER_ICON: LocationIcon = {
	kind: 'placeholder',
	glyph: '📍',
	label: 'Unknown location'
};

// Regional-indicator flag emoji exist for every A-Z pair, not just real ISO codes, so this
// never throws — it just sometimes renders as two letter tiles on fonts without a flag for
// an unusual code. Both are still plain text, never a broken image.
function flagEmoji(isoCode: string | null | undefined): string | null {
	const cc = isoCode?.trim().toUpperCase();
	if (!cc || !/^[A-Z]{2}$/.test(cc)) return null;
	const codePoints = [...cc].map((char) => 0x1f1e6 - 65 + char.charCodeAt(0));
	return String.fromCodePoint(...codePoints);
}

/**
 * City and country icon lookup (issue #11: "the airports include icons for the city or
 * country").
 *
 * The brief's suggestion, https://github.com/anto1/city-icons, was checked before writing
 * this and rejected on both grounds the issue asks about:
 *   - Coverage: 273 cities total (per its own README), a small fraction of the ~3,500
 *     distinct cities this dataset's scheduled-service airports serve.
 *   - Licence: no LICENSE file, and GitHub's own API reports `license: null` for the
 *     repo. Its README states the icons are "free for personal and educational use" with
 *     commercial use "requires permission" — there is no grant to redistribute the SVGs
 *     inside another site's static assets, which is what bundling them here would do.
 *
 * So every lookup falls back to the country flag, exactly as the issue describes for a
 * missing city icon — there is just no case where a city-specific icon is available to
 * fall back from. Flags are rendered as Unicode emoji rather than vendored SVGs: it needs
 * no asset files, no licence, and, as above, no image URL to ever come back broken.
 */
export function iconForCity(city: Pick<City, 'country'> | null | undefined): LocationIcon {
	const emoji = flagEmoji(city?.country.isoCode);
	if (!emoji) return PLACEHOLDER_ICON;
	return {
		kind: 'flag',
		glyph: emoji,
		label: `Flag of ${city?.country.name ?? city?.country.isoCode}`
	};
}

/** Same lookup, taking an `Airport` (or nothing) directly. */
export function iconForAirport(airport: Pick<Airport, 'city'> | null | undefined): LocationIcon {
	if (!airport) return PLACEHOLDER_ICON;
	return iconForCity(airport.city);
}
