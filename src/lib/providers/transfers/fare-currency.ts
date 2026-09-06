import type { FareParty, FareRange, IsoCurrencyCode } from '../../domain';
import { canConvert, convertMinorUnits, exchangeRateProvenance } from '$lib/data/exchange-rates';

/**
 * Putting a rate card's range into the currency the traveller picked, for every rate card
 * this app has.
 *
 * Issue #339 wrote this for the taxi table and issue #407 added a second card, for transit,
 * with the identical problem: a fare compiled in the ride's own currency, printed under a
 * total in the traveller's. Two copies of this would be two opinions about what "too old to
 * stand behind" means and two places to forget `party`, which is the #179 mistake exactly.
 * So it lives here and both cards call it.
 */

/**
 * Puts a rate-card range into the currency the traveller picked, or gives it back
 * untouched. Issue #339.
 *
 * Both bounds convert or neither does, which is what `canConvert` is checked for up front:
 * a low bound in euros beside a high bound in pounds is not a range, it is two numbers
 * that happen to be adjacent. The same reason `sumMoney` throws on a currency mix.
 *
 * The refusal path is deliberately the pre-#339 behaviour rather than an error or a blank.
 * No rate for this pair, or rates too old to stand behind, and the traveller reads the
 * rate card's own currency, which is the one figure this app can defend. See
 * `data/exchange-rates.ts` for what "too old" is and why it is a liveness check rather
 * than a precision one.
 *
 * Issue #344 added four more numbers inside `party`, and they cross with the other two or
 * not at all. Six figures in one currency and none in another is the same defect as a low
 * bound in euros beside a high bound in pounds, one screen further down: the picker prints
 * the party's fare and the per-head share on the same line.
 */
export function inTravellerCurrency(
	range: FareRange,
	displayCurrency: IsoCurrencyCode | undefined
): FareRange {
	if (displayCurrency === undefined || displayCurrency === range.currency) return range;
	if (!canConvert(range.currency, displayCurrency)) return range;
	const cross = (amount: number) => convertMinorUnits(amount, range.currency, displayCurrency);
	const low = cross(range.lowMinorUnits);
	const high = cross(range.highMinorUnits);
	if (low === undefined || high === undefined) return range;
	const party = convertParty(range.party, cross);
	if (party === 'failed') return range;

	return {
		...range,
		currency: displayCurrency,
		lowMinorUnits: low,
		highMinorUnits: high,
		...(party ? { party } : {}),
		converted: {
			from: range.currency,
			fromLowMinorUnits: range.lowMinorUnits,
			fromHighMinorUnits: range.highMinorUnits,
			rateDate: exchangeRateProvenance().referenceDate
		}
	};
}

/**
 * Every money field of a `FareParty` through the same rate, or `'failed'` if any one of
 * them will not cross. Issue #344.
 *
 * The three-way answer is the point. `undefined` in means there was no split to convert
 * and none comes back; `'failed'` means there was one and it could not be crossed, which
 * has to abandon the whole conversion rather than return a party fare in euros with a
 * per-head share still in koruna.
 *
 * `'unknown'` carries no money at all, so it crosses by doing nothing to it.
 */
function convertParty(
	party: FareParty | undefined,
	cross: (amount: number) => number | undefined
): FareParty | undefined | 'failed' {
	if (party === undefined || party.basis === 'unknown') return party;
	if (party.basis === 'per-person') {
		const low = cross(party.perPersonLowMinorUnits);
		const high = cross(party.perPersonHighMinorUnits);
		if (low === undefined || high === undefined) return 'failed';
		return { ...party, perPersonLowMinorUnits: low, perPersonHighMinorUnits: high };
	}
	const crossed = [
		cross(party.perVehicleLowMinorUnits),
		cross(party.perVehicleHighMinorUnits),
		cross(party.perPersonLowMinorUnits),
		cross(party.perPersonHighMinorUnits)
	];
	if (crossed.some((amount) => amount === undefined)) return 'failed';
	const [perVehicleLowMinorUnits, perVehicleHighMinorUnits, perPersonLowMinorUnits, perPersonHighMinorUnits] =
		crossed as number[];
	return {
		...party,
		perVehicleLowMinorUnits,
		perVehicleHighMinorUnits,
		perPersonLowMinorUnits,
		perPersonHighMinorUnits
	};
}
