import { describe, expect, it } from 'vitest';
import {
	classifyRoomKind,
	flattenGeoCities,
	mapPropertiesToStays,
	mapPropertyToStays,
	nightsBetweenDates,
	rankCitiesNear,
	toMoney
} from './hostelworld-mapper';
import type { HostelworldContinentCountriesResponse, HostelworldProperty } from './hostelworld-types';
import continentEurope from './fixtures/hostelworld-continent-europe.json';
import continentNorthAmerica from './fixtures/hostelworld-continent-north-america.json';
import propertiesLondon from './fixtures/hostelworld-properties-london.json';

/**
 * Every fixture is a real response captured on 2026-09-04. The properties one is the
 * acceptance trip's own stopover — London, check-in 2026-10-09, three nights, one guest,
 * EUR, price-sorted — trimmed of marketing prose and image galleries with every field the
 * mapper reads left intact. The two continent fixtures are `/continents/{3,1}/countries/`
 * cut down to England and Cyprus, and to four Canadian cities. Hostelworld is keyless and
 * unmetered, so capturing them cost nobody anything.
 */
const londonProperties = propertiesLondon.properties as HostelworldProperty[];
const europe = continentEurope as HostelworldContinentCountriesResponse;
const northAmerica = continentNorthAmerica as HostelworldContinentCountriesResponse;

/** From `airports.generated.json`: the acceptance search's three connection airports and
 * its destination. */
const GATWICK = { latitude: 51.148744, longitude: -0.185739 };
const MANCHESTER = { latitude: 53.353744, longitude: -2.27495 };
const BIRMINGHAM = { latitude: 52.453856, longitude: -1.74803 };
const PAPHOS = { latitude: 34.717999, longitude: 32.485699 };

describe('nightsBetweenDates', () => {
	it('counts the acceptance trip stopover', () => {
		expect(nightsBetweenDates('2026-10-09', '2026-10-12')).toBe(3);
	});

	it('counts across a month boundary and a DST change', () => {
		// A calendar date is not an instant. If this were `new Date(string)` differenced in
		// local time, the 25-hour night when European clocks go back on 2026-10-25 would
		// round this to 6 or 8 depending on the machine's timezone.
		expect(nightsBetweenDates('2026-10-24', '2026-11-01')).toBe(8);
	});

	it('rejects anything that is not YYYY-MM-DD', () => {
		expect(nightsBetweenDates('2026-10-9', '2026-10-12')).toBeUndefined();
		expect(nightsBetweenDates('', '2026-10-12')).toBeUndefined();
	});

	it('reports a check-out on or before check-in rather than pretending it is one night', () => {
		expect(nightsBetweenDates('2026-10-12', '2026-10-12')).toBe(0);
		expect(nightsBetweenDates('2026-10-12', '2026-10-09')).toBe(-3);
	});
});

describe('toMoney', () => {
	it('takes the currency from the response, never from what was asked for', () => {
		expect(toMoney({ value: '26.44', currency: 'gbp' })).toEqual({
			minorUnits: 2644,
			currency: 'GBP'
		});
	});

	it('reads the digits rather than multiplying a float', () => {
		// The values every adapter that goes through a `Number()` needs a `Math.round` to
		// survive: `19.99 * 100` is 1998.9999999999998 in JavaScript.
		expect(toMoney({ value: '19.99', currency: 'EUR' })?.minorUnits).toBe(1999);
		expect(toMoney({ value: '39.68', currency: 'EUR' })?.minorUnits).toBe(3968);
		expect(toMoney({ value: '7', currency: 'EUR' })?.minorUnits).toBe(700);
		expect(toMoney({ value: '7.5', currency: 'EUR' })?.minorUnits).toBe(750);
	});

	it('scales by the currency exponent domain/money.ts holds, not one of its own', () => {
		// This adapter used to carry a private copy of the exponent table that put HUF in
		// the zero-decimal set. ISO 4217 gives the forint two, so that copy read every
		// forint price 100x too small — the #179 bug, in the file that arrived after it was
		// fixed everywhere else. These three assertions fail the moment anyone reintroduces
		// a local table.
		expect(toMoney({ value: '45000.00', currency: 'HUF' })?.minorUnits).toBe(4500000);
		expect(toMoney({ value: '3500', currency: 'JPY' })?.minorUnits).toBe(3500);
		expect(toMoney({ value: '1.500', currency: 'KWD' })?.minorUnits).toBe(1500);
	});

	it('drops a price with no currency rather than assuming one', () => {
		expect(toMoney({ value: '26.44' })).toBeUndefined();
		expect(toMoney({ currency: 'EUR' })).toBeUndefined();
		expect(toMoney(undefined)).toBeUndefined();
	});

	it('refuses anything that is not a plain decimal', () => {
		// A signed, formatted or exponential value is a parse failure, never a price: a
		// negative room rate is not a discount and "€ 26.44" is Hostelworld's UI, not its data.
		for (const bad of ['-1.00', '1e3', '1,234.00', '€26.44', '', 'free', '..']) {
			expect(toMoney({ value: bad, currency: 'EUR' })).toBeUndefined();
		}
	});
});

describe('classifyRoomKind', () => {
	it('reads Hostelworld own basicType taxonomy', () => {
		expect(classifyRoomKind({ basicType: 'Mixed Dorm' })).toBe('dorm');
		expect(classifyRoomKind({ basicType: 'Female Dorm' })).toBe('female-dorm');
		expect(classifyRoomKind({ basicType: 'Private' })).toBe('private');
		expect(classifyRoomKind({ basicType: 'Dbl Private' })).toBe('private');
	});

	it('tests female before dorm, since a female dorm satisfies both', () => {
		// Getting this order wrong prices a women-only room as mixed inventory, which is
		// exactly the distinction domain/stay.ts's `female-dorm` kind exists to keep.
		expect(classifyRoomKind({ basicType: '', name: '6 Bed Female Dorm Ensuite' })).toBe(
			'female-dorm'
		);
	});

	it('falls back to the display name when basicType is missing', () => {
		expect(classifyRoomKind({ name: '8 Bed Mixed Dorm Ensuite' })).toBe('dorm');
		expect(classifyRoomKind({ name: 'Twin Room' })).toBe('private');
	});

	it('classifies nothing it does not recognise', () => {
		expect(classifyRoomKind({})).toBeUndefined();
		expect(classifyRoomKind({ basicType: 'Camping Pitch' })).toBeUndefined();
	});
});

describe('mapPropertyToStays', () => {
	const named = (prefix: string) =>
		londonProperties.find((property) => property.name?.startsWith(prefix)) as HostelworldProperty;
	/** Cheapest bed in London for the acceptance dates, and the sharpest teaser gap. */
	const restUp = named('Rest Up London');
	/** The one property in the fixture that actually has female dorms. */
	const backpackers = named('London Backpackers');

	it('prices the stay average per night, not the cheapest single night', () => {
		// The whole reason this adapter reads `lowestAverage*`: Rest Up advertises 12.32 as
		// its "from" price for these dates while the three nights really average 19.07.
		// Reading the teaser would under-report the bed by 35% and call it a total.
		expect(restUp.lowestDormPricePerNight?.value).toBe('12.32');
		const dorm = mapPropertyToStays(restUp, 1).find((stay) => stay.roomKind === 'dorm');
		expect(dorm?.pricePerNight).toEqual({ minorUnits: 1907, currency: 'EUR' });
	});

	it('emits one Stay per priced room kind at the property', () => {
		expect(mapPropertyToStays(backpackers, 1).map((stay) => stay.roomKind).sort()).toEqual([
			'dorm',
			'female-dorm',
			'private'
		]);
		// A property with no female dorm gets two, not a third priced from nothing.
		expect(mapPropertyToStays(restUp, 1).map((stay) => stay.roomKind).sort()).toEqual([
			'dorm',
			'private'
		]);
	});

	it('takes the female-dorm price from the room list, the only place one exists', () => {
		const stays = mapPropertyToStays(backpackers, 1);
		const female = stays.find((stay) => stay.roomKind === 'female-dorm');
		// The cheaper of the two Female Dorms in `rooms.dorms`, 21.33 against 25.60.
		expect(female?.pricePerNight).toEqual({ minorUnits: 2133, currency: 'EUR' });
	});

	it('never prices a female dorm below the mixed one it is derived alongside', () => {
		// The property-level dorm average can draw on rates `rooms.dorms` does not list, so
		// the female figure is a real bookable rate that is not guaranteed to be the
		// cheapest female bed. That is safe in one direction only: too high loses to a mixed
		// dorm during ranking, too low would make a total look cheaper than it is.
		for (const property of londonProperties) {
			const stays = mapPropertyToStays(property, 1);
			const female = stays.find((stay) => stay.roomKind === 'female-dorm');
			const dorm = stays.find((stay) => stay.roomKind === 'dorm');
			if (!female || !dorm) continue;
			expect(female.pricePerNight.minorUnits).toBeGreaterThanOrEqual(dorm.pricePerNight.minorUnits);
		}
	});

	it('joins the two halves of an image URL and carries the rating with the scale it is on', () => {
		const stays = mapPropertyToStays(backpackers, 1);
		expect(stays[0].property.images[0]).toMatch(
			/^https:\/\/a\.hwstatic\.com\/propertyimages\/.+\.jpg$/
		);
		// #245: the value stays exactly as Hostelworld sent it, and `outOf` says which
		// scale that is, so a screen can never label it with somebody else's.
		expect(stays[0].property.rating).toEqual({ value: 88, outOf: 100 });
	});

	it('treats Hostelworld’s zero as "nobody has rated this", not as the worst score there is', () => {
		// #245. Measured live on 2026-09-05, city 3671 (Gatwick), the same property the issue
		// reported showing "0.0 rating" in the picker:
		//   The Gatwick White House Hotel
		//     overallRating  { overall: 0, numberOfRatings: "100" }
		//     ratingBreakdown { ratingsCount: 0, security: 0, ..., average: 0 }
		//   The Lawn Guest House
		//     overallRating  { overall: 100, numberOfRatings: "16" }
		//     ratingBreakdown { ratingsCount: 1, security: 100, ..., average: 100 }
		// `numberOfRatings` is not a count of ratings — `ratingBreakdown.ratingsCount` is,
		// and it is 0 for exactly the property scoring 0. Zero out of a hundred with a
		// hundred reviews is a claim nobody made.
		const unrated: HostelworldProperty = {
			...backpackers,
			overallRating: { overall: 0 }
		};
		expect(mapPropertyToStays(unrated, 1)[0].property.rating).toBeUndefined();
	});

	it('returns nothing for a hole in the properties array rather than throwing', () => {
		// Nothing here is a contract anyone owes us, so a null element is a missing property,
		// not a crash that takes a search down.
		expect(mapPropertyToStays(undefined, 1)).toEqual([]);
	});

	it('drops a property with no usable coordinates rather than placing it at 0,0', () => {
		const nowhere: HostelworldProperty = {
			name: 'Null Island Hostel',
			latitude: 0,
			longitude: 0,
			lowestAverageDormPricePerNight: { value: '10.00', currency: 'EUR' }
		};
		expect(mapPropertyToStays(nowhere, 1)).toEqual([]);
	});

	it('drops a property with no price rather than inventing one', () => {
		const unpriced: HostelworldProperty = { name: 'Sold Out', latitude: 51.5, longitude: -0.1 };
		expect(mapPropertyToStays(unpriced, 1)).toEqual([]);
	});

	it('charges a party of three for three dorm beds, and for one private room', () => {
		// Measured 2026-09-04, London 9-12 October: at `guests=1` and `guests=3` every price
		// in the response was identical while `totalNumberOfItems` fell 74 to 71. So `guests`
		// filters availability and never scales a number, and the figure that comes back is
		// the rate for one unit of inventory — one bed in a dorm, one room in a private.
		// `search/resources.ts` needs "one flat per-night figure for the whole party", so
		// the dorm one is multiplied here and the private one is not.
		const kind = (stays: ReturnType<typeof mapPropertyToStays>, k: string) =>
			stays.find((stay) => stay.roomKind === k)?.pricePerNight.minorUnits;

		const alone = mapPropertyToStays(backpackers, 1);
		const party = mapPropertyToStays(backpackers, 3);

		expect(kind(alone, 'dorm')).toBe(2133);
		expect(kind(party, 'dorm')).toBe(2133 * 3);
		expect(kind(alone, 'female-dorm')).toBe(2133);
		expect(kind(party, 'female-dorm')).toBe(2133 * 3);
		// One room sleeps the party, so this is the same number for both.
		expect(kind(party, 'private')).toBe(kind(alone, 'private'));
	});

	it('marks a women-only property from its name, the same way the other two mappers do', () => {
		// #207: "Hostelle - women only hostel London" reached the owner's party of zero
		// female travellers because both mappers of the day only ever tested the ROOM name.
		// Hostelworld exposes no structured field for it either, so this adapter has to make
		// the same call or it reintroduces the bug through a third door.
		const hostelle: HostelworldProperty = {
			name: 'Hostelle - women only hostel London',
			latitude: 51.5,
			longitude: -0.1,
			lowestAverageDormPricePerNight: { value: '20.00', currency: 'EUR' }
		};
		expect(mapPropertyToStays(hostelle, 1)[0].property.womenOnly).toBe(true);
		// An ordinary hostel is not quietly made unbookable for half the searches.
		expect(mapPropertyToStays(restUp, 1)[0].property.womenOnly).toBeUndefined();
	});

	it('treats a party size that is not a whole number of people as one traveller', () => {
		// A `NaN` or fractional multiplier would turn a real price into a fabricated one,
		// and this app would rather quote a single bed than quote nonsense.
		for (const bad of [0, -2, 1.5, Number.NaN]) {
			const stays = mapPropertyToStays(restUp, bad);
			expect(stays.find((stay) => stay.roomKind === 'dorm')?.pricePerNight.minorUnits).toBe(1907);
		}
	});
});

describe('mapPropertiesToStays', () => {
	it('keeps London hostels within 100km of Gatwick', () => {
		const stays = mapPropertiesToStays(londonProperties, GATWICK, 100, 1);
		expect(stays.length).toBeGreaterThan(0);
		expect(new Set(stays.map((stay) => stay.property.name)).size).toBe(londonProperties.length);
	});

	it('enforces the radius itself, because the endpoint is keyed by city and never saw it', () => {
		// Central London is roughly 40km from Gatwick, so a 10km radius must return nothing
		// even though Hostelworld happily answered for the city.
		expect(mapPropertiesToStays(londonProperties, GATWICK, 10, 1)).toEqual([]);
	});

	it('is what makes picking the wrong same-named city safe', () => {
		// London, Ontario. Nothing Hostelworld returns for it is within 100km of Gatwick, so
		// a mis-ranked candidate produces no stays instead of somebody else s continent.
		const ontario = { latitude: 42.9849, longitude: -81.2453 };
		expect(mapPropertiesToStays(londonProperties, ontario, 100, 1)).toEqual([]);
	});

	it('handles a missing properties array', () => {
		expect(mapPropertiesToStays(undefined, GATWICK, 100, 1)).toEqual([]);
	});
});

describe('flattenGeoCities', () => {
	it('flattens every country\'s cities out of one continent response', () => {
		const cities = flattenGeoCities(europe);
		// England's 51 plus Cyprus's 6, in the trimmed fixture.
		expect(cities).toHaveLength(57);
		expect(cities.find((city) => city.name === 'London')).toEqual({
			id: 3,
			name: 'London',
			coordinates: { latitude: expect.any(Number), longitude: expect.any(Number) }
		});
	});

	it('drops entries with no id, no name or no real coordinates', () => {
		const ragged: HostelworldContinentCountriesResponse = {
			countries: [
				{
					id: 1,
					name: 'Nowhere',
					cities: [
						{ id: 1, name: 'No coordinates' },
						{ id: 2, name: 'Null Island', latitude: 0, longitude: 0 },
						{ name: 'No id', latitude: 1, longitude: 1 },
						{ id: 4, latitude: 1, longitude: 1 },
						{ id: 5, name: 'Real', latitude: 1.5, longitude: 2.5 }
					]
				}
			]
		};
		expect(flattenGeoCities(ragged)).toEqual([
			{ id: 5, name: 'Real', coordinates: { latitude: 1.5, longitude: 2.5 } }
		]);
	});

	it('handles a response with no countries at all', () => {
		expect(flattenGeoCities(undefined)).toEqual([]);
		expect(flattenGeoCities({})).toEqual([]);
	});
});

describe('rankCitiesNear', () => {
	const cities = [...flattenGeoCities(europe), ...flattenGeoCities(northAmerica)];

	it('picks the city the airport serves over the one nearest to it', () => {
		// Measured 2026-09-04: the nearest Hostelworld city to Gatwick is "Gatwick" at 2km,
		// then Crawley at 3.6km, then Guildford, Lewes and Brighton. London is SIXTH, 39.3km
		// out — and London is where a three-night stopover actually happens.
		expect(rankCitiesNear(cities, GATWICK, 100, 'London')[0]).toBe(3);
	});

	it('does the same for the search\'s other two stopovers', () => {
		// Manchester Airport's nearest city is Macclesfield, not Manchester.
		const manchester = cities.find((city) => city.name === 'Manchester');
		const birmingham = cities.find((city) => city.name === 'Birmingham');
		expect(rankCitiesNear(cities, MANCHESTER, 100, 'Manchester')[0]).toBe(manchester?.id);
		expect(rankCitiesNear(cities, BIRMINGHAM, 100, 'Birmingham')[0]).toBe(birmingham?.id);
	});

	it('falls back to the nearest city when the name is unknown to Hostelworld', () => {
		// An airport whose city Hostelworld has never heard of still gets the nearest real
		// beds rather than nothing at all.
		const nearest = rankCitiesNear(cities, GATWICK, 100, 'Nowhere-in-particular');
		expect(cities.find((city) => city.id === nearest[0])?.name).toBe('Gatwick');
	});

	it('needs no preferred name at all', () => {
		expect(rankCitiesNear(cities, PAPHOS, 100, undefined)[0]).toBe(
			cities.find((city) => city.name === 'Paphos')?.id
		);
	});

	it('never leaves the radius, so the wrong continent cannot be picked', () => {
		// The North American cities in the index are thousands of kilometres away and must
		// not appear for a European airport at any preference.
		const canadian = new Set(flattenGeoCities(northAmerica).map((city) => city.id));
		const ranked = rankCitiesNear(cities, GATWICK, 100, 'London');
		expect(ranked.some((id) => canadian.has(id))).toBe(false);
	});

	it('returns nothing when no city is inside the radius', () => {
		// Mid-Atlantic. Reported as "no city here", never as the least-distant one anyway.
		expect(rankCitiesNear(cities, { latitude: 30, longitude: -40 }, 100, 'London')).toEqual([]);
	});

	it('matches a name past accents and punctuation', () => {
		const accented = [
			{ id: 99, name: 'Košice', coordinates: { latitude: 51.2, longitude: -0.2 } }
		];
		expect(rankCitiesNear(accented, GATWICK, 100, 'Kosice')).toEqual([99]);
	});
});
