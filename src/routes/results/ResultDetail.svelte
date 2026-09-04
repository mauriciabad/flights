<script lang="ts">
	/**
	 * Issues #103/#104: what a result card expands into. Everything here is an existing,
	 * tested component (`ItineraryMap`, `ItineraryTimeline`, `FlightPicker`,
	 * `TransportPicker`, `StayPicker`) wired together for the first time against a real,
	 * streamed itinerary; this file owns none of their internals (AGENTS.md: "this issue
	 * is wiring, not rebuilding").
	 *
	 * ## Why the pickers sit in their own section below the timeline, not inside it
	 *
	 * Issue #104 asks for a picker "next to each leg." Doing that literally means adding a
	 * picker INSIDE one of `ItineraryTimeline`'s own `<li class="tl-row">` snippets, which
	 * that component's header comment explicitly reserves for the comparator's subgrid
	 * contract ("no wrapping element... a wrapper would need its own grid-template-columns:
	 * subgrid, breaking the two-column contract"). Editing that file is exactly what
	 * AGENTS.md's "do not rebuild" list forbids. Instead, the read-only timeline stays
	 * exactly as-is, and a second, editing-focused section below it mirrors the timeline's
	 * own row labels ("Outbound flight", "Travel to the connection airport", ...) in the
	 * same schedule order, so the correspondence between "this row" and "this picker" is
	 * visual and positional even though it isn't a shared DOM node.
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
	 * the instant a card is expanded is the same judgement call `+page.svelte`'s own
	 * "Compare selected" button makes for the comparator: a deliberate snapshot, not a live
	 * mirror. `group`, `stayCandidates`, `transferOptions` and `outerTransferOptions` are NOT
	 * frozen the same way — more alternatives streaming in after this card opens is a feature
	 * (the picker just grows more rows), it never overwrites the traveller's current pick the
	 * way replacing `itinerary` would.
	 */
	import type { Airport, Duration, Itinerary, Money, Stay } from '$lib/domain';
	import type { ConnectionTransferOptions, ItineraryGroup, OuterTransferOptions, TransferLegOptions } from '$lib/search';
	import type { ItinerarySegmentId } from '$lib/itinerary-map/segment-id';
	import { sumMoney } from '$lib/algorithm/build';
	import type { RecomputedSelection } from '$lib/algorithm/recompute-selection';
	import { FlightPicker, ItineraryMap, ItineraryTimeline, Skeleton, TransportPicker } from '$lib/components';
	import { hasSwappableAlternatives } from '$lib/components/picker-alternatives';
	import { keyStore } from '$lib/keys';
	import { hasUsableStayProvider } from '$lib/results/provider-setup';
	import { StayPicker, groupByProperty } from '$lib/stays';

	interface Props {
		itinerary: Itinerary;
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
	}

	/** Issue #114: no alternatives yet — the default for `transferOptions`/
	 * `outerTransferOptions` before their snapshot data arrives, so every `TransportPicker`
	 * below always has a real (possibly empty) array to render rather than needing its own
	 * `?? []` at each of the four call sites. */
	const NO_TRANSFER_LEG_OPTIONS: TransferLegOptions = { candidates: [] };

	let {
		itinerary: initialItinerary,
		group,
		stayCandidates = [],
		transferOptions,
		outerTransferOptions,
		connectionAirport,
		travellers,
		females,
		minLayoverTime,
		searchDone = false
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

	// Issue #140: is there anything below to try? The hint at the top of this view claimed
	// there was on every card, including the ordinary free-tier result with one flight per
	// leg, no transport options and no stays. `picker-alternatives.ts` counts the rows the
	// pickers would actually draw, sharing `FlightPicker`'s own dedupe so the two cannot
	// disagree.
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
	const transitAnswers = $derived(itinerary === initialItinerary ? group?.best.transit : undefined);
</script>

<div class="result-detail">
	<!-- aria-live: this sentence flips when a provider answers, not when the traveller does
	     anything, so a screen reader would otherwise never learn that alternatives arrived. -->
	<p class="result-detail-hint" aria-live="polite">
		{#if canSwapSomething}
			Trying an alternative below previews this trip. It does not change your saved results.
		{:else}
			Every leg came back with one option, so there is nothing to swap below. The waiting
			times are still yours to adjust.
		{/if}
	</p>

	<div class="result-detail-map">
		<ItineraryMap {itinerary} bind:selectedSegmentId />
	</div>

	<ItineraryTimeline {itinerary} {connectionAirport} bind:selectedSegmentId />

	<section class="result-detail-editor" aria-label="Adjust this itinerary">
		<h3 class="result-detail-heading">Adjust this trip</h3>

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

		<FlightPicker
			legLabel={`Outbound: ${itinerary.originAirport.iataCode} to ${itinerary.outboundFlight.arrivalAirport}`}
			{itinerary}
			leg="outbound"
			alternatives={outboundAlternatives}
			{minLayoverTime}
			onselect={applySelection}
		/>

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

		{#if stayIsRelevant}
			<div class="result-detail-stay">
				<h4 class="result-detail-subheading">The stopover stay</h4>
				{#if connectionAirport}
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
					/>
				{:else}
					<Skeleton height="12rem" />
				{/if}
			</div>
		{/if}

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

		<FlightPicker
			legLabel={`Onward: ${itinerary.outboundFlight.arrivalAirport} to ${itinerary.destinationAirport.iataCode}`}
			{itinerary}
			leg="onward"
			alternatives={onwardAlternatives}
			{minLayoverTime}
			onselect={applySelection}
		/>

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
	</section>
</div>

<style>
	.result-detail {
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
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

	.result-detail-editor {
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}

	.result-detail-heading {
		font-size: var(--font-size-base);
		font-weight: var(--font-weight-semibold);
	}

	.result-detail-stay {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.result-detail-subheading {
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		color: var(--color-text-muted);
	}
</style>
