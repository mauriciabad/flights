import { describe, expect, it } from 'vitest';
import type { Coordinates } from '$lib/domain';
import {
	deriveSizeClass,
	getAirport,
	loadAirports,
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

	it('names the city a traveller would say, not the municipality the runway sits in', async () => {
		// Issue #136, straight off the real dataset: every one of these read as an
		// OurAirports municipality on a result card headed "Nights in ...".
		expect((await getAirport('BGY'))?.city.name).toBe('Bergamo');
		expect((await getAirport('MXP'))?.city.name).toBe('Milan');
		expect((await getAirport('MRS'))?.city.name).toBe('Marseille');
		expect((await getAirport('OTP'))?.city.name).toBe('Bucharest');
		expect((await getAirport('BVC'))?.city.name).toBe('Boa Vista');
		// Fixed by the structural cleanup alone, with no entry in the curated table.
		expect((await getAirport('STN'))?.city.name).toBe('London');
		expect((await getAirport('PSA'))?.city.name).toBe('Pisa');
		expect((await getAirport('CDG'))?.city.name).toBe('Paris');
	});

	it('leaves an airport that really is in its own town alone', async () => {
		expect((await getAirport('GRO'))?.city.name).toBe('Girona');
		expect((await getAirport('CRL'))?.city.name).toBe('Charleroi');
		expect((await getAirport('BCN'))?.city.name).toBe('Barcelona');
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

	it('still finds a renamed airport by the municipality it used to be listed under', async () => {
		// Issue #136 changed what these airports are CALLED. Nothing that used to find
		// them may stop working, so every replaced municipality stays in the search index.
		const orio = await searchAirports('Orio al Serio');
		expect(orio.map((a) => a.iataCode)).toContain('BGY');
		const rabil = await searchAirports('Rabil');
		expect(rabil.map((a) => a.iataCode)).toContain('BVC');
		const ferno = await searchAirports('Ferno');
		expect(ferno.map((a) => a.iataCode)).toContain('MXP');
	});

	it('finds an airport by the city it is now named after', async () => {
		expect((await searchAirports('Bergamo')).map((a) => a.iataCode)).toContain('BGY');
		expect((await searchAirports('Bucharest')).map((a) => a.iataCode)).toContain('OTP');
		expect((await searchAirports('Marseille')).map((a) => a.iataCode)).toContain('MRS');
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

describe('city coordinates (issue #162)', () => {
	const EARTH_RADIUS_KM = 6371;
	function distanceKm(a: Coordinates, b: Coordinates): number {
		const toRad = (deg: number) => (deg * Math.PI) / 180;
		const dLat = toRad(b.latitude - a.latitude);
		const dLon = toRad(b.longitude - a.longitude);
		const h =
			Math.sin(dLat / 2) ** 2 +
			Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
		return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
	}

	it('gives the acceptance trip its own stopover centres', async () => {
		// Issue #198's whole point. `docs/ACCEPTANCE.md`'s trip connects through London,
		// Manchester, Birmingham and Rome, and before the generated table none of the four
		// had a centre, so the feature this app is named for rendered as two empty rows on
		// the one journey the repo uses to decide whether it works.
		for (const code of ['LGW', 'MAN', 'BHX', 'FCO', 'PFO']) {
			expect((await getAirport(code))?.city.coordinates, code).toBeDefined();
		}
		// The generated point for LGW is GeoNames 2643743, central London.
		expect((await getAirport('LGW'))?.city.coordinates).toEqual({
			latitude: 51.5085,
			longitude: -0.1257
		});
	});

	it('says nothing rather than guessing when no city could be resolved', async () => {
		// Still about a quarter of the dataset, and still the honest answer. Each of these
		// is a real refusal, not an oversight: the app calls HHN "Frankfurt Hahn", which is
		// not a city; BSL's municipality is "Bâle / Mulhouse" and DFW's is
		// "Dallas-Fort Worth", two cities in one string that the rule will not pick between.
		for (const code of ['HHN', 'BSL', 'DFW']) {
			expect((await getAirport(code))?.city.coordinates, code).toBeUndefined();
		}
	});

	it('lets a hand-checked centre beat the generated one', async () => {
		// Malpensa is the case the ordering exists for. Its municipality is Ferno, a village
		// of 6,000 next to the runway, and the app calls the city Milan. `cityCentreOf` is
		// consulted first, and the generated file deliberately holds no MXP row at all.
		const malpensa = await getAirport('MXP');
		expect(malpensa?.city.coordinates).toEqual({ latitude: 45.4642, longitude: 9.1896 });
	});

	it('never names the marketed city of an airport that is nowhere near it', async () => {
		// `airport-city-names.ts` refuses to RENAME these, "because each is a real town far
		// from the city on the ticket". A generated centre could tell the same lie one layer
		// down by pointing Girona at Barcelona, so this checks the coordinate, not the name.
		const cases: readonly [string, Coordinates][] = [
			['GRO', { latitude: 41.3874, longitude: 2.1686 }], // Barcelona
			['TRF', { latitude: 59.9139, longitude: 10.7522 }], // Oslo
			['NYO', { latitude: 59.3293, longitude: 18.0686 }] // Stockholm
		];
		for (const [code, marketedCity] of cases) {
			const airport = (await getAirport(code))!;
			expect(airport.city.coordinates, code).toBeDefined();
			expect(distanceKm(airport.city.coordinates!, marketedCity), code).toBeGreaterThan(50);
		}
	});

	it('never hands back the runway position as the city point, for any airport', async () => {
		// Issue #162 itself, now checked across the whole dataset rather than the ten
		// hand-checked rows: a card printing "6.0 km from the airport" above "6.0 km from
		// the city centre" is the bug, and an identical coordinate is how it comes back.
		const airports = await loadAirports();
		const withCentre = airports.filter((airport) => airport.city.coordinates);
		expect(withCentre.length).toBeGreaterThan(3000);
		for (const airport of withCentre) {
			expect(airport.city.coordinates, airport.iataCode).not.toEqual(airport.coordinates);
		}
	});

	it('never puts a curated city point on top of the runway, which is the bug itself', async () => {
		// Issue #162's own example: "a hostel 2 km from Bergamo's old town and 6 km from the
		// runway reads 6.0 km from the airport, 6.0 km from the city centre".
		for (const code of ['BGY', 'OTP', 'ZAG', 'MXP', 'ATH', 'BRU', 'EDI', 'MRS', 'BVC']) {
			const airport = (await getAirport(code))!;
			expect(airport.city.coordinates, code).toBeDefined();
			expect(distanceKm(airport.coordinates, airport.city.coordinates!), code).toBeGreaterThan(1);
		}
	});

	it('keeps every curated city point near the airport it belongs to', async () => {
		// Loose on purpose, at 130 km: it clears Malpensa-to-Milan (~43 km) without letting a
		// transposed sign or a swapped latitude and longitude reach a shipped card.
		for (const code of ['BGY', 'MXP', 'LIN', 'MRS', 'OTP', 'BVC', 'ZAG', 'ATH', 'BRU', 'EDI']) {
			const airport = (await getAirport(code))!;
			expect(distanceKm(airport.coordinates, airport.city.coordinates!), code).toBeLessThan(130);
		}
	});

	it('gives Milan one city point, whichever of its airports was asked', async () => {
		const malpensa = await getAirport('MXP');
		const linate = await getAirport('LIN');
		expect(malpensa?.city.name).toBe('Milan');
		expect(linate?.city.name).toBe('Milan');
		expect(malpensa?.city.coordinates).toEqual(linate?.city.coordinates);
	});
});
