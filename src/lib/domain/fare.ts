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
	/** The unconverted bounds, in `from`'s minor units, covering whoever `FareRange.party`
	 * says the converted ones do. Kept rather than recomputed: a screen that divided the
	 * converted figure back would be showing the rate's rounding error as though it were
	 * the tariff. */
	fromLowMinorUnits: number;
	fromHighMinorUnits: number;
	/** The ECB reference day the rate is for, `YYYY-MM-DD`. Not the day it was fetched and
	 * not today: this is the claim the ECB made, and it is what dates the conversion. */
	rateDate: string;
}

/**
 * Who a `FareRange`'s bounds cover, and what one head of them costs. Issue #344.
 *
 * The owner: "usually in this cases a taxi may be worth it, specially if can be split when
 * multiple people is traveling." He is right, and the app could not say it, because a
 * meter charges the car and a bus ticket charges the seat and both were printed in the
 * same column as though they answered the same question. For one traveller that is roughly
 * fair. For four it is wrong in the direction that hides the better option.
 *
 * A union rather than a per-person pair of numbers, because there are two different facts
 * here and only one of them is arithmetic:
 *
 * | basis | what the bounds are | may a screen divide them |
 * | --- | --- | --- |
 * | `per-vehicle` | the whole party's fare, every car it needs | yes, `perPerson*` is that division |
 * | `unknown` | one vehicle's fare, unmultiplied | **no** |
 *
 * `'unknown'` is the fallback rate card (`taxi-rate-table.ts`), which stands in for a
 * country this app has no tariff for. Whether a taxi there meters the car or sells a seat
 * is exactly what having no card means, and a shared taxi sold per seat is an ordinary
 * thing in the places that card covers. So the party size is carried and the arithmetic is
 * not done, and the screen says so rather than quietly showing one car's fare to four
 * people.
 *
 * Absent on a `FareRange` is a third thing again: nobody named a party size, or the party
 * is one traveller, where the car's fare and the head's are the same number and a split
 * would be noise. `stays/pricing.ts`'s `NightlyRate.audience` makes the same call for the
 * same reason.
 */
export type FareParty =
	| {
			basis: 'per-vehicle';
			/** How many travellers the range covers. Always more than one; see above. */
			people: number;
			/** How many cars that many people need, at `TAXI_SEATS_PER_VEHICLE`. */
			vehicles: number;
			/** What one car costs, which is what the rate card actually describes and what
			 * one driver's meter will read. Kept rather than recomputed by dividing the
			 * party figure by `vehicles`: a screen that did that would be showing this
			 * function's rounding as though it were the tariff. */
			perVehicleLowMinorUnits: number;
			perVehicleHighMinorUnits: number;
			/** The party's fare divided by heads: what each traveller pays if they split it,
			 * which is the figure that compares with a bus ticket. */
			perPersonLowMinorUnits: number;
			perPersonHighMinorUnits: number;
	  }
	| { basis: 'unknown'; people: number };

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
	/**
	 * Low and high bounds, in `currency`'s minor units, from applying the matched rate
	 * card's low/high flag-down and per-km figures to the route distance, then converting
	 * if `converted` says so.
	 *
	 * Issue #344: this is what the WHOLE PARTY pays, every car they need, whenever `party`
	 * below says `per-vehicle`. Same choice #339 made about the currency and for the same
	 * reason: a screen that had not heard of party size goes on printing one car's fare
	 * beside four bus tickets, which is the bug. This way forgetting costs the split line,
	 * not the figure. It also puts this range on the same footing as every other number on
	 * the receipt, since `algorithm/build.ts` totals the party's flights
	 * (`scaleFareForParty`) and the party's room.
	 */
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
	/** Who the bounds above cover, when the caller named a party of more than one. Issue
	 * #344, and see `FareParty` for what each of its two shapes licenses a screen to do. */
	party?: FareParty;
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
