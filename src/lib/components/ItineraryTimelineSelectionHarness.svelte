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
	 * There is no `bind:itinerary` any more. It existed because the waiting-time steppers
	 * inline in the wait rows edited the caller's trip (issue #250); issue #313 removed
	 * those, the customise panel keeps the one stepper that remains, and this timeline only
	 * reads. `WaitingTimeStepper.test.ts` owns the control's own behaviour now, and
	 * `algorithm/build.test.ts` owns what a caller does with the value it emits.
	 */
	import type { Itinerary } from '../domain';
	import type { ItinerarySegmentId } from '../itinerary-map/segment-id';
	import ItineraryTimeline from './ItineraryTimeline.svelte';

	interface Props {
		itinerary: Itinerary;
		withExpansion?: boolean;
	}

	let { itinerary, withExpansion = false }: Props = $props();

	let selectedSegmentId = $state<ItinerarySegmentId | null>(null);

	export function currentSelection() {
		return selectedSegmentId;
	}

	export function externalSelect(segment: ItinerarySegmentId | null) {
		selectedSegmentId = segment;
	}
</script>

{#snippet probe(segment: ItinerarySegmentId)}
	<button type="button" class="probe">probe {segment}</button>
{/snippet}

<ItineraryTimeline
	{itinerary}
	bind:selectedSegmentId
	expansion={withExpansion ? probe : undefined}
	optionMarks={withExpansion ? { 'outbound-flight': '2 flights' } : undefined}
/>
