<script lang="ts">
	/**
	 * The three ground legs, side by side, each opening the real map (issue #280).
	 *
	 * The owner: "for the other 3 parts of the route (origin transport, hotel transport and
	 * destination transport), we should display 3 smaller maps, side to side. they are not
	 * interactive and when one is clicked it opens a dialog with a large map ... if one is
	 * not existing, for example origin location was not set, the map for that part is not
	 * shown, so we would show only 2 maps in this case sigtly wider."
	 *
	 * That last rule is not implemented here. `buildGroundLegPreviews` returns only the
	 * legs an itinerary has, and each button is `flex: 1 1 0`, so two previews are each
	 * half the row and three are each a third with no count to branch on. This component
	 * never asks how many there are.
	 *
	 * Flex rather than grid, deliberately. `45151ce` fixed the trip strip rendering at
	 * zero width because definitely-placed grid items pushed auto-placed cells into
	 * implicit tracks. Equal columns need no placement algorithm to get right.
	 *
	 * The previews themselves are frozen SVG, not maps. `RoutePreview`'s own doc comment
	 * carries the measurement behind that; the short version is that four live MapLibre
	 * instances per card walks a five-card results page into Chromium's sixteen-context
	 * ceiling and blanks the first card.
	 */
	import RouteMapDialog from './RouteMapDialog.svelte';
	import RoutePreview from './RoutePreview.svelte';
	import type { Itinerary } from '$lib/domain';
	import type { ItinerarySegmentId } from '$lib/itinerary-map/segment-id';
	import type { GroundLegPreview } from '$lib/itinerary-map/previews';

	interface Props {
		itinerary: Itinerary;
		previews: GroundLegPreview[];
		/**
		 * The selection shared with `ItineraryTimeline` (`segment-id.ts` documents the
		 * contract). Tapping a preview writes its own leg here, which both frames the map
		 * the dialog opens and leaves the matching timeline row highlighted underneath.
		 */
		selectedSegmentId: ItinerarySegmentId | null;
	}

	let { itinerary, previews, selectedSegmentId = $bindable(null) }: Props = $props();

	// The dialog has no `open` prop: rendering it opens it and dropping it closes it, so
	// this one variable is the whole state and the MapLibre instance inside it lives
	// exactly as long as the dialog does.
	let openTitle = $state<string | undefined>();

	/**
	 * The heading is the short label, not the leg's full sentence. Joining two legs' own
	 * labels produced "Transfer to Vienna (straight-line estimate). Transfer to VIE
	 * (straight-line estimate)" across three lines of a phone's dialog header, which is a
	 * heading nobody reads and a caveat printed twice. The full sentence still reaches
	 * everyone: it is this button's accessible name, and `ItineraryMap`'s own status line
	 * prints it under the map the moment the dialog opens.
	 */
	function open(title: string, segmentId: ItinerarySegmentId | null): void {
		selectedSegmentId = segmentId;
		openTitle = title;
	}
</script>

{#if previews.length === 0}
	<!-- A trip with no origin location, no destination location and a connection city this
	     app has no coordinates for has no ground leg to draw, and would otherwise leave the
	     traveller with no way to a map at all. One button, no picture: there is nothing
	     honest to draw here, and drawing the flights instead would put a thumbnail under a
	     label that promises ground transport. -->
	<button type="button" class="ground-leg is-fallback" onclick={() => open('The whole route', null)}>
		Open the route map
	</button>
{:else}
	<ul class="ground-legs-row">
		{#each previews as preview (preview.id)}
			<li class="ground-legs-item">
				<button type="button" class="ground-leg" onclick={() => open(preview.label, preview.focusSegmentId)}>
					<span class="ground-leg-frame">
						<RoutePreview lines={preview.lines} points={preview.points} width={120} height={88} />
						<svg class="ground-leg-expand" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
							<path
								d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4"
								fill="none"
								stroke="currentColor"
								stroke-width="1.6"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
						</svg>
					</span>
					<span class="ground-leg-label">{preview.label}</span>
					<!-- The accessible name is the visible label plus this, never an aria-label
					     replacing it: WCAG's Label in Name wants the words on screen to be part of
					     what a voice-control user can say. `title` is the map's own sentence for
					     the leg, "(straight-line estimate)" included where that is true. -->
					<span class="visually-hidden">. {preview.title}. Opens the full map.</span>
				</button>
			</li>
		{/each}
	</ul>
{/if}

{#if openTitle !== undefined}
	<RouteMapDialog
		{itinerary}
		title={openTitle}
		bind:selectedSegmentId
		onclose={() => (openTitle = undefined)}
	/>
{/if}

<style>
	.ground-legs-row {
		display: flex;
		gap: var(--space-2);
		/* Capped, because these are thumbnails and a full-width desktop row turns each into
		   a 260px picture of one line. The owner asked for "3 smaller maps"; at 34rem they
		   are about 165px each, which is the size at which a leg's shape reads and stops
		   competing with the timeline under it. */
		max-width: 34rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* `1 1 0` and `min-width: 0`: every leg gets an equal share of the row whatever the
	   count, and a two-leg row is each half rather than each a third with a gap on the
	   end. */
	.ground-legs-item {
		flex: 1 1 0;
		min-width: 0;
	}

	.ground-leg {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		width: 100%;
		padding: var(--space-2);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-bg);
		color: var(--color-text-muted);
		font: inherit;
		text-align: left;
		cursor: pointer;
		transition:
			border-color 140ms ease-out,
			color 140ms ease-out;
	}

	.ground-leg-frame {
		position: relative;
		display: block;
	}

	/* Always drawn, not only on hover: on a phone there is no hover, and a picture with no
	   affordance is a picture nobody taps. Quiet until the leg is pointed at or focused.

	   Top right, and carrying the panel's own colour as a pad: a leg running south-east
	   ends its stroke in the bottom-right corner, and the glyph sat on top of the endpoint
	   dot there. Every corner can hold a line, so the glyph clears its own space instead of
	   hoping for an empty one. */
	.ground-leg-expand {
		position: absolute;
		top: 0;
		right: 0;
		box-sizing: content-box;
		width: 0.75rem;
		height: 0.75rem;
		padding: 0.1875rem;
		border-bottom-left-radius: var(--radius-md);
		background: var(--color-bg-inset);
		color: var(--color-text-faint);
		transition:
			color 140ms ease-out,
			opacity 140ms ease-out;
		opacity: 0.75;
	}

	.ground-leg.is-fallback {
		align-items: center;
		min-height: 2.75rem;
		font-size: var(--font-size-sm);
		text-align: center;
	}

	.ground-leg-label {
		font-size: var(--font-size-xs);
		line-height: 1.3;
		/* Two lines is the ceiling at 375px with three legs on screen. Wrapping beats
		   truncating: "To the destination" cut to "To the dest…" says less than nothing. */
		overflow-wrap: break-word;
	}

	.ground-leg:hover,
	.ground-leg:focus-visible {
		border-color: var(--color-accent);
		color: var(--color-text);
	}

	.ground-leg:hover .ground-leg-expand,
	.ground-leg:focus-visible .ground-leg-expand {
		color: var(--color-accent);
		opacity: 1;
	}

	.ground-leg:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	.ground-leg:active {
		/* The push this app gives every other pressable thing. */
		transform: translateY(1px);
	}

	@media (prefers-reduced-motion: reduce) {
		.ground-leg,
		.ground-leg-expand {
			transition: none;
		}

		.ground-leg:active {
			transform: none;
		}
	}
</style>
