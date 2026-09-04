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
	 */
	import type { Itinerary } from '../domain';
	import type { ItinerarySegmentId } from '../itinerary-map/segment-id';
	import ItineraryTimeline from './ItineraryTimeline.svelte';

	interface Props {
		itinerary: Itinerary;
	}

	let { itinerary }: Props = $props();

	let selectedSegmentId = $state<ItinerarySegmentId | null>(null);

	export function currentSelection() {
		return selectedSegmentId;
	}

	export function externalSelect(segment: ItinerarySegmentId | null) {
		selectedSegmentId = segment;
	}
</script>

<ItineraryTimeline {itinerary} bind:selectedSegmentId />
