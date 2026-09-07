/**
 * The marks on the timeline's rows ("3 options", "2 flights"), and the refusals its
 * transfer rows explain.
 *
 * ## Why this is a function and not a `$derived` block
 *
 * It was a `$derived` block, in `ResultDetail.svelte`, and issue #440 deleted that file. A
 * derivation copied into whichever component inherits it is how the mark and the panel it
 * promises start disagreeing, which is the defect `picker-alternatives.ts` was written to
 * prevent one layer down. Issue #440 moved the timeline to the customise panel, so the mark
 * and the picker it promises are now drawn by the same component, and the rule that decides
 * the mark is here, tested, rather than inside it.
 *
 * ## The four transfer legs are one table, because two copies of it already drifted
 *
 * Each leg has three names: the segment id the timeline and the map share, the
 * `UnroutedLeg` key the refusal notes are looked up under, and the field it occupies on an
 * `Itinerary`. `ResultDetail` wrote that correspondence out twice, once for the marks and
 * once for the refusals, and the two disagreed: the destination leg's refusal was filed
 * under `'to-destination'` where `UnroutedLeg` calls it `'to-destination-location'`, so the
 * note went under a name the timeline never looks up and the row fell back to "no route came
 * back". An inferred object literal reaches a `Partial<Record<...>>` prop without complaint,
 * so nothing said so.
 *
 * `TRANSFER_LEGS` below is that correspondence, once. Both outputs walk it, so they cannot
 * disagree about which leg is which.
 */

import type { FlightOffer, Itinerary } from '../domain';
import type { ItinerarySegmentId } from '../itinerary-map/segment-id';
import type { WithheldTransfers } from '../search/types';
import type { UnroutedLeg } from './itinerary-timeline-format';
import { distinctFlightCount } from './picker-alternatives';

/** The four fields on an `Itinerary` that hold a ground leg, which is also how a caller
 * keys the counts and refusals it hands in. */
export type TransferLegField =
	| 'transferToOriginAirport'
	| 'transferToHotel'
	| 'transferToConnectionAirport'
	| 'transferToDestinationLocation';

interface TransferLegSpec {
	field: TransferLegField;
	segment: ItinerarySegmentId;
	leg: UnroutedLeg;
}

export const TRANSFER_LEGS: readonly TransferLegSpec[] = [
	{ field: 'transferToOriginAirport', segment: 'transfer-to-origin-airport', leg: 'to-origin-airport' },
	{ field: 'transferToHotel', segment: 'transfer-to-hotel', leg: 'to-hotel' },
	{
		field: 'transferToConnectionAirport',
		segment: 'transfer-to-connection-airport',
		leg: 'from-hotel'
	},
	{
		field: 'transferToDestinationLocation',
		segment: 'transfer-to-destination-location',
		leg: 'to-destination-location'
	}
];

/** Everything a search offered for one itinerary, in the shape the marks are counted from.
 * Plain numbers and arrays rather than the `search/` option records, so this module stays
 * testable without assembling a provider answer. */
export interface AlternativesPool {
	outboundFlights: readonly FlightOffer[];
	onwardFlights: readonly FlightOffer[];
	/** `TransferLegOptions.candidates.length` per leg. An absent leg counts as none. */
	transferCandidateCounts: Partial<Record<TransferLegField, number>>;
	/** What a router answered for a leg and a plausibility rule then refused. */
	transferWithheld: Partial<Record<TransferLegField, WithheldTransfers>>;
	/** Distinct properties on offer, which is what `StayPicker` draws a row per. */
	stayPropertyCount: number;
}

export const EMPTY_ALTERNATIVES: AlternativesPool = {
	outboundFlights: [],
	onwardFlights: [],
	transferCandidateCounts: {},
	transferWithheld: {},
	stayPropertyCount: 0
};

/**
 * A stopover that ends the same day has no night to book, so it has no bed to choose
 * between and its row promises nothing. An already-picked stay keeps its mark.
 */
export function stayChoiceIsRelevant(itinerary: Itinerary): boolean {
	return itinerary.nightsInConnection > 0 || itinerary.stay !== undefined;
}

/**
 * The marks, gated on the same conditions the panel renders under, so a mark never promises
 * a choice the panel cannot open.
 *
 * A stay list counts from one property, the same reasoning `hasSwappableAlternatives` gave:
 * with no bed on the itinerary, one property is still the choice between pricing it in and
 * leaving it out. A flight leg with its only option already selected is not.
 */
export function optionMarksFor(
	itinerary: Itinerary,
	pool: AlternativesPool
): Partial<Record<ItinerarySegmentId, string>> {
	const marks: Partial<Record<ItinerarySegmentId, string>> = {};

	const outbound = distinctFlightCount(pool.outboundFlights);
	if (outbound > 1) marks['outbound-flight'] = `${outbound} flights`;
	const onward = distinctFlightCount(pool.onwardFlights);
	if (onward > 1) marks['onward-flight'] = `${onward} flights`;

	for (const { field, segment } of TRANSFER_LEGS) {
		const count = pool.transferCandidateCounts[field] ?? 0;
		if (itinerary[field] && count > 1) marks[segment] = `${count} options`;
	}

	if (stayChoiceIsRelevant(itinerary) && pool.stayPropertyCount > 0) {
		const count = pool.stayPropertyCount;
		marks['free-time'] = `${count} ${count === 1 ? 'stay' : 'stays'}`;
	}

	return marks;
}

/**
 * The refusals, keyed the way `unroutedLegNote` names the legs.
 *
 * A leg whose only road answer was refused has no transfer and therefore no picker, so the
 * timeline row is the only place left that can say a route came back and was declined
 * (issue #119).
 */
export function withheldTransfersByLeg(pool: AlternativesPool): Partial<Record<UnroutedLeg, WithheldTransfers>> {
	const withheld: Partial<Record<UnroutedLeg, WithheldTransfers>> = {};
	for (const { field, leg } of TRANSFER_LEGS) {
		const refused = pool.transferWithheld[field];
		if (refused) withheld[leg] = refused;
	}
	return withheld;
}
