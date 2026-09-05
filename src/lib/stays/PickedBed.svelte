<script lang="ts">
	/**
	 * The bed the traveller picked, shown as a thing with a picture rather than as a
	 * paragraph about a thing.
	 *
	 * Issue #279, the owner's own words: **"the picked hotel should also be shown in the
	 * card permanently, with more details and images (carrousel so i can see more images),
	 * and not inside the tooltip. and also with a better layout and design, not it is a
	 * blob of text."**
	 *
	 * The blob was four consecutive `<p>` elements in `StopoverBlock.svelte`: property,
	 * room kind and distance, nights and rate, then the ride. Four lines of the same size
	 * in the same colour, which is a paragraph with line breaks in it. This is the same
	 * four facts given a shape, plus the three the app already had and never showed: the
	 * photographs, the guest rating, and whether the property admits women only.
	 *
	 * ## Nothing here is computed here
	 *
	 * Every value arrives already derived, for the reason `StopoverBlock` gives at length:
	 * a fact with two derivations grows two answers. `bedNightlyRate` (issue #238) still
	 * owns the rate and who it covers, `stays/distance.ts` still owns the distance, and the
	 * ride's sentence is still the one `itinerary-timeline-format.ts` spells for the
	 * timeline. This file arranges them and draws pictures.
	 *
	 * ## What the photographs actually are, and what that forces
	 *
	 * Measured 2026-09-05 with `tools/probe-images.mjs`, which renders real `<img>` tags
	 * from an http origin in a browser, because an image tag is a no-cors request that
	 * ignores the `Access-Control-Allow-Origin` header `probe-cors.mjs` measures. All three
	 * adapters serve photographs that decode cross-origin: 200, `image/jpeg`, no
	 * `Cross-Origin-Resource-Policy`, no hotlink rule.
	 *
	 * Two facts from that run shape everything below.
	 *
	 * **There are two of them, not twenty.** Hostelworld returned 2 images for each of 3
	 * properties, Agoda 2 for each of 4, Booking exactly 1. So this is a photograph with a
	 * counter, not a gallery, and at one photograph the controls are gone rather than
	 * greyed: a dead arrow is a promise the data cannot keep.
	 *
	 * **They are enormous.** Hostelworld is the keyless default most visitors hit, and
	 * `a.hwstatic.com` serves the photographer's original: 4032x2268 at 2.79 MB, 3936x2624
	 * at 984 KB, 1930x1085 at 2.02 MB. It is not an image CDN and it has no resize. Passing
	 * imgix's `w`, `h`, `fit`, `auto` and `dpr` returned output byte-identical to a `?zzz=1`
	 * control, and there is no backend here to proxy through. So the second photograph is
	 * fetched when the reader asks for it and never before: loading a strip of two on render
	 * would cost 5 MB to show one picture.
	 *
	 * ## The photographs live next door now
	 *
	 * The strip, its arrows, its counter and its one-at-a-time fetching moved to
	 * `PhotoCarousel.svelte` for issue #307, unchanged, so the picker's open property and
	 * the stay map's sidebar can show the same thing rather than growing a second one. Both
	 * facts above still shape it and are argued there.
	 *
	 * ## A tooltip gets no photographs
	 *
	 * Issue #307, the owner: **"dont show the images inside the toooltip, it is too
	 * large."** Measured on this branch before the change, the trip strip's hover panel
	 * stood 542px tall on a 900px viewport and 189px of that was the media box. A tooltip is
	 * for a glance. So `photos` is false there, and everything else stays: the name, the
	 * score, the room kind, the women-only tag, the rate, the nights, the distance, the ride.
	 */
	import { ModeIcon } from '$lib/components';
	import type { Property, TransferMode } from '$lib/domain';
	import { formatPropertyRating } from '$lib/format';
	import PhotoCarousel from './PhotoCarousel.svelte';

	interface Props {
		/** Name, photographs, rating and the women-only restriction. The three after the
		 * name are read straight off the domain record and have never been on this card. */
		property: Property;
		/** `ROOM_KIND_LABELS[stay.roomKind]`, the same table the picker's tiles print. */
		roomKindLabel: string;
		/** How many nights this stopover books, for the figure beside the rate. */
		nights: number;
		/** `bedNightlyRate` through `formatMoney`, already split into the number and who it
		 * covers, so this block and the card's price breakdown cannot quote two different
		 * figures for one bed (issue #206). `audience` is absent when the party is one. */
		rate: { amount: string; audience?: string };
		/** `formatDistanceKm` of the straight line to the connection airport, or absent when
		 * the caller resolved no airport position. Straight-line on purpose: the ride below
		 * is the other half of the answer, and it is a route rather than a line. */
		distanceFromAirport?: string;
		/** The ride to the bed. `note` is always a full sentence, including when nothing
		 * routed at all, because issue #228 asked for a line that never vanishes. `mode` is
		 * absent in exactly that unrouted case, and the pictogram goes with it. */
		transfer: { note: string; mode?: TransferMode };
		/** Whether to draw the photographs at all. False in the trip strip's hover panel and
		 * nowhere else (issue #307): a media box is a third of that panel's height, and a
		 * tooltip is for a glance. Every other fact this block prints is unaffected. */
		photos?: boolean;
	}

	let {
		property,
		roomKindLabel,
		nights,
		rate,
		distanceFromAirport,
		transfer,
		photos = true
	}: Props = $props();

	const rating = $derived(property.rating ? formatPropertyRating(property.rating) : undefined);
</script>

<!--
	The frame exists only to be the query container. An element with `container-type`
	establishes a container for its DESCENDANTS and never for itself, so `.bed` carrying
	both the `container-type` and the `@container` rule meant the rule could never match:
	the block stayed in its one-column phone form at every width, and a desktop card drew a
	525px-tall photograph across 840px. Nothing in the markup looked wrong, which is why it
	took a screenshot to find.
-->
<div class="bed-frame">
	<div class={['bed', { 'has-photos': photos && property.images.length > 0 }]}>
		<!--
			No media element at all when the provider gave no photograph, and none in a
			tooltip. A grey box with a building glyph in it says "a picture is missing", and
			nothing is missing: this property came back without one.
		-->
		{#if photos}
			<PhotoCarousel images={property.images} name={property.name} />
		{/if}

		<div class="bed-facts">
			<p class="bed-name">
				{property.name}
				{#if rating}
					<!-- Issue #258 made the rating a value and its scale, and
					     `formatPropertyRating` is the only place it becomes a string. Absent
					     means no provider scored it, which is a different fact from a bad
					     score, so nothing is drawn. -->
					<span class="bed-rating font-mono tabular-nums">{rating}</span>
				{/if}
			</p>

			<p class="bed-tags">
				<span class="bed-tag">{roomKindLabel}</span>
				{#if property.womenOnly}
					<!-- The whole property admits women only, which `domain/stay.ts` is careful
					     to separate from one room being a female dorm. It has been on the record
					     since a women-only hostel was recommended to a party with no female
					     travellers, and this is the first surface to print it. -->
					<span class="bed-tag bed-tag-restricted">Women only</span>
				{/if}
			</p>

			<dl class="bed-rail">
				<div class="bed-figure">
					<dt class="bed-figure-label font-mono">Per night</dt>
					<dd class="bed-figure-value font-mono tabular-nums">
						{rate.amount}
						<!-- The space before this matters and is not formatting. The note is a block,
						     so it drops to its own line either way, but with the markup closed up
						     the two run together in `textContent` and a screen reader says
						     "twenty euros for three" as one word: "€20.00for 3". -->
						{#if rate.audience}<span class="bed-figure-note">{rate.audience}</span>{/if}
					</dd>
				</div>
				<div class="bed-figure">
					<dt class="bed-figure-label font-mono">Nights</dt>
					<dd class="bed-figure-value font-mono tabular-nums">{nights}</dd>
				</div>
				{#if distanceFromAirport}
					<div class="bed-figure">
						<dt class="bed-figure-label font-mono">From airport</dt>
						<dd class="bed-figure-value font-mono tabular-nums">{distanceFromAirport}</dd>
					</div>
				{/if}
			</dl>

			<p class="bed-transfer">
				{#if transfer.mode}
					<ModeIcon kind={transfer.mode} />
				{/if}
				<span>{transfer.note}</span>
			</p>
		</div>
	</div>
</div>

<style>
	/*
	   Two columns once there is room for two, one column when there is not, and the switch
	   is a container query rather than a media query because the card this sits in is a
	   different width in a results list, in a detail panel and in the desktop sidebar #278
	   is adding. A viewport width cannot tell those apart; the block's own width can.

	   The stacked form is the expensive one and it is the one a phone gets, so the height
	   it costs is argued in the PR rather than hidden here: roughly 190px of photograph on
	   a 375px screen. Side by side, the photograph costs nothing at all, because the facts
	   beside it are already taller than it is.
	*/
	.bed-frame {
		container-type: inline-size;
	}

	.bed {
		display: grid;
		gap: var(--space-3);
	}

	/* Two columns only when there is a photograph to put in the first one. Without one -
	   a provider that returned none, or the trip strip's hover panel, which asks for none
	   (issue #307) - a second track would reserve 13rem of blank and push every fact into
	   a column half the block's width. */
	@container (min-width: 26rem) {
		/* The photograph is 208px wide in this phase, where two 32px arrows and their insets
		   swallow 80px of it. Down to 24px, which is still over the 24px WCAG 2.5.8 minimum,
		   and tight to the edges. The phone keeps the larger target: there the photograph is
		   343px wide and the finger pressing it is not a mouse pointer. Both arrive as custom
		   properties, because a component's own class is out of this stylesheet's scope and
		   inheritance is the way in. */
		.bed.has-photos {
			--photo-arrow-size: 1.5rem;
			--photo-arrow-inset: var(--space-1);

			grid-template-columns: minmax(0, 13rem) minmax(0, 1fr);
			gap: var(--space-4);
			align-items: start;
		}
	}

	.bed-facts {
		display: grid;
		gap: var(--space-2);
		align-content: start;
	}

	.bed-name {
		margin: 0;
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		line-height: var(--line-height-sm);
		color: var(--color-text);
		/* Property names are a provider's free text and some of them are very long with no
		   spaces to break on. Same treatment `EmptyState` and `SegmentStub` give theirs. */
		overflow-wrap: anywhere;
	}

	/* Riding inside the name's own paragraph rather than in a row of its own, so a long
	   property name and its score reflow together instead of leaving a score stranded on a
	   line by itself. */
	.bed-rating {
		margin-left: var(--space-2);
		padding: 1px var(--space-2);
		border-radius: var(--radius-full);
		background: var(--color-stopover-bg);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		color: var(--color-stopover);
		white-space: nowrap;
	}

	.bed-tags {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
		margin: 0;
	}

	.bed-tag {
		padding: 1px var(--space-2);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-full);
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-muted);
	}

	/* Not a warning tone. A women-only property is a fact about the inventory, and colouring
	   it as a problem would editorialise a restriction that suits some travellers fine. */
	.bed-tag-restricted {
		border-color: var(--color-border-strong);
		color: var(--color-text);
	}

	/*
	   The boarding-pass field treatment `MetricRail` established: a small uppercase mono
	   caption over the figure, under a hairline, never boxed. Same vocabulary rather than
	   the same component, because `MetricRail` reads `itinerary-metrics.ts`, a fixed
	   registry of itinerary-level figures, and these three are facts about a property.
	   Bending that registry to hold them would put a bed's rate behind an itinerary's API.

	   A top rule rather than a left one for the reason that file records: the rail wraps,
	   and a left divider draws itself down the margin of whichever cell starts row two.
	*/
	.bed-rail {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(4.5rem, 1fr));
		gap: var(--space-3);
		margin: var(--space-1) 0 0;
	}

	.bed-figure {
		padding-top: var(--space-2);
		border-top: 1px solid var(--color-border);
	}

	/* Muted rather than faint, the measurement `MetricRail` records: the faint token comes
	   out at 4.19:1 on the dark palette's card surface, under WCAG AA, and this is a field
	   label rather than decoration. */
	.bed-figure-label {
		font-size: 0.625rem;
		font-weight: var(--font-weight-medium);
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.bed-figure-value {
		margin: 0;
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		line-height: 1.3;
		color: var(--color-text);
	}

	/* "each" or "for 3" sits under the number rather than beside it: who a rate covers is a
	   qualifier on the figure, and running it inline turns a two-character cell into a
	   nine-character one that wraps the rail at 375px. */
	.bed-figure-note {
		display: block;
		font-family: var(--font-sans);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-regular);
		color: var(--color-text-muted);
	}

	.bed-transfer {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		margin: var(--space-1) 0 0;
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-muted);
	}

	/* A flex item will not shrink below its longest word without this, and the sentence
	   beside the pictogram carries place names nobody here chose the length of. */
	.bed-transfer span {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	/* Colour swap rather than opacity, matching the rest of the card's deprioritised
	   treatment: every line here still has to be readable. */
	:global(.is-deprioritized) .bed-name,
	:global(.is-deprioritized) .bed-figure-value {
		color: var(--color-text-deprioritized);
	}
</style>
