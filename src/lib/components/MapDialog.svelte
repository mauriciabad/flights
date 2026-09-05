<script lang="ts">
	/**
	 * The near-fullscreen surface every real map in this app opens into: a map, optionally a
	 * panel beside it, and nothing else.
	 *
	 * ## Why this is one component and not three copies
	 *
	 * `RouteMapDialog` established the shape for issue #280, in the owner's words: "when one
	 * is clicked it opens a dialog with a large map (the dialog is almost fullscreen, it just
	 * has a fixed margin arround based on screen size)". Issue #319's stays map copied it
	 * verbatim, and issue #324's connections map would have been the third. Three copies of a
	 * `clamp()`, four `env(safe-area-inset-*)` calls and a focus-restoring attachment is the
	 * kind of duplication this codebase has already paid for twice: the notch insets and the
	 * scrim tint are exactly the details that get dropped in a copy and noticed by nobody
	 * until a phone puts the close button under a camera cutout.
	 *
	 * ## Existing is being open
	 *
	 * No `open` prop and no effect syncing one to `showModal()`. The parent renders this to
	 * open it and stops rendering it to close it, so opening is mounting and closing is
	 * teardown, with no second source of truth to drift.
	 *
	 * That shape is load-bearing rather than stylistic. Whatever the `map` snippet renders
	 * holds the page's only MapLibre instance, so unmounting the dialog is what runs its
	 * `map.remove()`. `tools/probe-map-cost.mjs` measured Chromium evicting the oldest WebGL
	 * context once a page holds more than sixteen, and a map left behind on every open walks a
	 * session into that ceiling one dialog at a time, slowly enough that nobody connects the
	 * blank map to the eight dialogs they opened an hour ago.
	 *
	 * ## Keyboard and focus
	 *
	 * A native `<dialog>` opened with `showModal()`, which is what supplies the focus trap,
	 * `aria-modal`, the top layer and the inert background, per the ARIA authoring practices
	 * modal pattern. Escape is the platform's own `cancel`, and every way out goes through the
	 * native `close` event so there is one path to test. Focus returns to whatever opened it.
	 *
	 * ## What this component deliberately does not know
	 *
	 * Whether the panel reacts to a click, a hover, or neither. #319's stays panel opens on a
	 * click; #324's connections panel previews on hover and pins on click, because the owner
	 * asked to sweep across close-together points and watch the panel change. Both are right
	 * for their job and neither is this component's business: it lays two halves out and gets
	 * out of the way.
	 */
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';

	interface Props {
		/** The dialog's accessible name, announced once on open. Name the whole surface, not
		 * whatever is selected inside it: a heading that changes underneath a screen reader
		 * is announced wrong or not at all. */
		title: string;
		/** The map. Required, because a dialog with no map is a dialog, not this. */
		map: Snippet;
		/** The details beside it. Omit for a map-only dialog and the map takes the whole
		 * body, which is what `RouteMapDialog` does. */
		panel?: Snippet;
		/** Fired for every way out: Escape, the close button, the backdrop. The parent stops
		 * rendering this component in response, which is what closes it. */
		onclose: () => void;
		/**
		 * The caller's own class on the `<dialog>`, alongside this component's.
		 *
		 * Not styling: it is each dialog's identity, and ten e2e specs across six files
		 * select `dialog.route-dialog` and `dialog.stays-dialog` to assert live WebGL context
		 * counts and focus restoration. Collapsing three dialogs onto one class name would
		 * have made every one of those assertions match whichever dialog happened to be open,
		 * which is the failure mode where a suite goes green by testing the wrong thing.
		 */
		class?: string;
	}

	let { title, map, panel, onclose, class: className }: Props = $props();

	const headingId = $props.id();

	function openAsModal(element: HTMLDialogElement) {
		const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		const previousOverflow = document.body.style.overflow;

		element.showModal();
		document.body.style.overflow = 'hidden';

		return () => {
			document.body.style.overflow = previousOverflow;
			// `isConnected` because a trigger inside a card the results stream replaced while
			// the dialog was open is gone, and focusing a detached node silently sends focus
			// to the document body instead of leaving it where the browser put it.
			if (trigger?.isConnected) trigger.focus();
		};
	}
</script>

<dialog {@attach openAsModal} class={['map-dialog', className]} aria-labelledby={headingId} {onclose}>
	<div class="map-dialog-shell">
		<div class="map-dialog-head">
			<h2 id={headingId} class="map-dialog-title">{title}</h2>
			<button
				type="button"
				class="map-dialog-close"
				onclick={(event) => event.currentTarget.closest('dialog')?.close()}
			>
				<Icon name="x" />
				Close
			</button>
		</div>
		<div class={['map-dialog-body', { 'has-panel': panel !== undefined }]}>
			{#if panel}
				<div class="map-dialog-panel">{@render panel()}</div>
			{/if}
			<div class="map-dialog-map">{@render map()}</div>
		</div>
	</div>
</dialog>

<style>
	/* "almost fullscreen, it just has a fixed margin arround based on screen size": one
	   token, read by the width and the height as well as the margin, so the three cannot
	   drift apart. 8px on a phone keeps the card behind it visible as context; 40px stops a
	   2560px monitor rendering a map the size of a wall.

	   The notch insets are added on top rather than folded into the token, because they are
	   the device's measurement and not a design decision. Without them an 8px margin puts a
	   near-fullscreen surface under a phone's camera cutout, which is where the close button
	   lives. */
	.map-dialog {
		--map-dialog-margin: clamp(0.5rem, 3vw, 2.5rem);

		width: calc(
			100dvw - var(--map-dialog-margin) * 2 - env(safe-area-inset-left, 0px) -
				env(safe-area-inset-right, 0px)
		);
		height: calc(
			100dvh - var(--map-dialog-margin) * 2 - env(safe-area-inset-top, 0px) -
				env(safe-area-inset-bottom, 0px)
		);
		max-width: none;
		max-height: none;
		margin: calc(var(--map-dialog-margin) + env(safe-area-inset-top, 0px))
			calc(var(--map-dialog-margin) + env(safe-area-inset-right, 0px))
			calc(var(--map-dialog-margin) + env(safe-area-inset-bottom, 0px))
			calc(var(--map-dialog-margin) + env(safe-area-inset-left, 0px));
		padding: 0;
		overflow: hidden;
		/* A pinch-zoom that runs out of map must not scroll the results list behind the
		   scrim, which reads as the dialog sliding. */
		overscroll-behavior: contain;
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-lg);
		background: var(--color-bg-elevated);
		color: var(--color-text);
		box-shadow: var(--shadow-lg);
	}

	/* Tinted with this app's own darkest surface rather than neutral black, so the scrim
	   reads as the app dimming itself and not as a browser default laid over it. */
	.map-dialog::backdrop {
		background: rgb(3 5 14 / 72%);
	}

	.map-dialog-shell {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.map-dialog-head {
		display: flex;
		flex: none;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
		border-bottom: 1px solid var(--color-border);
	}

	/* Two city names and a prefix run long on a phone. Two lines rather than a truncation:
	   the destination is the half that would be cut, and a route map headed "Route map:
	   Barcelona to…" names only where the traveller started. */
	.map-dialog-title {
		margin: 0;
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		line-height: 1.35;
		text-wrap: balance;
	}

	.map-dialog-close {
		display: inline-flex;
		flex: none;
		gap: var(--space-2);
		align-items: center;
		/* 44px, the touch target this app guarantees everywhere it controls the markup. */
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

	/* `:global` with a scoped ancestor, because the `<svg>` lives inside `Icon` and a bare
	   global selector at one class loses to Svelte's own scoping class on it. `Icon`'s doc
	   comment records the browser measurement that caught that. */
	.map-dialog-close :global(svg) {
		width: 0.875rem;
		height: 0.875rem;
	}

	.map-dialog-close:hover {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}

	.map-dialog-close:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	.map-dialog-body {
		display: flex;
		flex: 1;
		min-height: 0;
		padding: var(--space-3);
	}

	.map-dialog-map {
		flex: 1;
		min-height: 0;
		min-width: 0;
	}

	/* Stacked below 52rem, side by side above it. The panel is 22rem, so the map is only the
	   wider of the two once the body clears 44rem plus the gap; the body is the viewport
	   less two 3vw margins and two 12px paddings, which puts the crossover at about 787px,
	   and 52rem is the next round number above it. Below that the map would be narrower than
	   the text beside it, and the map is what the surface is for. Issue #319 worked that out
	   and #324 moved it here, so the app has one such breakpoint rather than three.

	   The map keeps the TOP half when stacked, because that is the half that answers
	   "where", and the panel scrolls under it. */
	.map-dialog-body.has-panel {
		display: grid;
		grid-template-rows: minmax(12rem, 45%) minmax(0, 1fr);
		gap: var(--space-3);
	}

	.map-dialog-body.has-panel .map-dialog-map {
		grid-area: 1 / 1;
	}

	.map-dialog-panel {
		grid-area: 2 / 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	/* After the three rules above, never before them. At equal specificity the later rule
	   wins, and #319 shipped an earlier media query that lost the row assignment to the base
	   one: the sidebar sat under a half-height map at 1280px, every spec passed, and a
	   screenshot is what caught it. Moving that CSS here is exactly where such an ordering
	   bug would get copied into three dialogs at once, so it stays last. */
	@media (min-width: 52rem) {
		.map-dialog-body.has-panel {
			grid-template-rows: minmax(0, 1fr);
			grid-template-columns: 22rem minmax(0, 1fr);
		}

		.map-dialog-panel {
			grid-area: 1 / 1;
		}

		.map-dialog-body.has-panel .map-dialog-map {
			grid-area: 1 / 2;
		}
	}
</style>
