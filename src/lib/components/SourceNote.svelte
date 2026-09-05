<script lang="ts">
	/**
	 * Where a card's figures came from and when each source was retrieved, behind one small
	 * control. Issue #312.
	 *
	 * The owner, reading the footer this replaces: "The footer of the card is unnecssary
	 * `TUI Airways easyJet via Transitous, fetched 5 minutes ago; Kiwi.com (no key required)
	 * & Hostelworld (no key required), fetched 6 minutes ago; OSRM (walking & driving),
	 * fetched 21 hours ago` the text is elipsed and cant be ssen, the fetched times could be
	 * a tooltip that shows on a small icon somewhere else int eh crd that doesnt take up much
	 * space."
	 *
	 * The agent that shipped #289 predicted this and said so at the time: at 375px that row
	 * showed about a tenth of its text whatever it said, and #289 made the string longer,
	 * because grouping sources by age is more honest and more words. The information is worth
	 * keeping. A full-width line of ellipsised prose is not.
	 *
	 * ## Why a disclosure and not a `title`
	 *
	 * A `title` attribute is not a tooltip. It does not open on touch at all, and this is a
	 * phone problem first, so the old row's fallback was no fallback for the reader who
	 * needed it. This is a real `<button>` with `aria-expanded`, so it opens by tap, by
	 * pointer and by keyboard, which is the only pattern that serves all three.
	 *
	 * `popover="auto"` in the top layer brings three behaviours that would otherwise be
	 * hand-written and is what `SegmentStub` already uses on this page for the same reasons:
	 * Escape closes it, a press outside dismisses it, and opening one auto popover closes
	 * every other, so a second card's panel closes the first with no bookkeeping between
	 * cards that know nothing about each other. That covers WCAG 1.4.13's Dismissible; the
	 * pointer handlers below cover Hoverable, since the panel stays open while the pointer is
	 * on it; and nothing closes it on a timer, which covers Persistent.
	 *
	 * Positioning is measured rather than declared, the same choice and the same reason as
	 * `SegmentStub`: CSS anchor positioning would replace `place()`, and Firefox in the field
	 * does not have it.
	 *
	 * ## What stays on the card
	 *
	 * Nothing in here is the staleness signal. The brief requires stale cached results to be
	 * marked visibly, and a fact reachable only by a deliberate tap is not marked, so the
	 * caller prints `describeStaleSources` beside this control and this component never has
	 * to know about it.
	 *
	 * ## It changes while the traveller watches
	 *
	 * #293 made a card follow the refetch it started, so these ages move: measured, a card
	 * goes from "fetched 1 hour ago" to "fetched this minute" over the first 1.5 seconds.
	 * Nothing here snapshots `groups`; it is a prop, re-derived by the card on every
	 * revalidation, and re-measured on the next open. Caching it anywhere would put back
	 * exactly the defect #293 removed.
	 */
	import type { SourceGroup } from '$lib/results/view-model';
	import Icon from './Icon.svelte';

	interface Props {
		/** Freshest group first, from `describeSourceGroups`. */
		groups: SourceGroup[];
		/** The whole sentence, for the control's accessible name: a reader who never opens
		 * the panel still hears what it would have said. */
		summary: string;
	}

	let { groups, summary }: Props = $props();

	const panelId = $props.id();
	let panel = $state<HTMLElement>();
	let trigger = $state<HTMLButtonElement>();

	/**
	 * How the panel that is up got there, `null` when it is down.
	 *
	 * A boolean cannot express this and the difference is the whole interaction. A pointer
	 * that hovers this control opens it, and the click that follows must PIN it rather than
	 * toggle it shut: with a plain boolean the sequence hover-then-click opened and closed in
	 * one gesture, and because the pointer was still on the button afterwards no second
	 * `pointerenter` ever arrived, so the panel stayed down until the reader moved away and
	 * came back. Leaving is likewise only allowed to close what hovering opened.
	 *
	 * `TripStrip` keeps the same state for the same reason and calls it the same thing.
	 */
	let openedBy = $state<'hover' | 'focus' | 'press' | null>(null);
	const open = $derived(openedBy !== null);

	/** Clear between the panel and the control it belongs to. */
	const GAP = 8;
	/** How close the panel may come to the edge of the window. */
	const EDGE = 8;

	function place(element: HTMLElement, anchor: HTMLElement) {
		const button = anchor.getBoundingClientRect();
		const rect = element.getBoundingClientRect();
		// Right-aligned to the control, which sits at the right end of the footer, then
		// clamped so a narrow phone never pushes it off either edge.
		const left = Math.min(
			Math.max(button.right - rect.width, EDGE),
			Math.max(EDGE, window.innerWidth - rect.width - EDGE)
		);
		const above = button.top - GAP - rect.height >= EDGE;
		element.style.setProperty('--x', `${Math.round(left)}px`);
		element.style.setProperty(
			'--y',
			`${Math.round(above ? button.top - GAP - rect.height : button.bottom + GAP)}px`
		);
	}

	// Measures and calls two DOM methods, and the state it writes (`open`) it does not read
	// back into a fetch, so it cannot retrigger itself (AGENTS.md, the `$effect` trap).
	$effect(() => {
		const element = panel;
		// Read so a group changing under a revalidation re-measures against the same control:
		// the panel's own height is what decides which side of it there is room on.
		const content = groups;
		if (!element || content.length === 0) return;
		const showing = element.matches(':popover-open');
		if (openedBy === null || !trigger) {
			if (showing) element.hidePopover();
			return;
		}
		if (!showing) element.showPopover();
		place(element, trigger);
	});

	function onToggle(event: ToggleEvent) {
		// The browser dismissed it: Escape, or a press outside. This component owns the state,
		// so it has to be told rather than left believing a panel is up.
		if (event.newState === 'closed') openedBy = null;
	}

	function onPress() {
		// A second deliberate press closes it. A press on a panel that hover or focus opened
		// pins it instead, which is what stops one gesture doing both.
		openedBy = openedBy === 'press' ? null : 'press';
	}

	/**
	 * Hover opens this, and a tap must not.
	 *
	 * On a touch screen the sequence for one tap is `pointerenter`, then focus, then `click`.
	 * Treating the first two as "the reader is looking at this" set `open` before the click
	 * arrived, and the click then toggled it straight back off, so the panel could not be
	 * opened by tap at all. That is the whole issue happening again in a new place: the phone
	 * is the case this control exists for.
	 *
	 * So hover is `mouse` only, and focus counts only when the browser itself calls it
	 * keyboard focus. `:focus-visible` is exactly that judgement and the browser is better
	 * placed to make it than a heuristic here.
	 */
	function onPointerEnter(event: PointerEvent) {
		if (event.pointerType !== 'mouse') return;
		if (openedBy === null) openedBy = 'hover';
	}

	function onPointerLeave(event: PointerEvent) {
		if (event.pointerType !== 'mouse') return;
		if (openedBy === 'hover') openedBy = null;
	}

	function onTriggerFocus(event: FocusEvent & { currentTarget: HTMLButtonElement }) {
		if (openedBy === null && event.currentTarget.matches(':focus-visible')) openedBy = 'focus';
	}

	function onTriggerBlur() {
		if (openedBy === 'focus') openedBy = null;
	}
</script>

{#if groups.length > 0}
	<button
		bind:this={trigger}
		type="button"
		class="source-note-trigger"
		aria-expanded={open}
		aria-label="Sources and when each was fetched: {summary}"
		aria-describedby={open ? panelId : undefined}
		onclick={onPress}
		onpointerenter={onPointerEnter}
		onpointerleave={onPointerLeave}
		onfocus={onTriggerFocus}
		onblur={onTriggerBlur}
	>
		<Icon name="clock" />
	</button>

	<div
		bind:this={panel}
		id={panelId}
		popover="auto"
		role="tooltip"
		class="source-note"
		ontoggle={onToggle}
		onpointerenter={onPointerEnter}
		onpointerleave={onPointerLeave}
	>
		<p class="source-note-title">Where these figures come from</p>
		<dl class="source-note-groups">
			{#each groups as group (group.age)}
				<dt>{group.sources.join(', ')}</dt>
				<dd>fetched {group.age}</dd>
			{/each}
		</dl>
	</div>
{/if}

<style>
	/* A 24px target out of a 14px glyph, which is SC 2.5.8's floor, reached with padding and
	   taken back off the footer's height with a matching negative margin: this row is one
	   line and the whole point of the change is that it stops costing more than that. */
	.source-note-trigger {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 1.5rem;
		height: 1.5rem;
		margin: -0.25rem 0;
		padding: 0;
		border: 0;
		border-radius: var(--radius-full);
		background: none;
		color: var(--color-text-faint);
		cursor: pointer;
		transition: color var(--transition-fast);
	}

	.source-note-trigger {
		--icon-size: 0.875rem;
	}

	.source-note-trigger:hover,
	.source-note-trigger[aria-expanded='true'] {
		color: var(--color-text);
	}

	.source-note-trigger:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	/* `left`/`top` stay at 0 and the position is a translate, the same arrangement
	   `SegmentStub` uses, so the panel glides on the compositor rather than relayouting. The
	   popover UA styles are reset on the same declarations. */
	.source-note {
		position: fixed;
		inset: auto;
		left: 0;
		top: 0;
		translate: var(--x, 0) var(--y, 0);
		width: max-content;
		max-width: min(22rem, calc(100vw - 1rem));
		margin: 0;
		padding: var(--space-3);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-md);
		background: var(--color-surface);
		box-shadow: var(--shadow-md);
		color: var(--color-text);
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
	}

	.source-note-title {
		margin: 0 0 var(--space-2);
		font-family: var(--font-mono);
		font-size: 0.625rem;
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-wide);
		text-transform: uppercase;
		color: var(--color-text-muted);
	}

	/* One source group per row, name on the left and its age on the right, so a reader
	   comparing two ages reads down one edge rather than through a sentence. This is the
	   shape the ellipsised line could not have at any width. */
	.source-note-groups {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: var(--space-1) var(--space-4);
		margin: 0;
	}

	.source-note-groups dt {
		min-width: 0;
	}

	.source-note-groups dd {
		margin: 0;
		white-space: nowrap;
		color: var(--color-text-muted);
	}
</style>
