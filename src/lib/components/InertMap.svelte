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
	 * ## The fallback is the background, and there is only one
	 *
	 * The container is painted `--color-map-land` and the picture sits on top. No snapshot
	 * yet, no WebGL on this device, or a capture that failed all leave exactly the solid
	 * fill these previews showed before, which is the same honest answer `land.ts` gives a
	 * window it cannot vouch for. Nothing here watches for an error, because there is
	 * nothing better to show if one happens.
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
	<RoutePreview {lines} {points} {width} {height} land={false} />
</span>

<style>
	/* The route `<svg>` is in normal flow and the picture is absolutely positioned over it,
	   so this box is exactly the drawing's box with no aspect ratio repeated here to drift
	   from the one the SVG already carries. */
	.inert-map {
		position: relative;
		display: block;
		overflow: hidden;
		border-radius: var(--radius-md);
		/* The fallback, and the only one. See the header. */
		background: var(--color-map-land);
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
