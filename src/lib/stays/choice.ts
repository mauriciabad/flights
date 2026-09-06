/**
 * One row of the stay list, as data: the property, what this group can book there, how far
 * out it is, and what swapping to it does to the price.
 *
 * Issue #319 is why this file exists. Three surfaces now show the same alternatives - the
 * list under the open card, the points on the map, and the sidebar the map opens - and
 * before this they would each have derived the same four facts from a
 * `PropertyStayOptions` on their own. `StayAlternativeCard.svelte` already carried that
 * derivation inline. A third copy is how a card and a sidebar end up disagreeing about
 * which room is the cheapest one.
 *
 * ## The price difference is the point of the issue
 *
 * The owner: **"i want to see also the price difference from the currently picked."** A
 * bare `€52.82/night` is a fact about one property; `+€12.00/night` answers the question a
 * traveller actually has, which is what changing their mind would cost them. The
 * alternative-flight list has shown a delta against the current pick since issue #28, and
 * this is the same idea for beds.
 *
 * **Per night is the headline, and the whole-stay figure is the follow-up.** A stopover can
 * book zero nights (`domain/itinerary.ts` `nightsInConnection`, and the picker is still
 * rendered for one that already carries a stay), and at zero nights every whole-stay total
 * is zero, so every whole-stay delta is zero: a column that says "same price" against thirty
 * different beds. The nightly rate is the figure that always separates them. So
 * `perNight` is always present on a difference and `overStay` only when there is more than
 * one night to multiply — see `showsWholeStayFigures`, which is issue #404's half of this.
 *
 * ## What the difference deliberately does NOT include
 *
 * The journey out to the bed. `rank.ts` orders this list on `stopover-cost.ts`, which adds
 * an assumed taxi fare to the room, and that module is explicit that not one unit of it may
 * reach a number the traveller reads: AGENTS.md, "never present an estimate as a fact". So
 * the delta is the room, quoted, and nothing else.
 *
 * That does mean the ordering and the deltas can disagree - a bed 40 km out can be cheaper
 * per night and still rank below a walkable one. That is the ranking working (issue #219)
 * rather than a sorting bug, and the distance printed on the same row is the reason.
 *
 * ## Currencies are never converted
 *
 * `pricing.ts`'s `moneyDifference` throws on a currency mismatch rather than guessing a
 * rate, which is the right call and the wrong exception to hit while rendering a list.
 * Two adapters can perfectly well quote one city in two currencies. So the mismatch is a
 * state of the comparison, checked before the subtraction, and the row says which currency
 * it is in instead of inventing a delta.
 */

import type { Coordinates, Money, Property, Stay } from '$lib/domain';
import { formatDistanceKm, haversineDistanceKm } from './distance';
import type { StayReach } from './reach';
import { formatMoney, stayTotalDelta, stayTotalForNights } from './pricing';
import { cheapestSelectableOption } from './rank';
import { stayGenderFitMessage } from './gendered-room-fit';
import { propertyKey, propertyOf, type PropertyStayOptions, type StayOption } from './types';

/** What one candidate costs relative to the stay the itinerary currently books. */
export type StayPriceComparison =
	/** This row is the stay the itinerary books. There is nothing to compare it to. */
	| { kind: 'picked' }
	/** Nothing this group can book here, so there is no price to compare either. */
	| { kind: 'unbookable' }
	/** Same nightly rate in the same currency. */
	| { kind: 'same' }
	/** Quoted in a currency the picked stay is not, and this app converts nothing. */
	| { kind: 'other-currency'; currency: string }
	/** Signed, `next` minus `picked`: negative is cheaper. `overStay` is absent on a
	 * stopover that books no night, where multiplying by zero would flatten every row. */
	| { kind: 'difference'; perNight: Money; overStay?: Money };

/** One property in the list, with every fact its three surfaces print already resolved. */
export interface StayChoice {
	/** `propertyKey`, which is what every `{#each}` over these keys on. */
	key: string;
	group: PropertyStayOptions;
	property: Property;
	/** The cheapest room this group can actually book here. Absent when every room is a
	 * women-only or men-only one they cannot use, which `rank.ts` sorts last rather than
	 * dropping. */
	cheapest?: StayOption;
	/** Why there is no price, in the same words the room tiles use for the same situation.
	 * Present exactly when `cheapest` is absent. */
	unavailableReason?: string;
	/** Straight line to the connection airport, the same figure and formatter every other
	 * stay surface prints. Issue #405 demoted this on the row in favour of `reach`, because a
	 * traveller cannot turn a straight line into "can I walk to this", but it is still what
	 * the map's sidebar prints as a labelled figure and what the row falls back to before any
	 * router has answered. */
	distanceToAirportKm: number;
	/** How long the journey out from the connection airport takes, per mode. Issue #405.
	 * Absent when nothing has been looked up for this list at all, which is the state a unit
	 * test or a caller with no provider access sits in; `fetch-reach.ts` fills it. */
	reach?: StayReach;
	/** Absent unless this airport has a hand-checked city point (issue #162). */
	distanceToCentreKm?: number;
	/** `cheapest`'s nightly rate, multiplied out for the stopover's nights. */
	total?: Money;
	comparison: StayPriceComparison;
	/** Whether the itinerary books this property right now. */
	isPicked: boolean;
}

export interface StayChoiceContext {
	/** The stay the itinerary currently books, which every difference is measured from. */
	picked?: Stay;
	/** Where both ground legs begin and end. */
	connectionAirport: Coordinates;
	/** The stopover city's own centre, when this airport has a hand-checked one. */
	cityCentre?: Coordinates;
	/** `Itinerary.nightsInConnection`. */
	nights: number;
	travellers?: number;
	females?: number;
	/** Issue #405's journey times, keyed by `propertyKey`. Passed in rather than fetched
	 * here because this module is pure and the lookup is two OSRM requests; `fetch-reach.ts`
	 * owns that and states what it costs. A key with no entry leaves `StayChoice.reach`
	 * absent, which every surface already has to handle for a list nothing has routed. */
	reachByProperty?: ReadonlyMap<string, StayReach>;
}

/**
 * Whether the whole-stay figures say anything the nightly ones do not.
 *
 * Issue #404, the owner: the money row **"repeats itself four times"**. At one night
 * `from €30.40/night`, `€30.40 total`, `+€5.60/night` and `+€5.60 over 1 night` are two
 * numbers printed twice, and the duplication is what the eye lands on instead of the
 * comparison the row exists to make. Multiplying by one is arithmetic, not information.
 *
 * Here rather than in the card, for the reason the rest of this file exists: the map's
 * sidebar prints the same pair of figures and would otherwise keep printing both.
 */
export function showsWholeStayFigures(nights: number): boolean {
	return nights > 1;
}

function compare(candidate: Stay | undefined, context: StayChoiceContext, isPicked: boolean): StayPriceComparison {
	if (!candidate) return { kind: 'unbookable' };
	if (isPicked) return { kind: 'picked' };
	const picked = context.picked;
	// No pick yet is not a difference of zero; there is simply nothing to measure from, and
	// `StayPicker` always falls back to a real stay before rendering a row, so this is the
	// first paint rather than a state a reader sits in.
	if (!picked) return { kind: 'unbookable' };
	if (picked.pricePerNight.currency !== candidate.pricePerNight.currency) {
		return { kind: 'other-currency', currency: candidate.pricePerNight.currency };
	}
	const perNight = stayTotalDelta(picked.pricePerNight, candidate.pricePerNight, 1);
	if (perNight.minorUnits === 0) return { kind: 'same' };
	return {
		kind: 'difference',
		perNight,
		overStay: showsWholeStayFigures(context.nights)
			? stayTotalDelta(picked.pricePerNight, candidate.pricePerNight, context.nights)
			: undefined
	};
}

/** Every candidate as a row, in the order they were given. Ranking is `rank.ts`'s job and
 * this preserves whatever order it was handed. */
export function describeStayChoices(
	groups: readonly PropertyStayOptions[],
	context: StayChoiceContext
): StayChoice[] {
	return groups.map((group) => {
		const property = propertyOf(group);
		const cheapest = cheapestSelectableOption(group, context.travellers, context.females);
		const isPicked = context.picked !== undefined && propertyKey(context.picked.property) === propertyKey(property);
		return {
			key: propertyKey(property),
			group,
			property,
			cheapest,
			// Asked of the cheapest room rather than assumed to be about women (issue #288):
			// a property whose only dorm is a men-only one gives a female traveller the
			// mirror answer, and the cheapest is the tile the reader would have reached for.
			unavailableReason: cheapest
				? undefined
				: stayGenderFitMessage(
						group.options.reduce((a, b) =>
							b.stay.pricePerNight.minorUnits < a.stay.pricePerNight.minorUnits ? b : a
						).stay,
						context.travellers,
						context.females
					),
			distanceToAirportKm: haversineDistanceKm(property.coordinates, context.connectionAirport),
			distanceToCentreKm: context.cityCentre
				? haversineDistanceKm(property.coordinates, context.cityCentre)
				: undefined,
			reach: context.reachByProperty?.get(propertyKey(property)),
			total: cheapest ? stayTotalForNights(cheapest.stay.pricePerNight, context.nights) : undefined,
			comparison: compare(cheapest?.stay, context, isPicked),
			isPicked
		};
	});
}

/** The delta in words, decided once so the row and the map's sidebar cannot word it two
 * ways. `undefined` where there is nothing to say: the picked row itself, and a property
 * with no bookable room, which already carries its own reason. */
export function describePriceComparison(
	comparison: StayPriceComparison,
	nights: number
): { headline: string; overStay?: string; cheaper: boolean } | undefined {
	switch (comparison.kind) {
		case 'picked':
		case 'unbookable':
			return undefined;
		case 'same':
			return { headline: 'Same nightly rate', cheaper: false };
		case 'other-currency':
			return { headline: `Priced in ${comparison.currency}`, cheaper: false };
		case 'difference': {
			const cheaper = comparison.perNight.minorUnits < 0;
			const sign = cheaper ? '-' : '+';
			const magnitude = (money: Money) => formatMoney({ ...money, minorUnits: Math.abs(money.minorUnits) });
			return {
				headline: `${sign}${magnitude(comparison.perNight)}/night`,
				// Always plural: `compare` only builds `overStay` where `showsWholeStayFigures`
				// is true, and that is two nights or more. A singular branch here would be a
				// case nothing can reach, which is the shape of check this repo keeps catching
				// itself keeping.
				overStay: comparison.overStay
					? `${sign}${magnitude(comparison.overStay)} over ${nights} nights`
					: undefined,
				cheaper
			};
		}
	}
}

/** One proximity figure and what it is measured from. Split rather than pre-joined because
 * the list row prints "6.0 km from airport" as a phrase and the map sidebar prints the same
 * pair as a labelled figure, and a sidebar that split the phrase back apart would be the
 * second derivation this module exists to prevent. */
export interface StayDistance {
	/** "airport" or "centre". */
	from: string;
	/** Through `formatDistanceKm`, the same figure every other stay surface prints. */
	distance: string;
}

/** The two proximity figures, in the order every other stay surface prints them. The
 * second is absent without a hand-checked city point (issue #162), where it used to repeat
 * the first one under a different label. */
export function stayDistances(choice: StayChoice): StayDistance[] {
	const lines: StayDistance[] = [{ from: 'airport', distance: formatDistanceKm(choice.distanceToAirportKm) }];
	if (choice.distanceToCentreKm !== undefined) {
		lines.push({ from: 'centre', distance: formatDistanceKm(choice.distanceToCentreKm) });
	}
	return lines;
}
