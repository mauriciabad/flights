<script lang="ts">
	/**
	 * Everything a traveller can change about one stretch of one trip, in one panel.
	 *
	 * Issue #278, the owner: **"we should move the nested collapasables (transport, flight,
	 * hotel picking...) to the card itself (not nested into the timeline) ... in the
	 * desktop we can make that we have a right sidebar, like the filters, that dynamically
	 * shows the customizing options for the selected segment, so we dont make the card
	 * larger. those are for customizing the itinerary, similar to the night count picker,
	 * so it can move as well."**
	 *
	 * ## What moved, and out of how deep a hole
	 *
	 * These pickers used to be `stepOptions` in `ResultDetail`, rendered as a fifth child
	 * of a selected timeline row, inside a panel below an expanded card. Three levels of
	 * disclosure over choices that are not independent of each other: a different onward
	 * flight changes which beds are worth booking, a different bed changes both in-city
	 * transfers, and every one of them changes the one price the traveller is comparing.
	 * Nielsen's own caveat on staged disclosure is that it works when the steps have low
	 * interdependence and traps people in back-and-forth navigation when they do not.
	 * These steps are as interdependent as steps get.
	 *
	 * So there is one level now. Pick a part of the trip on either timeline, and its
	 * controls appear here while the card keeps showing the price they change.
	 *
	 * ## Why the nights ladder is the stopover's panel and not a fixed header
	 *
	 * How long you stay IS a property of the stopover, and the bed you book is the other
	 * one, so issue #225's ladder and the stay picker share the panel the free-time
	 * segment opens. Putting the ladder above every panel would have made "staying longer"
	 * a permanent header over a flight picker it has nothing to do with.
	 *
	 * ## Every word in the header comes from `segment-stub.ts`
	 *
	 * The panel has to say which part of the trip it is about. It reads `segmentStubFor`
	 * rather than writing a title, so the sentence here and the sentence in the strip's own
	 * hover preview are one sentence with one set of tests behind it. #264, #265 and #269
	 * each spent a PR deleting a second derivation of a number the app already had.
	 *
	 * ## No `$effect`, and nothing async outside a handler
	 *
	 * `routeBedForDraft` writes `$state` and awaits a fetch. As an `$effect` that is
	 * AGENTS.md's own trap, the one that froze every search in #87. It runs from a click
	 * and from nowhere else, and `results/pick-bed.ts` says so where it is defined.
	 */
	import { base } from '$app/paths';
	import type { Airport, Duration, FlightOffer, Itinerary, Stay } from '$lib/domain';
	import { DEFAULT_LANDING_TO_TRANSPORT_RULES } from '$lib/domain';
	import type { ItinerarySegmentId } from '$lib/itinerary-map/segment-id';
	import { recomputeItineraryWaitingTimes } from '$lib/algorithm/build';
	import { flightOn, isSameFlight, pairingUsing } from '$lib/algorithm/pairings';
	import { recomputeItinerarySelection, type RecomputedSelection } from '$lib/algorithm/recompute-selection';
	import {
		Button,
		DepartureDates,
		FlightPicker,
		Skeleton,
		StopoverNights,
		TransportPicker,
		WaitingTimeStepper,
		visitDaysOf
	} from '$lib/components';
	import { segmentStubFor } from '$lib/components/segment-stub';
	import { unroutedLegNote } from '$lib/components/itinerary-timeline-format';
	import { waitsOvernight } from '$lib/algorithm/nights';
	import type { UnroutedLeg } from '$lib/components/itinerary-timeline-format';
	import type {
		ConnectionTransferOptions,
		ItineraryGroup,
		OuterTransferOptions,
		TransferLegOptions,
		TransitLegAnswer,
		TransitLegAnswers,
		TransitLookupBudget,
		TransitScheduleOutcome,
		WithheldTransfers
	} from '$lib/search';
	import {
		SourceTracker,
		TRANSIT_LEGS_TO_A_PROPERTY,
		fetchTransitSchedules,
		pickLandingToTransportTime
	} from '$lib/search';
	import { keyStore } from '$lib/keys';
	import { getProviderRegistry, hasUsableStayProvider, unconfiguredStayProviders } from '$lib/results/provider-setup';
	import { applyBedToDraft, journeyForBed, routeBedForDraft } from '$lib/results/pick-bed';
	import type { AutomaticStaySwap, TravellerChoices } from '$lib/results/traveller-choices';
	import type { ItineraryDraft } from '$lib/results/itinerary-draft.svelte';
	import type { DepartureDateOption } from '$lib/results/departure-ladder';
	import { VARIANT_VIEW, type StopoverLengthOption } from '$lib/results/types';
	import {
		StayPicker,
		describeNoStays,
		groupByProperty,
		isSameProperty,
		propertyKey,
		recommendedStay,
		stopoverForRanking
	} from '$lib/stays';
	import type { StayProviderOutcome } from '$lib/stays';

	interface Props {
		/** The trip this panel edits. The card beside it reads the same object, which is
		 * what makes the price on screen and the pick in here the same trip (issues #243,
		 * #250, #264). */
		draft: ItineraryDraft;
		/** Which stretch of it. `null` is the desktop rail with nothing picked yet; the
		 * phone sheet never mounts in that state. */
		segment: ItinerarySegmentId | null;
		/** Every stopover length this connection can do, priced, for the ladder issue #225
		 * built. Rides with the free-time panel because that is the segment it lengthens. */
		stopoverOptions?: readonly StopoverLengthOption[];
		/** True when the shortest pairing spends no night here, which makes this a flight
		 * change rather than a stopover (issue #225). */
		isFlightChange?: boolean;
		/** Issue #224: whether this trip is at the shortest length this connection can do,
		 * which is the one `pipeline.ts` refined transit timetables for. */
		atDefaultLength?: boolean;
		/** Issue #387: every day this connection can be flown on, priced, for the ladder
		 * beside the outbound flight. Rides with the outbound panel because that is the leg
		 * whose date it is. */
		departureOptions?: readonly DepartureDateOption[];
		group?: ItineraryGroup;
		stayCandidates?: Stay[];
		transferOptions?: ConnectionTransferOptions;
		outerTransferOptions?: OuterTransferOptions;
		connectionAirport?: Airport;
		travellers?: number;
		females?: number;
		minLayoverTime?: Duration;
		/** Issue #140: whether the search behind these options has finished. An empty stay
		 * list means "still arriving" while it is true and "nothing came back" once it is
		 * not, and the picker has to say which. */
		searchDone?: boolean;
		/** Issue #203: what each stay provider did in this search, so the note can tell
		 * "asked and answered with nothing" from "asked and got a 503". */
		stayProviders?: readonly StayProviderOutcome[];
		/**
		 * Issue #267: the timetable ration this search is spending, so the on-demand check
		 * below draws from it rather than from a second allowance nobody counts. The page
		 * hands the same object to `runSearch` and to `widenSearch`. Absent means the check
		 * cannot be offered at all.
		 */
		transitLookupBudget?: TransitLookupBudget;
		onNightsChange?: (nights: number) => void;
		onDateChange?: (date: string) => void;
		/**
		 * Issue #367: a bed this app moved when the length last changed, held until the
		 * traveller answers it. Never set for a bed they chose, because that one never moves.
		 */
		staySwap?: AutomaticStaySwap;
		/** Whether the bed on this trip is the traveller's own pick rather than the app's. */
		stayIsChosen?: boolean;
		/**
		 * Every decision made in this panel, sent to whoever can keep it. This panel edits a
		 * draft, and changing the stopover's length destroys that draft, so a decision that
		 * lived only here would be lost by the next press of the nights ladder.
		 */
		onchoice?: (choice: Partial<TravellerChoices>) => void;
	}

	/** Issue #114: no alternatives yet, which is the state before a connection's own
	 * resources resolve. One shared empty value rather than a `?? []` at each call site. */
	const NO_TRANSFER_LEG_OPTIONS: TransferLegOptions = { candidates: [] };

	/** The origin buffer has no domain-side ceiling (unlike the connection buffer, it never
	 * borrows from free time), so this is purely a sane upper bound for the number input. */
	const ORIGIN_WAITING_TIME_INPUT_MAX_MINUTES = 720;

	let {
		draft,
		segment,
		stopoverOptions = [],
		isFlightChange = false,
		atDefaultLength = true,
		departureOptions = [],
		group,
		stayCandidates = [],
		transferOptions,
		outerTransferOptions,
		connectionAirport,
		travellers,
		females,
		minLayoverTime,
		searchDone = false,
		stayProviders = [],
		transitLookupBudget,
		onNightsChange,
		onDateChange,
		staySwap,
		stayIsChosen = false,
		onchoice
	}: Props = $props();

	const itinerary = $derived(draft.itinerary);
	const connectionLabel = $derived(connectionAirport?.city.name ?? itinerary.outboundFlight.arrivalAirport);
	const connectionCode = $derived(itinerary.outboundFlight.arrivalAirport);

	const uid = $props.id();

	/** The panel's own heading, taken from the same model the strip's hover preview uses.
	 * `undefined` for the two timeline rows the strip draws no cell for, which is why the
	 * markup below still carries a fallback. */
	const stub = $derived(
		segment
			? segmentStubFor(segment, { itinerary, connectionLabel, connectionCode, connectionAirport })
			: undefined
	);

	// `ItineraryGroup.variants`: every (outbound, onward) pair the free tier found for this
	// stopover. `FlightPicker` dedupes internally, so passing every variant's flight
	// straight through, current pick included, is enough.
	const variants = $derived(group?.variants ?? []);
	const outboundAlternatives = $derived(variants.map((variant) => variant.score.itinerary.outboundFlight));
	const onwardAlternatives = $derived(variants.map((variant) => variant.score.itinerary.onwardFlight));

	/**
	 * Issue #387: the onward flight that goes with an outbound the traveller is considering.
	 *
	 * `pairConnections` already built every (outbound, onward) pair that connects, so this
	 * never invents a pairing: it looks one up. That is why a row answered this way can no
	 * longer produce "The onward flight leaves before this one lands", which is the sentence
	 * the owner was reading instead of a price.
	 *
	 * The length on screen is the target, so a flight change stays a flight change. A
	 * traveller moving to Thursday asked to leave on Thursday, not to be moved to Thursday's
	 * cheapest length as well; where Thursday cannot do the length they have, its own
	 * cheapest is the honest answer and the ladder below says so.
	 */
	function onwardFor(outbound: FlightOffer): FlightOffer | undefined {
		const pairing = pairingUsing(
			variants,
			VARIANT_VIEW,
			'outbound',
			outbound,
			itinerary.nightsInConnection
		);
		return pairing ? flightOn(pairing.score.itinerary, 'onward') : undefined;
	}

	/** Nothing may move an onward flight the traveller picked. Passing `undefined` down is
	 * what re-produces the out-of-order warning for the one case it is still for: two
	 * flights somebody pinned into an impossible pair on purpose. */
	const outboundCompanion = $derived(draft.onwardIsChosen ? undefined : onwardFor);

	/** Picking an onward flight is what makes it the traveller's, and from then on changing
	 * the outbound leaves it alone. The edge is directed: the outbound decides where and
	 * when you land, so the onward follows it and never the other way round. */
	function chooseOnwardFlight(recomputed: RecomputedSelection) {
		draft.apply(recomputed);
		draft.onwardIsChosen = true;
	}

	/**
	 * Hands the onward flight back to the app: it takes the one that goes with the outbound
	 * now, and follows it again from here on. Issue #367's "Use the recommended bed" in its
	 * other half of the trip.
	 */
	function followOutbound() {
		draft.onwardIsChosen = false;
		const onward = onwardFor(itinerary.outboundFlight);
		if (!onward || isSameFlight(onward, itinerary.onwardFlight)) return;
		draft.apply(recomputeItinerarySelection(itinerary, { onwardFlight: onward }, minLayoverTime));
	}
	const stayProperties = $derived(groupByProperty(stayCandidates));

	const originAirportTransferOptions = $derived(outerTransferOptions?.transferToOriginAirport ?? NO_TRANSFER_LEG_OPTIONS);
	const hotelTransferOptions = $derived(transferOptions?.transferToHotel ?? NO_TRANSFER_LEG_OPTIONS);
	const connectionAirportTransferOptions = $derived(
		transferOptions?.transferToConnectionAirport ?? NO_TRANSFER_LEG_OPTIONS
	);
	const destinationLocationTransferOptions = $derived(
		outerTransferOptions?.transferToDestinationLocation ?? NO_TRANSFER_LEG_OPTIONS
	);

	// Issue #135: what each leg's timetable lookup actually said, planned for THIS
	// itinerary's own flight times. Undefined once a leg has been swapped or the stopover
	// extended, because the lookups were never planned for the trip that results, and
	// pretending otherwise is the defect that issue is about.
	const transitAnswers = $derived(!draft.pickedAnAlternative && atDefaultLength ? group?.best.transit : undefined);

	/**
	 * Issue #267: the two in-city legs, once the traveller has swapped to a bed the search
	 * never routed to. `routeToProperty` asks road modes only, so those legs carry a real
	 * road route to the right address and no timetable at all, and the panel said nothing
	 * about the difference. "Taxi, 1h 27m" with no further word reads as a claim that a taxi
	 * is how you get there, when what happened is that nobody asked about the bus.
	 */
	const otherPropertyTransitAnswer: TransitLegAnswer = { answer: 'not-asked', reason: 'other-property' };
	const swappedToAnotherProperty = $derived(
		itinerary.stay !== undefined && !isSameProperty(itinerary.stay.property, draft.routedProperty)
	);
	const pickedPropertyKey = $derived(itinerary.stay ? propertyKey(itinerary.stay.property) : undefined);
	const transitCheckState = $derived(pickedPropertyKey ? draft.transitChecks.get(pickedPropertyKey) : undefined);

	/** Which timetable answers describe the two in-city legs as they now stand: the
	 * traveller's own check when they have made one, the "belongs to another bed" note while
	 * they have not, and the search's own answers when the bed is the search's own. */
	const connectionTransitAnswers = $derived.by<TransitLegAnswers | undefined>(() => {
		if (transitCheckState?.kind === 'checked') return transitCheckState.answers;
		if (!swappedToAnotherProperty) return transitAnswers;
		return {
			transferToHotel: otherPropertyTransitAnswer,
			transferToConnectionAirport: otherPropertyTransitAnswer
		};
	});

	/** Issue #385: this bed's lookup is running, and the panel says so. */
	const transitChecking = $derived(transitCheckState?.kind === 'checking');

	/**
	 * Offered once per property, and only for a bed the search never asked about. The
	 * search's own bed already has its timetable, and a second lookup for it would spend two
	 * requests to learn what is on screen.
	 *
	 * Issue #385: "once" means until an answer exists, not until the press. Gating on
	 * `transitCheckState === undefined` unmounted the button the instant
	 * `checkTransitForPickedProperty` wrote `{ kind: 'checking' }`, which is synchronous and
	 * therefore happens before the traveller's finger leaves it. What they saw was the one
	 * control in this app that spends a request vanish, over a notice still saying nobody
	 * had looked anything up, for the two round trips it takes Transitous to answer. The
	 * offer cannot be taken twice regardless: `Button` disables itself while `loading`, and
	 * `checkTransitForPickedProperty` refuses a second claim on a key it already holds.
	 */
	const canCheckTransit = $derived(
		swappedToAnotherProperty &&
			transitLookupBudget !== undefined &&
			connectionAirport !== undefined &&
			transitCheckState?.kind !== 'checked'
	);

	// The same expression the banner above the results list uses (`StayKeyNotice`), so the
	// two cannot say different things about whether a bed was ever searched for.
	const stayProviderConfigured = $derived(hasUsableStayProvider(keyStore.availableKeys));
	// Issue #203: which providers "add a key" could still reach. Since #202 made a keyless
	// provider always usable, the expression above is always true and stopped being able to
	// answer that. Issue #374 wants the labels, not a yes/no: a notice that names Booking
	// alone must not send a traveller to the Agoda row he already filled in.
	const widerProvidersToAdd = $derived(unconfiguredStayProviders(keyStore.availableKeys));

	/** Issue #185/#203: the one place that says WHY there is no bed and what could change
	 * it. Everything else about a missing bed states its own fact and leaves the cause
	 * here. */
	const noStaysNotice = $derived(
		describeNoStays({
			stayProviderConfigured,
			searchDone,
			cityName: connectionAirport?.city.name,
			stayProviders,
			unconfiguredStayProviders: widerProvidersToAdd
		})
	);

	// A stopover that ends the same day has no night to book. Showing a stay picker there
	// invites a purchase the trip cannot use. An already-picked stay keeps its picker
	// regardless, so a traveller is never shown a total they cannot inspect.
	const stayIsRelevant = $derived(itinerary.nightsInConnection > 0 || itinerary.stay !== undefined);

	// Days rather than nights, because this is what the stay ranking weighs a walk into
	// town against: a bed near the centre only earns its keep on a day you can go into
	// town, and a night asleep is not one of those.
	const visitDays = $derived(visitDaysOf(itinerary));

	// The ceiling on the connection buffer is real arithmetic: every minute it takes is a
	// minute free time gives up, both carved from one fixed layover.
	const maxConnectionWaitingTime = $derived(itinerary.connectionWaitingTime + itinerary.freeTime.duration);

	function setWaitingTime(field: 'originWaitingTime' | 'connectionWaitingTime', minutes: number) {
		// One object for both, since a buffer the traveller typed is both an override to
		// apply now and a decision to keep across the next rebuild of this draft.
		const choice: Partial<TravellerChoices> = { [field]: minutes as Duration };
		draft.itinerary = recomputeItineraryWaitingTimes(itinerary, choice);
		onchoice?.(choice);
	}

	/**
	 * Issue #243. Picking a property is not a price edit. `transferToHotel` and
	 * `transferToConnectionAirport` are journeys to one address, `freeTime` starts when the
	 * first of them gets the traveller there, and `nightsInConnection` follows from that
	 * window, so a swap that wrote `stay` and `totalPrice` and stopped there left every one
	 * of those describing the previous bed.
	 *
	 * The search's own transfers travel with the swap only when the traveller lands back on
	 * the property the pipeline routed to. Everything else is honestly unrouted until
	 * `routeBedForDraft` has asked, which since issue #367 is the same pair of functions the
	 * results page runs when a nights change moves the bed.
	 */
	function applyStaySelection(stay: Stay) {
		applyBedToDraft(draft, stay, journeyForBed(draft, stay), minLayoverTime);
		if (connectionAirport) void routeBedForDraft(draft, stay, connectionAirport, minLayoverTime);
		// Touching the bed is what makes it the traveller's, and from here on the length
		// ladder leaves it alone. It is also the answer to any swap this panel announced.
		onchoice?.({ stay });
	}

	/** One sentence for both the region a screen reader hears and the words on screen, so
	 * the two cannot drift apart. */
	function swapSentence(swap: AutomaticStaySwap): string {
		const length = swap.nights === 1 ? '1 night' : `${swap.nights} nights`;
		return `${length} moved the bed from ${swap.from.property.name} to ${swap.to.property.name}.`;
	}

	/** The bed the ranking puts first for the trip as it now stands, which is what the
	 * picker below is drawing at the head of its own list. */
	const recommendedForNow = $derived(
		connectionAirport
			? recommendedStay(
					stayCandidates,
					stopoverForRanking(itinerary, connectionAirport, travellers, females)
				)
			: undefined
	);

	/**
	 * Hands the bed back to the app: it takes the recommendation now, and follows it again
	 * the next time the length changes. Excel's "Restore to Calculated Column Formula".
	 *
	 * Deliberately not `applyStaySelection`, which would record this as a choice and pin the
	 * very bed the traveller just stopped pinning.
	 */
	function useRecommendedBed() {
		const stay = recommendedForNow;
		if (!stay) return;
		applyBedToDraft(draft, stay, journeyForBed(draft, stay), minLayoverTime);
		if (connectionAirport) void routeBedForDraft(draft, stay, connectionAirport, minLayoverTime);
		onchoice?.({ stay: undefined });
	}

	/**
	 * Issue #267: the timetable for a bed the traveller swapped to, asked because they
	 * pressed for it.
	 *
	 * ## Why this is a press and not part of the swap
	 *
	 * A bed swap already spends 2 to 4 OSRM requests on the road route. Adding the
	 * timetable to it would spend 2 Transitous `/plan` requests on every tap as well, so
	 * comparing five beds would cost 10 against the 12 this app rations to a whole search,
	 * on a free service run by volunteers. Behind a press it costs 2 when somebody has
	 * chosen a bed and wants to know whether they can get there by bus, and nothing at all
	 * while they are still comparing.
	 *
	 * ## Why it goes through the search's own budget
	 *
	 * `routeToProperty` sits outside `MAX_TRANSIT_LOOKUPS_PER_SEARCH` and can afford to: it
	 * asks road modes only, so it never reaches Transitous. This does, so it draws from the
	 * same object `runSearch` was handed. With the ration spent, `fetchTransitSchedules`
	 * refuses the claim and answers `not-asked` / `budget-spent`, which the picker already
	 * knows how to say. The request is never sent.
	 *
	 * A handler, never an `$effect`, for the same reason `routeBedForDraft` is one.
	 */
	async function checkTransitForPickedProperty() {
		const stay = itinerary.stay;
		const airport = connectionAirport;
		const budget = transitLookupBudget;
		if (!stay || !airport || !budget) return;
		const key = propertyKey(stay.property);
		if (draft.transitChecks.has(key)) return;

		const generation = ++draft.routingGeneration;
		draft.transitChecks.set(key, { kind: 'checking' });

		const outcome = await checkTransitOnce(airport, budget);
		draft.transitChecks.set(key, { kind: 'checked', answers: outcome.answers });
		// Same guard as `routeBedForDraft`, and the same counter on purpose. Pressing
		// this while that bed's road route is still in flight abandons the road route,
		// because a road answer landing second would rebuild the stay selection and wipe the
		// bus this just paid two requests for. The road route stays banked under its own
		// key, so tapping the bed again applies it.
		if (generation !== draft.routingGeneration) return;
		draft.itinerary = outcome.itinerary;
	}

	async function checkTransitOnce(
		airport: Airport,
		budget: TransitLookupBudget
	): Promise<TransitScheduleOutcome> {
		const controller = new AbortController();
		try {
			return await fetchTransitSchedules({
				itinerary,
				connectionCoordinates: airport.coordinates,
				// The same buffer `fetchConnectionResources` and `routeToProperty` apply, from
				// the same function, so a bus planned here starts from the same minute the road
				// route already assumed the traveller reaches the street.
				connectionLandingBuffer: pickLandingToTransportTime(
					DEFAULT_LANDING_TO_TRANSPORT_RULES,
					airport.sizeClass
				),
				// The two legs the swap moved, and no others. The origin and destination legs
				// keep the timetables the search fetched for them, which a bed swap cannot have
				// invalidated, and asking again would double what this press costs.
				fields: TRANSIT_LEGS_TO_A_PROPERTY,
				transferProviders: getProviderRegistry().ofKind('transfer'),
				keys: keyStore.availableKeys,
				signal: controller.signal,
				sources: new SourceTracker(),
				record: () => {},
				budget,
				minLayoverTime
			});
		} catch (error) {
			return {
				itinerary,
				answers: {
					transferToHotel: transitLookupFailure(error),
					transferToConnectionAirport: transitLookupFailure(error)
				}
			};
		}
	}

	/** AGENTS.md, "show the error you got, never the one you assumed": whatever threw comes
	 * through in its own words rather than as a generic "could not check". */
	function transitLookupFailure(error: unknown): TransitLegAnswer {
		return {
			answer: 'failed',
			error: { code: 'unknown', message: error instanceof Error ? error.message : String(error) }
		};
	}

	// `describeNoStays` titles are headings, and one of them ("Looking for stays in X…")
	// already ends in punctuation. Inline in a sentence, only the bare ones need a full stop.
	function asSentence(title: string): string {
		return /[.!?…]$/.test(title) ? title : `${title}.`;
	}

	/**
	 * Why a leg has no picker, in the words the timeline row beside it already uses.
	 *
	 * `unroutedLegNote` is the one place that decides this. It knows the five things this
	 * panel would otherwise have to restate and would restate worse: a road route that came
	 * back and was refused (#119), a bed the search never routed to (#243), a bed priced
	 * with no route to it (#211), a stopover with no night to sleep through (#231), and a
	 * plain "nobody answered". A hand-written sentence here would be a sixth version of a
	 * fact with one source, and `absenceNote`'s own comment records that exact pair drifting
	 * apart inside a day the last time somebody wrote one.
	 */
	function absenceNote(leg: UnroutedLeg): string {
		return unroutedLegNote(leg, {
			hasStay: itinerary.stay !== undefined,
			nightsInConnection: itinerary.nightsInConnection,
			overnightWait: waitsOvernight(itinerary),
			transferAnchor: itinerary.transferAnchor,
			withheld: withheldByLeg[leg]
		});
	}

	/**
	 * The one thing `unroutedLegNote` cannot say, because it is not about routing at all.
	 *
	 * A search with no origin or destination location has no outer ground leg to route: the
	 * trip starts and ends at an airport because that is what was asked for. Every sentence
	 * in the shared note claims somebody was asked and did not answer, which would be the
	 * app blaming a provider for a question it never put to one.
	 */
	const startsAtOriginAirport = $derived(!itinerary.originLocation);
	const endsAtDestinationAirport = $derived(!itinerary.destinationLocation);

	/** The four legs keyed the way `unroutedLegNote` names them. */
	const withheldByLeg = $derived<Partial<Record<UnroutedLeg, WithheldTransfers>>>({
		'to-origin-airport': originAirportTransferOptions.withheld,
		'to-hotel': hotelTransferOptions.withheld,
		'from-hotel': connectionAirportTransferOptions.withheld,
		'to-destination-location': destinationLocationTransferOptions.withheld
	});

	/** The heading for a segment the strip draws no cell for. Both are places rather than
	 * stretches of time, and neither has anything to change. */
	const PLACELESS_TITLES: Partial<Record<ItinerarySegmentId, string>> = {
		'origin-location': 'Where you start',
		'destination-location': 'Where you end up'
	};
</script>

{#snippet transportPanel(
	legLabel: string,
	legField: 'transferToOriginAirport' | 'transferToHotel' | 'transferToConnectionAirport' | 'transferToDestinationLocation',
	options: TransferLegOptions,
	transitAnswer: TransitLegAnswer | undefined,
	referenceMoment?: Itinerary['outboundFlight']['arrival'],
	referenceLabel?: string,
	/** Issue #267: offered on the two in-city legs alone, and only for a bed the search
	 * never asked Transitous about. `transitChecking` rides along from the component scope
	 * rather than through a ninth positional parameter; one lookup covers both in-city legs,
	 * and on a leg with no offer the picker never reads it. */
	oncheckTransit?: () => void
)}
	<TransportPicker
		{legLabel}
		{legField}
		{itinerary}
		alternatives={options.candidates}
		withheld={options.withheld}
		{transitAnswer}
		{referenceMoment}
		{referenceLabel}
		{minLayoverTime}
		{oncheckTransit}
		{transitChecking}
		onselect={(recomputed) => draft.apply(recomputed)}
	/>
{/snippet}

<div class="customiser" data-testid="segment-customiser" data-segment={segment ?? ''}>
	{#if !segment}
		<!-- The desktop rail before anything is picked. A rail that renders nothing reads as
		     a layout bug; a rail that says what it is for reads as an invitation. -->
		<p class="customiser-idle">
			Pick a step on any trip to change it here. Flights, ground transport, how many
			nights you stay and where you sleep.
		</p>
	{:else}
		<header class="customiser-head">
			{#if stub}
				<p class="customiser-eyebrow font-mono">{stub.eyebrow}</p>
				<h3 class="customiser-title">{stub.title}</h3>
				<p class="customiser-clocks font-mono tabular-nums">
					<span>{stub.start.time}</span>
					<span class="customiser-clock-sep" aria-hidden="true">&rarr;</span>
					<span>{stub.end.time}</span>
					<span class="customiser-duration">{stub.duration}</span>
				</p>
			{:else}
				<h3 class="customiser-title">{PLACELESS_TITLES[segment] ?? 'This step'}</h3>
			{/if}
		</header>

		<div class="customiser-body">
			{#if segment === 'transfer-to-origin-airport'}
				{#if itinerary.originLocation && itinerary.transferToOriginAirport}
					{@render transportPanel(
						'Travel to the airport',
						'transferToOriginAirport',
						originAirportTransferOptions,
						transitAnswers?.transferToOriginAirport
					)}
				{:else if startsAtOriginAirport}
					<p class="customiser-note">This trip starts at the airport, so there is no ride here.</p>
				{:else}
					<p class="customiser-note">{absenceNote('to-origin-airport')}</p>
				{/if}
			{:else if segment === 'origin-waiting'}
				{@render waitPanel(
					`Waiting time at ${itinerary.originAirport.name}`,
					itinerary.originWaitingTime,
					ORIGIN_WAITING_TIME_INPUT_MAX_MINUTES,
					(minutes) => setWaitingTime('originWaitingTime', minutes)
				)}
			{:else if segment === 'outbound-flight'}
				<!-- Issue #387. Which day you leave is a property of the outbound flight, so the
				     date ladder rides above the picker that changes it, exactly as issue #225's
				     nights ladder rides above the stay picker in the free-time panel. The owner
				     asked for the second of these after calling the first "well done". -->
				<DepartureDates {itinerary} options={departureOptions} {onDateChange} />
				{#if draft.onwardIsChosen}
					<!-- Every row below is priced against a flight the traveller chose rather than
					     the one that goes with it, and some of them will not connect at all. That
					     is what they asked for, and it is the one case the out-of-order warning is
					     still the right answer to, so the panel says which of the two is happening
					     instead of leaving a warning to be read as a bug. -->
					<div class="onward-pin" data-testid="onward-pin">
						<p class="onward-pin-line">
							Priced against the onward flight you picked, {itinerary.onwardFlight.carrier
								.iataCode}
							{itinerary.onwardFlight.flightNumber}.
						</p>
						<Button
							size="md"
							variant="secondary"
							data-testid="follow-outbound"
							onclick={followOutbound}>Let it follow the outbound</Button
						>
					</div>
				{/if}
				<FlightPicker
					legLabel={`Outbound: ${itinerary.originAirport.iataCode} to ${itinerary.outboundFlight.arrivalAirport}`}
					{itinerary}
					leg="outbound"
					alternatives={outboundAlternatives}
					companionFor={outboundCompanion}
					{minLayoverTime}
					onselect={(recomputed) => draft.apply(recomputed)}
				/>
			{:else if segment === 'transfer-to-hotel'}
				{#if itinerary.transferToHotel}
					{@render transportPanel(
						itinerary.stay ? `Travel to ${itinerary.stay.property.name}` : 'Travel to the stopover',
						'transferToHotel',
						hotelTransferOptions,
						connectionTransitAnswers?.transferToHotel,
						itinerary.outboundFlight.arrival,
						'you land',
						canCheckTransit ? checkTransitForPickedProperty : undefined
					)}
				{:else}
					<p class="customiser-note">{absenceNote('to-hotel')}</p>
				{/if}
			{:else if segment === 'free-time'}
				<!-- How long you stay and where you sleep are the two things you can change
				     about a stopover, so issue #225's ladder rides with the stay picker
				     rather than sitting as a header over every flight panel. -->
				<StopoverNights
					{itinerary}
					options={stopoverOptions}
					{isFlightChange}
					{connectionLabel}
					{onNightsChange}
				/>
				<!-- Issue #367. WCAG 4.1.3 governs how a change reported without moving focus is
				     announced, and the region has to be in the accessibility tree before the
				     change: a `role="status"` created together with its own text is usually not
				     read at all. So the live region is mounted with the ladder and only its
				     sentence appears, which is `ConnectionsPanel`'s pattern. It carries the
				     sentence alone, because `role="status"` is atomic and would otherwise read
				     the button's label as part of the announcement. -->
				<p class="visually-hidden" role="status">{staySwap ? swapSentence(staySwap) : ''}</p>
				{#if staySwap}
					{@const swap = staySwap}
					<!-- An announcement, not a question: the bed has already moved and the price on
					     the card is the new one. Pressing the button both puts the previous bed
					     back and makes it the traveller's, so it stops moving: Google Docs'
					     autocorrect undo, which is what makes announcing this worth its room. -->
					<div class="bed-swap" data-testid="bed-swap">
						<p class="bed-swap-line">{swapSentence(swap)}</p>
						<Button
							size="md"
							variant="secondary"
							class="bed-swap-action"
							data-testid="keep-previous-bed"
							onclick={() => applyStaySelection(swap.from)}>Keep {swap.from.property.name}</Button
						>
					</div>
				{/if}
				{#if stayIsRelevant}
					{#if !connectionAirport}
						<Skeleton height="6rem" />
					{:else if stayProperties.length === 0}
						<div class="stay-notice" data-testid="stay-notice">
							<p>
								<strong>{asSentence(noStaysNotice.title)}</strong>
								<!-- The line break belongs OUTSIDE the block. Svelte trims whitespace at
								     the start of a block's content, so a newline after `{#if}` is not a
								     space and the sentence runs on as "...than hostels do.Add an Agoda
								     key". Between two siblings it collapses to one space. -->
								{noStaysNotice.description}
								{#if noStaysNotice.action}<a href="{base}{noStaysNotice.action.href}"
										>{noStaysNotice.action.label}</a
									>{/if}
							</p>
							<!-- Issue #203: the provider's own sentence and status code, verbatim, in
							     its own type rather than folded into ours. The reader can tell which
							     words are the provider's and which are the app's. -->
							{#each noStaysNotice.providerFailures as failure (failure)}
								<p class="stay-notice-evidence font-mono" data-testid="stay-provider-failure">{failure}</p>
							{/each}
						</div>
					{:else}
						<StayPicker
							properties={stayProperties}
							{connectionAirport}
							nights={itinerary.nightsInConnection}
							{visitDays}
							{travellers}
							{females}
							selected={itinerary.stay}
							onchange={applyStaySelection}
							{stayProviders}
							unconfiguredStayProviders={widerProvidersToAdd}
							chosen={stayIsChosen}
							onuseRecommended={useRecommendedBed}
						/>
					{/if}
				{/if}
			{:else if segment === 'transfer-to-connection-airport'}
				{#if itinerary.transferToConnectionAirport}
					{@render transportPanel(
						'Travel to the connection airport',
						'transferToConnectionAirport',
						connectionAirportTransferOptions,
						connectionTransitAnswers?.transferToConnectionAirport,
						undefined,
						undefined,
						canCheckTransit ? checkTransitForPickedProperty : undefined
					)}
				{:else}
					<p class="customiser-note">{absenceNote('from-hotel')}</p>
				{/if}
			{:else if segment === 'connection-waiting'}
				{@render waitPanel(
					`Waiting time at ${connectionAirport?.name ?? connectionCode}`,
					itinerary.connectionWaitingTime,
					maxConnectionWaitingTime,
					(minutes) => setWaitingTime('connectionWaitingTime', minutes)
				)}
			{:else if segment === 'onward-flight'}
				<FlightPicker
					legLabel={`Onward: ${itinerary.outboundFlight.arrivalAirport} to ${itinerary.destinationAirport.iataCode}`}
					{itinerary}
					leg="onward"
					alternatives={onwardAlternatives}
					{minLayoverTime}
					onselect={chooseOnwardFlight}
				/>
			{:else if segment === 'transfer-to-destination-location'}
				{#if itinerary.destinationLocation && itinerary.transferToDestinationLocation}
					{@render transportPanel(
						'Travel to the destination',
						'transferToDestinationLocation',
						destinationLocationTransferOptions,
						transitAnswers?.transferToDestinationLocation,
						itinerary.onwardFlight.arrival,
						'you land'
					)}
				{:else if endsAtDestinationAirport}
					<p class="customiser-note">This trip ends at the airport, so there is no ride here.</p>
				{:else}
					<p class="customiser-note">{absenceNote('to-destination-location')}</p>
				{/if}
			{:else}
				<p class="customiser-note">
					Nothing to change here. This is where the trip starts and ends, not a leg of it.
				</p>
			{/if}
		</div>
	{/if}
</div>

{#snippet waitPanel(label: string, minutes: number, max: number, onChange: (minutes: number) => void)}
	<div class="wait-panel">
		<WaitingTimeStepper {label} {minutes} {max} inputId={`${uid}-wait`} {onChange} />
		<!-- The one thing a reader has to know about this number: nobody measured it. It is
		     the traveller's own buffer, and every total on the card is computed from it. -->
		<p class="customiser-note">
			Your own buffer, not a measured queue. Every total on the card follows it.
		</p>
	</div>
{/snippet}

<style>
	.customiser {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		min-width: 0;
		/* The pickers inside decide their own layout from THIS width, not the window's. In
		   the rail that is about 300px of a 1280px screen, and a viewport query answered the
		   wrong question: four columns of flight detail overlapped inside a column that had
		   room for two. */
		container-type: inline-size;
	}

	.customiser-idle {
		margin: 0;
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
		text-wrap: pretty;
	}

	/* The panel's own ticket stub: the eyebrow, the title and the two clocks, in the same
	   order and the same voice the strip's hover preview uses, because they come from the
	   same model. The tear line under it is the one this app draws everywhere a stub ends. */
	.customiser-head {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		padding-bottom: var(--space-3);
		border-bottom: 2px dashed var(--color-border-strong);
	}

	.customiser-eyebrow {
		margin: 0;
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-faint);
	}

	.customiser-title {
		margin: 0;
		font-size: var(--font-size-base);
		font-weight: var(--font-weight-semibold);
		color: var(--color-text);
		text-wrap: balance;
	}

	.customiser-clocks {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-2);
		margin: 0;
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.customiser-clock-sep {
		color: var(--color-text-faint);
	}

	.customiser-duration {
		margin-left: auto;
		color: var(--color-accent);
		font-weight: var(--font-weight-semibold);
	}

	.customiser-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		min-width: 0;
	}

	.customiser-note {
		margin: 0;
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
		text-wrap: pretty;
	}

	.wait-panel {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	/* The one warm rule on a navy panel, which is what the accent means everywhere else
	   here: this is the thing that changed. Wraps to two rows in the 300px rail and sits on
	   one as soon as there is room, with no breakpoint to keep in step. */
	.bed-swap {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
		padding: var(--space-3);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-left: 3px solid var(--color-accent);
		border-radius: var(--radius-md);
	}

	.bed-swap-line {
		flex: 1 1 12rem;
		margin: 0;
		font-size: var(--font-size-sm);
		color: var(--color-text);
		text-wrap: pretty;
	}

	/* A property name is as long as its owner made it, so this button cannot keep
	   `Button`'s own `white-space: nowrap`. */
	.bed-swap :global(.bed-swap-action) {
		white-space: normal;
		text-align: center;
	}

	/* Issue #387, and the same rule the bed swap wears, because it says the same kind of
	   thing: a decision the traveller made is still in force, and here is how to undo it. */
	.onward-pin {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
		padding: var(--space-3);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-left: 3px solid var(--color-accent);
		border-radius: var(--radius-md);
	}

	.onward-pin-line {
		flex: 1 1 12rem;
		margin: 0;
		font-size: var(--font-size-sm);
		color: var(--color-text);
		text-wrap: pretty;
	}

	.stay-notice {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.stay-notice p {
		margin: 0;
	}

	.stay-notice strong {
		color: var(--color-text);
	}

	.stay-notice a {
		color: var(--color-accent);
	}

	/* Set apart from our own sentence above it, the same separation `ErrorState` puts
	   between a headline and its evidence: monospaced, quieter, and its own line, so a
	   provider's words are never mistaken for the app's. */
	.stay-notice-evidence {
		margin-top: var(--space-2);
		padding-top: var(--space-2);
		border-top: 1px dashed var(--color-border);
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
		overflow-wrap: anywhere;
	}
</style>
