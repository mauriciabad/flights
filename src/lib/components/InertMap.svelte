<script lang="ts">
	/**
	 * A real map that never moves, with the route drawn on top of it.
	 *
	 * The owner, on the three ground-leg previews: "they should use a normal map but inert.
	 * the current map has no ptecision and shows no roads". Inert is the whole design, and
	 * here it is literal: the map is a PNG. One hidden MapLibre instance draws this
	 * preview's window once and hands back a picture (`map-snapshot.svelte.ts`), and an
	 * `<img>` shows it. There is nothing to pan, nothing to zoom, no controls and no
	 * canvas. Tapping still opens the full MapLibre map in a dialog, which is where a map
	 * that moves belongs.
	 *
	 * A live instance per preview is what this replaces and it is not an option:
	 * `tools/probe-map-cost.mjs` measured sixteen of them reaching Chromium's WebGL context
	 * ceiling, at which point it evicts the oldest and a traveller scrolling back to card
	 * one finds blank rectangles.
	 *
	 * ## What is under the picture when there is no picture
	 *
	 * The drawing `RoutePreview` already knows how to make: the coast, the sea and the
	 * country seams from the region's own land tile, a median of 389 B
	 * (`land-tiles.svelte.ts`). No snapshot yet, no WebGL on this device, a style that
	 * would not load, or a capture that failed all leave the traveller exactly the picture
	 * these previews showed before this change, rather than a blank box.
	 *
	 * The first build of this passed `land={false}` unconditionally, on the reasoning that
	 * a preview with a basemap coming should not spend a fetch on a coastline it would
	 * never draw. That was true and it was the wrong trade. It made the ordinary case a
	 * few hundred bytes cheaper and the failure case worse than what it replaced, on a
	 * feature whose whole subject is a map that might not arrive. 389 B is a fair price
	 * for the failure case being a map of somewhere.
	 *
	 * It is gated on the snapshot being absent rather than drawn underneath and covered,
	 * and that is not an optimisation either. Both children are positioned, so they paint
	 * in source order and the `<svg>` is second, which is what puts the route over the
	 * basemap. Land left on would put a flat fill over the basemap too.
	 *
	 * The container paints nothing of its own, and that is load-bearing rather than tidy.
	 * It used to be `--color-map-land`, which made the whole box the exact colour
	 * `RoutePreview` fills land with, so the drawn coast was invisible against it and the
	 * degraded preview came out as one flat rectangle. The sea has to be the card, the way
	 * it was before this feature existed, or there is no coastline to see.
	 *
	 * ## Why the projection is computed twice
	 *
	 * This calls `projectToBox` for the frame and `RoutePreview` calls it again for the
	 * paths. Both are pure, both get the same arguments including `PREVIEW_PADDING`, and
	 * both therefore get the same rectangle of the world. Passing the frame down instead
	 * would put a second way of driving `RoutePreview` in the way of the one `FlightDetour`
	 * uses, for a function that costs a few dozen multiplies.
	 */
	import RoutePreview from './RoutePreview.svelte';
	import { projectToBox } from '$lib/itinerary-map/geo';
	import { mapSnapshot } from '$lib/itinerary-map/map-snapshot.svelte';
	import { PREVIEW_PADDING, type PreviewLine, type PreviewPoint } from '$lib/itinerary-map/previews';

	interface Props {
		lines: PreviewLine[];
		points: PreviewPoint[];
		/** viewBox units of the drawing on top, and the box the map is captured for. */
		width: number;
		height: number;
		class?: string;
	}

	let { lines, points, width, height, class: className }: Props = $props();

	const frame = $derived(
		projectToBox(
			lines.map((line) => line.coordinates),
			points.map((point) => point.coordinates),
			{ width, height, padding: PREVIEW_PADDING }
		).frame
	);

	// Undefined until the capture lands, which is the "stale first, then fresh" rule this
	// app is built on: the fill below is on screen from the first frame and the map
	// replaces it. Reading is all that happens here; the module's own header explains why
	// that distinction is worth this much care.
	const snapshot = $derived(mapSnapshot(frame, width, height));
</script>

<span class={['inert-map', className]}>
	{#if snapshot}
		<img class="inert-map-picture" src={snapshot} alt="" aria-hidden="true" draggable="false" />
	{/if}
	<RoutePreview {lines} {points} {width} {height} land={snapshot === undefined} />
</span>

<style>
	/* The route `<svg>` is in normal flow and the picture is absolutely positioned over it,
	   so this box is exactly the drawing's box with no aspect ratio repeated here to drift
	   from the one the SVG already carries.

	   No background, and that one is measured rather than reasoned. `RoutePreview` fills
	   land with `--color-map-land` and leaves the sea as whatever the parent paints, so
	   painting this box that same colour hides the coast completely. The first build did
	   paint it, and the capture with the basemap blocked came out as one flat rectangle. */
	.inert-map {
		position: relative;
		display: block;
		overflow: hidden;
		border-radius: var(--radius-md);
	}

	.inert-map-picture {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		/* app.css caps every image at `max-width: 100%`, which is right for a photo in a
		   column and wrong here: this one is sized by `inset` against a box whose own width
		   the cap resolves against, and the two disagree at every rendered size. */
		max-width: none;
	}

	/* The route has to be positioned too, or it disappears. A positioned element paints
	   above a static sibling whatever the source order says, so with the picture absolute
	   and the drawing static the map covered the route completely. Positioned with no
	   z-index, the two paint in source order and the route is second. */
	.inert-map :global(.route-preview) {
		position: relative;
	}
</style>
