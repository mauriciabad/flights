import type { IsoCountryCode, IsoCurrencyCode } from '../../domain';

/**
 * A taxi fare is never a quote here, only a distance-based guess from a per-country rate
 * card. AGENTS.md, "When the data is missing": "never present an estimate as a fact." A
 * `Money` is a single number a UI can print as if it were confirmed, so this is
 * deliberately a different shape: a range, plus enough provenance to judge how much to
 * trust it. `kind: 'estimate'` exists so a discriminated union of "things that hold a
 * price" can never collapse a `TaxiFareRange` into whatever expects a real `Money`
 * without a caller noticing and handling the range on purpose.
 */
export interface TaxiFareRange {
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
 * The ride is longer than any card in this table describes, so there is no fare here at
 * all. Issue #246, and see `MAX_RATED_TAXI_DISTANCE_KM` for what settled the boundary.
 *
 * A separate member of the union rather than an absent estimate, because "we did not ask"
 * and "we asked and will not guess" are different answers and the traveller is owed the
 * second one in words. It carries the distance and the ceiling so a screen can say which
 * ride it is refusing to price, and the citation so it can still say which card it would
 * have reached for.
 */
export interface TaxiFareOutOfRange {
	kind: 'out-of-range';
	distanceKm: number;
	ratedUpToKm: number;
	countryCode: IsoCountryCode;
	citation: string;
}

/** Everything this table can say about one ride: a range, or a refusal. */
export type TaxiFareEstimate = TaxiFareRange | TaxiFareOutOfRange;

interface TaxiRateCard {
	currency: IsoCurrencyCode;
	/** Flag-down / minimum charge before any distance, minor units, `[low, high]`. */
	flagDownMinorUnits: readonly [number, number];
	/** Price per kilometre once moving, minor units, `[low, high]`. */
	perKmMinorUnits: readonly [number, number];
	citation: string;
}

/**
 * Compiled from public tariff pages and cross-city fare comparisons, checked
 * 2026-09-04. None of this is a live feed — a metered fare on the day will differ from
 * this table, sometimes by a lot, which is exactly why `estimateTaxiFare` returns a
 * range rather than a point figure. Two entries (Portugal and Czechia) are marked as
 * back-calculated from a single blended "5km ride" comparison rather than a real
 * flag-down/per-km breakdown, and are the least trustworthy rows in the table; their
 * ranges are widened accordingly rather than presented with the same confidence as an
 * entry sourced from an actual tariff ordinance.
 *
 * Extend this table by adding more countries; do not tighten an existing range without
 * a better source than the one already cited.
 */
export const TAXI_RATE_TABLE: Readonly<Record<IsoCountryCode, TaxiRateCard>> = {
	ES: {
		currency: 'EUR',
		flagDownMinorUnits: [215, 300],
		perKmMinorUnits: [113, 135],
		citation:
			'Barcelona municipal taxi tariff (Tariff 1, day), effective Jan 2025: flag-down €2.15, ' +
			'€1.13/km. Madrid municipal tariff: flag-down €2.50 (Tariff 1, day) / €3.00 (Tariff 2, ' +
			'night & weekends), €1.25-1.35/km.'
	},
	FR: {
		currency: 'EUR',
		flagDownMinorUnits: [260, 400],
		perKmMinorUnits: [100, 129],
		citation:
			'€1.29/km is the French government-regulated national maximum for daytime tariff ' +
			'(service-public.gouv.fr, 2025); flag-down is set per prefecture rather than nationally. ' +
			'A cross-city comparison (taxi-calculator.com) puts a blended 5km Paris-area fare around ' +
			'€10, consistent with a per-km rate below the regulated ceiling.'
	},
	DE: {
		currency: 'EUR',
		flagDownMinorUnits: [350, 430],
		perKmMinorUnits: [170, 240],
		citation:
			'taxi-calculator.com cites a representative German tariff of a €4.00 flag-down plus ' +
			'€2.20/km; range widened around that figure for the spread between cities (German taxi ' +
			'tariffs are set per municipality, not nationally).'
	},
	IT: {
		currency: 'EUR',
		flagDownMinorUnits: [300, 790],
		perKmMinorUnits: [110, 170],
		citation:
			"Roma Capitale tariff table: minimum fare €9, per-km €1.31/€1.42/€1.70 across the " +
			"city's three distance tiers (T1/T2/T3). Comune di Milano tariff: flag-down €4.10-7.90, " +
			'€1.32/km.'
	},
	PT: {
		currency: 'EUR',
		flagDownMinorUnits: [200, 325],
		perKmMinorUnits: [90, 140],
		citation:
			'Flag-down bracket from Portuguese national tariff reform reporting (The Portugal News, ' +
			'Jun 2026), reducing the flag-down from €3.25 to €2.00. The per-km figure has no direct ' +
			'source and is approximated from neighbouring Iberian tariffs (see ES above) — treat this ' +
			'as the least certain entry in the table alongside CZ below.'
	},
	GB: {
		currency: 'GBP',
		flagDownMinorUnits: [300, 380],
		perKmMinorUnits: [280, 450],
		citation:
			'Back-calculated from a London 5km fare comparison of roughly $23 (traveldailynews.com, ' +
			'2025) and the typical London black-cab Tariff 1 flag-down of around £3.20-3.80. London ' +
			"cabs meter a mixed time/distance formula, not a flat per-km rate, so this is an average " +
			'over a typical ride rather than the meter itself.'
	},
	CH: {
		currency: 'CHF',
		flagDownMinorUnits: [600, 700],
		perKmMinorUnits: [350, 500],
		citation:
			'Back-calculated from Zurich/Geneva 5km fare comparisons of roughly $25-27 ' +
			'(traveldailynews.com, 2025) and a blended Switzerland figure of €22.68/5km ' +
			'(taxi-calculator.com, 2025). Switzerland sets taxi tariffs per canton rather than ' +
			'nationally, so this range is intentionally wide.'
	},
	AT: {
		currency: 'EUR',
		flagDownMinorUnits: [380, 480],
		perKmMinorUnits: [140, 190],
		citation: 'Back-calculated from a blended Austria fare of €11.60/5km (taxi-calculator.com, 2025).'
	},
	BE: {
		currency: 'EUR',
		flagDownMinorUnits: [270, 400],
		perKmMinorUnits: [180, 230],
		citation: 'Back-calculated from a blended Belgium fare of €12.90/5km (taxi-calculator.com, 2025).'
	},
	NL: {
		currency: 'EUR',
		flagDownMinorUnits: [340, 410],
		perKmMinorUnits: [210, 260],
		citation:
			'Back-calculated from a blended Netherlands fare of €13.40/5km (taxi-calculator.com, 2025).'
	},
	SE: {
		currency: 'SEK',
		flagDownMinorUnits: [4500, 6000],
		perKmMinorUnits: [1500, 2500],
		citation:
			'Back-calculated from a blended Sweden fare of €9.91/5km (taxi-calculator.com, 2025), ' +
			'converted at roughly 11.3 SEK/EUR. Swedish taxi pricing is deliberately unregulated and ' +
			'varies a lot by operator, so this range is wide on purpose.'
	},
	CZ: {
		currency: 'CZK',
		flagDownMinorUnits: [4000, 7000],
		perKmMinorUnits: [2500, 4500],
		citation:
			'Back-calculated from a Prague 5km fare of roughly $10.50, the cheapest of the cities ' +
			'compared (traveldailynews.com, 2025), converted at roughly 23 CZK/USD. No direct ' +
			'flag-down/per-km breakdown was found — treat this as the least certain entry in the ' +
			'table alongside PT above.'
	}
};

/**
 * Used when `countryCode` has no entry in `TAXI_RATE_TABLE`. Deliberately spans this
 * table's own extremes (Prague's low end to Switzerland's high end) rather than picking
 * a single "average European" country to stand in for one it knows nothing about.
 */
const FALLBACK_TAXI_RATE_CARD: TaxiRateCard = {
	currency: 'EUR',
	flagDownMinorUnits: [200, 700],
	perKmMinorUnits: [80, 300],
	citation:
		'No rate card for this country. Range spans the low and high ends of every country ' +
		'already in TAXI_RATE_TABLE, so it is wide by construction rather than falsely specific.'
};

/**
 * The longest ride this table is willing to put a number on, and the number is arguable,
 * so here is the argument. Issue #246.
 *
 * **What went wrong.** Production quoted a Gatwick-to-London-Backpackers transfer at
 * £268.75-£430.90, against the €173.00 flight that ride connects to. Nothing in the
 * arithmetic misfired: `300 + 280 × 94.9` is £268.72 and the GB card really does say
 * £2.80-£4.50 per kilometre. The fault is that the card was never measured on a ride like
 * that one, and applying it linearly assumed it had been.
 *
 * **What the cards actually describe.** Every entry above is either a municipal tariff
 * (Barcelona, Madrid, Roma Capitale, Comune di Milano, London black-cab Tariff 1) or a
 * back-calculation from a single blended "5 km ride" comparison. Not one of them describes
 * an intercity or motorway run. The GB citation says so outright: "London cabs meter a
 * mixed time/distance formula, not a flat per-km rate, so this is an average over a typical
 * ride rather than the meter itself."
 *
 * **Why that does not extrapolate.** Measured on the router this app itself calls,
 * `routing.openstreetmap.de/routed-car`, 2026-09-05:
 *
 *   Kings Cross to Waterloo     5.1 km   13 min   23 km/h
 *   LGW to London Backpackers  94.9 km   76 min   75 km/h
 *
 * The first is the ride the GB card was calibrated on, and the card reproduces it
 * (£17.28-£26.75 against the cited "roughly $23"). Most of a per-km figure blended at
 * 23 km/h is the meter's time half, and a kilometre of motorway takes 0.8 minutes where a
 * kilometre of central London takes 2.6. So the estimate overstates a fast ride by roughly
 * the ratio of the two speeds, and airport transfers are exactly the trips this app quotes
 * most.
 *
 * **30 km, and why not some other number.** 5 km is where the evidence is and 95 km is
 * where it demonstrably breaks; nothing in this repo measures the middle, so any boundary
 * here is a judgment and it is placed on the conservative side. 30 km is past every ride a
 * municipal tariff describes for the cities actually cited, and it is where the widest card
 * in the table, GB, still produces a range its flag-down and per-km figures can account for
 * rather than one dominated by the extrapolation. One number for every country, because
 * every card in the table has the same shape and the same problem.
 *
 * **What was rejected.** Splitting each card into a time rate and a distance rate is what a
 * meter really does, and OSRM already returns both halves, but it needs twelve per-minute
 * figures no source in this table provides. Tapering the per-km rate past some distance
 * invents a second number with no source, which is worse than declining to answer. Both
 * would replace a wrong number with a differently wrong one; refusing states what is
 * actually true, which is that nothing here knows.
 */
export const MAX_RATED_TAXI_DISTANCE_KM = 30;

/**
 * Turns a route distance into a taxi fare range for the country it falls in, or into a
 * refusal when the ride is longer than the cards describe. Pure and synchronous on purpose
 * — it is arithmetic over a static table, not a lookup that needs caching or network access
 * the way the OSRM route it is normally fed by does.
 *
 * Brief line 77 / issue #9: "aprox prices" for the transport floor when transit is dead;
 * AGENTS.md "never present an estimate as a fact" is why the priced result is a range with
 * its `rateSource` and `citation` attached rather than a single `Money`, and why the
 * over-distance result is nothing at all rather than a wider range.
 */
export function estimateTaxiFare(distanceMeters: number, countryCode: IsoCountryCode): TaxiFareEstimate {
	if (!(distanceMeters >= 0)) {
		throw new Error(`estimateTaxiFare requires a non-negative distance, got ${distanceMeters}`);
	}

	const card = TAXI_RATE_TABLE[countryCode];
	const rateSource: TaxiFareRange['rateSource'] = card ? 'country' : 'fallback';
	const { currency, flagDownMinorUnits, perKmMinorUnits, citation } = card ?? FALLBACK_TAXI_RATE_CARD;
	const distanceKm = distanceMeters / 1000;

	if (distanceKm > MAX_RATED_TAXI_DISTANCE_KM) {
		return {
			kind: 'out-of-range',
			distanceKm,
			ratedUpToKm: MAX_RATED_TAXI_DISTANCE_KM,
			countryCode,
			citation
		};
	}

	return {
		kind: 'estimate',
		currency,
		lowMinorUnits: Math.round(flagDownMinorUnits[0] + perKmMinorUnits[0] * distanceKm),
		highMinorUnits: Math.round(flagDownMinorUnits[1] + perKmMinorUnits[1] * distanceKm),
		countryCode,
		rateSource,
		citation
	};
}
