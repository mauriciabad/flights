<script lang="ts">
	/**
	 * One photograph, as large as the screen allows, zoomable and pannable, with the others
	 * along the bottom. Issue #441, the owner's own words:
	 *
	 * > **"The carrousels components i should be able to click the image and it shows in a
	 * > big dialog, where i can zoom with trackpad and scrollwhel, and i have the preview of
	 * > the other photos and i can change next/prev with keyboard."**
	 *
	 * ## Existing is being open
	 *
	 * `MapDialog`'s shape, and `open-as-modal.ts` is literally its opening. `PhotoCarousel`
	 * renders this to open it and stops rendering it to close it, so there is no `open` prop
	 * to fall out of step with what is on screen, and the zoom resets by being thrown away
	 * rather than by anything remembering to reset it.
	 *
	 * ## What a zoom costs, and when
	 *
	 * The carousel hands over the card-sized addresses it already had, so opening this fetches
	 * nothing at all for the photograph the reader clicked. That is the whole reason it takes
	 * `photos` rather than a property: issue #284 bought a 96% saving by asking Cloudinary and
	 * Agoda for the card width, and re-requesting the originals on open would hand it straight
	 * back.
	 *
	 * A card-sized photograph is about 800px across, so at 2x it is showing its own pixels. So
	 * the moment the reader zooms past 1, and not one moment sooner, `originalStayPhoto` gives
	 * the address the provider published and that loads behind the one already on screen. A
	 * reader who pages through and never zooms pays nothing; a reader who zooms gets real
	 * detail and has asked for it. It is drawn as a second layer rather than by swapping the
	 * `src`, because swapping clears the element and the photograph blinks out mid-gesture.
	 *
	 * The strip along the bottom is the exception to the carousel's "only what was asked for"
	 * rule, deliberately. It is the reader asking to see the others, it is at most a handful
	 * of pictures (Hostelworld sends 2 per property, Agoda 2, Booking 1, plus a room's own),
	 * and every address in it is one pressing Next would have fetched anyway.
	 *
	 * ## The gestures, and the one that fights the browser
	 *
	 * A trackpad pinch reaches a page as a `wheel` event with `ctrlKey` set. Its default has
	 * to be prevented or the browser zooms the whole page instead, and a listener that wants
	 * to prevent a wheel has to be registered `{ passive: false }`, which is why the wheel is
	 * attached by hand rather than with `onwheel`. Chrome defaults wheel listeners on the
	 * window, the document and the body to passive; on an ordinary element it does not, but
	 * saying so is one word and being wrong about it is a feature that silently does nothing.
	 *
	 * Everything else is pointer events, so a mouse, a finger and a pen are one code path.
	 * Two fingers down is a pinch, and the same anchored zoom the wheel uses is applied about
	 * the midpoint between them. A double tap is detected here rather than left to `dblclick`,
	 * because `touch-action: none` is needed for panning and browsers disagree about whether
	 * a double tap still synthesises a click under it.
	 *
	 * `photo-zoom.ts` holds every line of arithmetic, with tests. This file reads events and
	 * writes a transform.
	 */
	import { tick, untrack } from 'svelte';
	import { Icon } from '$lib/components';
	import { openAsModal } from '$lib/components/open-as-modal';
	import { originalStayPhoto } from '$lib/providers/stays/original-photo';
	import {
		NO_ZOOM,
		clampPan,
		panBy,
		toggleZoom,
		wheelZoomFactor,
		zoomAt,
		type Pan,
		type Point,
		type ZoomBox
	} from './photo-zoom';
	import { photoAlt, type StayPhoto } from './stay-photos';

	interface Props {
		/** Every photograph on offer, already merged and labelled by `stayPhotos`. */
		photos: readonly StayPhoto[];
		/** Which one the reader clicked. The strip opens scrolled to it. */
		index: number;
		/** The dialog's accessible name. The property, not the photograph: a name that changes
		 * as the reader pages is announced wrong or not at all. */
		title: string;
		/** Fired for every way out: Escape, the close button, the backdrop. The parent stops
		 * rendering this in response, which is what closes it. */
		onclose: () => void;
	}

	let { photos, index: openAt, title, onclose }: Props = $props();

	// `untrack` because capturing the opening photograph once is the intent: from here the
	// reader pages this dialog, and re-seeding it from the prop would drag them back to the
	// thumbnail they clicked every time the carousel behind re-rendered.
	let index = $state(untrack(() => Math.max(0, Math.min(photos.length - 1, openAt))));
	const photo = $derived(photos[index]);

	let pan = $state<Pan>(NO_ZOOM);
	const zoomed = $derived(pan.scale > 1);
	/**
	 * Whether the next transform should be animated to rather than jumped to.
	 *
	 * A double tap is one instruction and looks wrong arriving instantly. A wheel, a drag and
	 * a pinch are continuous, and animating each of their dozens of steps puts the picture
	 * 120ms behind the finger, which reads as the photograph being heavy. So the transition
	 * is switched on for the one gesture that wants it.
	 */
	let smooth = $state(false);

	let viewport = $state<HTMLDivElement>();
	let image = $state<HTMLImageElement>();
	/** Held so `show` can move focus off an arrow it is about to disable, the same way
	 * `PhotoCarousel` does: a browser blurs a button the moment it becomes disabled, and a
	 * keyboard reader who pressed Next twice would lose the dialog's controls entirely. */
	let prevButton = $state<HTMLButtonElement>();
	let nextButton = $state<HTMLButtonElement>();

	/**
	 * The published address for the photograph on screen, once the reader has zoomed in far
	 * enough to be looking at the card-sized one's own pixels, and `undefined` while nothing
	 * has asked for it. Keyed by index so paging away drops the request rather than leaving a
	 * megabyte in flight for a picture nobody is looking at any more.
	 */
	let fullSizeFor = $state<number | undefined>(undefined);
	let fullSizeFailed = $state<Record<number, true>>({});
	let fullSizeReady = $state(false);
	const fullSize = $derived(
		fullSizeFor === index && !fullSizeFailed[index] ? originalStayPhoto(photo.src) : undefined
	);

	/** The box the photograph is drawn into, and the rectangle it occupies inside it. Read
	 * from the DOM at the moment of a gesture rather than tracked, because it only changes on
	 * resize and a gesture is exactly when the answer is needed. */
	function boxOf(): ZoomBox {
		const rect = viewport?.getBoundingClientRect();
		if (!rect || !image || image.naturalWidth === 0) {
			return { width: 0, height: 0, contentWidth: 0, contentHeight: 0 };
		}
		// `object-fit: contain`, so the drawn rectangle is the box scaled by whichever axis
		// runs out first. Measuring the element itself would give the box back, since the
		// element fills it and the letterboxing is inside the paint.
		const fit = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
		return {
			width: rect.width,
			height: rect.height,
			contentWidth: image.naturalWidth * fit,
			contentHeight: image.naturalHeight * fit
		};
	}

	/** A client point as `photo-zoom.ts` wants it: CSS pixels from the centre of the box. */
	function pointIn(clientX: number, clientY: number): Point {
		const rect = viewport?.getBoundingClientRect();
		if (!rect) return { x: 0, y: 0 };
		return { x: clientX - (rect.left + rect.width / 2), y: clientY - (rect.top + rect.height / 2) };
	}

	function apply(next: Pan, animate = false) {
		smooth = animate;
		pan = next;
		// One direction only. A photograph that has been zoomed stays worth its full size
		// while the reader zooms back out and in again, and dropping the request at 1 would
		// re-download it on the next gesture.
		if (next.scale > 1 && fullSizeFor !== index) {
			fullSizeFor = index;
			fullSizeReady = false;
		}
	}

	function onWheel(event: WheelEvent) {
		// Unconditional, and both halves matter. Without it a ctrl-wheel pinch zooms the whole
		// page and an ordinary wheel scrolls whatever is behind the dialog.
		event.preventDefault();
		apply(zoomAt(pan, boxOf(), pointIn(event.clientX, event.clientY), wheelZoomFactor(event)));
	}

	function attachWheel(element: HTMLDivElement) {
		// `passive: false` is the whole reason this is not `onwheel`. A passive listener's
		// `preventDefault` is ignored, and the browser page-zooms over the top of the dialog.
		element.addEventListener('wheel', onWheel, { passive: false });
		return () => element.removeEventListener('wheel', onWheel);
	}

	/** Every pointer currently down on the viewport, by id, at its last known position. One
	 * is a drag, two are a pinch, and more than two are the extra fingers a phone collects
	 * during a pinch, which are ignored rather than fought.
	 *
	 * A plain `Map` rather than `SvelteMap`, and deliberately: nothing renders from this. It
	 * is gesture bookkeeping read only by the handler that just wrote it, and making it
	 * reactive would schedule an update per pointer move for a value no template reads. */
	const active = new Map<number, Point>();
	let pinchDistance = 0;
	let lastTap = { time: 0, x: 0, y: 0 };

	function pinchOf(): { centre: Point; distance: number } | undefined {
		const [a, b] = [...active.values()];
		if (!a || !b) return undefined;
		return {
			centre: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
			distance: Math.hypot(a.x - b.x, a.y - b.y)
		};
	}

	function onPointerDown(event: PointerEvent) {
		active.set(event.pointerId, { x: event.clientX, y: event.clientY });
		pinchDistance = pinchOf()?.distance ?? 0;
		// Capture so a drag that leaves the picture keeps arriving here, which is most drags:
		// the reader is pushing the photograph towards an edge and their finger goes past it.
		if (event.currentTarget instanceof Element) {
			event.currentTarget.setPointerCapture(event.pointerId);
		}
	}

	function onPointerMove(event: PointerEvent) {
		const previous = active.get(event.pointerId);
		if (!previous) return;
		const current = { x: event.clientX, y: event.clientY };
		active.set(event.pointerId, current);

		const pinch = pinchOf();
		if (pinch) {
			if (pinchDistance > 0) {
				apply(zoomAt(pan, boxOf(), pointIn(pinch.centre.x, pinch.centre.y), pinch.distance / pinchDistance));
			}
			pinchDistance = pinch.distance;
			return;
		}
		if (!zoomed) return;
		apply(panBy(pan, boxOf(), current.x - previous.x, current.y - previous.y));
	}

	function onPointerUp(event: PointerEvent) {
		const start = active.get(event.pointerId);
		active.delete(event.pointerId);
		pinchDistance = pinchOf()?.distance ?? 0;
		if (!start) return;

		// A drag is not a tap. Four pixels is the smallest movement that reliably separates a
		// deliberate drag from the wobble a finger makes on the way up.
		const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4;
		if (moved || active.size > 0) return;

		const now = event.timeStamp;
		const near = Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 24;
		if (now - lastTap.time < 300 && near) {
			apply(toggleZoom(pan, boxOf(), pointIn(event.clientX, event.clientY)), true);
			lastTap = { time: 0, x: 0, y: 0 };
			return;
		}
		lastTap = { time: now, x: event.clientX, y: event.clientY };
	}

	async function show(next: number) {
		const wasFocused = document.activeElement;
		const target = Math.max(0, Math.min(photos.length - 1, next));
		if (target === index) return;
		index = target;
		// A zoom carried across is disorienting: the reader lands deep inside a photograph
		// they have never seen, with no way to tell that is what happened.
		smooth = false;
		pan = NO_ZOOM;
		fullSizeFor = undefined;
		fullSizeReady = false;

		// Read before `tick()`, because after it the browser has already blurred the button it
		// disabled and `document.activeElement` no longer remembers who was there.
		await tick();
		if (wasFocused === nextButton && nextButton?.disabled) prevButton?.focus();
		else if (wasFocused === prevButton && prevButton?.disabled) nextButton?.focus();
	}

	function onKeydown(event: KeyboardEvent) {
		// Escape is the dialog's own `cancel` and is deliberately not handled here.
		if (event.key === 'ArrowRight') show(index + 1);
		else if (event.key === 'ArrowLeft') show(index - 1);
		else if (event.key === '0' && zoomed) apply(NO_ZOOM, true);
		else return;
		event.preventDefault();
	}

	/**
	 * Closing by clicking outside the picture.
	 *
	 * The shell fills the dialog, so the only clicks that reach the dialog element itself are
	 * the ones on the backdrop, and that identity test is the whole guard. Without it a click
	 * anywhere inside, including the end of a pan that started on the photograph, would close
	 * the thing the reader is looking at.
	 */
	function onBackdropClick(event: MouseEvent & { currentTarget: HTMLDialogElement }) {
		if (event.target === event.currentTarget) event.currentTarget.close();
	}

	/** Keeps the photograph inside the box when the window changes shape under it, which
	 * otherwise leaves a zoomed picture panned to somewhere that no longer exists. */
	function attachResize() {
		const onResize = () => {
			if (pan.scale > 1) pan = clampPan(pan, boxOf());
		};
		window.addEventListener('resize', onResize);
		return () => window.removeEventListener('resize', onResize);
	}

	/** Scrolls the strip so the open photograph is in it. `nearest` rather than `center` so
	 * opening on the first thumbnail does not shove the strip half off its own start. */
	function attachStripFollow(element: HTMLDivElement) {
		$effect(() => {
			// Optional call because jsdom does not implement `scrollIntoView`, and this is the
			// one line in the file that would take a component test down over something purely
			// cosmetic.
			element.children[index]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
		});
	}
</script>

<dialog
	{@attach openAsModal}
	{@attach attachResize}
	class="photo-lightbox"
	aria-label={title}
	{onclose}
	onkeydown={onKeydown}
	onclick={onBackdropClick}
>
	<div class="lightbox-shell">
		<div class="lightbox-head">
			<p class="lightbox-caption">
				<span class={['lightbox-subject', photo.subject]}>
					{photo.badge ?? 'Building'}
				</span>
				{photo.caption}
			</p>
			<button
				type="button"
				class="lightbox-close"
				onclick={(event) => event.currentTarget.closest('dialog')?.close()}
			>
				<Icon name="x" />
				Close
			</button>
		</div>

		<!--
			The stage takes the pointer gestures and the picture takes the transform, so a drag
			that runs off the photograph keeps panning instead of stopping at the edge of the
			pixels. `svelte-ignore` because the same three actions are on real buttons: the
			arrows page, the close button closes, and the keyboard zooms with 0.
		-->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="lightbox-stage"
			bind:this={viewport}
			{@attach attachWheel}
			class:zoomed
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={onPointerUp}
		>
			<div
				class="lightbox-frame"
				class:smooth
				style="transform: translate({pan.x}px, {pan.y}px) scale({pan.scale})"
			>
				<img
					bind:this={image}
					src={photo.src}
					alt={photoAlt(photo, index + 1, photos.length)}
					decoding="async"
					draggable="false"
				/>
				{#if fullSize}
					<!-- The published original, laid over the card-sized one rather than replacing
					     its `src`. Swapping blanks the element while the new file decodes, which
					     during a zoom reads as the photograph disappearing. -->
					<img
						class="lightbox-full"
						class:ready={fullSizeReady}
						src={fullSize}
						alt=""
						aria-hidden="true"
						decoding="async"
						draggable="false"
						onload={() => (fullSizeReady = true)}
						onerror={() => (fullSizeFailed[index] = true)}
					/>
				{/if}
			</div>

			{#if photos.length > 1}
				<button
					type="button"
					class="lightbox-arrow prev"
					bind:this={prevButton}
					disabled={index === 0}
					aria-label="Previous photo"
					onclick={() => show(index - 1)}
				>
					<Icon name="chevron-left" />
				</button>
				<button
					type="button"
					class="lightbox-arrow next"
					bind:this={nextButton}
					disabled={index === photos.length - 1}
					aria-label="Next photo"
					onclick={() => show(index + 1)}
				>
					<Icon name="chevron-right" />
				</button>
			{/if}

			<p class="lightbox-count font-mono tabular-nums" aria-live="polite">
				{index + 1} / {photos.length}
				{#if zoomed}<span class="lightbox-scale">{Math.round(pan.scale * 100)}%</span>{/if}
			</p>
		</div>

		{#if photos.length > 1}
			<div class="lightbox-strip" {@attach attachStripFollow}>
				{#each photos as thumb, i (thumb.src)}
					<button
						type="button"
						class={['lightbox-thumb', thumb.subject]}
						aria-current={i === index ? 'true' : undefined}
						aria-label={photoAlt(thumb, i + 1, photos.length)}
						onclick={() => show(i)}
					>
						<img src={thumb.src} alt="" loading="lazy" decoding="async" />
					</button>
				{/each}
			</div>
		{/if}
	</div>
</dialog>

<style>
	/* The same near-fullscreen shape the map dialogs take, from the owner's own description of
	   one: "almost fullscreen, it just has a fixed margin arround based on screen size". The
	   margin is smaller here because the content is a photograph and every pixel given to the
	   frame is taken off the picture. */
	.photo-lightbox {
		--lightbox-margin: clamp(0.25rem, 2vw, 1.5rem);

		width: calc(
			100dvw - var(--lightbox-margin) * 2 - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)
		);
		height: calc(
			100dvh - var(--lightbox-margin) * 2 - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px)
		);
		max-width: none;
		max-height: none;
		margin: calc(var(--lightbox-margin) + env(safe-area-inset-top, 0px))
			calc(var(--lightbox-margin) + env(safe-area-inset-right, 0px))
			calc(var(--lightbox-margin) + env(safe-area-inset-bottom, 0px))
			calc(var(--lightbox-margin) + env(safe-area-inset-left, 0px));
		padding: 0;
		overflow: hidden;
		overscroll-behavior: contain;
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-lg);
		background: var(--color-bg-elevated);
		color: var(--color-text);
		box-shadow: var(--shadow-lg);
	}

	/* No ring on the dialog itself, and the rule now lives in app.css against every
	   `dialog`. A click on the photograph lands on the dialog because a photograph cannot
	   take focus, which is exactly the gesture this feature is for, and `MapDialog` turned
	   out to have the same hole one panel over (#448). `tools/probe-photo-lightbox.mjs`
	   still reports `dialogMatchesFocusVisible` for this surface. */

	/* Darker than the map dialog's scrim, because this surface is a photograph and anything
	   showing through it competes with the picture rather than with a map. */
	.photo-lightbox::backdrop {
		background: rgb(3 5 14 / 88%);
	}

	.lightbox-shell {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.lightbox-head {
		display: flex;
		flex: none;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
		border-bottom: 1px solid var(--color-border);
	}

	/* The caption is the answer to "what am I looking at", and issue #442 makes that a real
	   question rather than a decoration: a dorm bed's card can now hold pictures of the
	   building and pictures of the room, and a reader who cannot tell them apart is being
	   sold a lobby. So the subject leads the line rather than sitting under it. */
	.lightbox-caption {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: baseline;
		margin: 0;
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
		text-wrap: balance;
	}

	.lightbox-subject {
		flex: none;
		padding: 1px var(--space-2);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-full);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--color-text-muted);
	}

	/* A room photograph carries the accent and the building stays neutral, because telling a
	   lobby from a bedroom is the distinction a reader cannot afford to get wrong. Which KIND
	   of room claim it is comes from the word in the chip rather than from a third colour:
	   "Room" is the room whose rate is quoted, a plural is rooms of that kind at this property.
	   Colour is not the only signal either way, which is what a reader who cannot see the
	   accent reads instead. */
	.lightbox-subject.room,
	.lightbox-subject.room-kind {
		border-color: var(--color-accent);
		background: var(--color-accent-muted);
		color: var(--color-accent-muted-text);
	}

	.lightbox-close {
		display: inline-flex;
		flex: none;
		gap: var(--space-2);
		align-items: center;
		min-height: 2.75rem;
		padding: 0 var(--space-3);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-full);
		background: var(--color-bg);
		color: var(--color-text);
		font: inherit;
		font-size: var(--font-size-sm);
		cursor: pointer;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
	}

	.lightbox-close :global(svg) {
		width: 0.875rem;
		height: 0.875rem;
	}

	.lightbox-close:hover {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}

	.lightbox-close:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	.lightbox-stage {
		position: relative;
		flex: 1;
		min-height: 0;
		overflow: hidden;
		/* The darkest surface the palette has, so the bars beside a photograph that does not
		   match the box read as the room being dark rather than as a broken layout. */
		background: var(--color-bg-inset);
		/* The browser must not claim the gesture. Panning and pinching are this element's, and
		   without this a drag on a phone scrolls or triggers the back gesture instead. The
		   dialog is modal and `open-as-modal.ts` has already locked the body, so nothing behind
		   it wanted to scroll anyway. */
		touch-action: none;
		-webkit-tap-highlight-color: transparent;
	}

	.lightbox-stage.zoomed {
		cursor: grab;
	}

	.lightbox-stage.zoomed:active {
		cursor: grabbing;
	}

	.lightbox-frame {
		display: grid;
		width: 100%;
		height: 100%;
		will-change: transform;
	}

	/* Only on the double tap, and only `transform`, which is the one property a zoom can hand
	   to the compositor. app.css's reduced-motion block turns this off globally, and the
	   feature survives that: the photograph still zooms, it just arrives rather than travels. */
	.lightbox-frame.smooth {
		transition: transform var(--transition-base);
	}

	.lightbox-frame img {
		grid-area: 1 / 1;
		width: 100%;
		height: 100%;
		/* `contain`, unlike the card's `cover`: a lightbox exists to show the whole
		   photograph, and cropping the thing the reader clicked to see is the one thing it
		   must not do. */
		object-fit: contain;
		user-select: none;
	}

	/* Held back until it has decoded, so the card-sized photograph underneath carries the
	   picture until there is something better to show rather than blinking out first. */
	.lightbox-full {
		opacity: 0;
		transition: opacity var(--transition-base);
	}

	.lightbox-full.ready {
		opacity: 1;
	}

	.lightbox-arrow {
		position: absolute;
		top: 50%;
		display: grid;
		place-items: center;
		/* 44px, the touch target this app guarantees everywhere it controls the markup. */
		width: 2.75rem;
		height: 2.75rem;
		padding: 0;
		transform: translateY(-50%);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-full);
		/* Opaque rather than a translucent scrim, the same call `PhotoCarousel` makes: a
		   see-through control over a stranger's holiday photograph has whatever contrast that
		   photograph gives it. */
		background: var(--color-bg-elevated);
		color: var(--color-text);
		cursor: pointer;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		transition: background-color var(--transition-fast);
	}

	.lightbox-arrow :global(svg) {
		width: 1.25rem;
		height: 1.25rem;
	}

	.lightbox-arrow:hover:not(:disabled) {
		background: var(--color-surface-hover);
	}

	.lightbox-arrow:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	.lightbox-arrow:disabled {
		/* Colour, never opacity, per AGENTS.md: an arrow at the end of the strip still has to
		   be readable as an arrow. */
		color: var(--color-text-faint);
		cursor: default;
	}

	.lightbox-arrow.prev {
		left: var(--space-3);
	}

	.lightbox-arrow.next {
		right: var(--space-3);
	}

	.lightbox-count {
		position: absolute;
		right: var(--space-3);
		bottom: var(--space-3);
		display: flex;
		gap: var(--space-2);
		margin: 0;
		padding: 2px var(--space-2);
		border-radius: var(--radius-full);
		background: var(--color-bg-elevated);
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}

	.lightbox-scale {
		color: var(--color-accent);
	}

	.lightbox-strip {
		display: flex;
		flex: none;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		overflow-x: auto;
		/* Never chain out to the page: on a phone a horizontal scroller that reaches its end
		   is how the browser's back gesture fires and throws the reader off the results. */
		overscroll-behavior-x: contain;
		border-top: 1px solid var(--color-border);
	}

	/* The ones that are not open are dimmed rather than merely un-ringed. A 2px accent ring
	   over a dark holiday photograph is legible in dark mode and nearly invisible in light,
	   which a screenshot caught; a difference in weight reads at a glance in both. */
	.lightbox-thumb {
		flex: none;
		opacity: 0.55;
		width: 4.5rem;
		/* 44px minimum, and 3rem here so a strip of these still leaves the photograph the
		   height it deserves on a phone in landscape. */
		height: 3rem;
		padding: 0;
		overflow: hidden;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background: var(--color-bg-inset);
		cursor: pointer;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		transition:
			border-color var(--transition-fast),
			opacity var(--transition-fast);
	}

	.lightbox-thumb img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.lightbox-thumb:hover {
		opacity: 1;
		border-color: var(--color-border-strong);
	}

	.lightbox-thumb:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	/* The open one, marked with the app's accent and a second border rather than with a
	   colour alone, so it survives the greyed-out treatment and a monochrome screen. */
	.lightbox-thumb[aria-current='true'] {
		opacity: 1;
		border-color: var(--color-accent);
		box-shadow: inset 0 0 0 2px var(--color-accent);
	}

	/* A room's thumbnail is marked along its bottom edge, which is the only place in the strip
	   there is room to say "this one is the room" without covering the picture. The caption
	   above says it in words for anyone who cannot see the bar. */
	.lightbox-thumb.room,
	.lightbox-thumb.room-kind {
		border-bottom: 3px solid var(--color-accent);
	}

	/* Phones in portrait, where the strip has to give the photograph back the height it is
	   taking and the counter has to come off the edge of the screen. */
	@media (max-width: 30rem) {
		.lightbox-thumb {
			width: 3.5rem;
			height: 2.5rem;
		}

		.lightbox-count {
			right: var(--space-2);
			bottom: var(--space-2);
		}
	}
</style>
