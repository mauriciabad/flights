/**
 * Pure translation from Agoda's raw response shapes (agoda-types.ts) to this app's domain
 * shapes (src/lib/domain). No I/O, no cache, no fetch — same reasoning as
 * ryanair-mapper.ts, and what lets agoda-mapper.test.ts run entirely off the fixtures in
 * ./fixtures/ with no network.
 */

import type { Coordinates, Money, Property, RoomKind, Stay } from '../../domain';
import { haversineDistanceKm } from './agoda-geo';
import type { AgodaGetPricesResponse, AgodaMasterRoom, AgodaSearchProperty } from './agoda-types';

/**
 * Issue #68: `agoda-types.ts`'s interfaces declare every field this adapter reads as a
 * plain `number`/`string`, but that is a compile-time hint about the shape this adapter
 * was BUILT against, not a runtime guarantee about the shape a live response actually
 * HAS — the whole reason this issue exists. A scraper API that renames or re-types a field
 * still parses as valid JSON; `property.propertyId` typed `number` can still hold a string,
 * `null`, or nothing at all once the wire format drifts. The functions below therefore
 * treat every leaf value as `unknown` at the point it is read, the same discipline
 * kiwi-mapper.ts and skyscanner-map-offers.ts already apply, rather than trusting the
 * declared type. Money is the sharpest case: `null * 100` is `0` in JavaScript, not
 * `NaN` and not a thrown error — an unchecked `null` price would silently become a real,
 * wrong "free" price rather than something visibly broken.
 */
function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/** Trims and rejects anything that isn't a non-empty string — matches the trim this file
 * already needed for `mapSearchPropertyToCandidate`'s real fixture (a trailing U+00A0 on
 * Wombat's City Hostel Vienna Naschmarkt), and, unlike a bare `?.trim()`, never throws when
 * the raw value isn't a string at all (a number, `null`, an object) — see this function's
 * use in `mapSearchPropertyToCandidate` below for the exact crash that guarded against. */
function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Agoda's own currency ids, captured 2026-09-04 from a live `GET /currencies` call (see
 * the PR body for the full 50-currency response). Hardcoded rather than fetched-and-cached
 * like ryanair.ts's airport-timezone table: currency ids are a closed, essentially static
 * set (Agoda is not going to renumber "EUR" next month), so the extra cache-key/TTL
 * machinery a live lookup would need buys nothing a short static table doesn't already
 * give for free. Only currencies this app is likely to actually request are listed —
 * unmapped ones fall back to omitting `currency_id`, which live testing showed returns USD.
 *
 * `minorUnitDigits` is Agoda's own `NoDecimal` field from that same response — used so
 * `toMoney` below converts JPY's 0-decimal prices correctly instead of assuming every
 * currency has cents like EUR/USD do. USD itself never appears in `/currencies` (it is the
 * implicit default rather than a selectable option) but still needs an entry here so its
 * *returned* prices convert correctly.
 */
export const AGODA_CURRENCY_INFO: Readonly<Record<string, { id?: number; minorUnitDigits: number }>> = {
	EUR: { id: 1, minorUnitDigits: 2 },
	GBP: { id: 2, minorUnitDigits: 2 },
	SGD: { id: 5, minorUnitDigits: 2 },
	NZD: { id: 8, minorUnitDigits: 2 },
	AUD: { id: 9, minorUnitDigits: 2 },
	JPY: { id: 11, minorUnitDigits: 0 },
	CHF: { id: 19, minorUnitDigits: 2 },
	DKK: { id: 20, minorUnitDigits: 2 },
	SEK: { id: 21, minorUnitDigits: 2 },
	CZK: { id: 22, minorUnitDigits: 2 },
	PLN: { id: 23, minorUnitDigits: 2 },
	NOK: { id: 31, minorUnitDigits: 2 },
	HUF: { id: 87, minorUnitDigits: 2 },
	// USD has no id: it never appears in Agoda's own `/currencies` list (captured
	// 2026-09-04) and is instead the implicit default when `currency_id` is omitted
	// entirely — see agoda-client.ts `GetPricesParams.currencyId`. Still needs an entry
	// here so *returned* USD prices convert with the right number of decimal digits.
	USD: { minorUnitDigits: 2 }
};

/** Agoda's own numeric id for `currencyCode`, or `undefined` when this adapter has no
 * mapping for it — agoda.ts then omits `currency_id` from the request entirely rather
 * than guessing, which live testing showed falls back to USD. */
export function agodaCurrencyId(currencyCode: string | undefined): number | undefined {
	return currencyCode ? AGODA_CURRENCY_INFO[currencyCode]?.id : undefined;
}

/** Converts a display price (a plain float in major units, e.g. `29.46`) plus the
 * currency Agoda's response actually says it is in — never the currency this adapter
 * asked for, since a caller must not assume a request parameter was honoured — into
 * `Money`'s integer minor units. Multiplying by `10 ** digits` rather than always `* 100`
 * is what keeps a 0-decimal currency like JPY from being reported 100x too large.
 *
 * Both parameters are `unknown`, not `number`/`string`, because both come straight off an
 * unverified response body (see this file's header) — `undefined`, `null`, a boolean or an
 * object here must become "no price," never a fabricated one. `null * 100 === 0` in
 * JavaScript, so without this check a `null` display price would silently become a real
 * `Money` of zero minor units rather than being dropped, which is a worse outcome than
 * either a thrown error or a visibly missing price. */
export function toMoney(display: unknown, currencyCode: unknown): Money | undefined {
	if (!isFiniteNumber(display) || typeof currencyCode !== 'string' || !currencyCode) return undefined;
	const digits = AGODA_CURRENCY_INFO[currencyCode]?.minorUnitDigits ?? 2;
	return { minorUnits: Math.round(display * 10 ** digits), currency: currencyCode };
}

/**
 * Classifies one Agoda room-type name into this app's three-way `RoomKind`
 * (domain/stay.ts). `isDormitory` is accepted but deliberately given no weight: a live
 * check against Wombat's City Hostel Vienna (propertyId 417108, captured 2026-09-04)
 * found it `false` on every one of 13 room types, including several literally named
 * "N-Bed Dormitory" and "N Bedded Female Room" — see agoda-types.ts's `AgodaMasterRoom`
 * comment and the PR body for the full list this finding is based on. Name matching is
 * therefore the only signal that actually works here, not a fallback for when the flag is
 * missing.
 *
 * The "private" check runs first and wins outright because Agoda names some rooms
 * "4 Bed Private Dorm" / "Private 6 Bed Dorm Room" for a private room a group books as a
 * whole (priced roughly 4-5x a per-bed dorm rate in the same hostel), not a shared dorm —
 * exactly the "dorm bed exposed as a room with an occupancy field" confusion issue #10
 * warned to expect. Treating any name containing "private" as `private` regardless of the
 * word "dorm" elsewhere in it is what keeps that whole-room product out of the `dorm`
 * bucket, where it would badly overstate a single bed's price.
 */
export function classifyAgodaRoomKind(name: string): RoomKind {
	if (/\bprivate\b/i.test(name)) return 'private';
	const isDormLike = /dorm|dormitory|\bbed in\b|shared\s+room/i.test(name);
	if (isDormLike && /\bfemale\b|\bwomen'?s?\b|\bladies\b/i.test(name)) return 'female-dorm';
	if (isDormLike) return 'dorm';
	return 'private';
}

function toHttpsUrl(protocolRelativeUrl: string): string {
	return protocolRelativeUrl.startsWith('//') ? `https:${protocolRelativeUrl}` : protocolRelativeUrl;
}

function mapImages(property: AgodaSearchProperty): string[] {
	const images = property.content?.images?.hotelImages;
	if (!Array.isArray(images)) return [];
	const urls: string[] = [];
	for (const image of images) {
		const original = image.urls?.find((u) => u.key === 'original')?.value;
		// `typeof original === 'string'` guards a real crash, not just a wrong value:
		// `toHttpsUrl` calls `.startsWith` on it, which throws on anything that isn't a
		// string — a truthy non-string value here would have taken down the whole search
		// (types.ts: adapters must resolve, never throw) rather than just dropping one image.
		const url = typeof original === 'string' ? asNonEmptyString(original) : undefined;
		if (url) urls.push(toHttpsUrl(url));
	}
	return urls;
}

/** The property-level "from" price Agoda's search response buries under
 * `pricing.offers[0].roomOffers[0].room.mseRoomSummaries[0].pricingSummaries[0]` — used
 * only to rank candidates cheapest-first before spending a `get-prices` request drilling
 * into any of them (agoda.ts). Not the per-room-kind price this adapter ultimately
 * returns; that comes from `get-prices` via `mapMasterRoomsToStays` below. Returns
 * `undefined` for a sold-out property or one whose response shape doesn't reach this deep
 * (both seen live for properties Agoda itself marks `soldOut`), so agoda.ts can drop it
 * from the candidate list rather than ranking it as free. */
export function extractHeadlinePrice(property: AgodaSearchProperty): Money | undefined {
	if (property.soldOut) return undefined;
	const summary = property.pricing?.offers?.[0]?.roomOffers?.[0]?.room?.mseRoomSummaries?.[0]?.pricingSummaries?.[0];
	// `toMoney` itself now validates both arguments (see its own comment) — no need to
	// re-check `display`/`currency` here before calling it.
	return toMoney(summary?.price?.perRoomPerNight?.inclusive?.display, summary?.currency);
}

export interface AgodaCandidate {
	propertyId: number;
	property: Property;
	headlinePrice: Money;
}

/** Maps one search result to a rankable candidate, or `undefined` when it is missing
 * something this adapter cannot proceed without (coordinates, a name, or a live price —
 * see `extractHeadlinePrice`). Does NOT yet filter by `radiusKm`; that needs the caller's
 * query and lives in `filterWithinRadius` below so this function stays a pure 1:1 mapping
 * agoda-mapper.test.ts can check row by row. */
export function mapSearchPropertyToCandidate(property: AgodaSearchProperty): AgodaCandidate | undefined {
	const info = property.content?.informationSummary;
	const latitude = info?.geoInfo?.latitude;
	const longitude = info?.geoInfo?.longitude;
	// Trimmed because at least one real property name comes back with a trailing
	// non-breaking space (Wombat's City Hostel Vienna Naschmarkt, captured live
	// 2026-09-04) — a display-layer nuisance, not a meaningful part of the name.
	// `asNonEmptyString`, not a bare `?.trim()`: `displayName` is declared a `string` in
	// agoda-types.ts, but that is a compile-time hint, not a runtime guarantee (this file's
	// header) — calling `.trim()` on a value that turned out to be a number or an object
	// would throw and take the whole search down with it, rather than just dropping this
	// one candidate.
	const name = asNonEmptyString(info?.displayName);
	const headlinePrice = extractHeadlinePrice(property);
	if (!isFiniteNumber(latitude) || !isFiniteNumber(longitude) || !name || !headlinePrice) return undefined;
	if (!isFiniteNumber(property.propertyId)) return undefined;
	const rating = info?.rating;

	return {
		propertyId: property.propertyId,
		property: {
			name,
			coordinates: { latitude, longitude },
			images: mapImages(property),
			rating: isFiniteNumber(rating) ? rating : undefined
		},
		headlinePrice
	};
}

/** Enforces `StaySearchQuery.radiusKm` client-side, since Agoda's text-based search has no
 * radius parameter of its own to pass it to (agoda-client.ts's header comment). */
export function filterWithinRadius(
	candidates: readonly AgodaCandidate[],
	near: Coordinates,
	radiusKm: number
): AgodaCandidate[] {
	return candidates.filter((c) => haversineDistanceKm(near, c.property.coordinates) <= radiusKm);
}

/** The cheapest priced variant of one room type — a masterRoom can list several (e.g. the
 * same "Double Room" once for 1 adult and once for 2), and StayProvider wants one Stay per
 * room *kind* at a property, not one per occupancy variant. */
function cheapestOfferPrice(masterRoom: AgodaMasterRoom): Money | undefined {
	const rooms = masterRoom.rooms;
	if (!Array.isArray(rooms)) return undefined;
	let cheapest: Money | undefined;
	for (const offer of rooms) {
		const display = offer.inclusivePricePerNightWithoutExtraBed?.display ?? offer.inclusivePrice?.display;
		const money = toMoney(display, offer.currency);
		if (!money) continue;
		if (!cheapest || money.minorUnits < cheapest.minorUnits) cheapest = money;
	}
	return cheapest;
}

/**
 * Maps a property's full room-type list to `Stay[]`, one per `RoomKind` actually present
 * — domain/stay.ts: "a property offering both a dorm bed and a private room is two Stay
 * records, not one Stay with two prices." A hostel with several differently-sized dorm
 * rooms (Wombat's had four: 4/6/8-bed mixed, plus two female variants) collapses to at
 * most one `dorm` and one `female-dorm` Stay, each at that kind's cheapest room, rather
 * than one Stay per named room type — the picker issue #10 asks for is "dorm vs private,"
 * not "every bed configuration this property happens to sell."
 */
export function mapMasterRoomsToStays(property: Property, masterRooms: readonly AgodaMasterRoom[]): Stay[] {
	const cheapestByKind = new Map<RoomKind, Money>();
	for (const masterRoom of masterRooms) {
		const name = asNonEmptyString(masterRoom.name);
		if (!name) continue;
		const price = cheapestOfferPrice(masterRoom);
		if (!price) continue;
		const kind = classifyAgodaRoomKind(name);
		const existing = cheapestByKind.get(kind);
		if (!existing || price.minorUnits < existing.minorUnits) cheapestByKind.set(kind, price);
	}
	return Array.from(cheapestByKind.entries()).map(([roomKind, pricePerNight]) => ({
		property,
		roomKind,
		pricePerNight
	}));
}

export function mapGetPricesToStays(property: Property, response: AgodaGetPricesResponse): Stay[] {
	const masterRooms = response.data?.roomGridData?.masterRooms;
	// `Array.isArray`, not `?? []`: a nullish-coalesce only catches `masterRooms` being
	// absent, not it being present but the wrong shape (an object, say) — either way this
	// adapter has no room list to read, but only the array check protects the `for...of`
	// below from throwing on something that isn't iterable.
	return mapMasterRoomsToStays(property, Array.isArray(masterRooms) ? masterRooms : []);
}

/**
 * Turns a Nominatim reverse-geocode address into the "City, Country" text Agoda's search
 * expects (matching the shape of Agoda's own worked examples, e.g. "Ho Chi Minh City,
 * Vietnam" — captured from the API's embedded Postman collection, see the PR body).
 * Prefers, in order, the city/town/village/hamlet fields Nominatim itself uses depending
 * on the settlement's size — the fallback chain exists because a query coordinate near a
 * small airport town (Nominatim's own classification, not a display choice) never has a
 * `city` field at all, only `town` (see agoda-client.ts `fetchReverseGeocode`'s comment
 * for the Vienna-airport example this is based on).
 */
export function resolveLocationLabel(address: {
	city?: string;
	town?: string;
	village?: string;
	hamlet?: string;
	country?: string;
}): string | undefined {
	const place = address.city ?? address.town ?? address.village ?? address.hamlet;
	if (!place) return undefined;
	return address.country ? `${place}, ${address.country}` : place;
}
