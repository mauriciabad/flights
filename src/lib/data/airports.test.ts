import { describe, expect, it } from 'vitest';
import {
	deriveSizeClass,
	getAirport,
	iconForAirport,
	iconForCity,
	searchAirports,
	sizeClassOf
} from './airports';

describe('sizeClassOf', () => {
	it('classes a large hub as large', async () => {
		// Vienna International — large_airport in OurAirports.
		expect(await sizeClassOf('VIE')).toBe('large');
	});

	it('classes a regional airport as medium', async () => {
		// Alghero-Fertilia — medium_airport in OurAirports. Issue #11 acceptance:
		// sizeClassOf('VIE') and sizeClassOf('AHO') must return different classes.
		expect(await sizeClassOf('AHO')).toBe('medium');
	});

	it('returns undefined, never throws, for a code not in the dataset', async () => {
		await expect(sizeClassOf('ZZZ')).resolves.toBeUndefined();
	});
});

describe('deriveSizeClass', () => {
	it('maps the three OurAirports airport types', () => {
		expect(deriveSizeClass('large_airport')).toBe('large');
		expect(deriveSizeClass('medium_airport')).toBe('medium');
		expect(deriveSizeClass('small_airport')).toBe('small');
	});

	it('returns undefined for types outside the large/medium/small ladder', () => {
		expect(deriveSizeClass('seaplane_base')).toBeUndefined();
		expect(deriveSizeClass('heliport')).toBeUndefined();
		expect(deriveSizeClass(undefined)).toBeUndefined();
	});

	it('promotes a known high-volume hub even when OurAirports calls it medium', () => {
		// Regression guard: a hub in the curated passenger-volume list must win over a
		// medium_airport type, since that override exists specifically to correct cases
		// like this.
		expect(deriveSizeClass('medium_airport', 'AMS')).toBe('large');
	});
});

describe('getAirport', () => {
	it('finds a known airport by IATA code, case-insensitively, as a domain Airport', async () => {
		const airport = await getAirport('vie');
		expect(airport?.name).toContain('Vienna');
		expect(airport?.city.country.isoCode).toBe('AT');
		expect(airport?.sizeClass).toBe('large');
	});

	it('returns undefined rather than throwing for an unknown code', async () => {
		await expect(getAirport('ZZZ')).resolves.toBeUndefined();
		await expect(getAirport('')).resolves.toBeUndefined();
	});

	it('gives every airport a concrete sizeClass, even ones OurAirports cannot classify', async () => {
		// A scheduled seaplane base/heliport with an IATA code but no large/medium/small
		// OurAirports type — must still satisfy Airport.sizeClass being required.
		const airport = await getAirport('PPV'); // Port Protection Seaplane Base, AK
		expect(airport?.sizeClass).toBe('small');
	});
});

describe('searchAirports', () => {
	it('ranks an exact IATA match first', async () => {
		const results = await searchAirports('vie');
		expect(results[0]?.iataCode).toBe('VIE');
	});

	it('matches by city name', async () => {
		const results = await searchAirports('vienna');
		expect(results.some((a) => a.iataCode === 'VIE')).toBe(true);
	});

	it('returns nothing for a blank query rather than the whole dataset', async () => {
		expect(await searchAirports('   ')).toEqual([]);
	});

	// Issue #116: the owner typed "Boa Vista" looking for Boa Vista, Cabo Verde, and got
	// nothing — OurAirports' `municipality` for that airport is "Rabil", the
	// administrative district, and `name` is "Aristides Pereira International Airport".
	// Only `keywords` ("Boa Vista Island") has the name he actually typed.
	it('finds Boa Vista, Cabo Verde by keyword, not by its municipality or full name', async () => {
		const results = await searchAirports('Boa Vista');
		expect(results.some((a) => a.iataCode === 'BVC')).toBe(true);
	});

	// Same root cause, same issue: Paphos' `name` field only has the formal "Paphos", so
	// the common spelling "Pafos" is findable only through `keywords`.
	it('finds Paphos, Cyprus by the common spelling "Pafos", which lives only in keywords', async () => {
		const results = await searchAirports('Pafos');
		expect(results.some((a) => a.iataCode === 'PFO')).toBe(true);
	});

	it('matches diacritic-insensitively, so an unaccented query finds an accented name', async () => {
		// Málaga (AGP) also carries "Malaga" as one of its own keywords, so this alone
		// wouldn't prove the normalization works — Düsseldorf (DUS) has no keywords at
		// all, so this can only pass if `city` itself is compared without its umlaut.
		const results = await searchAirports('Dusseldorf');
		expect(results.some((a) => a.iataCode === 'DUS')).toBe(true);
	});

	it('matches the country name, including a common alias CLDR does not use', async () => {
		// Intl.DisplayNames reports iso code CV as "Cape Verde"; "Cabo Verde" is the
		// country's own 2013 renaming and how the owner would disambiguate the island
		// from Boa Vista, Roraima, Brazil (BVB) — this dataset's only other airport
		// whose city is named "Boa Vista".
		const results = await searchAirports('Cabo Verde');
		expect(results.some((a) => a.iataCode === 'BVC')).toBe(true);
	});

	it('disambiguates an island name from an unrelated same-named city using the country', async () => {
		const bareQuery = await searchAirports('Boa Vista');
		expect(bareQuery.map((a) => a.iataCode)).toEqual(expect.arrayContaining(['BVB', 'BVC']));

		// Adding the country narrows a query no single field satisfies on its own —
		// neither BVC's keywords nor its name contains "Cabo Verde", and its city
		// ("Rabil") has nothing to do with "Boa Vista" — to just the intended airport.
		const disambiguated = await searchAirports('Boa Vista Cabo Verde');
		expect(disambiguated.map((a) => a.iataCode)).toEqual(['BVC']);
	});

	// Issue #129: the owner typed "Paris" looking for a Ryanair fare into Beauvais —
	// which Ryanair itself books as "Paris Beauvais" — and got CDG, ORY and XCR back but
	// not BVA. OurAirports' own `keywords` column has nothing linking Beauvais to Paris
	// (confirmed against a fresh copy of the upstream CSV), unlike Warsaw Modlin or
	// Frankfurt-Hahn where the marketed city is already there; see
	// `MARKETED_CITY_KEYWORDS` in scripts/prepare-airports.mjs for why this one is a
	// small hand-written addition rather than a data-driven derivation.
	it('finds Paris-Beauvais by the city Ryanair markets it under, not just its own name', async () => {
		const results = await searchAirports('Paris');
		expect(results.some((a) => a.iataCode === 'BVA')).toBe(true);
	});

	// Same root cause as BVA, each confirmed missing from OurAirports' `keywords` for
	// that airport and added the same way: Girona and Reus are both sold as "Barcelona"
	// fares, Sandefjord Torp as "Oslo Torp", and Memmingen as "Munich West".
	it('finds other airports a budget carrier markets under a city they are not in', async () => {
		const barcelona = await searchAirports('Barcelona');
		expect(barcelona.map((a) => a.iataCode)).toEqual(expect.arrayContaining(['GRO', 'REU']));

		const oslo = await searchAirports('Oslo');
		expect(oslo.some((a) => a.iataCode === 'TRF')).toBe(true);

		const munich = await searchAirports('Munich');
		expect(munich.some((a) => a.iataCode === 'FMM')).toBe(true);
	});

	// Forlì has been sold and search-indexed as "Forlì-Bologna" since Ryanair's original
	// service there — also missing from OurAirports' `keywords`, also added by hand.
	it('finds Forlì by the "Bologna" name it has long been marketed under', async () => {
		const results = await searchAirports('Bologna');
		expect(results.map((a) => a.iataCode)).toEqual(expect.arrayContaining(['BLQ', 'FRL']));
	});

	// These four are already findable by their marketed city with no data addition at
	// all: Stockholm Skavsta and Frankfurt-Hahn have the city baked into OurAirports'
	// own `name` for the airport, Brussels South Charleroi the same, and Västerås'
	// `municipality` is already "Stockholm / Västerås". Regression guards, not fixes —
	// the owner's issue comment measured these as already working and this pins that.
	it('keeps finding secondary bases that were already findable by their marketed city', async () => {
		const stockholm = await searchAirports('Stockholm');
		expect(stockholm.map((a) => a.iataCode)).toEqual(
			expect.arrayContaining(['ARN', 'VST', 'BMA', 'NYO'])
		);

		const frankfurt = await searchAirports('Frankfurt');
		expect(frankfurt.map((a) => a.iataCode)).toEqual(expect.arrayContaining(['FRA', 'HHN']));

		const brussels = await searchAirports('Brussels');
		expect(brussels.map((a) => a.iataCode)).toEqual(expect.arrayContaining(['BRU', 'CRL']));

		// Treviso's OurAirports `keywords` already includes "Venice-Treviso".
		const venice = await searchAirports('Venice');
		expect(venice.some((a) => a.iataCode === 'TSF')).toBe(true);
	});

	it('never lets a keyword hit outrank a real city or name match', async () => {
		// Eday (EOI), a small Orkney airfield, carries "London Airport" as an old
		// OurAirports keyword unrelated to London the city. It must not bury Gatwick,
		// Heathrow or Stansted, whose `city` is genuinely "London".
		const results = await searchAirports('london');
		const eday = results.findIndex((a) => a.iataCode === 'EOI');
		const gatwick = results.findIndex((a) => a.iataCode === 'LGW');
		expect(gatwick).toBeGreaterThanOrEqual(0);
		if (eday >= 0) expect(eday).toBeGreaterThan(gatwick);
	});

	it('breaks ties within a rank by airport size, so a hub is not buried alphabetically', async () => {
		// Every "SF*" IATA code is an equally-good prefix match for "sf". Without a
		// size-based tie-break, alphabetical order alone would seat several minor
		// airports ahead of San Francisco.
		const results = await searchAirports('sf');
		const sfo = results.findIndex((a) => a.iataCode === 'SFO');
		expect(sfo).toBeGreaterThanOrEqual(0);
		for (const airport of results.slice(0, sfo)) {
			expect(airport.sizeClass).toBe('large');
		}
	});
});

describe('iconForCity / iconForAirport', () => {
	it('returns a flag for a known country', () => {
		const icon = iconForCity({ country: { isoCode: 'AT', name: 'Austria' } });
		expect(icon.kind).toBe('flag');
		expect(icon.glyph).toBe('🇦🇹');
		expect(icon.label).toContain('Austria');
	});

	it('returns a deliberate placeholder, not a throw, for an unrecognisable country', () => {
		expect(() => iconForCity({ country: { isoCode: '', name: '' } })).not.toThrow();
		const icon = iconForCity({ country: { isoCode: '', name: '' } });
		expect(icon.kind).toBe('placeholder');
		expect(icon.glyph).toBeTruthy();
		expect(icon.label).toBeTruthy();
	});

	it('is total for garbage or missing input', () => {
		expect(iconForCity({ country: { isoCode: 'NOTACODE', name: 'Nowhere' } })).toEqual(
			expect.objectContaining({ kind: 'placeholder' })
		);
		expect(iconForCity(null)).toEqual(expect.objectContaining({ kind: 'placeholder' }));
		expect(iconForCity(undefined)).toEqual(expect.objectContaining({ kind: 'placeholder' }));
		expect(iconForAirport(undefined)).toEqual(expect.objectContaining({ kind: 'placeholder' }));
		expect(iconForAirport(null)).toEqual(expect.objectContaining({ kind: 'placeholder' }));
	});

	it('resolves a full Airport to its country flag', async () => {
		const airport = await getAirport('VIE');
		const icon = iconForAirport(airport);
		expect(icon.kind).toBe('flag');
		expect(icon.glyph).toBe('🇦🇹');
	});
});
