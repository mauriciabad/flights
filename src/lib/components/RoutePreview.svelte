<script lang="ts">
	/**
	 * One frozen picture of a stretch of route (issue #280). No tiles, no basemap, no
	 * controls, no labels, no WebGL. An `<svg>` and nothing else.
	 *
	 * ## Why this is not a map
	 *
	 * The owner asked for the flight preview "way way smaller and frozen and no controls
	 * and no labels ... just to see how straight the itinerary is". Everything a basemap
	 * contributes is exactly what that description removes. At the size these render, with
	 * labels off, a 4 km airport-to-hotel hop's basemap is a grey rectangle, and under the
	 * flight ornament it is coastline competing with the one comparison the picture exists
	 * to make. Drawing the geometry alone is the better artifact, not the cheaper one.
	 *
	 * It is also the only one that works. `tools/probe-map-cost.mjs` renders both
	 * approaches on a throttled 375px phone: four MapLibre instances per card settle in
	 * 4.5s, sixteen (four cards) take 12.6s with 10.3s of main-thread blocking, and twenty
	 * never settle at all because Chromium holds sixteen live WebGL contexts and evicts the
	 * oldest past that, in its own words "Too many active WebGL contexts. Oldest context
	 * will be lost." A traveller scrolling back to compare card one would find blank
	 * rectangles. These SVGs are ready in about 100ms at any card count.
	 *
	 * MapLibre still draws the real map, once, inside `RouteMapDialog`.
	 *
	 * ## Decorative, deliberately
	 *
	 * `aria-hidden` here is not a shrug. The W3C test for a decorative image is to hide it
	 * and ask whether anything was lost, and every caller of this component prints the
	 * fact its picture carries as text beside it: `FlightShape` captions the detour in
	 * kilometres, `GroundLegPreviews` gives each button the leg's own name including its
	 * "(straight-line estimate)" caveat. Hide the drawing and a screen reader user still
	 * has everything. That is what makes it decoration rather than an unlabelled image.
	 *
	 * ## The `baseline`
	 *
	 * Drawn thin, muted and dashed, under everything else, and it is never a leg of the
	 * trip. Only `FlightShape` passes one: the shortest line that exists between the two
	 * end airports. `role` on a `<path>` would be meaningless, so the separation is
	 * carried by the prop, by the stroke, and by the caller's caption. Do not "tidy" the
	 * two strokes into one style. This app spent a night removing lines that implied
	 * routes they did not have, and the dash is the whole difference between "your flight"
	 * and "the line your flight could not beat".
	 */
	import type { Coordinates } from '$lib/domain';
	import { projectToBox } from '$lib/itinerary-map/geo';
	import type { PreviewLine, PreviewPoint } from '$lib/itinerary-map/previews';

	interface Props {
		lines: PreviewLine[];
		points: PreviewPoint[];
		/** The shortest-possible-line reference, when there is one. Not part of the route. */
		baseline?: Coordinates[];
		/** viewBox units, and the CSS aspect ratio the element takes, so the drawing never
		 *  letterboxes inside a box of a different shape. */
		width: number;
		height: number;
		class?: string;
	}

	let { lines, points, baseline, width, height, class: className }: Props = $props();

	// The baseline is fitted alongside the route rather than after it: left out of the
	// box, a longer direct line than the arcs around it would be cropped, and a cropped
	// baseline understates exactly the gap the picture is drawn to show.
	const shape = $derived(
		projectToBox(
			baseline ? [...lines.map((line) => line.coordinates), baseline] : lines.map((line) => line.coordinates),
			points.map((point) => point.coordinates),
			// Room for a 3px dot and its ring at every size this renders at.
			{ width, height, padding: 5 }
		)
	);
	const legPaths = $derived(shape.paths.slice(0, lines.length));
	const baselinePath = $derived(baseline ? shape.paths[lines.length] : undefined);
</script>

<svg
	class={['route-preview', className]}
	viewBox="0 0 {width} {height}"
	style:aspect-ratio="{width} / {height}"
	preserveAspectRatio="xMidYMid meet"
	aria-hidden="true"
	focusable="false"
>
	{#if baselinePath}
		<path class="rp-baseline" d={baselinePath} />
	{/if}
	{#each legPaths as path, index (index)}
		<path
			class="rp-leg"
			class:is-estimate={lines[index].geometryKind === 'schematic'}
			class:is-stopover={lines[index].tone === 'stopover'}
			d={path}
		/>
	{/each}
	{#each shape.points as point, index (index)}
		<circle
			class="rp-dot"
			class:is-stopover={points[index].tone === 'stopover'}
			cx={point.x}
			cy={point.y}
			r="3"
		/>
	{/each}
</svg>

<style>
	/* Issue #305: the drawing's ground and the ring around each endpoint dot are two
	   custom properties rather than fixed tokens, because a caller decides whether this is
	   a thumbnail sitting in its own tray (`GroundLegPreviews`, which keeps the default
	   inset) or an ornament drawn straight onto the card (`FlightDetour`, which sets both
	   to the card's own surface). The owner on the second case: "i expect tat it shows the
	   sea white (same as bg in parent element)". */
	.route-preview {
		display: block;
		width: 100%;
		height: auto;
		border-radius: var(--radius-md);
		background: var(--route-preview-bg, var(--color-bg-inset));
	}

	/* Stroke widths in screen pixels, not viewBox units: the same route drawn 100px wide
	   in a thumbnail and 320px wide on the card should read at the same line weight, and
	   without this a shared stylesheet would have to know each caller's scale. */
	.rp-leg,
	.rp-baseline {
		fill: none;
		vector-effect: non-scaling-stroke;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.rp-leg {
		stroke: var(--color-accent);
		stroke-width: 2;
	}

	.rp-leg.is-stopover {
		stroke: var(--color-stopover);
	}

	/* The full map's own convention for a leg nobody routed (`segments.ts`,
	   `ItineraryLineGeometryKind`), carried down unchanged so the small picture and the
	   big one do not disagree about which lines are guesses. */
	.rp-leg.is-estimate {
		stroke-dasharray: 5 4;
		opacity: 0.75;
	}

	/* Thinner, quieter and dashed differently from an estimated leg: a long fine dash
	   reads as a measuring line, a short one as a missing road. */
	.rp-baseline {
		stroke: var(--color-text-faint);
		stroke-width: 1;
		stroke-dasharray: 2 4;
	}

	.rp-dot {
		fill: var(--color-accent);
		/* The ground's own colour, so a dot sitting on the line it terminates still reads as
		   an endpoint rather than a thickening. Never `transparent`, whatever the caller
		   made the background: the ring's whole job is to cut the line. */
		stroke: var(--route-preview-ring, var(--color-bg-inset));
		stroke-width: 1.5;
		vector-effect: non-scaling-stroke;
	}

	.rp-dot.is-stopover {
		fill: var(--color-stopover);
	}
</style>
