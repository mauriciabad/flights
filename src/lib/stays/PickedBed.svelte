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
	 * fetched when the reader asks for it and never before, which is why `reached` exists
	 * below. Loading a strip of two on render would cost 5 MB to show one picture.
	 */
	import { tick } from 'svelte';
	import { ModeIcon } from '$lib/components';
	import type { Property, TransferMode } from '$lib/domain';
	import { formatPropertyRating } from '$lib/format';
	import { originalStayPhoto } from '$lib/providers/stays/original-photo';

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
	}

	let { property, roomKindLabel, nights, rate, distanceFromAirport, transfer }: Props = $props();

	/**
	 * The second address to try for a photograph, once the first one failed.
	 *
	 * `booking-mapper.ts` upgrades Booking's 60x60 thumbnail to a card-sized address, and
	 * that swap is measured against three photo ids rather than every photo id. A shape it
	 * guessed wrong about 404s, and this is where it degrades: back to the URL the provider
	 * actually gave, so the worst case is the thumbnail that shipped before the upgrade
	 * existed rather than an empty box. `broken` is a photograph that failed with nothing
	 * left to try.
	 *
	 * Booking was the only provider rewriting a URL when this was written. Issue #281 made
	 * Agoda a second, so the reverse lookup is now `original-photo.ts`'s table and this asks
	 * it rather than naming a provider.
	 */
	let fallbacks = $state<Record<number, string>>({});
	let broken = $state<Record<number, true>>({});
	const photos = $derived(
		property.images.map((original, i) => ({
			original,
			src: fallbacks[i] ?? original,
			broken: broken[i] === true
		}))
	);

	/** Which photograph is under the reader's eye, tracked from the scroll position so a
	 * swipe and a button press cannot disagree about the counter. Reset by the caller
	 * keying this component on the property: a different bed is a different strip. */
	let index = $state(0);
	/** The furthest photograph the reader has actually asked for. Nothing past this has a
	 * `src`, so nothing past this has been fetched. See the header comment on why a strip
	 * of two would otherwise cost 5 MB. */
	let reached = $state(0);
	let strip = $state<HTMLDivElement>();
	/** Held so `show` can move focus off an arrow it is about to disable. */
	let prevButton = $state<HTMLButtonElement>();
	let nextButton = $state<HTMLButtonElement>();

	const rating = $derived(property.rating ? formatPropertyRating(property.rating) : undefined);
	/** Below two there is nothing to page through, so the arrows and the counter are not
	 * rendered at all rather than rendered inert. */
	const pageable = $derived(photos.length > 1);

	async function show(next: number) {
		const wasFocused = document.activeElement;
		const target = Math.max(0, Math.min(photos.length - 1, next));
		index = target;
		if (target > reached) reached = target;
		// No `behavior` argument on purpose: the strip sets `scroll-behavior: smooth` in
		// CSS, and app.css's reduced-motion block already forces that back to `auto`
		// globally. Passing 'smooth' here would step over the reader's stated preference.
		if (strip && strip.clientWidth > 0) {
			travellingTo = target;
			strip.scrollTo({ left: target * strip.clientWidth });
		}

		// Paging to an end disables the arrow that got you there, and a browser blurs a
		// button the moment it becomes disabled. A keyboard reader who pressed Next twice
		// would land on the last photograph with focus dumped back on the document body,
		// having lost the carousel entirely. Hand focus to the arrow that still works.
		//
		// Read before `tick()` because after it the browser has already blurred the button
		// and `document.activeElement` no longer remembers who was there.
		await tick();
		if (wasFocused === nextButton && nextButton?.disabled) prevButton?.focus();
		else if (wasFocused === prevButton && prevButton?.disabled) nextButton?.focus();
	}

	/**
	 * Where `show` last sent the strip, while it is still on its way there.
	 *
	 * Two things set `index`: a button, which knows the answer immediately, and the strip's
	 * own scroll position, which is how a swipe is read. During a smooth programmatic
	 * scroll they disagree, and the disagreement is visible. Paging from photo 2 back to
	 * photo 1 sets `index` to 0 at once, then the animation starts from 343px and the first
	 * scroll events round back to 1. The counter flicks 1 to 2 to 1, and both arrows flick
	 * disabled with it, which is enough to make a keyboard press land on a control that was
	 * briefly dead.
	 *
	 * So while a programmatic scroll is in flight, the strip's position describes where it
	 * has got to rather than where the reader wants to be, and it is ignored until it
	 * arrives. A swipe sets nothing here and is honoured the moment it moves.
	 */
	let travellingTo: number | undefined;

	function onStripScroll() {
		if (!strip || strip.clientWidth === 0) return;
		if (travellingTo !== undefined) {
			if (Math.abs(strip.scrollLeft - travellingTo * strip.clientWidth) > 1) return;
			travellingTo = undefined;
		}
		const next = Math.round(strip.scrollLeft / strip.clientWidth);
		if (next === index) return;
		index = next;
		if (next > reached) reached = next;
	}

	function onStripKeydown(event: KeyboardEvent) {
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
		event.preventDefault();
		show(index + (event.key === 'ArrowRight' ? 1 : -1));
	}

	function onPhotoError(i: number) {
		const fallback = fallbacks[i] === undefined ? originalStayPhoto(photos[i].original) : undefined;
		if (fallback) {
			fallbacks[i] = fallback;
			return;
		}
		broken[i] = true;
	}
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
	<div class="bed">
		<!--
			No media element at all when the provider gave no photograph. A grey box with a
			building glyph in it says "a picture is missing", and nothing is missing: this
			property came back without one. The block simply has one less part.
		-->
		{#if photos.length > 0}
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<div
				class="bed-media"
				role="group"
				aria-label={`Photos of ${property.name}`}
				onkeydown={onStripKeydown}
			>
				<div class="bed-strip" bind:this={strip} onscroll={onStripScroll}>
					{#each photos as photo, i (photo.original)}
						<div class="bed-slide">
							{#if i <= reached && !photo.broken}
								<img
									src={photo.src}
									alt={pageable
										? `${property.name}, photo ${i + 1} of ${photos.length}`
										: property.name}
									loading="lazy"
									decoding="async"
									onerror={() => onPhotoError(i)}
								/>
							{/if}
						</div>
					{/each}
				</div>

				{#if pageable}
					<!-- Real buttons, outside the scroller, so they are ordinary tab stops that
					     tab out of again. Nothing inside the strip is focusable, which is what
					     keeps the usual carousel focus trap unreachable here: there is no
					     off-screen control to fall into. -->
					<button
						type="button"
						class="bed-arrow bed-arrow-prev"
						bind:this={prevButton}
						disabled={index === 0}
						aria-label="Previous photo"
						onclick={() => show(index - 1)}
					>
						<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
							<path
								d="M10 3 5 8l5 5"
								stroke="currentColor"
								stroke-width="1.6"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
						</svg>
					</button>
					<button
						type="button"
						class="bed-arrow bed-arrow-next"
						bind:this={nextButton}
						disabled={index === photos.length - 1}
						aria-label="Next photo"
						onclick={() => show(index + 1)}
					>
						<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
							<path
								d="m6 3 5 5-5 5"
								stroke="currentColor"
								stroke-width="1.6"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
						</svg>
					</button>
					<!-- The count is the whole reason a reader knows there is a second picture,
					     since two photographs do not earn a dot row. `aria-live` because the
					     number changes on a swipe, which fires no event a screen reader would
					     otherwise report. -->
					<p class="bed-count font-mono tabular-nums" aria-live="polite">
						{index + 1} / {photos.length}
					</p>
				{/if}
			</div>
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

	@container (min-width: 26rem) {
		.bed {
			grid-template-columns: minmax(0, 13rem) minmax(0, 1fr);
			gap: var(--space-4);
			align-items: start;
		}

		/* The photograph is 208px wide in this phase, where two 32px arrows and their insets
		   swallow 80px of it. Down to 24px, which is still over the 24px WCAG 2.5.8 minimum,
		   and tight to the edges. The phone keeps the larger target: there the photograph is
		   343px wide and the finger pressing it is not a mouse pointer. */
		.bed-arrow {
			width: 1.5rem;
			height: 1.5rem;
		}

		.bed-arrow svg {
			width: 0.875rem;
			height: 0.875rem;
		}

		.bed-arrow-prev {
			left: var(--space-1);
		}

		.bed-arrow-next {
			right: var(--space-1);
		}
	}

	.bed-media {
		position: relative;
		border-radius: var(--radius-md);
		/* The strip is what scrolls, so the rounding has to be clipped on this element or
		   the photograph's square corners sit proud of it. */
		overflow: hidden;
		/* Reserved before a byte arrives, which is the whole CLS story: these files run to
		   2.8 MB and land long after the text does. Without a ratio here the card would
		   grow by 190px under the reader's thumb the moment the first one decoded. */
		aspect-ratio: 16 / 10;
		background: var(--color-bg-inset);
	}

	.bed-strip {
		display: flex;
		height: 100%;
		overflow-x: auto;
		scroll-snap-type: x mandatory;
		scroll-behavior: smooth;
		/* Swiping past the last photograph must not chain out to the page, which on a phone
		   is how a horizontal scroller triggers the browser's back gesture and throws the
		   reader off the results entirely. `SegmentStub`'s own scroller does the same. */
		overscroll-behavior-x: contain;
		/* Firefox and Chrome hide it anyway at this height, but a scrollbar drawn across
		   the bottom of a photograph is a scrollbar drawn across a photograph. */
		scrollbar-width: none;
	}

	.bed-strip::-webkit-scrollbar {
		display: none;
	}

	.bed-slide {
		flex: 0 0 100%;
		height: 100%;
		scroll-snap-align: center;
	}

	.bed-slide img {
		display: block;
		width: 100%;
		height: 100%;
		/* `cover`, not `contain`: Booking's `max1024x768` is a bounding box rather than a
		   crop, so one property arrives 1024x768 and the next 768x768. Letting the file
		   pick the shape would give every card a different height. */
		object-fit: cover;
	}

	.bed-arrow {
		position: absolute;
		top: 50%;
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		margin: 0;
		padding: 0;
		transform: translateY(-50%);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-full);
		/* Opaque, not a translucent scrim: a translucent control over a photograph has the
		   contrast of whichever photograph it lands on, and these are strangers' holiday
		   pictures. An opaque chip is legible over all of them. */
		background: var(--color-bg-elevated);
		color: var(--color-text);
		cursor: pointer;
		/* The pair `TripStrip` uses on its own tap targets: no 300ms wait for a double-tap
		   that a photograph strip has no use for, and no grey flash over the picture. */
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		transition: background-color var(--transition-fast);
	}

	.bed-arrow:hover:not(:disabled) {
		background: var(--color-surface-hover);
	}

	.bed-arrow:disabled {
		/* Colour, never opacity, which is the treatment AGENTS.md names: an arrow at the end
		   of the strip still has to be readable as an arrow. */
		color: var(--color-text-faint);
		cursor: default;
	}

	.bed-arrow svg {
		width: 1rem;
		height: 1rem;
	}

	.bed-arrow-prev {
		left: var(--space-2);
	}

	.bed-arrow-next {
		right: var(--space-2);
	}

	.bed-count {
		position: absolute;
		right: var(--space-2);
		bottom: var(--space-2);
		margin: 0;
		padding: 2px var(--space-2);
		border-radius: var(--radius-full);
		background: var(--color-bg-elevated);
		font-size: 0.625rem;
		font-weight: var(--font-weight-medium);
		color: var(--color-text-muted);
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
