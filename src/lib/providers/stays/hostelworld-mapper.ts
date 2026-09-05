/**
 * Pure translation from Hostelworld's raw shapes (hostelworld-types.ts) into this app's
 * domain shapes. No network, no cache, no clock — same split agoda-mapper.ts and
 * booking-mapper.ts keep, so the part most likely to be wrong is the part cheapest to test.
 *
 * Every field arrives unverified. Nothing here throws on a missing or misshapen one; it
 * produces one fewer `Stay` instead, because a search that quietly drops a property is a
 * worse outcome than an error only when the alternative is a fabricated price, and it never
 * is.
 */

import { moneyFromDecimalString } from '../../domain';
import type { Coordinates, Money, RoomKind, Stay } from '../../domain';
import { haversineDistanceKm } from './agoda-geo';
import type {
	HostelworldContinentCountriesResponse,
	HostelworldPrice,
	HostelworldProperty,
	HostelworldRoom
} from './hostelworld-types';
import { isWomenOnlyPropertyName } from './women-only-name';

/**
 * Nights between two `YYYY-MM-DD` dates, or `undefined` when either is not one.
 *
 * Hostelworld takes a check-in and a NIGHT COUNT where `StaySearchQuery` carries a check-in
 * and a check-out, so somebody has to do this subtraction and it may as well be somewhere
 * testable. `Date.UTC` on the parsed parts, never `new Date(string)`: a calendar date is
 * not an instant, and parsing one in a local timezone west of Greenwich lands on the
 * previous day, which is how a three-night stay quietly becomes two.
 *
 * A local copy of a thing `algorithm/build.ts` also does, for the reason agoda-geo.ts keeps
 * its own haversine: that module sits a layer above providers in this app's dependency
 * direction, and importing upwards for one subtraction would be a layering violation.
 */
export function nightsBetweenDates(checkIn: string, checkOut: string): number | undefined {
	const parse = (date: string): number | undefined => {
		const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
		if (!match) return undefined;
		return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	};
	const start = parse(checkIn);
	const end = parse(checkOut);
	if (start === undefined || end === undefined) return undefined;
	return Math.round((end - start) / (24 * 60 * 60_000));
}

/**
 * One of Hostelworld's `{value, currency}` pairs as `Money`, or `undefined` when it is not
 * a real price.
 *
 * `moneyFromDecimalString` rather than anything local, because Hostelworld sends money as a
 * decimal STRING ("26.44") and that function reads the digits without ever building a
 * float — `19.99 * 100` is `1998.9999999999998` in JavaScript. It also owns the one
 * currency-exponent table in the app (#179, #193). An earlier draft of this file carried
 * its own copy of that table and listed HUF as zero-decimal, which is the exact factor-of-
 * 100 error #179 was opened about; deleting the copy is the only way it stays deleted.
 *
 * The currency comes from the response, never from what this adapter asked for: a request
 * parameter is a request, not a promise. `search/resources.ts` drops any stay not quoted in
 * the search's own currency (issue #152), so a silently-substituted currency has to arrive
 * labelled honestly to be caught there rather than totalled as if it were EUR.
 */
export function toMoney(price: HostelworldPrice | undefined): Money | undefined {
	return moneyFromDecimalString(price?.value, price?.currency);
}

/**
 * Hostelworld's own `basicType` for a room ("Mixed Dorm", "Female Dorm", "Private", "Dbl
 * Private") mapped onto domain/stay.ts's three kinds, falling back to the room's display
 * name when `basicType` is absent.
 *
 * Female is tested first because "Female Dorm" satisfies the dorm test too, and getting
 * that order wrong prices a women-only room as mixed inventory — issue #27's whole point is
 * that those are not the same beds.
 */
export function classifyRoomKind(room: HostelworldRoom): RoomKind | undefined {
	const label = `${room.basicType ?? ''} ${room.name ?? ''}`.toLowerCase();
	if (label.includes('female')) return 'female-dorm';
	if (label.includes('dorm')) return 'dorm';
	if (label.includes('private') || label.includes('apartment') || label.includes('room')) {
		return 'private';
	}
	return undefined;
}

/** The cheapest room of one kind among the room types Hostelworld returned, by minor units
 * in whatever currency each is quoted in. Only ever used for `female-dorm`, which has no
 * property-level field — see `mapPropertyToStays`. */
function cheapestRoomPriceOfKind(
	rooms: readonly HostelworldRoom[] | undefined,
	kind: RoomKind
): Money | undefined {
	let cheapest: Money | undefined;
	for (const room of rooms ?? []) {
		if (classifyRoomKind(room) !== kind) continue;
		const price = toMoney(room.averagePrice);
		if (!price) continue;
		if (!cheapest || price.minorUnits < cheapest.minorUnits) cheapest = price;
	}
	return cheapest;
}

/** `{prefix, suffix}` is a URL with its scheme missing, and nothing else. Confirmed 200
 * `image/jpeg` for the joined form on 2026-09-04. */
function imageUrls(property: HostelworldProperty): string[] {
	return (property.images ?? [])
		.map((image) =>
			typeof image?.prefix === 'string' && typeof image?.suffix === 'string'
				? `https://${image.prefix}${image.suffix}`
				: undefined
		)
		.filter((url): url is string => url !== undefined);
}

function coordinatesOf(property: HostelworldProperty | undefined): Coordinates | undefined {
	const latitude = property?.latitude;
	const longitude = property?.longitude;
	if (typeof latitude !== 'number' || !Number.isFinite(latitude)) return undefined;
	if (typeof longitude !== 'number' || !Number.isFinite(longitude)) return undefined;
	// 0,0 is in the Gulf of Guinea and is what this API uses for "we did not fill this in"
	// — the autocomplete endpoint returns it for every suggestion. A property there would
	// pass a radius check against nothing and fail one against everything, so treat it as
	// the absent value it is rather than as a place.
	if (latitude === 0 && longitude === 0) return undefined;
	return { latitude, longitude };
}

/**
 * Every priced room kind at one property, as one `Stay` each (domain/stay.ts: "a property
 * offering both a dorm bed and a private room is two Stay records").
 *
 * ## Which price field, and why it is not the obvious one
 *
 * `lowestAverageDormPricePerNight` / `lowestAveragePrivatePricePerNight`, NOT
 * `lowestDormPricePerNight` / `lowestPrivatePricePerNight`. The `lowest*` pair is the
 * cheapest single night of the stay, a "from" teaser: at Wombat's City Hostel London for
 * 9-12 October 2026 it reads 26.44 while the stay itself averages 39.68 a night. `Stay`
 * is consumed as `nights × pricePerNight`, so the teaser would have under-reported that
 * bed by 34% — a wrong total presented as a fact, which is the failure AGENTS.md's "never
 * present an estimate as a fact" names.
 *
 * Both were confirmed per-night rather than per-stay by asking for a single night, where
 * the two collapse to the same value (46.78 each, same property, 2026-09-04). A per-stay
 * total could not do that.
 *
 * ## Female dorms come from a different place, and are not directly comparable
 *
 * No property-level field carries a female-only price, so that one is the cheapest
 * `Female Dorm` in `rooms.dorms` (present only with `show-rooms=1`). That array is not the
 * property's full inventory — its cheapest mixed dorm can price ABOVE the property-level
 * dorm average, which is only possible if the property-level figure draws on rates the
 * array does not list. So the female-dorm `Stay` is a real, bookable per-night rate that
 * is not guaranteed to be the cheapest female bed there.
 *
 * That asymmetry is safe in the one direction it is used. `search/resources.ts` ranks every
 * candidate by price and picks the cheapest bookable one, so a female-dorm price that is
 * too HIGH only ever loses to a mixed dorm; it can never make a total look cheaper than it
 * is. Deriving a female price from the property-level average instead would be the
 * dangerous direction, and inventing one is not on the table.
 *
 * ## A dorm figure is per bed, so `guests` multiplies it. Measured, because it decides a price
 *
 * `search/resources.ts`: "`Stay` is priced as one flat per-night figure for the whole
 * party." Agoda and Booking satisfy that for free — both send `adults` and get a quote for
 * that many people back. Hostelworld does not. Asked for London, 9-12 October 2026, at
 * `guests=1` and again at `guests=3`, every price in the response was byte-identical while
 * `totalNumberOfItems` fell from 74 to 71. So `guests` filters which properties can host
 * the party and changes no number: what comes back is the rate for ONE unit of inventory.
 *
 * A unit of dorm inventory is a bed, and three travellers need three of them, so the
 * whole-party nightly figure is the quoted rate times `guests`. Left unmultiplied, a party
 * of three would have been quoted a third of what a London stopover costs them — the same
 * class of error as the `lowest*` teaser above, and invisible on the acceptance trip
 * because that is one traveller, where every multiplier is 1.
 *
 * Re-measured for issue #206 on 2026-09-05, at `guests` of 1, 2, 3, 4 and 6: every
 * property-level and room-level price identical at all five, `totalNumberOfItems` moving
 * 74, 74, 71, 69, 66. The private half is no longer inference either. Safestay Kensington
 * sells a 9-bed private at 203.52 against nine of its own dorm beds at 19.15, a 12-bed at
 * 248.92 and a 15-bed at 306.37; a per-person figure could not track bed count like that.
 * Hostelworld also says it in words on every private at `/2.2/properties/{id}/rooms/`: "3
 * persons booking a 4 bed private room will need to select and pay for 4 persons".
 *
 * So a dorm rate is one bed and a private rate is one room. The per-bed figure is kept on
 * `Stay.pricePerPersonPerNight` for the dorm kinds, because it is the number Hostelworld
 * actually quoted and issue #206 wants it on screen; a private sets nothing there, since
 * splitting a room between the people in it is a number nobody gave us.
 */
export function mapPropertyToStays(
	property: HostelworldProperty | undefined,
	guests: number
): Stay[] {
	const coordinates = coordinatesOf(property);
	const name = property?.name;
	if (!property || !coordinates || typeof name !== 'string' || name.length === 0) return [];

	const rating = property.overallRating?.overall;
	const propertyRecord = {
		name,
		coordinates,
		images: imageUrls(property),
		...(typeof rating === 'number' && Number.isFinite(rating) ? { rating } : {}),
		// #207, and it applies to this adapter for exactly the reason it applied to the
		// other two: Hostelworld has no structured field for a property-wide gender
		// restriction either, and a women-only hostel's ROOMS are named ordinarily, so
		// `classifyRoomKind` alone would hand one to a party with no women in it. The shared
		// name test rather than a local copy, so all three mappers can only ever agree.
		womenOnly: isWomenOnlyPropertyName(name) || undefined
	};

	// A fractional or absent party size would scale a real price into a fake one, so it
	// falls back to a single traveller rather than to `NaN` minor units.
	const beds = Number.isInteger(guests) && guests > 0 ? guests : 1;
	const perParty = (perPerson: Money): Money => ({
		minorUnits: perPerson.minorUnits * beds,
		currency: perPerson.currency
	});
	const dormStay = (roomKind: RoomKind, perPerson: Money | undefined): Stay | undefined =>
		perPerson && {
			property: propertyRecord,
			roomKind,
			pricePerNight: perParty(perPerson),
			pricePerPersonPerNight: perPerson
		};

	const privateRate = toMoney(property.lowestAveragePrivatePricePerNight);
	const stays: (Stay | undefined)[] = [
		dormStay('dorm', toMoney(property.lowestAverageDormPricePerNight)),
		privateRate && { property: propertyRecord, roomKind: 'private', pricePerNight: privateRate },
		dormStay('female-dorm', cheapestRoomPriceOfKind(property.rooms?.dorms, 'female-dorm'))
	];

	return stays.filter((stay): stay is Stay => stay !== undefined);
}

/**
 * Every `Stay` from a city's properties that really is within `radiusKm` of the coordinate
 * the caller asked about.
 *
 * The radius is enforced here rather than trusted as a request parameter, the same call
 * agoda-mapper.ts makes for the same reason: the endpoint is keyed by city, so "near this
 * airport" is not something it was ever asked. This filter is also what makes picking the
 * wrong same-named city safe — Hostelworld's autocomplete offers London Ontario and Boa
 * Vista Brazil ahead of, or alongside, the ones a European search means, and properties
 * five thousand kilometres from the connection airport are removed here rather than priced
 * into somebody's trip.
 */
export function mapPropertiesToStays(
	properties: readonly HostelworldProperty[] | undefined,
	near: Coordinates,
	radiusKm: number,
	guests: number
): Stay[] {
	return (properties ?? [])
		.flatMap((property) => mapPropertyToStays(property, guests))
		.filter((stay) => haversineDistanceKm(near, stay.property.coordinates) <= radiusKm);
}

/** One Hostelworld city, reduced to the three things a lookup needs. Coordinates rounded to
 * five decimals (about a metre) because this index is cached whole and every digit past
 * that is bytes spent on precision no city centroid has. */
export interface HostelworldCity {
	id: number;
	name: string;
	coordinates: Coordinates;
}

/** Every usable city out of one `/continents/{id}/countries/` response, flattened across
 * its countries. Entries missing an id, a name or real coordinates are dropped rather than
 * carried as holes for the ranking to trip over. */
export function flattenGeoCities(
	response: HostelworldContinentCountriesResponse | undefined
): HostelworldCity[] {
	const cities: HostelworldCity[] = [];
	for (const country of response?.countries ?? []) {
		for (const city of country?.cities ?? []) {
			const { id, name, latitude, longitude } = city ?? {};
			if (typeof id !== 'number' || typeof name !== 'string' || name.length === 0) continue;
			if (typeof latitude !== 'number' || !Number.isFinite(latitude)) continue;
			if (typeof longitude !== 'number' || !Number.isFinite(longitude)) continue;
			if (latitude === 0 && longitude === 0) continue;
			cities.push({
				id,
				name,
				coordinates: {
					latitude: Math.round(latitude * 1e5) / 1e5,
					longitude: Math.round(longitude * 1e5) / 1e5
				}
			});
		}
	}
	return cities;
}

/** Lowercased, unaccented, letters and digits only — so "Košice" matches "Kosice" and
 * "St. Petersburg" matches "St Petersburg", without a list of special cases. */
function normaliseCityName(name: string): string {
	return name
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]/g, '');
}

/**
 * Hostelworld city ids worth pricing for one airport, best first.
 *
 * ## Why distance alone is not enough, measured
 *
 * The nearest Hostelworld city to London Gatwick is "Gatwick" itself, 2 km away, then
 * Crawley at 3.6 km, then Guildford, Lewes and Brighton — London is SIXTH, 39.3 km out.
 * Manchester Airport's nearest is Macclesfield, not Manchester. A traveller with a
 * three-night stopover in London wants London.
 *
 * ## Why a name alone is not enough either
 *
 * Hostelworld has a London in Ontario and a Boa Vista in Brazil, and its search puts Brazil
 * first for the latter. A name with no geography attached picks the wrong continent.
 *
 * ## So: name first, distance second, both bounded by the radius
 *
 * `preferredName` is the city this app already decided the airport serves
 * (`geocode/airport-city.ts`, issue #65 — the file that exists because a reverse geocoder
 * calls Vienna's airport "Fischamend"). A city within `radiusKm` whose name matches it wins;
 * everything else within the radius follows by distance, nearest first, so an airport whose
 * city Hostelworld has never heard of still gets the nearest real beds rather than nothing.
 *
 * Checked against all three of the acceptance search's own stopovers on 2026-09-04: LGW
 * picks London (id 3) over Gatwick, MAN picks Manchester (171) over Macclesfield, BHX picks
 * Birmingham (718), and PFO picks Paphos (21908) — which is also its nearest, 8.7 km.
 */
export function rankCitiesNear(
	cities: readonly HostelworldCity[],
	near: Coordinates,
	radiusKm: number,
	preferredName: string | undefined
): number[] {
	const wanted = preferredName ? normaliseCityName(preferredName) : '';
	const withinRadius = cities
		.map((city) => ({ city, km: haversineDistanceKm(near, city.coordinates) }))
		.filter((entry) => entry.km <= radiusKm)
		.sort((a, b) => a.km - b.km);

	const named = wanted
		? withinRadius.filter((entry) => normaliseCityName(entry.city.name) === wanted)
		: [];
	return [...new Set([...named, ...withinRadius].map((entry) => entry.city.id))];
}
