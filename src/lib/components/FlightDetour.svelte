<script lang="ts">
	/**
	 * How straight this trip is, permanently on the card (issue #280).
	 *
	 * The owner: "the flight preview should be permanently shown somethere in the card, but
	 * with the map way way smaller and frozen and no controls and no labels, it is just to
	 * see 'how straight' the itinerary is, so adding a subtile dashed arc of the straight
	 * line from origin to destination airport would be useful."
	 *
	 * The picture is two solid great-circle arcs, origin to connection to destination, over
	 * one thin dashed arc joining the two ends. The gap between them is the answer.
	 *
	 * ## The dashed arc is not a flight
	 *
	 * It is the shortest line that exists between those two airports. No carrier flies it,
	 * nothing quoted a fare for it, and this itinerary does not contain it. The dash is what
	 * says so, and `RoutePreview`'s own header records why the two strokes must never be
	 * tidied into one.
	 *
	 * ## Issue #305 took the caption off
	 *
	 * It read "1,718 km further than a direct flight", and the owner asked for it to go:
	 * "The flight map should not have the text". The picture answers "how far out of the way
	 * is this" by being a picture, which is the whole reason #280 asked for a drawing
	 * instead of a number, and the caption was a second answer costing a row on a card that
	 * has none to spare. The figure is still on the trip's own segments in the timeline.
	 *
	 * The same issue took the grey tray away. `--route-preview-bg` is the card's own
	 * surface here, so what is left is two arcs drawn on the ticket rather than a
	 * screenshot of a map pasted onto it: "i expect tat it shows the sea white (same as bg
	 * in parent element)". The endpoint dots keep a ring in that same colour, because a dot
	 * with no ring reads as a thickening of the line it sits on.
	 */
	import RoutePreview from './RoutePreview.svelte';
	import type { FlightShape } from '$lib/itinerary-map/previews';

	interface Props {
		shape: FlightShape;
	}

	let { shape }: Props = $props();
</script>

<div class="flight-shape">
	<RoutePreview lines={shape.lines} points={shape.points} baseline={shape.directLine} width={120} height={92} />
</div>

<style>
	/* Fixed and modest. A route's own proportions swing from nearly east-west to nearly
	   north-south depending on where it goes, and a box that resized to fit each one would
	   give every card in the list a different height, which is the one thing a comparison
	   surface cannot have. `RoutePreview` centres what it cannot fill. */
	.flight-shape {
		flex: none;
		width: 6.5rem;
		--route-preview-bg: transparent;
		--route-preview-ring: var(--color-surface);
	}
</style>
