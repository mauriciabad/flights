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
	 * one thin dashed arc joining the two ends. The gap between them is the answer, and the
	 * caption states it in kilometres so the picture is not the only place the fact lives.
	 *
	 * ## The dashed arc is not a flight
	 *
	 * It is the shortest line that exists between those two airports. No carrier flies it,
	 * nothing quoted a fare for it, and this itinerary does not contain it. The one job the
	 * caption has beyond printing a number is saying so: "290 km further than a direct
	 * flight" names the dashed line as the direct flight the traveller is not taking. This
	 * codebase already labels a straight-line transfer estimate honestly for the same
	 * reason, and issue #280 lists that label among the things that work.
	 *
	 * ## Comparable across cards
	 *
	 * Two cards for one search share an origin and a destination, so they share a direct
	 * distance, so "290 km further" and "1,100 km further" are directly comparable down the
	 * list. That is why the caption prints the extra rather than the total flown: the total
	 * would be a bigger number carrying less.
	 */
	import RoutePreview from './RoutePreview.svelte';
	import { formatKilometres } from './itinerary-timeline-format';
	import type { FlightShape } from '$lib/itinerary-map/previews';

	interface Props {
		shape: FlightShape;
	}

	let { shape }: Props = $props();

	/**
	 * Under a kilometre of detour is a connection sitting on the direct line, and
	 * "0 km further than a direct flight" reads as a bug rather than as the good news it
	 * is. The threshold is a kilometre and not a percentage: a kilometre is below what
	 * either distance is accurate to anyway, since both are great-circle figures between
	 * runway coordinates rather than filed flight plans.
	 */
	const isEssentiallyDirect = $derived(shape.extraKm < 1);
</script>

<div class="flight-shape">
	<div class="flight-shape-picture">
		<RoutePreview lines={shape.lines} points={shape.points} baseline={shape.directLine} width={120} height={92} />
	</div>
	<p class="flight-shape-caption">
		<span class="flight-shape-key" aria-hidden="true"></span>
		{#if isEssentiallyDirect}
			<span class="flight-shape-figure">As straight</span> as a direct flight
		{:else}
			<span class="flight-shape-figure">{formatKilometres(shape.extraKm)} further</span> than a
			direct flight
		{/if}
	</p>
</div>

<style>
	.flight-shape {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}

	/* Fixed and modest. A route's own proportions swing from nearly east-west to nearly
	   north-south depending on where it goes, and a box that resized to fit each one would
	   give every card in the list a different height, which is the one thing a comparison
	   surface cannot have. `RoutePreview` centres what it cannot fill. */
	.flight-shape-picture {
		flex: none;
		width: 6.5rem;
	}

	.flight-shape-caption {
		margin: 0;
		color: var(--color-text-muted);
		font-size: var(--font-size-xs);
		line-height: 1.4;
		text-wrap: balance;
	}

	/* The same dash the picture draws, so the caption identifies which line it is talking
	   about without a legend row of its own. */
	.flight-shape-key {
		display: inline-block;
		width: 1.25rem;
		height: 0;
		margin-right: var(--space-1);
		border-top: 1px dashed var(--color-text-faint);
		vertical-align: middle;
	}

	.flight-shape-figure {
		color: var(--color-text);
		font-weight: var(--font-weight-semibold);
	}
</style>
