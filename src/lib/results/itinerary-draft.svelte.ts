/**
 * One connection's trip while the traveller is editing it.
 *
 * ## Why this exists at all
 *
 * Issue #278 moved the flight, transport and stay pickers off the expanded timeline and
 * into a rail beside the results list. The card and the rail are now two components in
 * two different corners of the page describing one trip, which is precisely the shape
 * that produced #243, #250, #264, #265 and #266: a bed swapped in one place while
 * another place kept printing the journey to the previous address.
 *
 * The fix those issues converged on was one itinerary that every surface reads. That
 * itinerary used to be a `$state` inside `ResultDetail`, which worked while every surface
 * was inside `ResultDetail`. It no longer is, so the trip moves to an object the page
 * owns and hands to both. `svelte-core-bestpractices`: "use classes with `$state` fields
 * to share reactivity between components, instead of using stores."
 *
 * ## What is deliberately NOT here
 *
 * No policy. This holds the trip, the flag that says a leg was swapped, and the routing
 * answers gathered for beds nobody asked the pipeline about. Deciding what to route,
 * when to route it and what a recompute should carry stays in the component that owns
 * those inputs, because those inputs (`minLayoverTime`, the connection airport, the
 * provider registry) are per-card props and threading them in here would only move the
 * wiring, not remove it.
 *
 * No `$effect` and nothing async. `routePickedProperty` in `SegmentCustomiser.svelte`
 * writes `itinerary` and `propertyRouting` from a click handler, which is what keeps
 * AGENTS.md's `$effect`-that-calls-async trap out of this path.
 *
 * ## Freezing, and why it is still right
 *
 * `initial` is the trip as the search last streamed it; `itinerary` starts equal to it
 * and then diverges. Nothing syncs the two. `SearchSnapshot.itineraryGroups` is rebuilt
 * whole on every snapshot, so a draft that re-read its prop would throw away the flight
 * the traveller just picked the moment an unrelated provider answered. The page creates a
 * draft only once somebody starts editing, and drops it when the stopover length changes,
 * because a different length is a different onward flight and every pick made against the
 * old one was for a trip that no longer exists.
 */

import { SvelteMap } from 'svelte/reactivity';
import type { Itinerary, Stay } from '$lib/domain';
import type { RecomputedSelection } from '$lib/algorithm/recompute-selection';
import type { PropertyRouting, TransitLegAnswers } from '$lib/search';
import { propertyKey } from '$lib/stays';

/**
 * Issue #267: what routing to one property produced, plus the two states a fetch has
 * before it has an answer. A union rather than a pair of booleans because "asked and
 * nothing came back" and "not asked yet" are different sentences, and #243 is what
 * happens when two states that read differently share one representation.
 */
export type PropertyRouteState = PropertyRouting | { kind: 'unrouted' } | { kind: 'routing' };

/** Issue #267's timetable half: what asking Transitous about one property produced. Kept
 * apart from the road answer above because the two are asked separately and cost different
 * things: the road route rides along with a bed tap, the timetable costs two requests out
 * of a whole search's ration and so waits for a press. */
export type TransitCheckState = { kind: 'checking' } | { kind: 'checked'; answers: TransitLegAnswers };

export class ItineraryDraft {
	/** The trip as the search last streamed it, kept for the two questions that are about
	 * the search rather than about the edit: which property the pipeline actually routed
	 * to, and the pair of transfers it measured for that property. */
	readonly initial: Itinerary;

	/** The trip on screen. Every surface for this card reads it and nothing else. */
	itinerary: Itinerary = $state()!;

	/** Whether a flight, a transfer or the bed has been replaced. A waiting-time edit is
	 * not one of these: it changes how long the traveller waits, never which leg they
	 * take, which is what the transit timetables are still true about (issue #135). */
	pickedAnAlternative = $state(false);

	/**
	 * Issue #387: the onward flight is the traveller's own pick, so nothing may move it.
	 *
	 * The outbound and the onward are not equals. Where you land and when follows from the
	 * outbound, so changing the outbound re-picks the onward that goes with it; that is the
	 * dependency this issue is about, and the edge is directed. This flag is the one
	 * exception, and it is HTML's input dirty value flag again, the same rule issue #367
	 * settled for the bed: a default keeps flowing in until the person touches the field.
	 *
	 * On the draft rather than in `TravellerChoices` because it dies with the draft, and
	 * that is correct rather than a shortcut. Changing the length or the departure date
	 * rebuilds the draft from a different pairing, and an onward flight picked against the
	 * old pairing was for a trip that no longer exists, which is the rule this class's
	 * header already states for every other pick.
	 */
	onwardIsChosen = $state(false);

	/** Routing answers by `propertyKey`, for the lifetime of this draft. A `SvelteMap`
	 * rather than a plain one because the stay rows read it while a click handler writes
	 * it, and a plain `Map` mutated in place would not repaint. */
	readonly propertyRouting = new SvelteMap<string, PropertyRouteState>();

	/** Issue #267: timetable answers by `propertyKey`, for the lifetime of this draft, so a
	 * press that cost two requests is not spent again on the bed it already answered for. */
	readonly transitChecks = new SvelteMap<string, TransitCheckState>();

	/** Bumped on every pick, so a route that resolves after the traveller has moved on is
	 * banked but never written onto whatever bed is on screen now. Plain bookkeeping: it
	 * is compared inside a handler and nothing renders from it. */
	routingGeneration = 0;

	constructor(initial: Itinerary) {
		this.initial = initial;
		this.itinerary = initial;
	}

	/** The property the search's own two in-city legs were measured against, if any.
	 * `undefined` when the pipeline priced no bed, in which case those legs go to the city
	 * centre (issue #161) and belong to no property at all. */
	get routedProperty() {
		return this.initial.transferAnchor === 'stay' ? this.initial.stay?.property : undefined;
	}

	/** The pipeline's own journey to and from its chosen bed. Both legs or neither:
	 * `transferAnchor === 'stay'` should mean it routed to that bed, but #211 is the case
	 * where a bed is priced and a transfer provider was unreachable, and half a pair would
	 * rebuild half the stopover. Typed as a `PropertyRouteState` so a caller can hand it
	 * and a freshly fetched answer to the same writer, which is what stops a routed bed and
	 * an unrouted one rebuilding the trip two different ways. */
	get routedJourney(): PropertyRouteState {
		const { transferToHotel, transferToConnectionAirport } = this.initial;
		if (!transferToHotel || !transferToConnectionAirport) return { kind: 'unrouted' };
		return { kind: 'routed', transferToHotel, transferToConnectionAirport };
	}

	/** What is known about reaching one property. Never `undefined`: a property nobody has
	 * asked about is honestly `unrouted`, which is the sentence the panel prints. */
	routingFor(stay: Stay): PropertyRouteState {
		return this.propertyRouting.get(propertyKey(stay.property)) ?? { kind: 'unrouted' };
	}

	/** Writes a rebuilt trip. Every edit that swaps a leg goes through here rather than
	 * assigning `itinerary` directly, so nothing can set the trip without also recording
	 * that the timetables no longer describe it. */
	apply(recomputed: RecomputedSelection) {
		this.itinerary = recomputed.itinerary;
		this.pickedAnAlternative = true;
	}
}
