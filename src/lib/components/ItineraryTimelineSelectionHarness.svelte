<script lang="ts">
	/**
	 * Test-only wrapper for issue #73's `selectedSegmentId` binding. Svelte's own docs
	 * (Testing > Component testing) call this out directly: exercising a two-way `bind:`
	 * from a `.ts` test file needs a real compiled `bind:` directive somewhere, which only
	 * a `.svelte` file can provide. `externalSelect` stands in for the other side of the
	 * binding this issue wires up (`ItineraryMap`, issue #26): calling it is exactly what
	 * that component does when a marker or line is clicked, so a test calling it is
	 * checking the same "external write highlights the right row" path `ItineraryMap`
	 * will exercise for real once issue #26 merges.
	 *
	 * `withExpansion` covers the second thing a `.ts` file cannot author: a snippet. It
	 * hands the timeline a probe snippet and one option mark, so a test can check where
	 * the expansion lands and that a click inside it leaves the selection alone.
	 *
	 * `bind:itinerary` is the third (issue #250). The waiting-time stepper edits the trip
	 * the caller holds, which is what stops `ResultDetail`'s stopover block from going on
	 * describing the trip from before the edit, and `currentItinerary` is how a `.ts` test
	 * reads what the caller ended up with.
	 *
	 * The totals rail below the timeline is this harness's, not the timeline's. Issue #309
	 * removed the one the timeline used to render, because the results card prints the same
	 * four figures a few centimetres above it. What the rail is here for is unchanged and is
	 * the whole point of `bind:itinerary`: it reads the itinerary the CALLER holds, so a
	 * figure that moves here proves the edit left the timeline, which is exactly what the
	 * card's own rail does on the real screen.
	 */
	import type { Itinerary } from '../domain';
	import type { ItinerarySegmentId } from '../itinerary-map/segment-id';
	import { ALL_METRIC_IDS } from './itinerary-metrics';
	import ItineraryTimeline from './ItineraryTimeline.svelte';
	import MetricRail from './MetricRail.svelte';

	interface Props {
		itinerary: Itinerary;
		withExpansion?: boolean;
	}

	let { itinerary: initialItinerary, withExpansion = false }: Props = $props();

	// svelte-ignore state_referenced_locally
	let itinerary = $state(initialItinerary);
	let selectedSegmentId = $state<ItinerarySegmentId | null>(null);

	export function currentSelection() {
		return selectedSegmentId;
	}

	export function currentItinerary() {
		return itinerary;
	}

	export function externalSelect(segment: ItinerarySegmentId | null) {
		selectedSegmentId = segment;
	}
</script>

{#snippet probe(segment: ItinerarySegmentId)}
	<button type="button" class="probe">probe {segment}</button>
{/snippet}

<ItineraryTimeline
	bind:itinerary
	bind:selectedSegmentId
	expansion={withExpansion ? probe : undefined}
	optionMarks={withExpansion ? { 'outbound-flight': '2 flights' } : undefined}
/>

<MetricRail {itinerary} ids={ALL_METRIC_IDS} class="harness-totals" />
