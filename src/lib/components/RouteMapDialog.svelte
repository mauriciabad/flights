<script lang="ts">
	/**
	 * The one real map (issue #280). Near-fullscreen, opened by tapping a frozen preview,
	 * framed on the leg that was tapped, and pannable from there to the rest of the trip.
	 *
	 * The owner: "when one is clicked it opens a dialog with a large map (the dialog is
	 * almost fullscreen, it just has a fixed margin arround based on screen size). the
	 * dialog has the full map, like now but zoomed and placed on the respective area, so if
	 * the user wants, can move and see the other parts of the itinerary."
	 *
	 * ## Existing is being open
	 *
	 * This component has no `open` prop and no effect syncing one to `showModal()`. The
	 * parent renders it to open it and stops rendering it to close it, so opening is
	 * mounting, closing is teardown, and there is no second source of truth to drift. The
	 * attachment below opens the dialog when the element appears and undoes everything it
	 * did when the element goes.
	 *
	 * That shape buys the thing that actually matters here. `ItineraryMap` is inside this
	 * component, so exactly one MapLibre instance exists, only while the dialog is on
	 * screen, and its own `onMount` teardown (`map.remove()`, every marker removed) runs on
	 * close. `tools/probe-map-cost.mjs` measured Chromium evicting the oldest WebGL context
	 * once a page holds more than sixteen; a map left behind on every open would walk a
	 * session into that ceiling one dialog at a time, slowly enough that nobody would
	 * connect the blank map to the eight dialogs they opened an hour ago.
	 * `tools/probe-dialog-map.mjs` opens and closes this ten times and asserts the live
	 * canvas count returns to zero.
	 *
	 * ## Keyboard and focus
	 *
	 * A native `<dialog>` opened with `showModal()`, which is what supplies the focus trap,
	 * `aria-modal`, the top layer and the inert background, per the ARIA authoring
	 * practices modal pattern. Escape is the platform's own `cancel`, and every way out
	 * goes through the native `close` event so there is one path to test. Focus returns to
	 * whatever opened it: browsers do that themselves, and the attachment does it again on
	 * teardown, because the requirement belongs to this app rather than to the platform.
	 *
	 * Body scroll is locked while open. The dialog's margin leaves the page visible at the
	 * edges, and a background that scrolls under a modal reads as the modal sliding.
	 */
	import { ItineraryMap } from '$lib/components';
	import type { Itinerary } from '$lib/domain';
	import type { ItinerarySegmentId } from '$lib/itinerary-map/segment-id';

	interface Props {
		itinerary: Itinerary;
		/** Heading, and the dialog's accessible name. The leg's own sentence from the map
		 *  model, "(straight-line estimate)" included where that is true. */
		title: string;
		/**
		 * The selection this map shares with `ItineraryTimeline`, one `ItinerarySegmentId`
		 * meaning the same thing on both sides (`segment-id.ts` documents that contract in
		 * full). Bound rather than copied so a marker click inside the dialog leaves the
		 * right timeline row highlighted once the dialog is gone. The button that opened the
		 * dialog has already written its own leg into it, which is what frames the map on
		 * the leg that was tapped.
		 */
		selectedSegmentId: ItinerarySegmentId | null;
		/** Fired for every way out: Escape, the close button, the backdrop. The parent stops
		 *  rendering this component in response, which is what closes it. */
		onclose: () => void;
	}

	let { itinerary, title, selectedSegmentId = $bindable(null), onclose }: Props = $props();

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

<dialog {@attach openAsModal} class="route-dialog" aria-labelledby={headingId} {onclose}>
	<div class="route-dialog-shell">
		<div class="route-dialog-head">
			<h2 id={headingId} class="route-dialog-title">{title}</h2>
			<button
				type="button"
				class="route-dialog-close"
				onclick={(event) => event.currentTarget.closest('dialog')?.close()}
			>
				<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
					<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
				</svg>
				Close
			</button>
		</div>
		<div class="route-dialog-map">
			<ItineraryMap {itinerary} bind:selectedSegmentId class="route-dialog-map-inner" />
		</div>
	</div>
</dialog>

<style>
	/* "almost fullscreen, it just has a fixed margin arround based on screen size": one
	   token, read by the width and the height as well as the margin, so the three cannot
	   drift apart. 8px on a phone keeps the card behind it visible as context; 40px stops a
	   2560px monitor rendering a map the size of a wall. */
	.route-dialog {
		--route-dialog-margin: clamp(0.5rem, 3vw, 2.5rem);

		width: calc(100dvw - var(--route-dialog-margin) * 2);
		height: calc(100dvh - var(--route-dialog-margin) * 2);
		max-width: none;
		max-height: none;
		margin: var(--route-dialog-margin);
		padding: 0;
		overflow: hidden;
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-lg);
		background: var(--color-bg-elevated);
		color: var(--color-text);
		box-shadow: var(--shadow-lg);
	}

	/* Tinted with this app's own darkest surface rather than neutral black, so the scrim
	   reads as the app dimming itself and not as a browser default laid over it. */
	.route-dialog::backdrop {
		background: rgb(3 5 14 / 72%);
	}

	.route-dialog-shell {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.route-dialog-head {
		display: flex;
		flex: none;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
		border-bottom: 1px solid var(--color-border);
	}

	/* A leg's own sentence runs long ("Transfer to Wombat's City Hostel (straight-line
	   estimate)"). Two lines on a phone, never a truncation that hides the caveat, which is
	   always the last thing in the string. */
	.route-dialog-title {
		margin: 0;
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		line-height: 1.35;
	}

	.route-dialog-close {
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
	}

	.route-dialog-close svg {
		width: 0.875rem;
		height: 0.875rem;
	}

	.route-dialog-close:hover {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}

	.route-dialog-close:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	.route-dialog-map {
		flex: 1;
		min-height: 0;
		padding: var(--space-3);
	}

	/* `ItineraryMap` sizes its canvas from a token whose default is card-shaped. Here the
	   map is the whole point of the surface, so it takes the height the dialog has left. */
	.route-dialog-map :global(.route-dialog-map-inner) {
		--itinerary-map-canvas-height: 100%;

		height: 100%;
	}
</style>
