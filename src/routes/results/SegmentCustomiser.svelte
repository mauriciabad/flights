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
	 * `routePickedProperty` writes `$state` and awaits a fetch. As an `$effect` that is
	 * AGENTS.md's own trap, the one that froze every search in #87. It runs from a click
	 * and from nowhere else.
	 */
	import { base } from '$app/paths';
	import type { Airport, Duration, Itinerary, Stay } from '$lib/domain';
	import { DEFAULT_LANDING_TO_TRANSPORT_RULES } from '$lib/domain';
	import type { ItinerarySegmentId } from '$lib/itinerary-map/segment-id';
	import { recomputeItineraryWaitingTimes } from '$lib/algorithm/build';
	import { recomputeItinerarySelection } from '$lib/algorithm/recompute-selection';
	import { FlightPicker, Skeleton, StopoverNights, TransportPicker, WaitingTimeStepper } from '$lib/components';
	import { segmentStubFor } from '$lib/components/segment-stub';
	import type {
		ConnectionTransferOptions,
		ItineraryGroup,
		OuterTransferOptions,
		TransferLegOptions,
		TransitLegAnswer,
		TransitLegAnswers,
		TransitLookupBudget,
		TransitScheduleOutcome
	} from '$lib/search';
	import {
		SourceTracker,
		TRANSIT_LEGS_TO_A_PROPERTY,
		fetchTransitSchedules,
		pickLandingToTransportTime,
		routeToProperty
	} from '$lib/search';
	import { keyStore } from '$lib/keys';
	import { getProviderRegistry, hasUnconfiguredStayProvider, hasUsableStayProvider } from '$lib/results/provider-setup';
	import type { ItineraryDraft, PropertyRouteState } from '$lib/results/itinerary-draft.svelte';
	import type { StopoverLengthOption } from '$lib/results/types';
	import { StayPicker, describeNoStays, groupByProperty, isSameProperty, propertyKey } from '$lib/stays';
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
		onNightsChange
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
	const outboundAlternatives = $derived((group?.variants ?? []).map((variant) => variant.score.itinerary.outboundFlight));
	const onwardAlternatives = $derived((group?.variants ?? []).map((variant) => variant.score.itinerary.onwardFlight));
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

	/** Offered once per property, and only for a bed the search never asked about. The
	 * search's own bed already has its timetable, and a second lookup for it would spend two
	 * requests to learn what is on screen. */
	const canCheckTransit = $derived(
		swappedToAnotherProperty &&
			transitLookupBudget !== undefined &&
			connectionAirport !== undefined &&
			transitCheckState === undefined
	);

	// The same expression the banner above the results list uses (`StayKeyNotice`), so the
	// two cannot say different things about whether a bed was ever searched for.
	const stayProviderConfigured = $derived(hasUsableStayProvider(keyStore.availableKeys));
	// Issue #203: whether "add a key" is still something this traveller could do. Since
	// #202 made a keyless provider always usable, the expression above is always true and
	// stopped being able to answer that.
	const hasWiderProviderToAdd = $derived(hasUnconfiguredStayProvider(keyStore.availableKeys));

	/** Issue #185/#203: the one place that says WHY there is no bed and what could change
	 * it. Everything else about a missing bed states its own fact and leaves the cause
	 * here. */
	const noStaysNotice = $derived(
		describeNoStays({
			stayProviderConfigured,
			searchDone,
			cityName: connectionAirport?.city.name,
			stayProviders,
			hasUnconfiguredStayProvider: hasWiderProviderToAdd
		})
	);

	// A stopover that ends the same day has no night to book. Showing a stay picker there
	// invites a purchase the trip cannot use. An already-picked stay keeps its picker
	// regardless, so a traveller is never shown a total they cannot inspect.
	const stayIsRelevant = $derived(itinerary.nightsInConnection > 0 || itinerary.stay !== undefined);

	// The ceiling on the connection buffer is real arithmetic: every minute it takes is a
	// minute free time gives up, both carved from one fixed layover.
	const maxConnectionWaitingTime = $derived(itinerary.connectionWaitingTime + itinerary.freeTime.duration);

	function setWaitingTime(field: 'originWaitingTime' | 'connectionWaitingTime', minutes: number) {
		draft.itinerary = recomputeItineraryWaitingTimes(itinerary, { [field]: minutes as Duration });
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
	 * `routePickedProperty` below has asked.
	 */
	function applyStaySelection(stay: Stay) {
		const routed = isSameProperty(stay.property, draft.routedProperty);
		applyStayWithJourney(stay, routed ? draft.routedJourney : draft.routingFor(stay));
		void routePickedProperty(stay);
	}

	/** Writes one bed and whatever journey is known for it. Every branch goes through here
	 * rather than through its own `recomputeItinerarySelection` call, so a routed answer
	 * and an unrouted one cannot rebuild the trip two different ways. `transferToHotel:
	 * undefined` is what makes the panel say "Nothing routed to this property":
	 * `recomputeItinerarySelection` sets `transferAnchor: 'unrouted-stay'` from exactly
	 * that (issue #264). */
	function applyStayWithJourney(stay: Stay, routing: PropertyRouteState) {
		const journey = routing.kind === 'routed' ? routing : undefined;
		draft.apply(
			recomputeItinerarySelection(
				itinerary,
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
	 * this ran, picking any other bed could only ever say the journey to it was unknown.
	 * This asks OSRM the same question the pipeline asks, for the bed just tapped.
	 *
	 * `routingGeneration` is bumped on every pick and a resolved route only reaches the
	 * trip while its own generation is current. Without that, tapping bed A then bed B and
	 * having A's slower route land second would put A's journey under B's name, which is
	 * #243's defect reintroduced through the back door by the fix for it. The answer is
	 * banked either way: it cost a request, it is true about that property, and tapping
	 * back to it is then instant.
	 */
	async function routePickedProperty(stay: Stay) {
		const key = propertyKey(stay.property);
		if (isSameProperty(stay.property, draft.routedProperty)) return;
		const known = draft.propertyRouting.get(key);
		if (known && known.kind !== 'unrouted') return;
		if (!connectionAirport) return;

		const generation = ++draft.routingGeneration;
		draft.propertyRouting.set(key, { kind: 'routing' });

		const routing = await routeOnce(stay, connectionAirport);
		draft.propertyRouting.set(key, routing);
		// Superseded: the traveller picked something else while this was in the queue. The
		// answer is banked above and dropped here, never written onto whatever bed is on
		// screen now.
		if (generation !== draft.routingGeneration) return;
		if (routing.kind === 'routed') applyStayWithJourney(stay, routing);
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
	 * A handler, never an `$effect`, for the same reason `routePickedProperty` is one.
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
		// Same guard as `routePickedProperty`, and the same counter on purpose. Pressing
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

	async function routeOnce(stay: Stay, airport: Airport): Promise<PropertyRouteState> {
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
				// Deliberately dropped rather than folded into `SearchSnapshot.providers`:
				// this call happens after the search is over, and counting it there would
				// change a provider row the traveller reads as "what this search did".
				record: () => {}
			});
		} catch (error) {
			return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
		}
	}

	// `describeNoStays` titles are headings, and one of them ("Looking for stays in X…")
	// already ends in punctuation. Inline in a sentence, only the bare ones need a full stop.
	function asSentence(title: string): string {
		return /[.!?…]$/.test(title) ? title : `${title}.`;
	}

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
	 * never asked Transitous about. */
	oncheckTransit?: () => void
)}
	<TransportPicker
		{legLabel}
		{legField}
		{itinerary}
		alternatives={options.candidates}
		{transitAnswer}
		{referenceMoment}
		{referenceLabel}
		{minLayoverTime}
		{oncheckTransit}
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
				{:else}
					<p class="customiser-note">This trip starts at the airport, so there is no ride to change.</p>
				{/if}
			{:else if segment === 'origin-waiting'}
				{@render waitPanel(
					`Waiting time at ${itinerary.originAirport.name}`,
					itinerary.originWaitingTime,
					ORIGIN_WAITING_TIME_INPUT_MAX_MINUTES,
					(minutes) => setWaitingTime('originWaitingTime', minutes)
				)}
			{:else if segment === 'outbound-flight'}
				<FlightPicker
					legLabel={`Outbound: ${itinerary.originAirport.iataCode} to ${itinerary.outboundFlight.arrivalAirport}`}
					{itinerary}
					leg="outbound"
					alternatives={outboundAlternatives}
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
					<p class="customiser-note">Nothing was routed into the city, so there is no ride to change.</p>
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
							{travellers}
							{females}
							selected={itinerary.stay}
							onchange={applyStaySelection}
							{stayProviderConfigured}
							{searchDone}
							{stayProviders}
							hasUnconfiguredStayProvider={hasWiderProviderToAdd}
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
					<p class="customiser-note">Nothing was routed back to the airport, so there is no ride to change.</p>
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
					onselect={(recomputed) => draft.apply(recomputed)}
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
				{:else}
					<p class="customiser-note">This trip ends at the airport, so there is no ride to change.</p>
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
