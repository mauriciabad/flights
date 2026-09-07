/**
 * A trip the traveller kept, and every price this app has seen it at since.
 *
 * Issue #434, the owner in full:
 *
 * > when i search a flight combination i want to save some itinerary (the flights,
 * > transport methid, hotel, etc). currenty there's a search history but we should also
 * > have saved itineraries, and keep track of prices (only when user revisits the page we
 * > get a new price entry, and save the breakdown not just the final number)
 *
 * `search-history/` next door stores one query string per row and nothing else, because a
 * search IS its query and reconstructing it is `/results/?<query>`. A saved itinerary
 * cannot work that way. It is one connection city out of one search, and the list has to
 * draw before any provider answers, on a plane, in a tunnel, with every key removed. So a
 * snapshot of the trip travels with it and the query rides alongside for the day the
 * traveller wants the live version back.
 *
 * ## The two rules the shape enforces
 *
 * **A price is a receipt, never a headline.** `PriceObservation` carries the flights, the
 * bed and the ground separately, because a total that moved says nothing about which part
 * moved, and "the hotel went up €40 while the fare fell €12" is the whole reason to keep
 * a log at all. Each part is `Money`, so every figure here is integer minor units and a
 * currency code (AGENTS.md, "Money").
 *
 * **A part nobody priced is absent, never zero.** `flights`, `bed` and `ground` are all
 * optional and an absent one means no provider quoted that part. This repo has caught
 * itself confusing the two before: `domain/transfer.ts` keeps a free walk and an unquoted
 * taxi apart on purpose, and issue #212 removed a fabricated zero from the receipt. A
 * stored `{ minorUnits: 0 }` would say the bed was free.
 *
 * Times are `LocalDateTime` throughout: the wall clock at the airport that reads it, with
 * its zone and offset. Never an instant, never a formatted string. AGENTS.md, "Timezones".
 */

import type {
	IataAirportCode,
	IataAirlineCode,
	ItineraryTransferLeg,
	LocalDateTime,
	Money,
	PropertyRating,
	RoomKind,
	TransferMode
} from '$lib/domain';

/**
 * Identifies one saved trip forever, derived from the search and the connection city and
 * from nothing else. See `savedItineraryId` in `storage.ts` for the derivation and for why
 * it is a pure function both halves of this feature call.
 */
export type SavedItineraryId = string;

/**
 * One visit to one results page, as an opaque token.
 *
 * The owner's constraint is "only when user revisits the page we get a new price entry",
 * and a re-render is not a revisit. A time window would guess at that ("assume anything
 * inside five minutes is the same visit"), and the guess is wrong in both directions: a
 * traveller who reloads twice in a minute made two visits, and a tab left open for an hour
 * made one. So the visit is a value the results page mints once and holds, and the
 * recorder refuses an observation whose token it already stored.
 */
export type VisitToken = string;

/** One end of one flight, as a boarding pass prints it. */
export interface SavedFlight {
	carrier: { iataCode: IataAirlineCode; name: string };
	/** e.g. "FR1234". */
	flightNumber: string;
	departureAirport: IataAirportCode;
	arrivalAirport: IataAirportCode;
	departure: LocalDateTime;
	arrival: LocalDateTime;
}

/** An airport and the city on the ticket, so a saved row can say "VIE, Vienna" without an
 * airport lookup. The dataset is in the bundle either way; carrying the name means a row
 * cannot go blank because a code fell out of a later dataset revision. */
export interface SavedPlace {
	airport: IataAirportCode;
	city: string;
}

/** The bed, as much of it as a list row needs. No coordinates, no images: this is a line
 * of text, and the live version is one tap away through `query`. */
export interface SavedBed {
	propertyName: string;
	roomKind: RoomKind;
	/** Absent means no provider gave a score, which is a different fact from a bad score
	 * (`domain/stay.ts`). The scale travels with the number, issue #245. */
	rating?: PropertyRating;
}

/** One ground leg and how it was travelled. Named by the itinerary field it came from, so
 * nothing can map a mode onto the wrong leg. */
export interface SavedGroundLeg {
	leg: ItineraryTransferLeg;
	mode: TransferMode;
}

/**
 * The trip as it stood the moment the heart was pressed.
 *
 * Deliberately not an `Itinerary`. That type is the search pipeline's working shape,
 * ninety fields deep with geometry, schedules and provenance on it, and storing it would
 * put a snapshot of this app's internals in a browser that has to keep reading them a
 * year from now. This is what a row draws, and it is allowed to be exactly that.
 */
export interface SavedTrip {
	origin: SavedPlace;
	connection: SavedPlace;
	destination: SavedPlace;
	outboundFlight: SavedFlight;
	onwardFlight: SavedFlight;
	/** Zero on a connection the traveller never leaves the airport for (`domain/itinerary.ts`
	 * calls that trip airside), where there is no bed and no ride into town either. */
	nightsInConnection: number;
	/** Every ground leg this trip has, in trip order. Empty on an airside connection with
	 * no origin or destination location set. */
	groundLegs: SavedGroundLeg[];
	/** Absent when no stay provider priced a bed. Never a placeholder: a missing bed is a
	 * fact this app states rather than fills in (AGENTS.md, "When the data is missing"). */
	bed?: SavedBed;
	/** The party size the prices below were quoted for. */
	travellers: number;
}

/**
 * What this trip cost on one visit, part by part.
 *
 * The three parts sum to `total` exactly, because `build.ts` derives them from the same
 * `scaleFareForParty`/`sumMoney` pair that produced `Itinerary.totalPrice` in the first
 * place. A part that no provider priced is absent, and then `total` is a floor rather than
 * a price, which is the same reading `Itinerary.totalPrice` already carries (issue #204).
 */
export interface PriceObservation {
	/** Epoch milliseconds. Our clock, when we looked, never when a provider set the price
	 * (`results/types.ts` on `retrievedAgeMs` has the argument for the distinction). */
	observedAt: number;
	/** The visit that produced this row. See `VisitToken`. */
	visit: VisitToken;
	/**
	 * The nights this price was for.
	 *
	 * Not redundant with the snapshot's own count. A traveller can extend a stopover on the
	 * results page and the total moves with it, so two rows of one log can be priced at
	 * different lengths, and a chart that did not say so would read as a fare doubling
	 * overnight.
	 */
	nights: number;
	/** Both fares, scaled to the party by each offer's own `priceScope`. */
	flights?: Money;
	/** `nights x pricePerNight`, the figure that went into the total. Absent when no bed was
	 * priced, which is not the same as a free one. */
	bed?: Money;
	/** Every ground leg a provider actually quoted, summed. Normally absent: no transfer
	 * provider in this codebase quotes a fare today (`domain/transfer.ts`), and the rate-card
	 * estimate is deliberately not counted here because it is a guess from a table of
	 * municipal tariffs rather than a price anybody was charged. */
	ground?: Money;
	/** `Itinerary.totalPrice`: the sum of what providers actually quoted. */
	total: Money;
}

/** One trip in the list. */
export interface SavedItinerary {
	id: SavedItineraryId;
	/**
	 * URL search params for `/results/`, in the spelling `normalizeQuery` produces, so
	 * `/results/?<query>` reopens the search this trip was found in. Same field, same
	 * spelling and same purpose as `SearchHistoryEntry.query`, so a saved trip and the
	 * search behind it are the same string in both stores.
	 */
	query: string;
	/** Epoch milliseconds. */
	savedAt: number;
	trip: SavedTrip;
	/** Oldest first, so a chart reads left to right and the newest row is the last one.
	 * Capped; see `MAX_PRICE_OBSERVATIONS`. */
	prices: PriceObservation[];
}
