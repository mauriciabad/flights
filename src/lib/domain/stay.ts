import type { Coordinates } from "./coordinates";
import type { Money } from "./money";
import type { ProviderId } from "./provider-id";

/**
 * Issue #1: "room kind (`dorm` | `private` | `female-dorm`)." A distinct female-dorm kind
 * matters because "Number of females" (brief line 34) decides whether those beds are even
 * available to filter in or out — a female dorm bed is not the same inventory as a mixed
 * dorm bed, so collapsing them into one `dorm` kind would lose that filter.
 *
 * `male-dorm` joined them for issue #288, and for the same reason rather than for
 * symmetry's sake. Hostelworld sells one: `basicType: "Male Dorm"` is 8 of the 69 dorm
 * rooms in a live Rome page and 3 of the 135 in London
 * (`tools/probe-female-dorms.mjs`, 2026-09-05). Without a kind of its own it classified
 * as `dorm`, so the app offered a woman a bed she cannot book. Issue #27's rule pointed
 * the other way. Two of those Rome properties sell dorm beds and nothing but male ones,
 * so it is not a rounding error either.
 */
export type RoomKind = "dorm" | "private" | "female-dorm" | "male-dorm";

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
  /**
   * Photographs of THIS room, as opposed to `property.images`, which is the building.
   *
   * Issue #442, the owner: "I think the hotels offer a different set of images for the room
   * selected, would be nice to also be able to see those in my app." He is right about the
   * providers and wrong about the endpoints this app calls, which is the whole finding.
   * `docs/PROVIDERS.md` holds the field-by-field table; the short version is that only
   * Hostelworld publishes room photographs at all, and not on the search endpoint. So this
   * field is empty for every stay any search returns, and it is not the whole answer to the
   * owner's question. `RoomPhotoLookup` below is the rest of it: what a provider says when
   * it is asked about one property, which is issue #449.
   *
   * Absent and empty mean the same thing here, which is "the provider gave none". Neither
   * means the room has no photographs.
   *
   * Card-sized already, through the same `*-photo.ts` rewriter `Property.images` goes
   * through, so a room photograph cannot arrive as the 2.8 MB original the rewriters exist
   * to avoid.
   *
   * The one rule everything downstream keeps: a photograph in here is of the room and a
   * photograph in `property.images` is of the building, and nothing may present one as the
   * other. `$lib/stays/stay-photos.ts` is where the two sets become one list, labelled.
   */
  roomImages?: string[];
  /**
   * Where this listing lives at the provider that sent it, so it can be asked a follow-up
   * question about itself. Issue #450.
   *
   * `propertyKey` is `name@lat,lon`, which is an identity for merging two adapters' records
   * for one physical hostel and means nothing to the provider that sent them. This is the
   * other identity, and the two must not be confused: a `Property` can already be two
   * providers' idea of one building, while a `Stay` is always exactly one provider's
   * listing, which is the thing an id can honestly describe.
   *
   * Absent for an adapter that publishes no stable id, and absent on every `Stay` written
   * before #450 that a cache or a saved trip still holds. Absent means one thing only:
   * nothing can be asked about this listing. Nothing downstream may read it as a fact about
   * the property.
   *
   * **Never compare two records on this.** `propertyKey` and `isSameBed` stay name and
   * coordinates. Two adapters listing one hostel carry two different provider ids for it,
   * so comparing on this would stop them merging and show the owner the same hostel twice
   * (#188 is what that looks like).
   */
  source?: StaySource;
}

/** One provider's own coordinates for one listing. See `Stay.source`. */
export interface StaySource {
  provider: ProviderId;
  /** The provider's own property id, verbatim as a string, never parsed and never
   * arithmetic. Hostelworld sends it as a number on the city endpoint and as a string on
   * the availability endpoint for the same property (`"330521"` against `330521`, measured
   * 2026-09-08 with `tools/probe-hostelworld-rooms.mjs`), which is exactly why this is
   * normalised to text at the mapper and compared as text everywhere after. */
  propertyId: string;
  /**
   * The room whose rate `pricePerNight` came from, when one room owns it.
   *
   * Absent for a `dorm` or a `private` at Hostelworld, which are priced from
   * `lowestAverage*PricePerNight`, a property-level average over rates no single room
   * quotes. Absent for every Booking and Agoda stay, because neither response carries a room
   * id at all (docs/PROVIDERS.md's room table, measured from captures already on disk).
   */
  roomId?: string;
}

/**
 * Photographs of the rooms at one property, as a provider publishes them, keyed both ways a
 * `Stay` can honestly claim one. Issue #449.
 *
 * Card-sized already, through the same `*-photo.ts` rewriter `Property.images` and
 * `Stay.roomImages` go through, so nothing in here can arrive as the multi-megabyte original.
 *
 * Two keyings because a `Stay` has two kinds of claim on a photograph and they are not the
 * same claim.
 *
 * `byRoomId` is the strong one. `Stay.source.roomId` names the room the rate came from, so a
 * photograph found under that id really is a photograph of the room whose price is on screen.
 *
 * `byKind` is the honest weaker one. A `dorm` or a `private` at Hostelworld is priced from a
 * property-level average that no single room quotes, so no photograph is of "the room" and
 * the strong claim is unavailable for the two commonest kinds. What is still true is that
 * these are the dorms at this property. `$lib/stays/stay-photos.ts` labels the two
 * differently and that difference is the whole point: "Dorm rooms at Rest Up London" is a
 * true sentence, and "this is the bed you are buying" is not one anybody can make here.
 *
 * Plain records rather than `Map`s because this is cached, and a record survives the trip
 * through IndexedDB as itself.
 */
export interface RoomPhotoLookup {
  /** Whose room ids `byRoomId` is keyed by. Two adapters can describe one building
   * (`groupByProperty` merges them on name and coordinates), and their room ids come from
   * different namespaces, so matching one provider's id against another's table would put a
   * stranger's room under a price. The kind table below is safe across providers because it
   * is a claim about the building rather than about a listing. */
  provider: ProviderId;
  /** Keyed by the provider's own room id, the same text `StaySource.roomId` carries. */
  byRoomId: Record<string, string[]>;
  /** Every photographed room of one kind at this property, in the order the provider listed
   * them. A restricted dorm never contributes to `dorm` and a mixed one never to
   * `female-dorm`, because those are different inventory (#27, #288) and mixing them would
   * put a women-only room under a bed anyone can book. */
  byKind: Partial<Record<RoomKind, string[]>>;
}

/**
 * Bumped whenever the stored shape of a `Stay` changes, and mixed into the cache key of
 * every cache that holds one. Issue #450, and #131 before it.
 *
 * A value already in IndexedDB is read back and used, never inspected and found wanting, so
 * a shape change with an unchanged key means the fix installs and the old value comes
 * straight back. #131 shipped exactly that. The OSRM route cache keyed on
 * `{service, profile, origin, destination}` with a thirty-day TTL, so everyone who had used
 * the app that month installed real map geometry and kept seeing straight lines. The rule
 * AGENTS.md drew from it is that a cached value whose shape changed needs a key that no
 * longer resolves to the old one.
 *
 * Only the caches that store a `Stay` mix this in, which today is Agoda's `getPrices` and
 * Booking's `roomList`. Hostelworld caches the provider's own response body and re-runs its
 * mapper on every read, so its entries pick up a new field with no eviction at all, and
 * versioning it would spend a request per city to relearn something already on disk.
 *
 * A saved trip does not carry it either, on purpose. `source` is optional and its absence
 * degrades to what the app did before #450, which is a far better outcome for someone who
 * saved a trip than losing the trip.
 */
export const STAY_SHAPE_VERSION = 2;

/**
 * The reminder that the constant above exists, in a form the compiler enforces.
 *
 * Adding or removing a field on `Stay` makes this literal wrong, so the build fails until
 * somebody reads this comment and decides whether the change reaches a cached value. A
 * sentence in a doc comment would only be read by whoever went looking for it, and the
 * whole lesson of #131 is that nobody did.
 */
const STAY_SHAPE_FIELDS: Record<keyof Required<Stay>, true> = {
  property: true,
  roomKind: true,
  pricePerNight: true,
  pricePerPersonPerNight: true,
  roomImages: true,
  source: true,
};

/** Every field name `STAY_SHAPE_VERSION` is a version of. Exported so the guard above is a
 * value the build keeps rather than dead weight a linter removes. */
export const STAY_SHAPE_FIELD_NAMES: readonly string[] = Object.keys(STAY_SHAPE_FIELDS);
