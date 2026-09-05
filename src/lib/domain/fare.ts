import type { IsoCountryCode, IsoCurrencyCode } from './codes';

/**
 * What a ride costs when nobody has quoted it and the app is willing to guess anyway.
 *
 * Issue #249. These two shapes used to live in `providers/transfers/taxi-rate-table.ts`,
 * where only that module and the transport picker could see them. They moved here so a
 * `Transfer` can carry one (`transfer.ts`'s `fareEstimate`), which is what lets the
 * receipt on the results card say "about £24-£38" where it used to say "not priced".
 *
 * The rate card that fills these in is still taxi-specific and still lives in
 * `providers/transfers/taxi-rate-table.ts`. Only the answer's shape is general, because
 * the thing a screen has to render — a bounded guess with its source attached, or a
 * refusal with the reason — is the same whatever mode ever produces one.
 */

/**
 * A fare nobody quoted: two bounds and enough provenance to judge how much to trust them.
 *
 * A range rather than a single figure, and that is the whole design. `Money` is one number
 * a UI can print as if it were confirmed, so an estimate is deliberately a different type:
 * a discriminated union of "things that hold a price" can never collapse this into
 * whatever expects a real `Money` without a caller noticing and handling the range on
 * purpose. Issue #212 removed a fabricated `€0` and issue #246 removed a fare bigger than
 * the flight it connected to; both got in because a guess was shaped like a quote.
 */
export interface FareRange {
	kind: 'estimate';
	currency: IsoCurrencyCode;
	/** Low and high bounds, in the currency's minor units, from applying the matched rate
	 * card's low/high flag-down and per-km figures to the route distance. */
	lowMinorUnits: number;
	highMinorUnits: number;
	/** The country whose rate card produced this estimate — not necessarily the country
	 * the app already knows the connection is in, since a caller might ask for any pair
	 * of points. */
	countryCode: IsoCountryCode;
	/** `'fallback'` means no dedicated card exists for `countryCode` and a generic
	 * cross-country range was used instead. A UI should hedge harder on this, e.g. widen
	 * a "roughly €X" line to "somewhere between €X and €Y, could be more". */
	rateSource: 'country' | 'fallback';
	/** Where the flag-down and per-km figures came from, for whoever wants to check them
	 * rather than take them on faith. */
	citation: string;
}

/**
 * The ride is longer than any rate card describes, so there is no fare here at all.
 * Issue #246, and see `MAX_RATED_TAXI_DISTANCE_KM` for what settled the boundary.
 *
 * A separate member of the union rather than an absent estimate, because "we did not ask"
 * and "we asked and will not guess" are different answers and the traveller is owed the
 * second one in words. It carries the distance and the ceiling so a screen can say which
 * ride it is refusing to price, and the citation so it can still say which card it would
 * have reached for.
 */
export interface FareBeyondRatedRange {
	kind: 'out-of-range';
	distanceKm: number;
	ratedUpToKm: number;
	countryCode: IsoCountryCode;
	citation: string;
}

/** Everything a rate card can say about one ride: a range, or a refusal. */
export type FareEstimate = FareRange | FareBeyondRatedRange;
