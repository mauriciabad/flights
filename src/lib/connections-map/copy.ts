/**
 * Issue #324's sentences, apart from the components that print them.
 *
 * The reason this is a module and not a template full of `{#if}` is the refusals. The
 * owner asked for a different line on a connection with no viable pair, and the useful
 * version of that line says WHY: "nothing flies onward from here" and "the only onward
 * flight leaves 40 minutes before you land" are different answers, and a traveller can act
 * on the second. Six sentences with numbers in them is logic, and logic belongs somewhere a
 * test can read it without rendering a map.
 *
 * Every sentence states an observation. None of them recommends anything, and none says
 * anything a provider did not: "nobody has looked" is written as itself rather than as "no
 * flights", which is the same discipline `$lib/flexible-dates` holds about an unknown day.
 */

import { formatDuration } from '../format';
import type { ConnectionBlock } from '../algorithm/build';
import type { ConnectionOnMap, ConnectionState, UnpricedParts } from './model';
import type { IataAirportCode, ItineraryTransferLeg } from '../domain';

/** One refusal, split so a panel can lead with the short form and a map point can use it as
 * an accessible name, without either of them re-deriving the other. */
export interface BlockCopy {
	/** Three or four words. Goes on the row in the list and in the point's label. */
	headline: string;
	/** The measurement behind it, when there is one. Absent when the headline is the whole
	 * fact. */
	detail?: string;
}

export function describeBlock(block: ConnectionBlock): BlockCopy {
	switch (block.reason) {
		case 'airport-unknown':
			return {
				headline: 'Airport not in the dataset',
				detail: 'This app has no record of where this airport is, so it cannot plan through it.'
			};
		case 'timezone-unknown':
			return {
				headline: 'A flight here could not be timed',
				detail:
					'A source had a priced flight to this airport on a day in your window, and this app knows no time zone for it, so it cannot say when that flight lands.'
			};
		case 'no-outbound-flight':
			return {
				headline: 'Nothing flies here',
				detail: 'No source found a flight from your origin to this airport on any day in your window.'
			};
		case 'no-onward-flight':
			return {
				headline: 'Nothing flies onward',
				detail: 'Flights reach this airport, and no source found one continuing to your destination.'
			};
		case 'prices-disagree':
			return {
				headline: 'No total could be stated',
				detail: 'Two parts of this trip were quoted in currencies that cannot be added together.'
			};
		case 'onward-before-arrival':
			return {
				headline: 'The onward flight goes first',
				detail: `The nearest onward flight leaves ${formatDuration(Math.abs(block.closestLayover))} before you land.`
			};
		case 'layover-under-minimum':
			return {
				headline: 'The gap is too short',
				detail: `The longest gap here is ${formatDuration(block.closestLayover)}, and your minimum layover is ${formatDuration(block.minLayoverTime)}.`
			};
		case 'layover-under-ground-time':
			return {
				headline: 'No time to leave the airport',
				detail: `The longest gap here is ${formatDuration(block.closestLayover)}, and getting into town, back, and checked in takes ${formatDuration(block.groundTimeNeeded)}.`
			};
	}
}

/** The one-word status a list row and a map point share, so the two never disagree about
 * what colour a connection is. */
export const STATE_LABEL: Record<ConnectionState, string> = {
	bookable: 'Priced',
	'part-priced': 'Part priced',
	blocked: 'No trip',
	pending: 'Still looking'
};

const TRANSFER_LEG_NAME: Record<ItineraryTransferLeg, string> = {
	transferToOriginAirport: 'the ride to your origin airport',
	transferToHotel: 'the ride into town',
	transferToConnectionAirport: 'the ride back to the airport',
	transferToDestinationLocation: 'the ride from your destination airport'
};

/**
 * Why a total is a floor rather than a price. Returns nothing when it is not one.
 *
 * `Itinerary.totalPrice` is documented as the sum of what this app was given, which is not
 * the same claim as what the trip costs. A map that printed it as a price with no note
 * would make the cheapest stopover on screen the one nobody managed to price.
 */
export function describeUnpriced(unpriced: UnpricedParts): string | undefined {
	const missing: string[] = [];
	if (unpriced.bed) missing.push('a bed for the night');
	for (const leg of unpriced.transferLegs) missing.push(TRANSFER_LEG_NAME[leg]);
	if (missing.length === 0) return undefined;
	return `Nobody priced ${joinWithAnd(missing)}, so this total is a floor.`;
}

function joinWithAnd(parts: readonly string[]): string {
	if (parts.length === 1) return parts[0];
	return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/**
 * The line the dialog opens on, counting what is on the map.
 *
 * Written as counts rather than as "N stopovers found", because the four states are the
 * whole point of the screen and a single total would hide the three connections that
 * exist and do not work.
 */
export function summariseConnections(
	counts: Record<ConnectionState, number>,
	confirmedBeyondCap: readonly IataAirportCode[] = []
): string {
	const parts: string[] = [];
	const priced = counts.bookable + counts['part-priced'];
	if (priced > 0) parts.push(`${priced} with a trip`);
	if (counts.blocked > 0) parts.push(`${counts.blocked} without one`);
	if (counts.pending > 0) parts.push(`${counts.pending} still being looked at`);
	if (parts.length === 0) return 'No connection airports considered yet.';
	const total = priced + counts.blocked + counts.pending;
	const considered = `${total} connection ${total === 1 ? 'airport' : 'airports'} considered: ${joinWithAnd(parts)}.`;
	return confirmedBeyondCap.length === 0
		? considered
		: `${considered} ${describeBeyondCap(confirmedBeyondCap)}`;
}

/**
 * Issue #350: the stopovers this search confirmed and stopped short of pricing.
 *
 * Every airport here passed both of the checks the ones on the map passed — a source says
 * the origin flies there, and a source says something flies onward — and then the candidate
 * cap filled. On the acceptance route `BVC -> PFO` that is nine confirmed and six kept, with
 * Munich, Orly, Gatwick and Amsterdam among the four the map used to say nothing about.
 *
 * Codes, not city names. This sentence lists what is NOT on the map, so there is no point on
 * screen for a name to sit beside, and every other row here already carries its code. It is
 * also the version that stays honest without a lookup: an airport this app cannot place is
 * left off the map entirely, and naming a city for it would be inventing the one fact the
 * omission is about.
 *
 * Deliberately says nothing about why the cap exists. It is a real limit and a right one —
 * each candidate kept costs two metered fare searches downstream — but a traveller cannot
 * act on that, and a screen that explains its own budget every time is the noise that makes
 * the sentences beside it stop being read.
 */
function describeBeyondCap(codes: readonly IataAirportCode[]): string {
	const verb = codes.length === 1 ? 'was' : 'were';
	return `${codes.length} more ${codes.length === 1 ? 'airport' : 'airports'} ${verb} confirmed on both flights and not priced: ${joinWithAnd([...codes])}.`;
}

/**
 * The one sentence a screen reader hears when the panel changes, in place of the whole
 * detail block being re-read.
 *
 * A live region wrapping the detail would announce three flight rows, a calendar summary and
 * a button every time focus moved to the next stopover, which is how a keyboard reader gets
 * buried. This is the same set of facts a sighted reader takes off the block at a glance:
 * where, what state, and the two or three numbers that state turns on.
 */
export function spokenSummary(
	connection: ConnectionOnMap,
	numbers: { price?: string; flightTime?: string; nights?: number }
): string {
	const place = `${connection.airport.city.name}, ${connection.airport.iataCode}.`;
	if (connection.state === 'blocked') {
		const copy = describeBlock(connection.block);
		return `${place} ${copy.detail ?? copy.headline}`;
	}
	if (connection.state === 'pending') return `${place} Still being looked at.`;
	const parts: string[] = [];
	if (numbers.price) parts.push(`${numbers.price} in total`);
	if (numbers.flightTime) parts.push(`${numbers.flightTime} in the air`);
	if (numbers.nights !== undefined) parts.push(`${numbers.nights} ${numbers.nights === 1 ? 'night' : 'nights'}`);
	return parts.length > 0 ? `${place} ${joinWithAnd(parts)}.` : place;
}

/** What a screen reader hears on a map point, and what a pointer sees in its tooltip. Both
 * are the city, its state and the one number that state turns on, because a point carries
 * no room for more and the panel beside it carries everything. */
export function pointLabel(connection: ConnectionOnMap, priceLabel?: string): string {
	const place = `${connection.airport.city.name} (${connection.airport.iataCode})`;
	if (connection.state === 'blocked') return `${place}: ${describeBlock(connection.block).headline}`;
	if (connection.state === 'pending') return `${place}: still being looked at`;
	return priceLabel ? `${place}: ${priceLabel}` : place;
}
