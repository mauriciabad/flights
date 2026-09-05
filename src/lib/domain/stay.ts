import type { Coordinates } from "./coordinates";
import type { Money } from "./money";

/**
 * Issue #1: "room kind (`dorm` | `private` | `female-dorm`)." A distinct female-dorm kind
 * matters because "Number of females" (brief line 34) decides whether those beds are even
 * available to filter in or out — a female dorm bed is not the same inventory as a mixed
 * dorm bed, so collapsing them into one `dorm` kind would lose that filter.
 */
export type RoomKind = "dorm" | "private" | "female-dorm";

/**
 * A guest score together with the scale its provider published it on.
 *
 * Issue #245: this used to be a bare `number` with a comment saying the scale was a
 * display concern, and the display had no way to know it. `ItineraryTimeline.svelte`
 * hardcoded `/5`, so Hostelworld's 87-out-of-100 for London Backpackers reached the owner
 * as "rated 87/5" and a Booking 7.8-out-of-10 would have read "7.8/5". The `StayPicker`
 * hedged instead, printing "87.0 rating (scale as reported by the source)", which is
 * honest and unreadable, and made one screen describe one number two ways.
 *
 * The number and the scale are one value, so they travel as one value. The three scales
 * this repo has captured live are in `outOf`'s comment.
 */
export interface PropertyRating {
  /** Exactly what the provider reported, on its own scale, never rescaled here. Converting
   * for a reader is `formatPropertyRating`'s job in `$lib/format`. */
  value: number;
  /** The top of that provider's scale. Measured, per adapter: Hostelworld 100
   * (`hostelworld-properties-london.json`, 63/68/88), Booking 10
   * (`booking-search-vienna.json`, 7.8/7.4), Agoda 5 (`agoda-search-vienna.json`,
   * 4.0/5.0/1.5/3.0). */
  outOf: number;
}

/**
 * The hostel/hotel itself, shared by every RoomKind priced within it.
 * Brief line 64: "Info about the hostels and rooms and images if possible."
 */
export interface Property {
  name: string;
  coordinates: Coordinates;
  images: string[];
  /** Absent means no provider gave a score, which is a different fact from a bad score.
   * See `PropertyRating`. */
  rating?: PropertyRating;
  /** The WHOLE property admits women only, which is not the same thing as one of its
   * rooms being a female dorm. "Hostelle - women only hostel London" was recommended to
   * the owner's party of zero female travellers, because both mappers only ever tested
   * the ROOM name and its rooms are named ordinarily. The restriction lives here, on the
   * thing it actually restricts. Absent means the provider gave no signal, not that the
   * property is mixed. */
  womenOnly?: boolean;
}

/**
 * One priced room-kind option at a property.
 * Issue #1: "Stay — property, room kind, price per night, coords, images, rating."
 * Brief line 65: "price per night in dorm and in private room (user can select to update
 * total)" — a property offering both a dorm bed and a private room is two Stay records,
 * not one Stay with two prices.
 */
export interface Stay {
  property: Property;
  roomKind: RoomKind;
  /** The whole party's nightly cost, which is what `nights × pricePerNight` totals into
   * `Itinerary.totalPrice`. Every adapter normalises to this. */
  pricePerNight: Money;
  /**
   * What one person's bed costs a night, and only when a provider quoted it that way.
   *
   * Issue #206 asks the card for "price per night per person", and it warns that nobody
   * had checked whether a provider's nightly rate is per person or per party. Measured on
   * 2026-09-05 (docs/PROVIDERS.md, "`guests` filters availability and never scales a
   * price"): Hostelworld quotes one unit of inventory and `guests` moves no number. A dorm
   * unit is one bed, so its quote already IS the per-person rate and
   * `hostelworld-mapper.ts` multiplies it up to fill `pricePerNight`. This field carries
   * the figure it started from, so the card prints what Hostelworld said rather than a
   * division of a total.
   *
   * Absent for a private room, and for every Agoda and Booking quote. Those are one room
   * for the whole party, priced as a room whatever the party size, and cutting a room rate
   * into heads would put a number on screen that no provider ever gave. A card with no
   * per-person figure says the party rate and who it covers instead.
   */
  pricePerPersonPerNight?: Money;
}
