<script lang="ts">
	/**
	 * Issues #103/#104: what a result card expands into. Everything here is an existing,
	 * tested component (`ItineraryMap`, `ItineraryTimeline`, `FlightPicker`,
	 * `TransportPicker`, `StayPicker`) wired together for the first time against a real,
	 * streamed itinerary; this file owns none of their internals (AGENTS.md: "this issue
	 * is wiring, not rebuilding").
	 *
	 * ## Why the pickers unfold inside the timeline row, not in a section below it
	 *
	 * Issue #104 asks for a picker "next to each leg." The first version of this file
	 * printed every leg's alternatives again in a second list under the timeline, headed
	 * "Adjust this trip", because this comment once claimed a picker inside a timeline row
	 * would need a wrapper and a wrapper would break the row's subgrid. That list was 1594
	 * of the panel's 2932 desktop pixels, and the owner's verdict on the panel was
	 * "pathetic". The claim was wrong. `ItineraryTimeline` renders its `expansion` snippet
	 * as a fifth child of the selected `<li>`, spanning the row's four subgrid columns, so
	 * nothing about the timetable alignment changes and the picker sits under the leg it
	 * changes. `stepOptions` below is that snippet: one branch per segment, the same
	 * components with the same props and guards the old section had. `optionMarks` is the
	 * only other thing the timeline needs from here, a short "2 flights" or "3 options" on
	 * the rows where a swap exists. Selecting a row already drove the map; it now also
	 * unfolds that row's choices, and selecting it again folds them away.
	 *
	 * ## One trip on this screen, and `itinerary` below is it
	 *
	 * Issues #243 and #250 were the same defect found twice: an edit changed part of the
	 * panel and left the rest describing the trip from before it. #250 was the timeline
	 * keeping a waiting-time edit in its own private copy, so the stopover block eight lines
	 * above went on naming a bed the edited total no longer charged for. #243 was the stay
	 * picker writing `stay` and `totalPrice` directly and leaving the two in-city transfers,
	 * the free-time window and the timetables alone, so a hotel 2.8 km from the terminal
	 * inherited a 36 km hostel's bus ride.
	 *
	 * So `itinerary` is the trip, and every surface here reads it: the map, the stopover
	 * block, the pickers and the timeline, which binds it and edits it in place. Every edit
	 * goes through `algorithm/`, never through a field assignment, so nothing derived can be
	 * left behind: `recomputeItinerarySelection` for a picked alternative or a swapped bed,
	 * `recomputeItineraryWaitingTimes` (inside the timeline) for a buffer.
	 *
	 * ## Why edits here are a frozen, local "what if" preview
	 *
	 * `itinerary` starts from the `itinerary` prop but is NOT kept in sync with it via an
	 * `$effect`. That's deliberate: `SearchSnapshot.itineraryGroups` is rebuilt whole on
	 * every snapshot (`+page.svelte`'s own header comment on that field), so the prop this
	 * component receives gets a brand-new object identity on basically every tick of an
	 * active search, whether or not this particular connection's own data changed. Re-
	 * syncing on every prop change would silently discard whatever flight, transfer or stay
	 * the traveller just picked below the moment an unrelated provider answers. Freezing at
	 * the instant a card is expanded is a deliberate snapshot, not a live mirror. `group`,
	 * `stayCandidates`, `transferOptions` and `outerTransferOptions` are NOT
	 * frozen the same way — more alternatives streaming in after this card opens is a feature
	 * (the picker just grows more rows), it never overwrites the traveller's current pick the
	 * way replacing `itinerary` would.
	 */
	import { base } from '$app/paths';
	import type { Airport, Duration, Itinerary, Stay, Transfer } from '$lib/domain';
	import type { ConnectionTransferOptions, ItineraryGroup, OuterTransferOptions, TransferLegOptions } from '$lib/search';
	import type { ItinerarySegmentId } from '$lib/itinerary-map/segment-id';
	import { recomputeItinerarySelection } from '$lib/algorithm/recompute-selection';
	import type { RecomputedSelection } from '$lib/algorithm/recompute-selection';
	import {
		FlightPicker,
		GroundLegPreviews,
		ItineraryTimeline,
		Skeleton,
		StopoverBlock,
		TransportPicker
	} from '$lib/components';
	import { buildItineraryMapModel } from '$lib/itinerary-map/segments';
	import { buildGroundLegPreviews } from '$lib/itinerary-map/previews';
	import { distinctFlightCount, hasSwappableAlternatives } from '$lib/components/picker-alternatives';
	import { keyStore } from '$lib/keys';
	import { SvelteMap } from 'svelte/reactivity';
	import { DEFAULT_LANDING_TO_TRANSPORT_RULES } from '$lib/domain';
	import { routeToProperty } from '$lib/search';
	import {
		SourceTracker,
		TRANSIT_LEGS_TO_A_PROPERTY,
		fetchTransitSchedules,
		pickLandingToTransportTime
	} from '$lib/search';
	import type {
		PropertyRouting,
		TransitLegAnswer,
		TransitLegAnswers,
		TransitLookupBudget,
		TransitScheduleOutcome
	} from '$lib/search';
	import { getProviderRegistry, hasUnconfiguredStayProvider, hasUsableStayProvider } from '$lib/results/provider-setup';
	import { StayPicker, describeNoStays, groupByProperty, isSameProperty, propertyKey } from '$lib/stays';
	import type { StayProviderOutcome } from '$lib/stays';

	interface Props {
		itinerary: Itinerary;
		/** Issue #224: whether `itinerary` is the shortest stopover this connection can do,
		 * which is the one `pipeline.ts` refined transit timetables for. False once the
		 * traveller has extended the stay on the card above. */
		atDefaultLength?: boolean;
		/** The full group behind this connection (issue #104: "confirm what search/
		 * resources.ts already retains"): every (outbound, onward) pairing the free tier
		 * already fetched for this stopover, which is exactly the flight-alternatives pool
		 * brief line 67 asks for. `undefined` before the first snapshot has resolved it. */
		group?: ItineraryGroup;
		/** `SearchSnapshot.stayCandidatesByConnection[connectionCode]` — every stay the
		 * pipeline found near this connection, gender-eligibility not applied yet. */
		stayCandidates?: Stay[];
		/** `SearchSnapshot.transferOptionsByConnection[connectionCode]` (issue #114) — the
		 * connection-side legs' real transfer alternatives and taxi fare estimates.
		 * `undefined` before this connection's own resources have resolved, same timing as
		 * `group` above. */
		transferOptions?: ConnectionTransferOptions;
		/** `SearchSnapshot.outerTransferOptions` (issue #114) — the origin/destination legs'
		 * alternatives, the same fixed value for every connection in this search. */
		outerTransferOptions?: OuterTransferOptions;
		connectionAirport?: Airport;
		travellers?: number;
		females?: number;
		minLayoverTime?: Duration;
		/** Issue #140: whether the search behind these options has finished. An empty stay
		 * list means "still arriving" while it is true and "nothing came back" once it is
		 * not, and the picker below has to say which. Unlike `itinerary`, this is NOT
		 * frozen at expand time: a card left open while the search completes must stop
		 * saying it is still looking. */
		searchDone?: boolean;
		/** Issue #203: what each stay provider did in this search
		 * (`stayProviderOutcomes(SearchSnapshot.providers)`). Without it the stopover note
		 * cannot tell "asked and answered with nothing" from "asked and got a 503", and it
		 * used to claim the first for both. Not frozen at expand time, for the same reason
		 * `searchDone` is not. */
		stayProviders?: readonly StayProviderOutcome[];
		/**
		 * Issue #267: the timetable ration this search is spending, so the on-demand check
		 * below draws from it rather than from a second allowance nobody counts. The page
		 * hands the same object to `runSearch`. Absent means the check cannot be offered at
		 * all, which is what a test that mounts this panel bare gets.
		 */
		transitLookupBudget?: TransitLookupBudget;
	}

	/** Issue #114: no alternatives yet — the default for `transferOptions`/
	 * `outerTransferOptions` before their snapshot data arrives, so every `TransportPicker`
	 * below always has a real (possibly empty) array to render rather than needing its own
	 * `?? []` at each of the four call sites. */
	const NO_TRANSFER_LEG_OPTIONS: TransferLegOptions = { candidates: [] };

	let {
		itinerary: initialItinerary,
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
		transitLookupBudget
	}: Props = $props();

	// Deliberately a one-time read, not a reactive derivation — see this file's header
	// comment on why re-syncing to `initialItinerary` on every prop change would wipe out
	// a traveller's in-progress pick. `ProviderKeyCard.svelte` documents the same ignore for
	// the same reason: a fixed-for-this-instance's-lifetime initial value, not a missed
	// `$derived`.
	// svelte-ignore state_referenced_locally
	let itinerary = $state(initialItinerary);
	let selectedSegmentId = $state<ItinerarySegmentId | null>(null);

	/**
	 * Issue #280: one preview per ground leg this trip actually has, so the row is three
	 * thumbnails or two, and never an empty slot. Re-derives with `itinerary`, which is
	 * what keeps a swapped transfer's new geometry on screen: picking a different bus
	 * redraws its thumbnail, and a picked bed moves the stopover preview's endpoint.
	 */
	const groundLegPreviews = $derived(
		connectionAirport ? buildGroundLegPreviews(buildItineraryMapModel(itinerary, connectionAirport)) : []
	);

	/** Whether the traveller has replaced a flight, a transfer or the bed. A waiting-time
	 * edit is not one of these: it changes how long they wait, never which leg they take,
	 * which is what `transitAnswers` below turns on. */
	let pickedAnAlternative = $state(false);

	/** Issue #267: what routing to each property produced, keyed by `propertyKey`, for the
	 * lifetime of this panel. `PropertyRouting`'s three outcomes plus the two states a
	 * fetch has before it has one, as a union rather than a pair of booleans: "asked and
	 * nothing came back" and "not asked yet" are different sentences and #243 is what
	 * happens when two states that read differently share one representation.
	 *
	 * A `SvelteMap` rather than a plain one because the rows below read it while a click
	 * handler writes it; a plain `Map` mutated in place would not repaint. */
	type PropertyRouteState = PropertyRouting | { kind: 'unrouted' } | { kind: 'routing' };
	let propertyRouting = new SvelteMap<string, PropertyRouteState>();

	/**
	 * Issue #267's timetable half: what asking Transitous about one property produced,
	 * keyed the same way, for the lifetime of this panel.
	 *
	 * Separate from `propertyRouting` above because the two are asked at different times
	 * and on different terms. The road route happens on the tap, costs OSRM requests
	 * against a 30-day cache, and is what makes the swap useful at all. The timetable
	 * happens only when the traveller presses for it, costs two `/plan` requests against a
	 * volunteer-run service this search may only ask twelve times, and is a question about
	 * a bed they have already chosen. Folding them into one state would make the cheap
	 * answer wait for the expensive one, or spend the expensive one on every tap.
	 *
	 * Present means asked. There is no retry affordance: a second press would spend two
	 * more requests to re-ask a question the service has already answered.
	 */
	type TransitCheckState = { kind: 'checking' } | { kind: 'checked'; answers: TransitLegAnswers };
	let transitChecks = new SvelteMap<string, TransitCheckState>();

	/** Bumped on every pick, so a route that resolves after the traveller has moved on is
	 * kept but not applied. See `routePickedProperty`. */
	let routingGeneration = 0;

	function applySelection(recomputed: RecomputedSelection) {
		itinerary = recomputed.itinerary;
		pickedAnAlternative = true;
	}

	/** The property `initialItinerary`'s two in-city legs were routed to, if any.
	 * `undefined` when the pipeline priced no bed, in which case those legs go to the city
	 * centre (issue #161) and belong to no property at all. */
	const routedProperty = $derived(
		initialItinerary.transferAnchor === 'stay' ? initialItinerary.stay?.property : undefined
	);

	/**
	 * Issue #243. Picking a property is not a price edit. `transferToHotel` and
	 * `transferToConnectionAirport` are journeys to one address, `freeTime` starts when the
	 * first of them gets the traveller there, and `nightsInConnection` follows from that
	 * window, so a swap that wrote `stay` and `totalPrice` and stopped there left every one
	 * of those describing the previous bed. On the acceptance trip that meant a hostel
	 * 36.3 km from Gatwick showing `1h 7m`, "Bus, then bus", and the same five next
	 * departures computed for a hotel 2.8 km from the terminal.
	 *
	 * The transfers on `initialItinerary` belong to whatever the pipeline routed to for this
	 * connection, so they travel with the swap only when the traveller lands back on that
	 * same property. Everything else is honestly unrouted: the search asks OSRM and
	 * Transitous about the one property it picks and no other, so no journey to this address
	 * exists to show. `StaySelection` carries that, `recomputeItinerarySelection` rebuilds
	 * the window, the nights and the total from it, and the transfer rows and the stopover
	 * block say "Nothing routed to this property" rather than wearing the last bed's times.
	 *
	 * `StayPicker` still offers a price delta as its second argument and this ignores it.
	 * The recompute totals the whole trip from its parts, and adding a delta to the total
	 * that stood before would be a second arithmetic path over one number, which is how
	 * this repo has lost time more than once.
	 */
	function applyStaySelection(stay: Stay) {
		const routed = isSameProperty(stay.property, routedProperty);
		applyStayWithJourney(
			stay,
			routed
				? // Both legs or none. `transferAnchor === 'stay'` should mean the pipeline
					// routed to this bed, but #211 is the case where a bed is priced and a
					// transfer provider was unreachable, so the pair is not guaranteed and
					// half of it would rebuild half the stopover.
					journeyOf(initialItinerary.transferToHotel, initialItinerary.transferToConnectionAirport)
				: (propertyRouting.get(propertyKey(stay.property)) ?? { kind: 'unrouted' })
		);
		void routePickedProperty(stay);
	}

	function journeyOf(
		transferToHotel: Transfer | undefined,
		transferToConnectionAirport: Transfer | undefined
	): PropertyRouteState {
		if (!transferToHotel || !transferToConnectionAirport) return { kind: 'unrouted' };
		return { kind: 'routed', transferToHotel, transferToConnectionAirport };
	}

	/** Writes one bed and the journey known for it, whatever that journey is. Every branch
	 * below goes through here rather than through its own `recomputeItinerarySelection`
	 * call, so a routed answer and an unrouted one cannot end up rebuilding the trip two
	 * different ways. `transferToHotel: undefined` is what makes the panel say "Nothing
	 * routed to this property" — `recomputeItinerarySelection` sets `transferAnchor:
	 * 'unrouted-stay'` from exactly that (issue #264). */
	function applyStayWithJourney(stay: Stay, routing: PropertyRouteState) {
		const journey = routing.kind === 'routed' ? routing : undefined;
		applySelection(
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
	 * This asks OSRM the same question the pipeline asks, for the bed the traveller just
	 * tapped, and rewrites the trip when the answer lands.
	 *
	 * ## Why this is a handler and not an `$effect`
	 *
	 * AGENTS.md's "the Svelte trap that cost us a working search": an `$effect` that calls
	 * an async function without awaiting it runs the synchronous prefix on the effect's own
	 * call stack, so any `$state` that prefix writes counts as the effect writing its own
	 * dependency, and it retriggers until Svelte aborts. This writes `propertyRouting` and
	 * `itinerary`, both `$state`, so as an effect it would be exactly #87 again. #264 fixed
	 * its own version of this by deleting an effect; nothing here creates one. The fetch
	 * starts from a click and from nowhere else.
	 *
	 * ## Why the answer can arrive after the traveller has moved on
	 *
	 * `routingGeneration` is bumped on every pick, and a resolved route only reaches
	 * `itinerary` while its own generation is still the current one. Without that, tapping
	 * bed A then bed B and having A's slower route land second would put A's journey under
	 * B's name — which is #243's defect exactly, reintroduced through the back door by the
	 * fix for it. The answer is still kept in `propertyRouting` either way: it cost a
	 * request, it is true about that property, and tapping back to it is then instant.
	 */
	async function routePickedProperty(stay: Stay) {
		const key = propertyKey(stay.property);
		if (isSameProperty(stay.property, routedProperty)) return;
		const known = propertyRouting.get(key);
		if (known && known.kind !== 'unrouted') return;
		if (!connectionAirport) return;

		const generation = ++routingGeneration;
		propertyRouting.set(key, { kind: 'routing' });

		const routing = await routeOnce(stay, connectionAirport);
		propertyRouting.set(key, routing);
		// Superseded: the traveller picked something else while this was in the queue. The
		// answer is banked above and dropped here, never written onto whatever bed is on
		// screen now.
		if (generation !== routingGeneration) return;
		if (routing.kind === 'routed') applyStayWithJourney(stay, routing);
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
				connectionCountryCode: airport.country.isoCode,
				// Deliberately dropped rather than folded into `SearchSnapshot.providers`:
				// this call happens after the search is over, and counting it there would
				// change a provider row the traveller reads as "what this search did".
				// `PropertyRouting`'s own `failed` branch carries the provider's words.
				record: () => {}
			});
		} catch (error) {
			return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
		}
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
	 * `routeToProperty` sits outside `MAX_TRANSIT_LOOKUPS_PER_SEARCH` and can afford to:
	 * it asks road modes only, so it never reaches Transitous. This does, so it draws from
	 * the same object `runSearch` was handed. With the ration spent, `fetchTransitSchedules`
	 * refuses the claim and answers `not-asked` / `budget-spent`, which the picker already
	 * knows how to say. The request is never sent.
	 *
	 * A handler, never an `$effect`, for the same reason `routePickedProperty` is one: this
	 * writes two pieces of `$state` and an unawaited async call inside an effect is #87.
	 */
	async function checkTransitForPickedProperty() {
		const stay = itinerary.stay;
		const airport = connectionAirport;
		const budget = transitLookupBudget;
		if (!stay || !airport || !budget) return;
		const key = propertyKey(stay.property);
		if (transitChecks.has(key)) return;

		const generation = ++routingGeneration;
		transitChecks.set(key, { kind: 'checking' });

		const outcome = await checkTransitOnce(airport, budget);
		transitChecks.set(key, { kind: 'checked', answers: outcome.answers });
		// Same guard as `routePickedProperty`, and the same counter on purpose. Pressing
		// this while that bed's road route is still in flight abandons the road route,
		// because a road answer landing second would rebuild the stay selection and wipe
		// the bus this just paid two requests for. The road route stays banked under its
		// own key, so tapping the bed again applies it.
		if (generation !== routingGeneration) return;
		itinerary = outcome.itinerary;
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
				// the same function, so a bus planned here starts from the same minute the
				// road route already assumed the traveller reaches the street.
				connectionLandingBuffer: pickLandingToTransportTime(
					DEFAULT_LANDING_TO_TRANSPORT_RULES,
					airport.sizeClass
				),
				// The two legs the swap moved, and no others. The origin and destination legs
				// keep the timetables the search fetched for them, which a bed swap cannot
				// have invalidated, and asking again would double what this press costs.
				fields: TRANSIT_LEGS_TO_A_PROPERTY,
				transferProviders: getProviderRegistry().ofKind('transfer'),
				keys: keyStore.availableKeys,
				signal: controller.signal,
				sources: new SourceTracker(),
				// Dropped rather than folded into `SearchSnapshot.providers`, the same choice
				// `routeOnce` makes and for the same reason: this happens after the search is
				// over, and the provider strip reads as "what this search did".
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
			error: {
				code: 'unknown',
				message: error instanceof Error ? error.message : String(error)
			}
		};
	}

	// `ItineraryGroup.variants`: every (outbound, onward) pair the free tier found for this
	// stopover. `FlightPicker` dedupes internally (`flightKey`), so passing every variant's
	// flight straight through, current pick included, is enough.
	const outboundAlternatives = $derived(
		(group?.variants ?? []).map((variant) => variant.score.itinerary.outboundFlight)
	);
	const onwardAlternatives = $derived(
		(group?.variants ?? []).map((variant) => variant.score.itinerary.onwardFlight)
	);
	const stayProperties = $derived(groupByProperty(stayCandidates));

	// Issue #114: each TransportPicker's `alternatives`/`taxiFareEstimate` — every candidate
	// this exact leg's providers returned, falling back to the "nothing yet" default above
	// rather than an inline `?? []` repeated at each of the four call sites below.
	const originAirportTransferOptions = $derived(outerTransferOptions?.transferToOriginAirport ?? NO_TRANSFER_LEG_OPTIONS);
	const hotelTransferOptions = $derived(transferOptions?.transferToHotel ?? NO_TRANSFER_LEG_OPTIONS);
	const connectionAirportTransferOptions = $derived(
		transferOptions?.transferToConnectionAirport ?? NO_TRANSFER_LEG_OPTIONS
	);
	const destinationLocationTransferOptions = $derived(
		outerTransferOptions?.transferToDestinationLocation ?? NO_TRANSFER_LEG_OPTIONS
	);

	// Issue #119: the same four legs again, keyed the way `unroutedLegNote` names them. A
	// leg whose only road answer was refused has no transfer and therefore no picker, so the
	// timeline row is the only place left that can say a route came back and was declined.
	const withheldRoadByLeg = $derived({
		'to-origin-airport': originAirportTransferOptions.withheldRoad,
		'to-hotel': hotelTransferOptions.withheldRoad,
		'from-hotel': connectionAirportTransferOptions.withheldRoad,
		'to-destination-location': destinationLocationTransferOptions.withheldRoad
	});

	// Issue #140: is there anything to try? The hint above the timeline claimed there was
	// on every card, including the ordinary free-tier result with one flight per leg, no
	// transport options and no stays. `picker-alternatives.ts` counts the rows the pickers
	// would actually draw, sharing `FlightPicker`'s own dedupe so the two cannot disagree.
	const canSwapSomething = $derived(
		hasSwappableAlternatives({
			outboundFlights: outboundAlternatives,
			onwardFlights: onwardAlternatives,
			transferCandidateCounts: [
				originAirportTransferOptions.candidates.length,
				hotelTransferOptions.candidates.length,
				connectionAirportTransferOptions.candidates.length,
				destinationLocationTransferOptions.candidates.length
			],
			stayPropertyCount: stayProperties.length
		})
	);

	// The same expression the banner above the results list uses (`StayKeyNotice`), so the
	// two cannot say different things about whether a bed was ever searched for.
	const stayProviderConfigured = $derived(hasUsableStayProvider(keyStore.availableKeys));
	// Issue #203: whether "add a key" is still a thing this traveller could do. Since #202
	// made a keyless provider always usable, `stayProviderConfigured` above is always true
	// and stopped being able to answer that.
	const hasWiderProviderToAdd = $derived(hasUnconfiguredStayProvider(keyStore.availableKeys));

	/**
	 * Issue #185/#203: the one place on this screen that says WHY there is no bed and what
	 * could change it. Everything else about the missing bed — the price line's chip, the
	 * rail's caveat, the two unrouted connection legs — states its own fact about its own
	 * number or row and leaves the cause to this.
	 */
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
	// invites a purchase the trip cannot use, and every empty-state sentence it could
	// print would be about a search that should never run. An already-picked stay keeps
	// its picker regardless, so a traveller is never shown a total they cannot inspect.
	const stayIsRelevant = $derived(itinerary.nightsInConnection > 0 || itinerary.stay !== undefined);

	// Issue #135: what each leg's timetable lookup actually said, planned for THIS
	// itinerary's own flight times. Read off `group.best` rather than threaded through
	// `+page.svelte`: `group.best.score.itinerary` is the itinerary this component opened
	// with, so the answers already belong to it. Undefined until the group arrives, and for
	// the frozen local copy the traveller edits below — an itinerary rebuilt from a picked
	// alternative was never the one these lookups were planned for, and pretending otherwise
	// is the defect this issue is about.
	//
	// Issue #224 adds the second way this component can be looking at something other than
	// `group.best`: the traveller extended the stopover on the card above. `pipeline.ts`
	// spends its one timetable lookup on the shortest pairing, which is what `group.best`
	// is, so a longer one has no answers of its own and says so rather than borrowing the
	// short trip's bus times.
	//
	// `pickedAnAlternative` rather than comparing `itinerary` against the prop, since issue
	// #250 made a waiting-time edit replace `itinerary` too. That edit takes the same legs
	// at the same times, so the lookups still describe this trip; swapping one of them is
	// what ends that.
	const transitAnswers = $derived(!pickedAnAlternative && atDefaultLength ? group?.best.transit : undefined);

	/**
	 * Issue #267: the two in-city legs, once the traveller has swapped to a bed the search
	 * never routed to. `routeToProperty` asks road modes only, so those legs carry a real
	 * road route to the right address and no timetable at all, and the panel said nothing
	 * about the difference. "Taxi, 1h 27m" with no further word reads as a claim that a
	 * taxi is how you get there, when what happened is that nobody asked about the bus.
	 *
	 * Deliberately not a lookup. Putting a Transitous request behind a bed tap costs two
	 * `/plan` requests per bed against a volunteer-run service this app rations to twelve
	 * per whole search, so browsing five beds would spend most of a search's ration on
	 * browsing. Saying which bed the timetable belongs to costs nothing and is true.
	 */
	const otherPropertyTransitAnswer: TransitLegAnswer = { answer: 'not-asked', reason: 'other-property' };
	const swappedToAnotherProperty = $derived(
		itinerary.stay !== undefined && !isSameProperty(itinerary.stay.property, routedProperty)
	);
	const pickedPropertyKey = $derived(itinerary.stay ? propertyKey(itinerary.stay.property) : undefined);
	const transitCheckState = $derived(pickedPropertyKey ? transitChecks.get(pickedPropertyKey) : undefined);

	/** Which timetable answers describe the two in-city legs as they now stand: the
	 * traveller's own check when they have made one, the "belongs to another bed" note
	 * while they have not, and the search's own answers when the bed is the search's own. */
	const connectionTransitAnswers = $derived.by<TransitLegAnswers | undefined>(() => {
		if (transitCheckState?.kind === 'checked') return transitCheckState.answers;
		if (!swappedToAnotherProperty) return transitAnswers;
		return {
			transferToHotel: otherPropertyTransitAnswer,
			transferToConnectionAirport: otherPropertyTransitAnswer
		};
	});

	/** Offered once per property, and only for a bed the search never asked about. The
	 * search's own bed already has its timetable, and a second lookup for it would spend
	 * two requests to learn what is on screen. */
	const canCheckTransit = $derived(
		swappedToAnotherProperty &&
			transitLookupBudget !== undefined &&
			connectionAirport !== undefined &&
			transitCheckState === undefined
	);

	// The timeline's "2 flights" / "3 options" marks: only rows whose fold offers more than
	// one thing to pick, gated on the same conditions the fold itself renders under, so a
	// mark never promises a choice the row cannot open. A stay list counts from one
	// property, the same reasoning as `hasSwappableAlternatives`: with no bed on the
	// itinerary, one property is still the choice between pricing it in and leaving it out.
	const optionMarks = $derived.by(() => {
		const marks: Partial<Record<ItinerarySegmentId, string>> = {};
		const outbound = distinctFlightCount(outboundAlternatives);
		if (outbound > 1) marks['outbound-flight'] = `${outbound} flights`;
		const onward = distinctFlightCount(onwardAlternatives);
		if (onward > 1) marks['onward-flight'] = `${onward} flights`;
		const transferLegs = [
			['transfer-to-origin-airport', itinerary.transferToOriginAirport, originAirportTransferOptions],
			['transfer-to-hotel', itinerary.transferToHotel, hotelTransferOptions],
			['transfer-to-connection-airport', itinerary.transferToConnectionAirport, connectionAirportTransferOptions],
			['transfer-to-destination-location', itinerary.transferToDestinationLocation, destinationLocationTransferOptions]
		] as const;
		for (const [segment, transfer, options] of transferLegs) {
			if (transfer && options.candidates.length > 1) marks[segment] = `${options.candidates.length} options`;
		}
		if (stayIsRelevant && stayProperties.length > 0) {
			const count = stayProperties.length;
			marks['free-time'] = `${count} ${count === 1 ? 'stay' : 'stays'}`;
		}
		return marks;
	});

	// `describeNoStays` titles are headings, and one of them ("Looking for stays in X…")
	// already ends in punctuation. Inline in a sentence, only the bare ones need a full stop.
	function asSentence(title: string): string {
		return /[.!?…]$/.test(title) ? title : `${title}.`;
	}
</script>

{#snippet stepOptions(segment: ItinerarySegmentId)}
	{#if segment === 'transfer-to-origin-airport'}
		{#if itinerary.originLocation && itinerary.transferToOriginAirport}
			<TransportPicker
				legLabel="Travel to the airport"
				legField="transferToOriginAirport"
				{itinerary}
				alternatives={originAirportTransferOptions.candidates}
				transitAnswer={transitAnswers?.transferToOriginAirport}
				{minLayoverTime}
				onselect={applySelection}
			/>
		{/if}
	{:else if segment === 'outbound-flight'}
		<FlightPicker
			legLabel={`Outbound: ${itinerary.originAirport.iataCode} to ${itinerary.outboundFlight.arrivalAirport}`}
			{itinerary}
			leg="outbound"
			alternatives={outboundAlternatives}
			{minLayoverTime}
			onselect={applySelection}
		/>
	{:else if segment === 'transfer-to-hotel'}
		{#if itinerary.transferToHotel}
			<TransportPicker
				legLabel={itinerary.stay ? `Travel to ${itinerary.stay.property.name}` : 'Travel to the stopover'}
				legField="transferToHotel"
				{itinerary}
				alternatives={hotelTransferOptions.candidates}
				transitAnswer={connectionTransitAnswers?.transferToHotel}
				oncheckTransit={canCheckTransit ? checkTransitForPickedProperty : undefined}
				transitChecking={transitCheckState?.kind === 'checking'}
				referenceMoment={itinerary.outboundFlight.arrival}
				referenceLabel="you land"
				{minLayoverTime}
				onselect={applySelection}
			/>
		{/if}
	{:else if segment === 'free-time'}
		{#if stayIsRelevant}
			{#if !connectionAirport}
				<Skeleton height="6rem" />
			{:else if stayProperties.length === 0}
				<!-- StayPicker's own empty state is a 250px hero. Inside a timeline row the
				     reason a bed is missing is a note, not a scene, so the same wording
				     (`describeNoStays`, issue #140) goes on one line. -->
				<div class="stay-notice" data-testid="stay-notice">
					<p>
						<strong>{asSentence(noStaysNotice.title)}</strong>
						<!-- The line break belongs OUTSIDE the block. Svelte trims whitespace at the
						     start of a block's content, so the newline this used to have after
						     `{#if}` was not a space and the sentence ran on as "...than hostels
						     do.Add an Agoda key". Between two siblings it collapses to one space,
						     which is what a sentence followed by a link needs. -->
						{noStaysNotice.description}
						{#if noStaysNotice.action}<a href="{base}{noStaysNotice.action.href}"
								>{noStaysNotice.action.label}</a
							>{/if}
					</p>
					<!-- Issue #203: the provider's own sentence and status code, verbatim, in its
					     own type rather than folded into ours. The reader can tell which words are
					     the provider's and which are the app's, which is the whole point of
					     AGENTS.md's "show the error you got, never the one you assumed". -->
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
			<TransportPicker
				legLabel="Travel to the connection airport"
				legField="transferToConnectionAirport"
				{itinerary}
				alternatives={connectionAirportTransferOptions.candidates}
				transitAnswer={connectionTransitAnswers?.transferToConnectionAirport}
				oncheckTransit={canCheckTransit ? checkTransitForPickedProperty : undefined}
				transitChecking={transitCheckState?.kind === 'checking'}
				{minLayoverTime}
				onselect={applySelection}
			/>
		{/if}
	{:else if segment === 'onward-flight'}
		<FlightPicker
			legLabel={`Onward: ${itinerary.outboundFlight.arrivalAirport} to ${itinerary.destinationAirport.iataCode}`}
			{itinerary}
			leg="onward"
			alternatives={onwardAlternatives}
			{minLayoverTime}
			onselect={applySelection}
		/>
	{:else if segment === 'transfer-to-destination-location'}
		{#if itinerary.destinationLocation && itinerary.transferToDestinationLocation}
			<TransportPicker
				legLabel="Travel to the destination"
				legField="transferToDestinationLocation"
				{itinerary}
				alternatives={destinationLocationTransferOptions.candidates}
				transitAnswer={transitAnswers?.transferToDestinationLocation}
				referenceMoment={itinerary.onwardFlight.arrival}
				referenceLabel="you land"
				{minLayoverTime}
				onselect={applySelection}
			/>
		{/if}
	{/if}
{/snippet}

<div class="result-detail">
	<!-- Issue #280. The always-on MapLibre map that used to sit here is now inside
	     `RouteMapDialog`, reached by tapping one of these. Three frozen SVG previews cost
	     nothing to render down a results list; the map that replaced them cost 12.6 seconds
	     to settle at four cards and stopped working entirely at five, which
	     `tools/probe-map-cost.mjs` measures on demand. A leg the itinerary does not have
	     gets no preview, so this row is three items or two, slightly wider. -->
	<GroundLegPreviews {itinerary} previews={groundLegPreviews} bind:selectedSegmentId />

	<!-- Issue #228's block, in full. It lands here rather than on the card because seven
	     lines repeated down a results list is not a results screen, and here rather than
	     inside the timeline because the timeline's own left column already prints these two
	     clock readings as its spine. Above the timeline: "what do I get here" is the
	     question a person asks before reading the trip step by step. -->
	<StopoverBlock
		{itinerary}
		connectionLabel={connectionAirport?.city.name ?? itinerary.outboundFlight.arrivalAirport}
		connectionCoordinates={connectionAirport?.coordinates}
	/>

	<!-- aria-live: this sentence flips when a provider answers, not when the traveller does
	     anything, so a screen reader would otherwise never learn that alternatives arrived. -->
	<p class="result-detail-hint" aria-live="polite">
		{#if canSwapSomething}
			Tap a step to see its alternatives. Picking one previews this trip and does not change
			your saved results.
		{:else}
			Every leg came back with one option, so there is nothing to swap. The waiting times are
			still yours to adjust.
		{/if}
	</p>

	<!-- `bind:itinerary`, not a plain prop: the waiting-time stepper inside the rows edits
	     the trip, and issue #250 is what happened while that edit lived in a copy only the
	     timeline could see. -->
	<ItineraryTimeline
		bind:itinerary
		{connectionAirport}
		bind:selectedSegmentId
		expansion={stepOptions}
		{optionMarks}
		withheldRoad={withheldRoadByLeg}
	/>
</div>

<style>
	.result-detail {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		/* Reads as the ticket above unfolding, the same dashed "tear line" the timeline's
		   own totals divider and this card's control row both already use. */
		margin-top: var(--space-3);
		padding: var(--space-5) 0 0;
		border-top: 2px dashed var(--color-border-strong);
	}

	.result-detail-hint {
		margin: 0;
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
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
	/* `--color-text-muted`, not `--color-text-faint`, which `ErrorState` uses for the same
	   job on a plain surface. This note sits inside the stopover row's own tint
	   (`--color-stopover-bg`), where faint measures 3.55:1 and fails AA. Muted measures
	   6.49:1 dark and 6.93:1 light against that tint. It is quieter than the sentence above
	   it by size and by family, which is the separation this needs; a quote the reader
	   cannot read is not evidence of anything. */
	.stay-notice-evidence {
		margin-top: var(--space-2);
		padding-top: var(--space-2);
		border-top: 1px dashed var(--color-border);
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
		overflow-wrap: anywhere;
	}
</style>
