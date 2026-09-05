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
 * the thing a screen has to render, a bounded guess with its source attached or a refusal
 * with the reason, is the same whatever mode ever produces one.
 */

/**
 * What a `FareRange` was before it was put into the traveller's currency. Issue #339.
 *
 * The owner read `Rides from and to hotel  £115.04-£182.84` on a trip he had asked for in
 * euros. The rate card really is written in the ride's country's currency, so the pounds
 * were true and useless: a figure he could not compare with the total three lines above
 * it. Converting fixes that and introduces a second thing to be honest about, because a
 * converted estimate is an approximation of an approximation. A rate card compiled once,
 * applied to a distance, then crossed at a rate of some age.
 *
 * So the source survives the conversion instead of being spent by it. A screen holding one
 * of these can always say what the driver will actually charge and in what, which is the
 * fact a traveller standing at a taxi rank needs, and no screen can print the converted
 * bounds while believing they are what the rate card said.
 *
 * Absent on a `FareRange` means no conversion happened, which is a fact rather than a
 * failure: the rate card's currency was already the traveller's, or
 * `data/exchange-rates.ts` had no rate to offer. In both cases `currency` on the range is
 * the one number this app can stand behind.
 */
export interface FareConversion {
	/** The rate card's own currency, and the one the ride is actually paid in. */
	from: IsoCurrencyCode;
	/** The unconverted bounds, in `from`'s minor units. Kept rather than recomputed: a
	 * screen that divided the converted figure back would be showing the rate's rounding
	 * error as though it were the tariff. */
	fromLowMinorUnits: number;
	fromHighMinorUnits: number;
	/** The ECB reference day the rate is for, `YYYY-MM-DD`. Not the day it was fetched and
	 * not today: this is the claim the ECB made, and it is what dates the conversion. */
	rateDate: string;
}

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
	/**
	 * What a screen prints these bounds in. The traveller's picked currency once
	 * `converted` is set, and the rate card's own currency otherwise.
	 *
	 * Issue #339 changed which of those it usually is, and deliberately did not add a
	 * second pair of fields for the converted figure. A screen that forgot about
	 * conversion would then have gone on printing the rate card's currency, which is the
	 * bug. This way forgetting costs the provenance line, not the fix.
	 */
	currency: IsoCurrencyCode;
	/** Low and high bounds, in `currency`'s minor units, from applying the matched rate
	 * card's low/high flag-down and per-km figures to the route distance, then converting
	 * if `converted` says so. */
	lowMinorUnits: number;
	highMinorUnits: number;
	/** The country whose rate card produced this estimate, not necessarily the country the
	 * app already knows the connection is in, since a caller might ask for any pair of
	 * points. */
	countryCode: IsoCountryCode;
	/** `'fallback'` means no dedicated card exists for `countryCode` and a generic
	 * cross-country range was used instead. A UI should hedge harder on this, e.g. widen
	 * a "roughly €X" line to "somewhere between €X and €Y, could be more". */
	rateSource: 'country' | 'fallback';
	/** Where the flag-down and per-km figures came from, for whoever wants to check them
	 * rather than take them on faith. */
	citation: string;
	/** Set only when the bounds above were crossed out of another currency. Issue #339,
	 * and see `FareConversion` for why the source survives rather than being spent. */
	converted?: FareConversion;
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
