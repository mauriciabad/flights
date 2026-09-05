<script lang="ts">
	/**
	 * A property's photographs, one at a time, with a counter and two arrows.
	 *
	 * This was built inside `PickedBed` for issue #283 and lifted out here for #307, whose
	 * ask was **"the carrousel for hotel should be used in more places"**. Nothing about its
	 * behaviour changed in the move; every decision below was argued there and is repeated
	 * here because this is now where it lives.
	 *
	 * ## Why it is two photographs and not a gallery
	 *
	 * Measured with `tools/probe-images.mjs`, which renders real `<img>` tags from an http
	 * origin because an image tag is a no-cors request that ignores the header a `fetch`
	 * reads. Hostelworld returns 2 images per property, Agoda 2, Booking 1. So this is a
	 * photograph with a counter, and below two photographs the arrows and the counter are
	 * not rendered at all rather than rendered inert: a dead arrow is a promise the data
	 * cannot keep.
	 *
	 * ## Why only the photographs the reader asked for are fetched
	 *
	 * Hostelworld is the keyless default most visitors hit and `a.hwstatic.com` serves the
	 * photographer's original: 4032x2268 at 2.79 MB, 1930x1085 at 2.02 MB. It is not an
	 * image CDN and it honours no resize - imgix's `w`, `h`, `fit`, `auto` and `dpr` all
	 * returned output byte-identical to a `?zzz=1` control (issue #284). There is no backend
	 * here to proxy through. So `reached` holds the furthest photograph the reader has
	 * actually asked for, nothing past it has a `src`, and a strip of two costs one image
	 * rather than five megabytes. `loading="lazy"` on top of that is what keeps a list of
	 * these to the ones on screen.
	 *
	 * ## Accessibility, which is most of the file
	 *
	 * Real `<button>` arrows outside the scroller, so they are ordinary tab stops that tab
	 * out of again and nothing inside the strip is focusable - which is what keeps the usual
	 * carousel focus trap unreachable. Arrow keys while focus is anywhere in the block. An
	 * `aria-live` counter, because a swipe changes the number and fires no event a screen
	 * reader would otherwise report. Focus handed to the arrow that still works when the one
	 * you pressed disables under you. No auto-advance, ever.
	 *
	 * ## Sizing is the caller's
	 *
	 * `--photo-aspect` and `--photo-arrow-size` are read from whatever contains this, so a
	 * card, a popover and a map sidebar can each shape the box without this file knowing
	 * about any of them.
	 */
	import { tick } from 'svelte';
	import { Icon } from '$lib/components';
	import { originalStayPhoto } from '$lib/providers/stays/original-photo';

	interface Props {
		/** `Property.images`, in the provider's own order. Empty renders nothing at all: a
		 * grey box with a building glyph in it says "a picture is missing", and nothing is
		 * missing - this property came back without one. */
		images: readonly string[];
		/** The property's name, which is what every photograph's `alt` is built from. */
		name: string;
		class?: string;
	}

	let { images, name, class: className }: Props = $props();

	/**
	 * The second address to try for a photograph, once the first one failed.
	 *
	 * `booking-mapper.ts` upgrades Booking's 60x60 thumbnail to a card-sized address, and
	 * `agoda-photo.ts` does its own rewrite (issue #281). Both are measured against a
	 * handful of photo ids rather than every photo id, so a shape they guessed wrong 404s,
	 * and this is where it degrades: back to the URL the provider actually gave.
	 * `broken` is a photograph that failed with nothing left to try.
	 */
	let fallbacks = $state<Record<number, string>>({});
	let broken = $state<Record<number, true>>({});
	const photos = $derived(
		images.map((original, i) => ({
			original,
			src: fallbacks[i] ?? original,
			broken: broken[i] === true
		}))
	);

	/** Which photograph is under the reader's eye, tracked from the scroll position so a
	 * swipe and a button press cannot disagree about the counter. */
	let index = $state(0);
	/** The furthest photograph the reader has actually asked for. Nothing past this has a
	 * `src`, so nothing past this has been fetched. */
	let reached = $state(0);
	let strip = $state<HTMLDivElement>();
	/** Held so `show` can move focus off an arrow it is about to disable. */
	let prevButton = $state<HTMLButtonElement>();
	let nextButton = $state<HTMLButtonElement>();

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

{#if photos.length > 0}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class={['photo-carousel', className]}
		role="group"
		aria-label={`Photos of ${name}`}
		onkeydown={onStripKeydown}
	>
		<div class="photo-strip" bind:this={strip} onscroll={onStripScroll}>
			{#each photos as photo, i (photo.original)}
				<div class="photo-slide">
					{#if i <= reached && !photo.broken}
						<img
							src={photo.src}
							alt={pageable ? `${name}, photo ${i + 1} of ${photos.length}` : name}
							loading="lazy"
							decoding="async"
							onerror={() => onPhotoError(i)}
						/>
					{/if}
				</div>
			{/each}
		</div>

		{#if pageable}
			<button
				type="button"
				class="photo-arrow photo-arrow-prev"
				bind:this={prevButton}
				disabled={index === 0}
				aria-label="Previous photo"
				onclick={() => show(index - 1)}
			>
				<Icon name="chevron-left" />
			</button>
			<button
				type="button"
				class="photo-arrow photo-arrow-next"
				bind:this={nextButton}
				disabled={index === photos.length - 1}
				aria-label="Next photo"
				onclick={() => show(index + 1)}
			>
				<Icon name="chevron-right" />
			</button>
			<!-- The count is the whole reason a reader knows there is a second picture, since
			     two photographs do not earn a dot row. `aria-live` because the number changes
			     on a swipe, which fires no event a screen reader would otherwise report. -->
			<p class="photo-count font-mono tabular-nums" aria-live="polite">
				{index + 1} / {photos.length}
			</p>
		{/if}
	</div>
{/if}

<style>
	.photo-carousel {
		position: relative;
		border-radius: var(--radius-md);
		/* The strip is what scrolls, so the rounding has to be clipped on this element or
		   the photograph's square corners sit proud of it. */
		overflow: hidden;
		/* Reserved before a byte arrives, which is the whole CLS story: these files run to
		   2.8 MB and land long after the text does. Without a ratio here the card would
		   grow by 190px under the reader's thumb the moment the first one decoded. */
		aspect-ratio: var(--photo-aspect, 16 / 10);
		background: var(--color-bg-inset);
	}

	.photo-strip {
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

	.photo-strip::-webkit-scrollbar {
		display: none;
	}

	.photo-slide {
		flex: 0 0 100%;
		height: 100%;
		scroll-snap-align: center;
	}

	.photo-slide img {
		display: block;
		width: 100%;
		height: 100%;
		/* `cover`, not `contain`: Booking's `max1024x768` is a bounding box rather than a
		   crop, so one property arrives 1024x768 and the next 768x768. Letting the file
		   pick the shape would give every card a different height. */
		object-fit: cover;
	}

	.photo-arrow {
		position: absolute;
		top: 50%;
		display: grid;
		place-items: center;
		width: var(--photo-arrow-size, 2rem);
		height: var(--photo-arrow-size, 2rem);
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

	.photo-arrow:hover:not(:disabled) {
		background: var(--color-surface-hover);
	}

	.photo-arrow:disabled {
		/* Colour, never opacity, which is the treatment AGENTS.md names: an arrow at the end
		   of the strip still has to be readable as an arrow. */
		color: var(--color-text-faint);
		cursor: default;
	}

	.photo-arrow :global(svg) {
		width: calc(var(--photo-arrow-size, 2rem) / 2);
		height: calc(var(--photo-arrow-size, 2rem) / 2);
	}

	.photo-arrow-prev {
		left: var(--photo-arrow-inset, var(--space-2));
	}

	.photo-arrow-next {
		right: var(--photo-arrow-inset, var(--space-2));
	}

	.photo-count {
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
</style>
