/**
 * The order the stay list is in, as something the traveller picks.
 *
 * Issue #406, the owner: **"in the hotel list I want to be able to sort by diferent factors
 * such as transport time for each method, price, distance from center, recommended (an
 * euristic that considers everything, the default)"**.
 *
 * ## The default does not move
 *
 * `rankProperties` stays exactly what it was, and stays first. It orders on
 * `stopover-cost.ts`: the room for this stopover's nights, plus a round trip to the airport,
 * plus a round trip into the centre for each usable day. Issue #219 is why it weighs those
 * things (a EUR 13.00 bed 48.3 km out was beating a EUR 52.82 room 2.8 km from the terminal),
 * and none of that is reopened here. This file takes the ranked list and lets a traveller
 * ask for a different arrangement of it.
 *
 * ## Here rather than in the card
 *
 * `choice.ts` exists because three surfaces render these same alternatives and were each
 * deriving the same facts. Order is one of those facts. A sort living in
 * `StayAlternativeCard` would leave the map's points and the map's sidebar on the old order,
 * and "first" would mean two different things on one screen.
 *
 * ## Missing data is the case worth getting right
 *
 * Every key is a number or nothing. A property with no routed walk cannot be sorted by
 * walking time; a property quoted in a currency the picked stay is not cannot be compared on
 * price, because this app converts nothing (`pricing.ts` throws rather than guess a rate).
 * Both are the same shape of gap and both get the same treatment, which is the one
 * `rank.ts` already uses for a property nobody in the group can book: it sorts last and stays
 * visible with the reason on the row, rather than sorting as zero or vanishing.
 *
 * Ties, and the whole tail of unsortable rows, keep the order they came in. `Array.prototype.sort`
 * is stable in every engine this app targets, and the order they came in is the recommendation,
 * so "cheapest first, and among the ones I cannot price, the recommended order" is what a
 * reader gets rather than whatever the engine left behind.
 */

import type { StayChoice } from './choice';
import { REACH_MODES, type ReachMode } from './reach';

export const STAY_SORT_KEYS = ['recommended', 'price', 'centre', ...REACH_MODES] as const;
export type StaySortKey = (typeof STAY_SORT_KEYS)[number];

export const STAY_SORT_LABELS: Record<StaySortKey, string> = {
	recommended: 'Recommended',
	price: 'Cheapest room',
	centre: 'Closest to the centre',
	walk: 'Shortest walk',
	transit: 'Shortest bus ride',
	taxi: 'Shortest taxi ride'
};

function reachMinutes(choice: StayChoice, mode: ReachMode): number | undefined {
	const answer = choice.reach?.[mode];
	return answer?.kind === 'routed' ? answer.minutes : undefined;
}

/**
 * What this key measures on one row, or `undefined` where it cannot measure it.
 *
 * `recommended` measures nothing on purpose. Every row is then unsortable, every comparison
 * is a tie, and a stable sort hands back the input untouched. That is the default order
 * expressed as a case of the same rule rather than as a branch around it.
 */
export function staySortValue(key: StaySortKey, choice: StayChoice, currency?: string): number | undefined {
	switch (key) {
		case 'recommended':
			return undefined;
		case 'price': {
			const rate = choice.cheapest?.stay.pricePerNight;
			if (!rate) return undefined;
			// Minor units only compare within one currency, and one stopover's list can carry
			// two: `choice.ts` already refuses to subtract across a mismatch for the same
			// reason. A row in another currency is unsortable here, not cheap or dear.
			if (currency !== undefined && rate.currency !== currency) return undefined;
			return rate.minorUnits;
		}
		case 'centre':
			return choice.distanceToCentreKm;
		case 'walk':
		case 'transit':
		case 'taxi':
			return reachMinutes(choice, key);
	}
}

/**
 * The list rearranged. Ascending on every key, because every key is a cost: money, minutes,
 * kilometres. Rows the key cannot measure keep their incoming order at the end.
 *
 * `currency` is the picked stay's, which is what the price key compares against. Omit it and
 * every priced row is comparable, which is right for a caller that knows the list is in one
 * currency and wrong for one that does not, so callers on this screen pass it.
 */
export function sortStayChoices(
	choices: readonly StayChoice[],
	key: StaySortKey,
	currency?: string
): StayChoice[] {
	const values = new Map(choices.map((choice) => [choice.key, staySortValue(key, choice, currency)]));
	return choices.slice().sort((a, b) => {
		const left = values.get(a.key);
		const right = values.get(b.key);
		if (left === undefined && right === undefined) return 0;
		if (left === undefined) return 1;
		if (right === undefined) return -1;
		return left - right;
	});
}

/**
 * The keys worth offering for this list, in `STAY_SORT_KEYS` order.
 *
 * Issue #406 asks for "one key per mode". Offering all three regardless would put a "shortest
 * bus ride" option on a list where nothing has a bus time, and choosing it would rearrange
 * nothing while looking broken. So a mode earns its key by having a routed answer on at least
 * one row, which is exactly the condition under which sorting by it does something.
 *
 * `recommended` is always offered because it always works, and `price` and `centre` are
 * offered when at least one row carries them, on the same rule. A stopover whose airport has
 * no hand-checked city point (issue #162) has no centre distance on any row, and it does not
 * get a control that pretends otherwise.
 */
export function availableStaySortKeys(choices: readonly StayChoice[], currency?: string): StaySortKey[] {
	return STAY_SORT_KEYS.filter(
		(key) =>
			key === 'recommended' || choices.some((choice) => staySortValue(key, choice, currency) !== undefined)
	);
}
