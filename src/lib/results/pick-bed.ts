/**
 * Putting one bed on a draft trip, and asking OSRM how to reach it.
 *
 * This was `SegmentCustomiser.svelte`'s alone while the stay picker was the only thing
 * that could change the bed. Issue #367 lets the nights ladder change it too, from the
 * results page, and two copies of "rebuild the trip around this property" is how a panel
 * and a page come to describe the same bed differently. That is #243, #250, #264 and #265,
 * each of which was one surface still printing the journey to the previous address.
 *
 * Nothing here is an `$effect` and nothing here may become one. `routeBedForDraft` writes
 * `$state` and awaits a fetch, which as an effect is AGENTS.md's own trap, the one that
 * froze every search in #87. Both callers run it from a click.
 */

import { DEFAULT_LANDING_TO_TRANSPORT_RULES } from '$lib/domain';
import type { Airport, Duration, Itinerary, Stay } from '$lib/domain';
import { recomputeItinerarySelection } from '$lib/algorithm/recompute-selection';
import { keyStore } from '$lib/keys';
import { routeToProperty } from '$lib/search';
import { isSameProperty, propertyKey } from '$lib/stays';
import type { ItineraryDraft, PropertyRouteState } from './itinerary-draft.svelte';
import { getProviderRegistry } from './provider-setup';
import { createSearchDependencies } from './search-dependencies';

/**
 * Issue #243. Picking a property is not a price edit. `transferToHotel` and
 * `transferToConnectionAirport` are journeys to one address, `freeTime` starts when the
 * first of them gets the traveller there, and `nightsInConnection` follows from that
 * window, so a swap that wrote `stay` and `totalPrice` and stopped there left every one of
 * those describing the previous bed.
 *
 * Every path writes one bed through here rather than through its own
 * `recomputeItinerarySelection` call, so a routed answer and an unrouted one cannot
 * rebuild the trip two different ways. A `routing` that is anything but `routed` leaves
 * both transfers undefined, which is what makes the panel say "Nothing routed to this
 * property": `recomputeItinerarySelection` reads `transferAnchor: 'unrouted-stay'` off
 * exactly that (issue #264).
 */
export function applyBedToDraft(
	draft: ItineraryDraft,
	stay: Stay,
	routing: PropertyRouteState,
	minLayoverTime?: Duration
): void {
	const journey = routing.kind === 'routed' ? routing : undefined;
	draft.apply(
		recomputeItinerarySelection(
			draft.itinerary,
			{
				staySelection: {
					stay,
					transferToHotel: journey?.transferToHotel,
					transferToConnectionAirport: journey?.transferToConnectionAirport
				}
			},
			minLayoverTime
		)
	);
}

/**
 * Issue #267. The search routes to the one property it picks and to no other, so until
 * this runs, any other bed can only ever say the journey to it is unknown. This asks OSRM
 * the same question the pipeline asks, for the bed just chosen, and costs 2 requests
 * against a free service.
 *
 * `routingGeneration` is bumped on every pick and a resolved route only reaches the trip
 * while its own generation is current. Without that, tapping bed A then bed B and having
 * A's slower route land second would put A's journey under B's name, which is #243's
 * defect reintroduced through the back door by the fix for it. The answer is banked either
 * way: it cost a request, it is true about that property, and reaching it again is instant.
 */
export async function routeBedForDraft(
	draft: ItineraryDraft,
	stay: Stay,
	connectionAirport: Airport,
	minLayoverTime?: Duration
): Promise<void> {
	if (isSameProperty(stay.property, draft.routedProperty)) return;
	const key = propertyKey(stay.property);
	const known = draft.propertyRouting.get(key);
	if (known && known.kind !== 'unrouted') return;

	const generation = ++draft.routingGeneration;
	draft.propertyRouting.set(key, { kind: 'routing' });

	const routing = await routeOnce(draft.itinerary, stay, connectionAirport);
	draft.propertyRouting.set(key, routing);
	// Superseded: something else was picked while this was in the queue. The answer is
	// banked above and dropped here, never written onto whatever bed is on screen now.
	if (generation !== draft.routingGeneration) return;
	if (routing.kind === 'routed') applyBedToDraft(draft, stay, routing, minLayoverTime);
}

async function routeOnce(
	itinerary: Itinerary,
	stay: Stay,
	airport: Airport
): Promise<PropertyRouteState> {
	const controller = new AbortController();
	try {
		return await routeToProperty({
			connectionCoordinates: airport.coordinates,
			propertyCoordinates: stay.property.coordinates,
			transferProviders: getProviderRegistry().ofKind('transfer'),
			keys: keyStore.availableKeys,
			signal: controller.signal,
			landingToTransportRules: DEFAULT_LANDING_TO_TRANSPORT_RULES,
			connectionAirportSize: airport.sizeClass,
			// Issue #356: the two arguments that decide whether this ride carries a fare at
			// all. Without the country `osrm.ts` hands back a taxi with no estimate, so a
			// swapped bed was being compared against the search's own bed with a price on one
			// side and nothing on the other, and the unpriced one looked cheaper than it is.
			connectionCountryCode: airport.country.isoCode,
			// Through `createSearchDependencies` rather than a second
			// `keyStore.currency ?? DEFAULT_SEARCH_CURRENCY` written here. That function IS
			// the app's answer to "what currency is this search in", and issue #158 moved it
			// out of a component closure precisely because a copy living in one could not be
			// tested and was wrong. Read live, the way the keys above are, so a currency
			// picked in settings in another tab reaches this call.
			displayCurrency: createSearchDependencies(keyStore.availableKeys, keyStore.currency).currency,
			// The trip's own party rather than the search query's, which can be absent. Every
			// other figure beside this one is already the one `itinerary.travellers` describes.
			travellers: itinerary.travellers,
			// Deliberately dropped rather than folded into `SearchSnapshot.providers`: this
			// call happens after the search is over, and counting it there would change a
			// provider row the traveller reads as "what this search did".
			record: () => {}
		});
	} catch (error) {
		return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * The journey to hand `applyBedToDraft` for a bed just chosen: the search's own pair when
 * this is the property the pipeline routed to, and whatever has been gathered for any
 * other, which for a property nobody has asked about is honestly nothing.
 */
export function journeyForBed(draft: ItineraryDraft, stay: Stay): PropertyRouteState {
	return isSameProperty(stay.property, draft.routedProperty)
		? draft.routedJourney
		: draft.routingFor(stay);
}

/**
 * Whether two beds are the same room at the same address.
 *
 * Reference equality does not answer this: a stay read back out of IndexedDB has been
 * through JSON, so the candidate list and the itinerary can hold structurally equal copies
 * of one hostel (issue #188, the same reason `propertyKey` exists). Putting a bed on a
 * trip that already has it would change nothing on screen and still mark the draft as
 * edited, which takes away the timetables the search paid for.
 */
export function isSameBed(a: Stay | undefined, b: Stay | undefined): boolean {
	if (!a || !b) return false;
	return a.roomKind === b.roomKind && isSameProperty(a.property, b.property);
}
