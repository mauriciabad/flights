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
	import type { Airport, Duration, Itinerary, Money, Stay } from '$lib/domain';
	import type { ConnectionTransferOptions, ItineraryGroup, OuterTransferOptions, TransferLegOptions } from '$lib/search';
	import type { ItinerarySegmentId } from '$lib/itinerary-map/segment-id';
	import { sumMoney } from '$lib/algorithm/build';
	import type { RecomputedSelection } from '$lib/algorithm/recompute-selection';
	import {
		FlightPicker,
		ItineraryMap,
		ItineraryTimeline,
		Skeleton,
		StopoverBlock,
		TransportPicker
	} from '$lib/components';
	import { distinctFlightCount, hasSwappableAlternatives } from '$lib/components/picker-alternatives';
	import { keyStore } from '$lib/keys';
	import { hasUnconfiguredStayProvider, hasUsableStayProvider } from '$lib/results/provider-setup';
	import { StayPicker, describeNoStays, groupByProperty } from '$lib/stays';
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
		stayProviders = []
	}: Props = $props();

	// Deliberately a one-time read, not a reactive derivation — see this file's header
	// comment on why re-syncing to `initialItinerary` on every prop change would wipe out
	// a traveller's in-progress pick. `ProviderKeyCard.svelte` documents the same ignore for
	// the same reason: a fixed-for-this-instance's-lifetime initial value, not a missed
	// `$derived`.
	// svelte-ignore state_referenced_locally
	let itinerary = $state(initialItinerary);
	let selectedSegmentId = $state<ItinerarySegmentId | null>(null);

	function applySelection(recomputed: RecomputedSelection) {
		itinerary = recomputed.itinerary;
	}

	// No override field for the stay itself exists on `recomputeItinerarySelection`
	// (that module's own doc comment: "issue #27's picker owns that swap separately,
	// outside this module") — nights and free time don't change with which property is
	// booked, only the price does, already multiplied out by `StayPicker` itself.
	function applyStaySelection(stay: Stay, deltaForStay: Money) {
		itinerary = { ...itinerary, stay, totalPrice: sumMoney(itinerary.totalPrice, deltaForStay) };
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
	const transitAnswers = $derived(
		itinerary === initialItinerary && atDefaultLength ? group?.best.transit : undefined
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
				taxiFareEstimate={originAirportTransferOptions.taxiFareEstimate}
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
				taxiFareEstimate={hotelTransferOptions.taxiFareEstimate}
				transitAnswer={transitAnswers?.transferToHotel}
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
				taxiFareEstimate={connectionAirportTransferOptions.taxiFareEstimate}
				transitAnswer={transitAnswers?.transferToConnectionAirport}
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
				taxiFareEstimate={destinationLocationTransferOptions.taxiFareEstimate}
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
	<div class="result-detail-map">
		<ItineraryMap {itinerary} bind:selectedSegmentId />
	</div>

	<!-- Issue #228's block, in full. It lands here rather than on the card because seven
	     lines repeated down a results list is not a results screen, and here rather than
	     inside the timeline because the timeline's own left column already prints these two
	     clock readings as its spine. Above the timeline: "what do I get here" is the
	     question a person asks before reading the trip step by step. -->
	<StopoverBlock
		{itinerary}
		connectionLabel={connectionAirport?.city.name ?? itinerary.outboundFlight.arrivalAirport}
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

	<ItineraryTimeline {itinerary} {connectionAirport} bind:selectedSegmentId expansion={stepOptions} {optionMarks} />
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
