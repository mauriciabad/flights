<script lang="ts">
	/**
	 * The full timeline, the map and the stopover block: what the trip strip unfolds into.
	 *
	 * ## What this file used to be, and what issue #278 took off it
	 *
	 * It was "what a result card expands into", and it held everything: the map, the
	 * stopover block, the timeline, and every picker, rendered as a fifth child of whichever
	 * timeline row was selected. The owner, on that arrangement: **"we should move the
	 * nested collapasables (transport, flight, hotel picking...) to the card itself (not
	 * nested into the timeline)"**. They went further than the card, to
	 * `SegmentCustomiser`, and this file is now the second of the two timelines and nothing
	 * else. Its `stepOptions` snippet, `optionMarks`' picker gating, the stay list, the
	 * routing machinery and the frozen local itinerary all left with them.
	 *
	 * What remains is a reader, and since issue #313 it is only a reader. It renders the
	 * trip and reports which row was picked. The waiting-time steppers that used to sit
	 * inline in the two wait rows are gone: they edited the same number the customise
	 * panel's own stepper edits, and two controls for one figure is worse than either
	 * alone. `ItineraryTimeline`'s `bind:itinerary` went with them.
	 *
	 * ## One trip on this screen, and `draft.itinerary` is it
	 *
	 * Issues #243 and #250 were the same defect found twice: an edit changed part of the
	 * panel and left the rest describing the trip from before it. #250 was the timeline
	 * keeping a waiting-time edit in its own private copy, so the stopover block eight lines
	 * above went on naming a bed the edited total no longer charged for. #243 was the stay
	 * picker writing `stay` and `totalPrice` and leaving the two in-city transfers, the free
	 * time window and the timetables alone, so a hotel 2.8 km from the terminal inherited a
	 * 36 km hostel's bus ride.
	 *
	 * The answer both landed on was one itinerary every surface reads. #278 moved half those
	 * surfaces out of this component, so that itinerary moved to `ItineraryDraft`, which the
	 * page owns and hands to this and to the customise rail. Nothing here keeps a copy.
	 *
	 * ## The selection is the page's, not this component's
	 *
	 * `ItineraryMap` and `ItineraryTimeline` each take a bindable `selectedSegmentId`, and
	 * one variable used to be bound to both here. It now lives on the page, because the rail
	 * shows one segment of one card and only the page knows which card that is. Both are
	 * bound through a function binding, so the selection is read from the prop and written
	 * through the callback and there is still exactly one of it.
	 */
	import type { Airport, Duration } from '$lib/domain';
	import type { ConnectionTransferOptions, ItineraryGroup, OuterTransferOptions, WithheldTransfers } from '$lib/search';
	import type { UnroutedLeg } from '$lib/components/itinerary-timeline-format';
	import type { ItinerarySegmentId } from '$lib/itinerary-map/segment-id';
	import { GroundLegPreviews, ItineraryTimeline, StopoverBlock } from '$lib/components';
	import { buildItineraryMapModel } from '$lib/itinerary-map/segments';
	import { buildGroundLegPreviews } from '$lib/itinerary-map/previews';
	import { distinctFlightCount, hasSwappableAlternatives } from '$lib/components/picker-alternatives';
	import type { ItineraryDraft } from '$lib/results/itinerary-draft.svelte';
	import { groupByProperty } from '$lib/stays';
	import type { Stay } from '$lib/domain';

	interface Props {
		/** The trip, shared with the card above and the customise rail beside it. */
		draft: ItineraryDraft;
		/** Which stretch of it is picked, owned by the page. */
		selectedSegmentId: ItinerarySegmentId | null;
		onSelectSegment: (segment: ItinerarySegmentId | null) => void;
		connectionAirport?: Airport;
		/** The alternatives pool, read here only to mark which rows have something to
		 * choose. The pickers themselves live in the rail. */
		group?: ItineraryGroup;
		stayCandidates?: Stay[];
		transferOptions?: ConnectionTransferOptions;
		outerTransferOptions?: OuterTransferOptions;
		minLayoverTime?: Duration;
	}

	let {
		draft,
		selectedSegmentId,
		onSelectSegment,
		connectionAirport,
		group,
		stayCandidates = [],
		transferOptions,
		outerTransferOptions
	}: Props = $props();

	const itinerary = $derived(draft.itinerary);

	/**
	 * Issue #280: one preview per ground leg this trip actually has, so the row is three
	 * thumbnails or two, and never an empty slot. Re-derives with `itinerary`, which is what
	 * keeps a swapped transfer's new geometry on screen: picking a different bus redraws its
	 * thumbnail, and a picked bed moves the stopover preview's endpoint.
	 */
	const groundLegPreviews = $derived(
		connectionAirport ? buildGroundLegPreviews(buildItineraryMapModel(itinerary, connectionAirport)) : []
	);

	const outboundAlternatives = $derived((group?.variants ?? []).map((variant) => variant.score.itinerary.outboundFlight));
	const onwardAlternatives = $derived((group?.variants ?? []).map((variant) => variant.score.itinerary.onwardFlight));
	const stayProperties = $derived(groupByProperty(stayCandidates));

	const originAirportTransferCount = $derived(outerTransferOptions?.transferToOriginAirport?.candidates.length ?? 0);
	const hotelTransferCount = $derived(transferOptions?.transferToHotel?.candidates.length ?? 0);
	const connectionAirportTransferCount = $derived(transferOptions?.transferToConnectionAirport?.candidates.length ?? 0);
	const destinationTransferCount = $derived(outerTransferOptions?.transferToDestinationLocation?.candidates.length ?? 0);

	// Issue #119: the same four legs again, keyed the way `unroutedLegNote` names them. A
	// leg whose only road answer was refused has no transfer and therefore no picker, so the
	// timeline row is the only place left that can say a route came back and was declined.
	//
	// Annotated rather than inferred, which is what caught the last key here being
	// `'to-destination'`: `UnroutedLeg` calls that leg `'to-destination-location'`, so the
	// destination-side refusal was written under a name the timeline never looks up and the
	// row it belongs to fell back to "no route came back". An inferred object literal reaches
	// a `Partial<Record<...>>` prop without complaint, so nothing said so.
	const withheldByLeg = $derived<Partial<Record<UnroutedLeg, WithheldTransfers>>>({
		'to-origin-airport': outerTransferOptions?.transferToOriginAirport?.withheld,
		'to-hotel': transferOptions?.transferToHotel?.withheld,
		'from-hotel': transferOptions?.transferToConnectionAirport?.withheld,
		'to-destination-location': outerTransferOptions?.transferToDestinationLocation?.withheld
	});

	// Issue #140: is there anything to try? The hint below claimed there was on every card,
	// including the ordinary free-tier result with one flight per leg, no transport options
	// and no stays. `picker-alternatives.ts` counts the rows the pickers would actually
	// draw, sharing `FlightPicker`'s own dedupe so the two cannot disagree.
	const canSwapSomething = $derived(
		hasSwappableAlternatives({
			outboundFlights: outboundAlternatives,
			onwardFlights: onwardAlternatives,
			transferCandidateCounts: [
				originAirportTransferCount,
				hotelTransferCount,
				connectionAirportTransferCount,
				destinationTransferCount
			],
			stayPropertyCount: stayProperties.length
		})
	);

	// A stopover that ends the same day has no night to book, so it has no bed to choose
	// between and its row promises nothing. An already-picked stay keeps its mark.
	const stayIsRelevant = $derived(itinerary.nightsInConnection > 0 || itinerary.stay !== undefined);

	// The "2 flights" / "3 options" marks: only rows whose panel offers more than one thing
	// to pick, gated on the same conditions the panel renders under, so a mark never
	// promises a choice the rail cannot open. A stay list counts from one property, the
	// same reasoning as `hasSwappableAlternatives`: with no bed on the itinerary, one
	// property is still the choice between pricing it in and leaving it out.
	const optionMarks = $derived.by(() => {
		const marks: Partial<Record<ItinerarySegmentId, string>> = {};
		const outbound = distinctFlightCount(outboundAlternatives);
		if (outbound > 1) marks['outbound-flight'] = `${outbound} flights`;
		const onward = distinctFlightCount(onwardAlternatives);
		if (onward > 1) marks['onward-flight'] = `${onward} flights`;
		const transferLegs = [
			['transfer-to-origin-airport', itinerary.transferToOriginAirport, originAirportTransferCount],
			['transfer-to-hotel', itinerary.transferToHotel, hotelTransferCount],
			['transfer-to-connection-airport', itinerary.transferToConnectionAirport, connectionAirportTransferCount],
			['transfer-to-destination-location', itinerary.transferToDestinationLocation, destinationTransferCount]
		] as const;
		for (const [segment, transfer, count] of transferLegs) {
			if (transfer && count > 1) marks[segment] = `${count} options`;
		}
		if (stayIsRelevant && stayProperties.length > 0) {
			const count = stayProperties.length;
			marks['free-time'] = `${count} ${count === 1 ? 'stay' : 'stays'}`;
		}
		return marks;
	});
</script>

<div class="result-detail">
	<!-- Issue #280. The always-on MapLibre map that used to sit here is now inside
	     `RouteMapDialog`, reached by tapping one of these. Three frozen SVG previews cost
	     nothing to render down a results list; the map that replaced them cost 12.6 seconds
	     to settle at four cards and stopped working entirely at five, which
	     `tools/probe-map-cost.mjs` measures on demand. A leg the itinerary does not have gets
	     no preview, so this row is three items or two, slightly wider.

	     Bound to the page's own selection like everything else on this screen, through a
	     function binding: tapping a preview is another way of picking a segment, and the
	     customise rail has to hear about it. -->
	<GroundLegPreviews
		{itinerary}
		previews={groundLegPreviews}
		bind:selectedSegmentId={() => selectedSegmentId, onSelectSegment}
	/>

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
			Pick a step to change it. Your choices preview this trip and do not change your
			saved results.
		{:else}
			Every leg came back with one option, so there is nothing to swap. The waiting times
			are still yours to adjust.
		{/if}
	</p>

	<!-- A plain prop since issue #313. The timeline used to edit one thing, the waiting-time
	     steppers inside its two wait rows, and `bind:` was what stopped that edit living in a
	     copy only the timeline could see (issue #250). The steppers are gone, the panel keeps
	     the one that remains, and this component now only reads the draft the card and the
	     rail read too. -->
	<ItineraryTimeline
		itinerary={draft.itinerary}
		{connectionAirport}
		bind:selectedSegmentId={() => selectedSegmentId, onSelectSegment}
		{optionMarks}
		withheld={withheldByLeg}
	/>
</div>

<style>
	.result-detail {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		/* Reads as the ticket above unfolding, the same dashed "tear line" the timeline's
		   own totals divider already uses. */
		padding-top: var(--space-4);
		border-top: 2px dashed var(--color-border-strong);
	}

	.result-detail-hint {
		margin: 0;
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}
</style>
