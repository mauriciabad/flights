<script lang="ts">
	/**
	 * The one real map of a single itinerary (issue #280). Near-fullscreen, opened by tapping
	 * a frozen preview, framed on the leg that was tapped, and pannable from there to the
	 * rest of the trip.
	 *
	 * The owner: "when one is clicked it opens a dialog with a large map (the dialog is
	 * almost fullscreen, it just has a fixed margin arround based on screen size). the
	 * dialog has the full map, like now but zoomed and placed on the respective area, so if
	 * the user wants, can move and see the other parts of the itinerary."
	 *
	 * The surface itself is `MapDialog` (issue #324 extracted it, after this file's shell had
	 * been copied verbatim into a second dialog and was about to be copied into a third).
	 * Everything about the near-fullscreen shape, the focus restore, the body scroll lock and
	 * the "existing is being open" lifecycle now lives there, with the argument for each.
	 * This file is the map and the heading, which is all it was ever about.
	 */
	import MapDialog from './MapDialog.svelte';
	import { ItineraryMap } from '$lib/components';
	import type { Itinerary } from '$lib/domain';
	import type { ItinerarySegmentId } from '$lib/itinerary-map/segment-id';

	interface Props {
		itinerary: Itinerary;
		/**
		 * The selection this map shares with `ItineraryTimeline`, one `ItinerarySegmentId`
		 * meaning the same thing on both sides (`segment-id.ts` documents that contract in
		 * full). Bound rather than copied so a marker click inside the dialog leaves the
		 * right timeline row highlighted once the dialog is gone. The button that opened the
		 * dialog has already written its own leg into it, which is what frames the map on
		 * the leg that was tapped.
		 */
		selectedSegmentId: ItinerarySegmentId | null;
		/** Fired for every way out: Escape, the close button, the backdrop. The parent stops
		 *  rendering this component in response, which is what closes it. */
		onclose: () => void;
	}

	let { itinerary, selectedSegmentId = $bindable(null), onclose }: Props = $props();

	/**
	 * The journey, not the leg that opened this (issue #286).
	 *
	 * It was the leg's name until the map inside gained a way to move between them, at which
	 * point a heading fixed at whichever thumbnail was tapped described the wrong thing the
	 * moment a traveller used that. It is also the dialog's accessible name, which a screen
	 * reader announces once on open and never again, so a value that changes underneath it
	 * would be announced wrong or not at all. Which leg is on screen is `ItineraryMap`'s own
	 * status line, live, directly under the map.
	 */
	const heading = $derived(
		`Route map: ${itinerary.originAirport.city.name} to ${itinerary.destinationAirport.city.name}`
	);
</script>

<MapDialog title={heading} {onclose} class="route-dialog">
	{#snippet map()}
		<div class="route-dialog-map">
			<ItineraryMap {itinerary} bind:selectedSegmentId class="route-dialog-map-inner" />
		</div>
	{/snippet}
</MapDialog>

<style>
	.route-dialog-map {
		height: 100%;
	}

	/* `ItineraryMap` sizes its canvas from a token whose default is card-shaped. Here the
	   map is the whole point of the surface, so it takes the height the dialog has left.
	   `:global` on the inner half because a `class` passed to a child component is a plain
	   string and never picks up this component's scoping hash. */
	.route-dialog-map :global(.route-dialog-map-inner) {
		--itinerary-map-canvas-height: 100%;

		height: 100%;
	}
</style>
