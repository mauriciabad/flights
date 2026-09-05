<script lang="ts">
	/**
	 * One frozen picture of a stretch of route (issue #280). No tiles, no basemap, no
	 * controls, no labels, no WebGL. An `<svg>` and nothing else.
	 *
	 * ## Why this is not a map, and what #346 put back
	 *
	 * The owner asked for the flight preview "way way smaller and frozen and no controls
	 * and no labels ... just to see how straight the itinerary is". Everything a basemap
	 * contributes is exactly what that description removes: tiles, labels, controls, a
	 * second palette.
	 *
	 * Land is not one of those things, and #280 was wrong to argue it was. It reasoned that
	 * "coastline under that competes with the only thing it exists to show", and the owner
	 * disagreed twice, in #305 and again in #346: "in the flight map, the re's no map, it
	 * just shwos the lines". He is right. An arc between two dots cannot say whether a
	 * stopover is a detour north or a straight run down a coast, and that comparison is the
	 * entire job of this drawing.
	 *
	 * So there is exactly one thing under the geometry: `land.ts` fills the land grey and
	 * leaves the sea as whatever the parent element's background is. No stroke on the
	 * coast, no second colour, nothing that could be read as a route. What competes with an
	 * arc is a line, and this draws none.
	 *
	 * It is also the only shape of picture that works. `tools/probe-map-cost.mjs` renders both
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
	import { landPath } from '$lib/itinerary-map/land';
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
	// The projected endpoint dots go in, so `land.ts` can refuse to draw a coast that would
	// leave one of them offshore. They are the only places on this drawing whose being
	// ashore is a fact rather than a guess.
	const land = $derived(landPath(shape.frame, width, height, shape.points));
</script>

<svg
	class={['route-preview', className]}
	viewBox="0 0 {width} {height}"
	style:aspect-ratio="{width} / {height}"
	preserveAspectRatio="xMidYMid meet"
	aria-hidden="true"
	focusable="false"
>
	{#if land}
		<path class="rp-land" d={land} fill-rule="evenodd" />
	{/if}
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
	/* The sea, and it is deliberately nothing: whatever the parent element paints shows
	   through. The owner, twice, in #305 and #346: "i expect tat it shows the sea white
	   (same as bg in parent element) and land a but gray (current gray is fine)".

	   That is why there is no `--route-preview-bg` any more. It existed so `FlightDetour`
	   could opt out of a grey tray that `GroundLegPreviews` wanted; now neither has a tray,
	   because the grey is the land and the land is drawn, not assumed. */
	.route-preview {
		display: block;
		width: 100%;
		height: auto;
		border-radius: var(--radius-md);
		background: transparent;
	}

	/* "current gray is fine" — the same `--color-bg-inset` the previews used as a
	   background before this was geography rather than decoration.

	   Filled and never stroked. #280's objection to a basemap here was that "coastline
	   under that competes with the only thing it exists to show", and it is a real risk
	   that a stroked coast would run straight into: a thin line next to the trip's own
	   thin lines is a second route the eye has to rule out. A flat fill has no line in it
	   at all, so the only strokes on this drawing remain the ones that mean something. */
	.rp-land {
		fill: var(--color-bg-inset);
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
		/* The land's own colour, so a dot sitting on the line it terminates still reads as
		   an endpoint rather than a thickening. Land rather than sea because every dot on
		   these drawings is an airport, a hotel or a city centre, and those are ashore.
		   Never `transparent`: the ring's whole job is to cut the line. */
		stroke: var(--color-bg-inset);
		stroke-width: 1.5;
		vector-effect: non-scaling-stroke;
	}

	.rp-dot.is-stopover {
		fill: var(--color-stopover);
	}
</style>
