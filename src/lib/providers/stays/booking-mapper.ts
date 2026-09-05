/**
 * Pure translation from Booking's raw response shapes (booking-types.ts) to this app's
 * domain shapes (src/lib/domain). No I/O, no cache, no fetch — same reasoning as
 * ryanair-mapper.ts and agoda-mapper.ts.
 */

import type { Money, Property, RoomKind, Stay } from "../../domain";
import { moneyFromMajorUnits } from "../../domain";
import type {
  BookingMoneyAmount,
  BookingRoomBlock,
  BookingRoomListResponse,
  BookingSearchResult,
} from "./booking-types";
import { upgradeBookingPhoto } from "./booking-photo";
import { isWomenOnlyPropertyName } from "./women-only-name";

/** Reads only `value`/`currency` — never `amount_rounded`/`amount_unrounded`, which are
 * pre-formatted currency-symbol strings (e.g. "€ 100.15", non-breaking space included) for
 * Booking's own UI. Issue #10 warned specifically to watch for an API returning formatted
 * strings; this is that exact trap in this API.
 *
 * Issue #179: the minor-unit exponent comes from `domain/money.ts`, so a room in a
 * zero-decimal currency is no longer reported a hundred times too expensive. This function
 * used to multiply every price by 100 whatever the currency was, which made a 12000 JPY
 * room 1,200,000 minor units — the mirror of the flight adapters' forint bug. Booking's own
 * wrapper exposes no per-currency decimal-count field to read instead (`getCurrency` was
 * never called: the 50-request/month budget did not stretch to it), so the shared table is
 * the only answer available, and it is the same one the price is later formatted with.
 *
 * Issue #68: `moneyFromMajorUnits` takes `unknown`, not `number` — `booking-types.ts`
 * declares `value` a plain `number`, but that is a compile-time hint about the shape this
 * adapter expects, not a runtime guarantee about what a live scraper response actually
 * sends (this file's header links the same risk in agoda-mapper.ts). Without that check a
 * `null` or non-numeric `value` would silently become `NaN` or, worse, `0`
 * (`null * 100 === 0` in JavaScript) minor units — a real, wrong price — rather than being
 * dropped. */
export function toMoney(amount: BookingMoneyAmount): Money | undefined {
  return moneyFromMajorUnits(amount.value, amount.currency);
}

/**
 * Classifies one Booking room-type name (plus its `is_dormitory` flag) into this app's
 * three-way `RoomKind` (domain/stay.ts). Unlike agoda-mapper.ts's `classifyAgodaRoomKind`,
 * `is_dormitory` is trusted here — it is Booking's own structured field, confirmed live to
 * exist and read `0` correctly for an ordinary hotel's twin/double rooms, not a
 * same-named-but-broken flag the way Agoda's turned out to be. What was NOT verified live
 * (the 50-request/month budget ran out first) is that it actually reads `1` for a real
 * dorm room — see booking-types.ts's `BookingRoomBlock.is_dormitory` comment and the PR
 * body's "hostel data" section. Name matching still runs as a second, OR'd signal rather
 * than being dropped, both because that gap exists and because Booking has no dedicated
 * field for the female-only case at all — a name check is the only way to catch that
 * regardless of how reliable `is_dormitory` proves to be.
 *
 * "Private" is checked first for the same reason agoda-mapper.ts checks it first: a
 * private multi-bed room can plausibly be named with the word "dorm" in it (not confirmed
 * live for Booking specifically, but Agoda's "Private 6 Bed Dorm Room" shows the pattern
 * exists on at least one of these two providers, so this adapter treats it as a real risk
 * rather than an Agoda-only quirk).
 */
export function classifyBookingRoomKind(
  roomName: string,
  isDormitory: 0 | 1 | undefined,
): RoomKind {
  if (/\bprivate\b/i.test(roomName)) return "private";
  const isDormLike =
    isDormitory === 1 ||
    /dorm|dormitory|\bbed in\b|shared\s+room/i.test(roomName);
  if (isDormLike && /\bfemale\b|\bwomen'?s?\b|\bladies\b/i.test(roomName))
    return "female-dorm";
  if (isDormLike) return "dorm";
  return "private";
}

export interface BookingCandidate {
  hotelId: number;
  property: Property;
  headlinePrice: Money;
}

/** Maps one search result to a rankable candidate, or `undefined` when it is missing a
 * name, coordinates, or a live price — mirrors agoda-mapper.ts
 * `mapSearchPropertyToCandidate`'s same three-field requirement. Booking's own search
 * already filters by the requested coordinate and radius server-side (unlike Agoda's), so
 * there is no separate client-side radius filter here. */
export function mapSearchResultToCandidate(
  result: BookingSearchResult,
): BookingCandidate | undefined {
  const { hotel_name: name, latitude, longitude, hotel_id: hotelId } = result;
  const headlinePrice = toMoney(
    result.composite_price_breakdown?.gross_amount_per_night ?? {},
  );
  // `typeof` checks, not just truthiness/`undefined` checks (issue #68): `booking-types.ts`
  // declares these fields' types as a compile-time hint, not a runtime guarantee — a
  // scraper response that re-types `hotel_id` as a string, say, must drop this candidate
  // rather than carry a wrongly-typed id into the cache keys and dedupe logic that assume
  // a real number (booking.ts).
  if (
    typeof name !== "string" ||
    !name ||
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    typeof hotelId !== "number" ||
    !headlinePrice
  ) {
    return undefined;
  }
  const rating = result.review_score;

  return {
    hotelId,
    property: {
      name,
      coordinates: { latitude, longitude },
      // `main_photo_url` arrives at 60x60 and is upgraded to a card-sized address here.
      // `booking-photo.ts` carries the measurement and the fallback that makes the swap
      // safe.
      images:
        typeof result.main_photo_url === "string" && result.main_photo_url
          ? [upgradeBookingPhoto(result.main_photo_url)]
          : [],
      // Issue #245: out of 10 (see `booking-types.ts`), and the scale rides along so no
      // screen has to guess which one this is.
      rating:
        typeof rating === "number" && Number.isFinite(rating)
          ? { value: rating, outOf: 10 }
          : undefined,
      // Read from the property name because neither provider has a field for it. Its
      // rooms are named ordinarily, so classifying rooms alone let a women-only
      // hostel through to a party with no female travellers.
      womenOnly: isWomenOnlyPropertyName(name) || undefined,
    },
    headlinePrice,
  };
}

/** One Stay per `RoomKind` actually present at this property, each at that kind's
 * cheapest block — same "dorm vs private, not every named variant" grouping
 * agoda-mapper.ts's `mapMasterRoomsToStays` does, and for the same reason: domain/stay.ts
 * wants one Stay per priced room-kind option, not one per rate plan. */
export function mapRoomBlocksToStays(
  property: Property,
  blocks: readonly BookingRoomBlock[],
): Stay[] {
  const cheapestByKind = new Map<RoomKind, Money>();
  for (const block of blocks) {
    if (typeof block.room_name !== "string" || !block.room_name) continue;
    const price = toMoney(
      block.product_price_breakdown?.gross_amount_per_night ?? {},
    );
    if (!price) continue;
    const isDormitory =
      block.is_dormitory === 0 || block.is_dormitory === 1
        ? block.is_dormitory
        : undefined;
    const kind = classifyBookingRoomKind(block.room_name, isDormitory);
    const existing = cheapestByKind.get(kind);
    if (!existing || price.minorUnits < existing.minorUnits)
      cheapestByKind.set(kind, price);
  }
  return Array.from(cheapestByKind.entries()).map(
    ([roomKind, pricePerNight]) => ({
      property,
      roomKind,
      pricePerNight,
    }),
  );
}

export function mapRoomListToStays(
  property: Property,
  response: BookingRoomListResponse,
): Stay[] {
  const blocks = response.data?.block;
  // Same reasoning as agoda-mapper.ts's mapGetPricesToStays: a present-but-wrong-shaped
  // `block` (not an array) must not reach the `for...of` above, which would throw on
  // anything that isn't iterable.
  return mapRoomBlocksToStays(property, Array.isArray(blocks) ? blocks : []);
}
