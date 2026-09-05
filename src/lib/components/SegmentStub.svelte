<script lang="ts">
	/**
	 * One strip segment's own ticket stub, torn off the strip: issue #227's panel.
	 *
	 * A tinted top half carries the eyebrow, the title and the two clocks; a plain
	 * counterfoil carries the facts. Between them a perforation and two die-cut notches,
	 * and a tail pointing at the cell you asked about. `segment-stub.ts` decides every word
	 * on it; this file only arranges them.
	 *
	 * ## Why it is a popover in the top layer
	 *
	 * A strip cell is `container-type: inline-size` with `overflow: hidden`, so a panel
	 * rendered inside one is clipped to about 28px and trapped, and the app shell scrolls
	 * inside `.app-content` rather than the document, so even a `position: fixed` panel
	 * would be caught by an ancestor. `popover="auto"` in the top layer escapes all of it,
	 * and brings three behaviours that would otherwise be hand-written: Escape closes it,
	 * a click outside dismisses it, and opening one auto popover closes every other, so
	 * hovering the second card's strip closes the first card's panel with no bookkeeping
	 * between cards that do not know about each other.
	 *
	 * Positioning is measured rather than declared. CSS anchor positioning would replace
	 * `place()` below, but Firefox in the field does not have it and a
	 * `getBoundingClientRect` does.
	 *
	 * ## The notches come free
	 *
	 * Two boxes touch, each with its adjacent corners rounded. The four quarter-circles
	 * leave a die-cut pinch at both sides, at any content height, with nothing measured.
	 * The shadow is `filter: drop-shadow` rather than `box-shadow` so it follows that
	 * pinched silhouette and the tail instead of a rectangle neither of them is.
	 */
	import type { Itinerary } from '$lib/domain';
	import type { SegmentStub } from './segment-stub';
	import StopoverBlock from './StopoverBlock.svelte';

	interface Props {
		/** Every word on the panel, already decided. */
		stub: SegmentStub;
		id: string;
		/** The hit target this panel belongs to. `undefined` closes it. */
		anchor?: HTMLElement;
		open: boolean;
		itinerary: Itinerary;
		connectionLabel: string;
		deprioritized?: boolean;
		/** The browser dismissed it: Escape, or a click outside. The parent owns `open`, so
		 * it has to be told rather than left believing a panel is up. */
		onDismiss: () => void;
		/** Leaving the union of the target and the panel is what closes a hover, so the
		 * panel has to report its own pointer crossings. */
		onPointerEnter?: () => void;
		onPointerLeave?: () => void;
	}

	let {
		stub,
		id,
		anchor,
		open,
		itinerary,
		connectionLabel,
		deprioritized = false,
		onDismiss,
		onPointerEnter,
		onPointerLeave
	}: Props = $props();

	let panel = $state<HTMLElement>();
	let top = $state<HTMLElement>();
	let placement = $state<'above' | 'below'>('above');

	/** Clear between the tail's tip and the cell it points at. */
	const GAP = 8;
	/** How close the panel may come to the edge of the window. */
	const EDGE = 8;
	/** A counterfoil shorter than this is not worth scrolling; flip sides instead. */
	const MIN_BODY = 96;

	function place(element: HTMLElement, target: HTMLElement) {
		const cell = target.getBoundingClientRect();
		const rect = element.getBoundingClientRect();
		const topHeight = top?.getBoundingClientRect().height ?? 0;

		const left = Math.min(
			Math.max(cell.left + cell.width / 2 - rect.width / 2, EDGE),
			Math.max(EDGE, window.innerWidth - rect.width - EDGE)
		);

		const roomAbove = cell.top - GAP - EDGE;
		const roomBelow = window.innerHeight - cell.bottom - GAP - EDGE;
		const above = rect.height <= roomAbove || roomAbove >= roomBelow;
		const room = above ? roomAbove : roomBelow;

		element.style.setProperty('--x', `${Math.round(left)}px`);
		element.style.setProperty('--y', `${Math.round(above ? cell.top - GAP - rect.height : cell.bottom + GAP)}px`);
		// The tail sits over the cell's centre wherever the panel had to slide to, clamped
		// so it never hangs off a rounded corner.
		element.style.setProperty(
			'--tail-x',
			`${Math.round(Math.min(Math.max(cell.left + cell.width / 2 - left, 14), rect.width - 14))}px`
		);
		// Only when neither side fits. The top half is the identity of the thing and never
		// scrolls; the counterfoil is the list, and a list is what scrolls.
		element.style.setProperty(
			'--stub-body-max',
			rect.height <= room ? 'none' : `${Math.max(MIN_BODY, Math.floor(room - topHeight))}px`
		);
		placement = above ? 'above' : 'below';
	}

	// Nothing in here is async, so the retriggering trap AGENTS.md records (an unawaited
	// call whose synchronous prefix writes state the effect reads) cannot apply: it
	// measures, writes custom properties on a DOM node, and toggles the popover. None of
	// those is reactive state this effect also reads.
	$effect(() => {
		const element = panel;
		// `stub` is read here so a content change re-measures against the same anchor: the
		// panel's own height is what decides which side of the strip it can take.
		const content = stub;
		if (!element || !content) return;
		const showing = element.matches(':popover-open');
		if (!open || !anchor) {
			if (showing) element.hidePopover();
			return;
		}
		if (!showing) element.showPopover();
		place(element, anchor);
	});

	function onToggle(event: ToggleEvent) {
		if (event.newState === 'closed' && open) onDismiss();
	}
</script>

<div
	bind:this={panel}
	{id}
	popover="auto"
	role="tooltip"
	class={['stub', `stub-${stub.kind}`, { 'is-quiet': deprioritized, 'is-below': placement === 'below' }]}
	ontoggle={onToggle}
	onpointerenter={onPointerEnter}
	onpointerleave={onPointerLeave}
>
	<div class="stub-top" bind:this={top}>
		<p class="stub-eyebrow">
			<span><span class="stub-key" aria-hidden="true"></span>{stub.eyebrow}</span>
			<span>{stub.day}</span>
		</p>
		<p class="stub-title">{stub.title}</p>
		{#each stub.notes as note (note.text)}
			<p class={['stub-note', { 'is-warning': note.tone === 'warning' }]}>{note.text}</p>
		{/each}

		<div class="stub-times">
			<div class="stub-time">
				<span class="stub-clock">{stub.start.time}</span>
				{#if stub.start.code || stub.start.place}
					<span class="stub-place">
						{#if stub.start.code}<b>{stub.start.code}</b>{/if}
						{stub.start.place ?? ''}
					</span>
				{/if}
			</div>
			<span class="stub-rail"><span>{stub.duration}</span></span>
			<div class="stub-time stub-time-end">
				<span class="stub-clock"
					>{stub.end.time}{#if stub.end.plusDays}<span class="stub-plusday">+{stub.end.plusDays}</span>{/if}</span
				>
				{#if stub.end.code || stub.end.place}
					<span class="stub-place">
						{#if stub.end.code}<b>{stub.end.code}</b>{/if}
						{stub.end.place ?? ''}
					</span>
				{/if}
				{#if stub.end.date}<span class="stub-place">{stub.end.date}</span>{/if}
			</div>
		</div>

		{#if stub.offsetNote}
			<p class="stub-note">{stub.offsetNote}</p>
		{/if}
		{#if placement === 'below'}<span class="stub-tail" aria-hidden="true"></span>{/if}
	</div>

	<div class="stub-bottom">
		<div class="stub-body">
			{#if stub.rendersStopoverBlock}
				<StopoverBlock {itinerary} {connectionLabel} />
			{/if}
			{#if stub.facts.length > 0}
				<dl class={['stub-facts', { 'after-block': stub.rendersStopoverBlock }]}>
					{#each stub.facts as fact (fact.label)}
						<dt>{fact.label}</dt>
						<dd class={{ 'is-unknown': fact.unknown }}>{fact.value}</dd>
					{/each}
				</dl>
			{/if}
		</div>
		{#if placement === 'above'}<span class="stub-tail" aria-hidden="true"></span>{/if}
	</div>
</div>

<style>
	/* `left`/`top` stay at 0 and the position is a translate, so moving from one segment to
	   the next glides on the compositor and the entry can start 4px nearer the cell it
	   belongs to. The popover UA styles are reset on the same declarations. */
	.stub {
		--stub-bg: var(--color-surface-hover);
		--stub-tint: var(--color-bg-inset);
		--stub-rail: var(--color-border-strong);
		--stub-rail-style: solid;
		--tail-x: 50%;
		--enter-dy: 4px;
		position: fixed;
		inset: 0 auto auto 0;
		margin: 0;
		padding: 0;
		border: 0;
		background: none;
		overflow: visible;
		width: min(21rem, calc(100vw - 1rem));
		translate: var(--x, 0) var(--y, 0);
		color: var(--color-text);
		font-family: var(--font-sans);
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		filter: drop-shadow(0 12px 28px rgb(3 5 14 / 55%)) drop-shadow(0 1px 1px rgb(3 5 14 / 45%));
		opacity: 0;
		transition:
			opacity 120ms ease,
			translate 160ms cubic-bezier(0.16, 1, 0.3, 1),
			display 120ms allow-discrete,
			overlay 120ms allow-discrete;
	}

	.stub:popover-open {
		opacity: 1;
	}

	@starting-style {
		.stub:popover-open {
			opacity: 0;
			translate: var(--x, 0) calc(var(--y, 0px) + var(--enter-dy));
		}
	}

	.stub.is-below {
		--enter-dy: -4px;
	}

	/* Each kind is tinted in the paint its own cell wears, so the panel and the strip read
	   as the same object seen twice. */
	.stub-flight {
		--stub-tint: var(--color-accent-muted);
		--stub-rail: var(--color-accent);
	}

	.stub-stopover {
		--stub-tint: var(--color-stopover-bg);
		--stub-rail: var(--color-stopover);
		--stub-rail-style: dashed;
	}

	/* An airline the traveller asked to avoid: the tint steps back exactly as the strip's
	   cells do, and the text does not. They opened this panel on purpose; greying what
	   somebody asked to read is the opposite of quiet. */
	.is-quiet.stub-flight,
	.is-quiet.stub-stopover {
		--stub-tint: var(--color-bg-inset);
		--stub-rail: var(--color-border-strong);
	}

	@media (prefers-color-scheme: light) {
		.stub {
			--stub-bg: var(--color-surface);
			filter: drop-shadow(0 10px 24px rgb(19 24 41 / 16%)) drop-shadow(0 1px 1px rgb(19 24 41 / 10%));
		}
	}

	.stub-top,
	.stub-bottom {
		position: relative;
		border: 1px solid var(--color-border-strong);
		padding: var(--space-3) var(--space-4);
	}

	/* The two rounded inner corners meet the two below them, and the four quarter-circles
	   between them are the die-cut notch. Nothing here is measured against the content. */
	.stub-top {
		background: var(--stub-tint);
		border-bottom: 0;
		border-radius: var(--radius-md) var(--radius-md) 7px 7px;
	}

	.stub-bottom {
		background: var(--stub-bg);
		border-top: 2px dashed var(--color-border-strong);
		border-radius: 7px 7px var(--radius-md) var(--radius-md);
	}

	/* Only when neither side of the strip has room for the whole panel. The top half keeps
	   its size: it is what the panel is about. */
	.stub-body {
		max-height: var(--stub-body-max, none);
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	/* Painted after its own box so it covers the border it hangs from, and `left`
	   transitions so the tail glides when the panel moves between two segments. */
	.stub-tail {
		position: absolute;
		left: var(--tail-x);
		bottom: -7px;
		width: 12px;
		height: 12px;
		background: var(--stub-bg);
		border: 1px solid var(--color-border-strong);
		border-width: 0 1px 1px 0;
		rotate: 45deg;
		translate: -50% 0;
		transition: left 160ms cubic-bezier(0.16, 1, 0.3, 1);
	}

	.is-below .stub-tail {
		top: -7px;
		bottom: auto;
		background: var(--stub-tint);
		border-width: 1px 0 0 1px;
	}

	.stub p {
		margin: 0;
	}

	.stub-eyebrow {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-2);
		font-family: var(--font-mono);
		font-size: 0.625rem;
		font-weight: var(--font-weight-semibold);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-text-muted);
	}

	/* The strip cell's own paint, hatching and dashes included, so the key still says
	   "wait" or "stopover" on a card whose colour has gone quiet. */
	.stub-key {
		display: inline-block;
		width: 14px;
		height: 8px;
		margin-right: var(--space-1);
		border-radius: 2px;
		vertical-align: -1px;
	}

	.stub-flight .stub-key {
		background: var(--color-accent-muted);
		box-shadow: inset 0 0 0 1px var(--color-accent);
	}

	.stub-stopover .stub-key {
		background: var(--color-stopover-bg);
		border: 1px dashed var(--color-stopover);
	}

	.stub-wait .stub-key {
		background:
			repeating-linear-gradient(135deg, var(--color-border-strong) 0 1px, transparent 1px 3px),
			var(--color-bg-inset);
		box-shadow: inset 0 0 0 1px var(--color-border);
	}

	.stub-transport .stub-key {
		background: var(--color-border-strong);
	}

	.stub-title {
		margin-top: var(--space-1);
		font-family: var(--font-sans);
		font-size: var(--font-size-base);
		font-weight: var(--font-weight-semibold);
		line-height: 1.25;
		letter-spacing: var(--tracking-tight);
		text-wrap: balance;
	}

	.stub-stopover .stub-title {
		color: var(--color-stopover);
	}

	.is-quiet.stub-stopover .stub-title {
		color: var(--color-text-deprioritized);
	}

	.stub-note {
		margin-top: var(--space-1);
		font-size: 0.6875rem;
		line-height: 1.35;
		color: var(--color-text-muted);
	}

	.stub-note.is-warning {
		color: var(--color-warning);
	}

	/* The two clocks are the loudest thing on the panel, ahead of the title: the strip is a
	   picture of time and this is where the picture becomes numbers. */
	.stub-times {
		display: grid;
		grid-template-columns: auto minmax(3rem, 1fr) auto;
		column-gap: var(--space-2);
		align-items: start;
		margin-top: var(--space-2);
	}

	.stub-time {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.stub-time-end {
		text-align: right;
	}

	.stub-clock {
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		font-size: var(--font-size-xl);
		line-height: 1.1;
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-tight);
		white-space: nowrap;
	}

	/* A lost night is the one thing this app must never let a reader miss, so the stamp is
	   a mark beside the clock rather than another muted line under it. */
	.stub-plusday {
		margin-left: 0.15em;
		font-size: 0.625rem;
		vertical-align: super;
		color: var(--color-warning);
	}

	.stub-place {
		font-size: 0.6875rem;
		line-height: 1.3;
		color: var(--color-text-muted);
	}

	.stub-place b {
		font-family: var(--font-mono);
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-wide);
		color: var(--color-text);
	}

	/* The duration sits on the rail between the clocks, the way a boarding pass draws a
	   leg. The label's own background is the tint, which is what breaks the line. */
	.stub-rail {
		align-self: start;
		margin-top: 0.7rem;
		height: 0;
		border-top: 1px var(--stub-rail-style) var(--stub-rail);
		text-align: center;
	}

	.stub-rail > span {
		position: relative;
		top: -0.55rem;
		padding: 0 var(--space-2);
		background: var(--stub-tint);
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.stub-facts {
		display: grid;
		grid-template-columns: minmax(0, auto) minmax(0, 1fr);
		row-gap: var(--space-1);
		column-gap: var(--space-3);
		margin: 0;
	}

	.stub-facts dt {
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.stub-facts dd {
		margin: 0;
		overflow-wrap: anywhere;
		font-variant-numeric: tabular-nums;
	}

	/* A number nobody gave us, muted so it does not read as a value. Never blank and never
	   zero (issue #204). "No fare" is deliberately NOT this: walking being free is a fact
	   this app knows, and it prints in the ordinary text colour.
	   `--color-text-faint` is not used anywhere on this panel: it measures about 4.1:1 on
	   `--color-surface-hover`, which fails AA at this size. */
	.stub-facts dd.is-unknown {
		color: var(--color-text-muted);
	}

	/* The stopover's counterfoil is StopoverBlock, whose top rule would draw a second line
	   directly under the perforation. */
	.stub-body :global(.stopover) {
		padding-top: 0;
		border-top: 0;
	}

	/* The distances sit under the block rather than inside it, so they need the rule the
	   block's own top border would otherwise have given them. */
	.stub-facts.after-block {
		margin-top: var(--space-3);
		padding-top: var(--space-2);
		border-top: 1px solid var(--color-border);
	}
</style>
