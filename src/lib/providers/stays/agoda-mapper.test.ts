import { describe, expect, it } from 'vitest';
import type { Property } from '../../domain';
import agodaGetPricesWombats from './fixtures/agoda-get-prices-wombats-hostel.json';
import agodaSearchVienna from './fixtures/agoda-search-vienna.json';
import nominatimFischamend from './fixtures/nominatim-fischamend.json';
import nominatimVienna from './fixtures/nominatim-vienna.json';
import type { AgodaGetPricesResponse, AgodaSearchResponse } from './agoda-types';
import {
	agodaCurrencyId,
	classifyAgodaRoomKind,
	extractHeadlinePrice,
	filterWithinRadius,
	mapGetPricesToStays,
	mapMasterRoomsToStays,
	mapSearchPropertyToCandidate,
	resolveLocationLabel,
	toMoney
} from './agoda-mapper';

const searchFixture = agodaSearchVienna as AgodaSearchResponse;
const wombatsFixture = agodaGetPricesWombats as AgodaGetPricesResponse;

describe('classifyAgodaRoomKind', () => {
	// Every name below is a real Agoda room type, captured live 2026-09-04 against
	// Wombat's City Hostel Vienna Naschmarkt (propertyId 417108) — see
	// fixtures/agoda-get-prices-wombats-hostel.json and the PR body's "hostel data"
	// section. `isDormitory` read `false` on all thirteen of these live, which is why it
	// plays no part in this function at all (see its own doc comment).
	it('classifies plain dorm rooms as dorm', () => {
		expect(classifyAgodaRoomKind('1 Person in 8-Bed Dormitory - Mixed')).toBe('dorm');
		expect(classifyAgodaRoomKind('Bed in 6 Bed Mixed Dormitory')).toBe('dorm');
		expect(classifyAgodaRoomKind('Bed in 4 Bed Mixed Dormitory Room with Ensuite Bathroom')).toBe('dorm');
	});

	it('classifies female-only dorm rooms as female-dorm', () => {
		expect(classifyAgodaRoomKind('1 Bed in 6 Bedded Female Room Ensuite')).toBe('female-dorm');
		expect(classifyAgodaRoomKind('1 Bed in 4 Bedded Female Room Ensuite')).toBe('female-dorm');
	});

	it('classifies ordinary rooms as private', () => {
		expect(classifyAgodaRoomKind('Double Room')).toBe('private');
		expect(classifyAgodaRoomKind('Twin Room')).toBe('private');
	});

	it('classifies a "Private N Bed Dorm" whole-room product as private, not dorm', () => {
		// The exact naming trap issue #10 warned to expect: a private room with bunk beds,
		// booked and priced as one whole unit (roughly 4-5x a per-bed dorm rate at the same
		// hostel), not a shared dorm bed.
		expect(classifyAgodaRoomKind('4 Bed Private Dorm')).toBe('private');
		expect(classifyAgodaRoomKind('Private 4 Bed Dorm Room')).toBe('private');
		expect(classifyAgodaRoomKind('Private 6 Bed Dorm Room')).toBe('private');
	});
});

describe('toMoney', () => {
	it('converts a 2-decimal currency using cents', () => {
		expect(toMoney(29.46, 'EUR')).toEqual({ minorUnits: 2946, currency: 'EUR' });
	});

	it('converts a 0-decimal currency without multiplying by 100', () => {
		expect(toMoney(1500, 'JPY')).toEqual({ minorUnits: 1500, currency: 'JPY' });
	});

	it('defaults to 2 decimal digits for an unmapped currency', () => {
		expect(toMoney(10, 'XYZ')).toEqual({ minorUnits: 1000, currency: 'XYZ' });
	});
});

describe('agodaCurrencyId', () => {
	it('resolves a known ISO code to its real, captured Agoda id', () => {
		expect(agodaCurrencyId('EUR')).toBe(1);
	});

	it('returns undefined for USD, which Agoda never lists as a selectable id', () => {
		expect(agodaCurrencyId('USD')).toBeUndefined();
	});

	it('returns undefined for an unmapped currency rather than guessing an id', () => {
		expect(agodaCurrencyId('THB')).toBeUndefined();
	});

	it('returns undefined when no currency was requested', () => {
		expect(agodaCurrencyId(undefined)).toBeUndefined();
	});
});

describe('resolveLocationLabel', () => {
	it('prefers city over the smaller settlement levels', () => {
		expect(resolveLocationLabel({ city: 'Vienna', town: 'Should not win', country: 'Austria' })).toBe('Vienna, Austria');
	});

	it('resolves Vienna city-centre coordinates to "Vienna, Austria" (real Nominatim capture)', () => {
		expect(resolveLocationLabel(nominatimVienna.address)).toBe('Vienna, Austria');
	});

	it('falls back to town when there is no city, matching the real VIE-airport case', () => {
		// Real finding, 2026-09-04: Vienna International Airport's coordinates reverse-geocode
		// to "Fischamend" (a town), never "Vienna" (a city) — captured live, not synthesised;
		// see agoda-client.ts `fetchReverseGeocode`'s doc comment for why this matters.
		expect(resolveLocationLabel(nominatimFischamend.address)).toBe('Fischamend, Austria');
	});

	it('falls back through village and hamlet when even town is absent', () => {
		expect(resolveLocationLabel({ village: 'Some Village', country: 'Austria' })).toBe('Some Village, Austria');
		expect(resolveLocationLabel({ hamlet: 'Some Hamlet', country: 'Austria' })).toBe('Some Hamlet, Austria');
	});

	it('returns undefined when Nominatim has no settlement name at all', () => {
		expect(resolveLocationLabel({ country: 'Austria' })).toBeUndefined();
	});
});

describe('mapSearchPropertyToCandidate (real fixture)', () => {
	const properties = searchFixture.data?.properties ?? [];

	it('maps an ordinary hotel with a live price to a candidate', () => {
		const mercure = properties.find((p) => p.propertyId === 50373);
		const candidate = mapSearchPropertyToCandidate(mercure!);
		expect(candidate).toMatchObject({
			propertyId: 50373,
			property: { name: 'Mercure Wien Westbahnhof Hotel' },
			headlinePrice: { currency: 'USD' }
		});
		expect(candidate?.property.images.length).toBeGreaterThan(0);
		expect(candidate?.property.images[0]).toMatch(/^https:/);
	});

	it('trims a trailing non-breaking space off a real property name', () => {
		// Wombat's City Hostel Vienna Naschmarkt came back from Agoda with a trailing
		// U+00A0, captured as-is in the fixture.
		const wombats = properties.find((p) => p.propertyId === 417108);
		const candidate = mapSearchPropertyToCandidate(wombats!);
		expect(candidate?.property.name).toBe("Wombat's City Hostel Vienna Naschmarkt");
	});

	it('skips a sold-out property entirely', () => {
		const soldOut = properties.find((p) => p.propertyId === 65548);
		expect(mapSearchPropertyToCandidate(soldOut!)).toBeUndefined();
	});
});

describe('extractHeadlinePrice / filterWithinRadius (synthetic)', () => {
	const property: Property = {
		name: 'Test Property',
		coordinates: { latitude: 48.2, longitude: 16.37 },
		images: []
	};

	it('drops candidates outside the requested radius', () => {
		const near = { property, propertyId: 1, headlinePrice: { minorUnits: 1000, currency: 'EUR' } };
		const far = {
			property: { ...property, coordinates: { latitude: 40, longitude: -3 } }, // Madrid-ish, far from Vienna
			propertyId: 2,
			headlinePrice: { minorUnits: 1000, currency: 'EUR' }
		};
		const result = filterWithinRadius([near, far], { latitude: 48.2082, longitude: 16.3738 }, 25);
		expect(result.map((c) => c.propertyId)).toEqual([1]);
	});
});

/**
 * Issue #68: this adapter has no captured evidence of Agoda ever sending a wrong-typed
 * field, but the scraper-API risk applies here the same as it does everywhere else in this
 * sweep. Each case below takes the same real, good fixture used above and corrupts exactly
 * one field a mapper function actually reads, asserting the corrupted item is dropped
 * (never a thrown error, never a fabricated price) — the "drop the bad item, keep the
 * rest" rule this adapter follows since real captured fixtures exist for it, unlike Kiwi.
 */
describe('runtime validation of an unverified field type (corrupted fixture)', () => {
	const properties = searchFixture.data?.properties ?? [];
	const mercure = properties.find((p) => p.propertyId === 50373)!;
	const wombatsMasterRoom = wombatsFixture.data?.roomGridData?.masterRooms?.[0]!;

	it('drops a candidate whose price is null rather than reporting a free stay', () => {
		// null * 100 === 0 in JavaScript — the exact "worst possible output" this issue
		// warns about: a wrong price that looks real instead of an error or a gap.
		const corrupted = {
			...mercure,
			pricing: {
				offers: [
					{
						roomOffers: [
							{
								room: {
									mseRoomSummaries: [
										{
											pricingSummaries: [
												{ currency: 'USD', price: { perRoomPerNight: { inclusive: { display: null as unknown as number } } } }
											]
										}
									]
								}
							}
						]
					}
				]
			}
		};
		expect(mapSearchPropertyToCandidate(corrupted)).toBeUndefined();
	});

	it('drops a candidate whose price is a non-numeric string rather than reporting NaN', () => {
		const corrupted = {
			...mercure,
			pricing: {
				offers: [
					{
						roomOffers: [
							{
								room: {
									mseRoomSummaries: [
										{
											pricingSummaries: [
												{ currency: 'USD', price: { perRoomPerNight: { inclusive: { display: 'N/A' as unknown as number } } } }
											]
										}
									]
								}
							}
						]
					}
				]
			}
		};
		expect(mapSearchPropertyToCandidate(corrupted)).toBeUndefined();
	});

	it('drops a candidate whose latitude is a string instead of crashing or coercing it', () => {
		const corrupted = {
			...mercure,
			content: {
				...mercure.content,
				informationSummary: {
					...mercure.content?.informationSummary,
					geoInfo: { latitude: '48.2' as unknown as number, longitude: 16.37 }
				}
			}
		};
		expect(mapSearchPropertyToCandidate(corrupted)).toBeUndefined();
	});

	it('drops a candidate whose displayName is a number instead of throwing on .trim()', () => {
		// Before issue #68's fix, `info?.displayName?.trim()` would throw a TypeError here
		// (numbers have no .trim method), taking the whole search down with it.
		const corrupted = {
			...mercure,
			content: {
				...mercure.content,
				informationSummary: { ...mercure.content?.informationSummary, displayName: 12345 as unknown as string }
			}
		};
		expect(() => mapSearchPropertyToCandidate(corrupted)).not.toThrow();
		expect(mapSearchPropertyToCandidate(corrupted)).toBeUndefined();
	});

	it('drops a candidate whose propertyId is a string rather than carrying it through wrongly typed', () => {
		const corrupted = { ...mercure, propertyId: '50373' as unknown as number };
		expect(mapSearchPropertyToCandidate(corrupted)).toBeUndefined();
	});

	it('skips a non-string image URL instead of throwing on .startsWith()', () => {
		const corrupted = {
			...mercure,
			content: {
				...mercure.content,
				images: { hotelImages: [{ urls: [{ key: 'original', value: 42 as unknown as string }] }] }
			}
		};
		const candidate = mapSearchPropertyToCandidate(corrupted);
		expect(candidate).toBeDefined();
		expect(candidate?.property.images).toEqual([]);
	});

	it('treats a non-array masterRooms as no rooms rather than throwing on for...of', () => {
		const property: Property = {
			name: 'Test Property',
			coordinates: { latitude: 48.2, longitude: 16.37 },
			images: []
		};
		const corrupted = { data: { roomGridData: { masterRooms: { not: 'an array' } as never } } };
		expect(() => mapGetPricesToStays(property, corrupted)).not.toThrow();
		expect(mapGetPricesToStays(property, corrupted)).toEqual([]);
	});

	it('drops a room type whose price is a non-numeric string rather than reporting NaN', () => {
		const corrupted = {
			...wombatsMasterRoom,
			rooms: [{ currency: 'EUR', inclusivePrice: { display: 'bad-data' as unknown as number } }]
		};
		const property: Property = {
			name: "Wombat's City Hostel Vienna Naschmarkt",
			coordinates: { latitude: 48.19685745239258, longitude: 16.36066246032715 },
			images: []
		};
		expect(mapMasterRoomsToStays(property, [corrupted])).toEqual([]);
	});
});

describe('mapGetPricesToStays (real fixture)', () => {
	it('groups Wombat’s 13 room types into one Stay per RoomKind, each at its cheapest price', () => {
		const property: Property = {
			name: "Wombat's City Hostel Vienna Naschmarkt",
			coordinates: { latitude: 48.19685745239258, longitude: 16.36066246032715 },
			images: []
		};
		const stays = mapGetPricesToStays(property, wombatsFixture);

		expect(stays).toHaveLength(3);
		const byKind = Object.fromEntries(stays.map((s) => [s.roomKind, s.pricePerNight]));
		// Cheapest dorm: "1 Person in 8-Bed Dormitory - Mixed" at 29.46 EUR.
		expect(byKind.dorm).toEqual({ minorUnits: 2946, currency: 'EUR' });
		// Cheapest female-dorm: "1 Bed in 6 Bedded Female Room Ensuite" at 30.56 EUR.
		expect(byKind['female-dorm']).toEqual({ minorUnits: 3056, currency: 'EUR' });
		// Cheapest private: "Double Room" at 133.11 EUR — cheaper than either
		// "Private N Bed Dorm" whole-room product also present in this hostel's list.
		expect(byKind.private).toEqual({ minorUnits: 13311, currency: 'EUR' });
		for (const stay of stays) {
			expect(stay.property).toBe(property);
		}
	});
});

/**
 * Issue #152, and the one live request this fix was allowed to spend. Captured
 * 2026-09-04 from `get-prices` for Hostelle (propertyId 46866744, the cheapest property in
 * a live "London, United Kingdom" search), 6-8 October 2026, 1 adult, **with
 * `currency_id=1`** — the parameter `agoda.ts` omitted before this fix because the stay
 * query carried no currency.
 *
 * The point of the request was that both outcomes were informative. EUR back would mean
 * the parameter had simply been absent and threading it through is the whole fix; USD back
 * would mean Agoda ignores it and `resources.ts`'s currency filter is load-bearing rather
 * than a safeguard. It came back **EUR**, so the parameter is honoured and the fix is
 * sufficient.
 */
describe('mapGetPricesToStays against a live EUR response (issue #152)', () => {
	const property: Property = {
		name: 'Hostelle - women only hostel London',
		coordinates: { latitude: 51.5, longitude: -0.12 },
		images: []
	};

	it('prices every room in the currency that was actually requested', async () => {
		const response = (await import('./fixtures/agoda-get-prices-hostelle-london-eur.json')).default;
		const stays = mapGetPricesToStays(property, response as never);

		expect(stays.length).toBeGreaterThan(0);
		for (const stay of stays) expect(stay.pricePerNight.currency).toBe('EUR');
	});

	it('reads the cheapest bed as 22.97 EUR in integer minor units', async () => {
		const response = (await import('./fixtures/agoda-get-prices-hostelle-london-eur.json')).default;
		const stays = mapGetPricesToStays(property, response as never);
		const cheapest = [...stays].sort((a, b) => a.pricePerNight.minorUnits - b.pricePerNight.minorUnits)[0];

		expect(cheapest?.pricePerNight).toEqual({ minorUnits: 2297, currency: 'EUR' });
	});

	it('classifies a women-only hostel as female-dorm, from the room name', async () => {
		const response = (await import('./fixtures/agoda-get-prices-hostelle-london-eur.json')).default;
		const stays = mapGetPricesToStays(property, response as never);

		expect(stays.map((s) => s.roomKind)).toEqual(['female-dorm']);
	});

	it('is right to ignore isDormitory, which is false on all five real dormitory rows', async () => {
		// Second independent confirmation of docs/PROVIDERS.md's finding, on a different
		// property from the Vienna one it was first measured against: every row here is
		// literally named "N-Bed Dormitory" and every `isDormitory` reads false. The flag is
		// wrong site-wide, not occasionally.
		const response = (await import('./fixtures/agoda-get-prices-hostelle-london-eur.json')).default;
		const rooms = response.data.roomGridData.masterRooms;

		expect(rooms).toHaveLength(5);
		for (const room of rooms) {
			expect(room.name).toMatch(/Dormitory/);
			expect(room.isDormitory).toBe(false);
		}
	});
});
