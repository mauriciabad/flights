/**
 * The bed on an itinerary, gathered once for every surface that draws it.
 *
 * Issue #435 put the property on the result card, beside the receipt, and the stopover
 * block was already printing the same four facts inside the customise panel. Two components
 * each deriving a nightly rate and a distance is the failure `StopoverBlock`'s own header
 * spends a paragraph on: a fact with two derivations grows two answers, and the one nobody
 * notices has gone stale is the one on the card.
 *
 * So the rate, the room kind and the distance are resolved here and both surfaces read the
 * result. Nothing is formatted for a layout: the rate arrives as `Money` and the distance as
 * kilometres, because the card prints a distance where the panel prints a journey, and a
 * function that returned strings would have to guess which.
 *
 * ## The reach line on the card comes from the trip, not from a lookup
 *
 * `StayReachLine` was built for the stay picker, where every candidate's journey out of the
 * airport has been measured by `fetch-reach.ts`. A results list has no such answer and must
 * not go and get one: that is a router request per card, on a screen whose whole job is to
 * be scrolled past.
 *
 * What the card does have is better than an estimate. The itinerary already carries the ride
 * to this bed, routed, with a mode and a duration, because the price on the card is built
 * from it. `reachFromTransfer` states that one measured journey in the shape the row already
 * draws, so the card says "22m from the airport" where it would otherwise say "1.2 km" and
 * neither number is invented. With no ride on the trip there is nothing measured to show,
 * and the row falls back to the straight line, which is what `StayReachLine` does with an
 * absent reach.
 */

import type { Coordinates, Itinerary, Property, Transfer, TransferMode } from '$lib/domain';
import { transferRideDuration } from '$lib/domain';
import { haversineDistanceKm } from './distance';
import { bedNightlyRate, type NightlyRate } from './pricing';
import { stayPhotos, type StayPhoto } from './stay-photos';
import { UNASKED_REACH, type ModeReach, type ReachMode, type StayReach } from './reach';
import { ROOM_KIND_LABELS } from './room-kind';

/** Everything a surface needs to name the bed on a trip, with nothing formatted. */
export interface BedFacts {
	property: Property;
	/** `ROOM_KIND_LABELS[stay.roomKind]`, so the tile in the picker and the line on the card
	 * print the same words for one room. */
	roomKindLabel: string;
	/** The nights this stopover books, off the flight schedule alone (issue #105). */
	nights: number;
	/** What one night costs and who that figure covers (issue #206). */
	rate: NightlyRate;
	/**
	 * The building's photographs and this room's, labelled, through `stayPhotos`.
	 *
	 * Assembled here so every surface showing this bed shows the same set. Issue #442's rule
	 * is that a photograph of the building may never be presented as a photograph of the
	 * room, and it holds by construction because the merge happens once.
	 */
	photos: StayPhoto[];
	/**
	 * Straight line from the connection airport to the property, in kilometres. Absent when
	 * the caller resolved no airport position: the itinerary carries only an IATA code, and a
	 * surface that invented a point would print a distance to nowhere.
	 */
	distanceFromAirportKm?: number;
	/** The journey out to the bed as `StayReachLine` draws it, or `undefined` when this trip
	 * has no routed ride to state. */
	reach?: StayReach;
}

/**
 * Which reach mode a transfer's own mode is.
 *
 * `'drive'` maps to `taxi` because `reach.ts` already argues that pair: somebody who has just
 * landed has no car, so the road option they are choosing between is a taxi, and both ride
 * the same driving route. Every other `TransferMode` value is already a `ReachMode`.
 */
export function reachModeOf(mode: TransferMode): ReachMode {
	return mode === 'drive' ? 'taxi' : mode;
}

/**
 * One measured ride, in the shape the reach row draws.
 *
 * `transferRideDuration` rather than `Transfer.duration`, which since issue #290 is landing
 * to doorstep and includes the walk out of the terminal. The row says how long the journey
 * takes; the buffer in front of it is the airport's, not the property's.
 */
export function reachFromTransfer(transfer: Transfer | undefined): StayReach | undefined {
	if (!transfer) return undefined;
	const routed: ModeReach = { kind: 'routed', minutes: transferRideDuration(transfer) };
	const mode = reachModeOf(transfer.mode);
	return { ...UNASKED_REACH, [mode]: routed };
}

/**
 * The bed on this trip, or `undefined` when there is none.
 *
 * Absent means the trip books no bed, which is a different fact from a bed with something
 * missing, and every caller renders nothing at all for it. A grey frame saying a property is
 * missing is worse than the space (issue #435).
 */
export function bedFacts(itinerary: Itinerary, connectionCoordinates?: Coordinates): BedFacts | undefined {
	const stay = itinerary.stay;
	if (!stay) return undefined;
	return {
		property: stay.property,
		roomKindLabel: ROOM_KIND_LABELS[stay.roomKind],
		nights: itinerary.nightsInConnection,
		rate: bedNightlyRate(stay, itinerary.travellers),
		photos: stayPhotos(stay.property, [stay]),
		distanceFromAirportKm: connectionCoordinates
			? haversineDistanceKm(stay.property.coordinates, connectionCoordinates)
			: undefined,
		reach: reachFromTransfer(itinerary.transferToHotel)
	};
}
