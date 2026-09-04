<script lang="ts">
	/**
	 * Issue #25: the comparator. One column per selected itinerary, aligned row-for-row
	 * with CSS subgrid so a flight sits beside a flight and a stopover beside a stopover,
	 * exactly the brief's "shows them in fullscreen as columns where the elements are
	 * aligned (subgrid)". Rendered at the persistent `/comparator/` tab the app shell
	 * already links to (`src/routes/+layout.svelte`'s own comment: "Every route below is
	 * owned by a different issue... #25"), not as a modal invoked from elsewhere, so this
	 * is a plain in-flow view, not a `<dialog>`.
	 *
	 * ROWS: ORDER-BASED, NOT TIME-PROPORTIONAL — the judgement call the issue asks for.
	 * A row's height comes from its content (`grid-template-rows: repeat(n, auto)`), shared
	 * across columns by subgrid so the tallest column at each row index sets that row's
	 * height everywhere. It does NOT scale with the segment's real duration. Two reasons:
	 *
	 * 1. Rows hold real controls, not just a duration figure. `origin-waiting` and
	 *    `connection-waiting` (ItineraryTimeline.svelte) are inline editors with 44px tap
	 *    targets (AGENTS.md-adjacent WCAG 2.5.5 note in that file). A 2-hour buffer sized
	 *    proportionally against a 3-day stopover would be a sliver a few pixels tall,
	 *    too small to hold a usable stepper, which defeats the point of reusing the
	 *    editable timeline here instead of a read-only summary.
	 * 2. Every row already prints its own real duration as text (formatDuration badges,
	 *    the free-time clock badges) — reused as-is from ItineraryTimeline, not
	 *    reimplemented here. Order-based rows do not hide magnitude, they just stop
	 *    encoding it spatially.
	 *
	 * The hybrid: the one place duration differences are genuinely easy to miss is the
	 * stopover, which is this whole app's pitch (AGENTS.md: "a trip for free"), so the
	 * shared footer below draws a small relative-share bar under each column's "Free time"
	 * total, scaled against the longest free time among the compared itineraries. It is a
	 * comparison aid next to a number, not a layout mechanism, so it never risks squeezing
	 * an editable control.
	 *
	 * SHARED SCROLL: there is no scroll-sync code. `.comparator-scroll` is the ONLY
	 * scrolling element (`overflow: auto` on both axes) and every column lives inside it as
	 * a cell of one grid, so scrolling it moves every column's rows and the pinned card/
	 * footer (`position: sticky`) together by construction — a mouse wheel, a keyboard
	 * (the container is focusable), and touch panning all drive the same one scrollport,
	 * so "locked" is a property of there being one scroll position, not two kept in sync.
	 *
	 * WHY `max-height: 70dvh` RATHER THAN A FLEX `flex: 1; min-height: 0` FILL: the app
	 * shell (`src/routes/+layout.svelte`) sizes its content row with `min-height: 100dvh`
	 * on the shell, not `height`, specifically so ordinary routes can grow taller than the
	 * viewport and let the page scroll, which is the correct default for a search form or a
	 * results list. `min-height` is not `height`: percentages and `flex-basis: 0` on a
	 * descendant have nothing definite to resolve against, so a naive "fill the remaining
	 * viewport" attempt here just measures its own content and grows the whole shell
	 * instead (verified empirically while building this: the shell's content row and the
	 * body both end up exactly as tall as this component's content, and nothing ever
	 * scrolls except the whole page — which also breaks `position: sticky` on the card and
	 * footer below, since their nearest actual scrolling ancestor turns out to be
	 * `.app-content`, and an ancestor that never itself overflows never "sticks" anything
	 * inside it). A viewport unit (`dvh`) is definite regardless of any ancestor's sizing,
	 * so capping `.comparator-scroll` at `70dvh` gives it real overflow to scroll on its own
	 * — which is what makes the sticky card and footer below work at all, not only what
	 * bounds the layout.
	 *
	 * GRID NESTING (three levels, each with a reason):
	 * - `.comparator-scroll` — the outer grid: N column tracks (one per itinerary),
	 *   3 implicit rows (top cards, the timelines, the footer), sized to content.
	 * - `.comparator-rows` — spans every column (`grid-column: 1 / -1`) and re-declares
	 *   those same N columns via `grid-template-columns: subgrid`, plus its OWN row
	 *   tracks (one per schedule segment). ItineraryTimeline's `subgrid` prop hardcodes
	 *   `grid-row: 1 / -1` on its `<ol>`, spanning every row of whichever grid contains
	 *   it — which is why the row tracks it aligns against have to live in a wrapper
	 *   dedicated to just the timelines, not the outer grid that also holds the card and
	 *   footer rows (that would make `1 / -1` span those too).
	 * - `.comparator-footer` — same `subgrid` trick for columns, one row, so each
	 *   itinerary's totals land under its own column without repeating the outer grid's
	 *   column sizes by hand.
	 * Column alignment across all three needs no explicit `grid-column` index anywhere:
	 * the same `items` array, in the same order, auto-places into column 1, 2, 3... in
	 * each of the three grids independently, the same trick ItineraryTimeline's own rows
	 * already rely on for row order.
	 */
	import type { Itinerary } from '../domain';
	import type { ComparedItinerary } from './comparator-types';
	import { formatRelativeFetchTime, providerDisplayName, relativeShare } from './comparator-format';
	import { formatDuration, formatMoney } from './itinerary-timeline-format';
	import Card from './Card.svelte';
	import Chip from './Chip.svelte';
	import EmptyState from './EmptyState.svelte';
	import ItineraryTimeline from './ItineraryTimeline.svelte';

	interface Props {
		items: ComparedItinerary[];
	}

	let { items }: Props = $props();

	/**
	 * Explicit keyboard scrolling for `.comparator-scroll`, rather than relying on a
	 * browser's own default handling of arrow/page keys on a focused scrollable region.
	 * That default exists in every real browser this app ships to, but it is exactly the
	 * kind of behaviour that is awkward to prove in a test (headless automation drives
	 * key events through the same DOM path a script would, and does not reliably trigger
	 * a browser's built-in scroll-on-keydown handling the way real input does) and issue
	 * #25 explicitly asks to verify keyboard scrolling, so this makes it code instead of
	 * an assumption. Guarded to `event.target === event.currentTarget` so a key press
	 * that bubbles up from a focused child — the waiting-time stepper's number input,
	 * which uses ArrowUp/ArrowDown itself to change its value — never gets hijacked into
	 * scrolling the page out from under it.
	 */
	function handleScrollKeydown(event: KeyboardEvent) {
		if (event.target !== event.currentTarget) return;
		const el = event.currentTarget as HTMLElement;
		const rowStep = 96; // roughly one timeline row's height, a comfortable nudge
		switch (event.key) {
			case 'ArrowDown':
				el.scrollBy({ top: rowStep });
				break;
			case 'ArrowUp':
				el.scrollBy({ top: -rowStep });
				break;
			case 'ArrowRight':
				el.scrollBy({ left: rowStep });
				break;
			case 'ArrowLeft':
				el.scrollBy({ left: -rowStep });
				break;
			case 'PageDown':
				el.scrollBy({ top: el.clientHeight * 0.9 });
				break;
			case 'PageUp':
				el.scrollBy({ top: -el.clientHeight * 0.9 });
				break;
			case 'Home':
				el.scrollTo({ top: 0 });
				break;
			case 'End':
				el.scrollTo({ top: el.scrollHeight });
				break;
			default:
				return; // leave Tab and everything else alone
		}
		event.preventDefault();
	}

	/** The row count every column's `<ol subgrid>` needs from `.comparator-rows` GRID's
	 * row tracks. Read from the first item only: the DOM contract ItineraryTimeline.svelte
	 * documents guarantees every itinerary compared side by side shares one SearchQuery, so
	 * origin/destination location presence — the only thing that changes row count — is
	 * identical across `items`, not something this component re-derives per column. */
	function rowCountFor(itinerary: Itinerary): number {
		const BASE_ROWS = 7; // origin-waiting, outbound-flight, transfer-to-hotel, free-time,
		// transfer-to-connection-airport, connection-waiting, onward-flight
		const ORIGIN_ROWS = itinerary.originLocation ? 2 : 0; // origin-location, transfer-to-origin-airport
		const DESTINATION_ROWS = itinerary.destinationLocation ? 2 : 0; // transfer + destination-location
		return BASE_ROWS + ORIGIN_ROWS + DESTINATION_ROWS;
	}

	const rowCount = $derived(items.length > 0 ? rowCountFor(items[0].itinerary) : 0);

	const maxFreeTime = $derived(
		items.reduce((max, item) => Math.max(max, item.itinerary.times.free), 0)
	);

	const columnTemplate = $derived(`repeat(${items.length}, minmax(min(22rem, 88vw), 1fr))`);
	const rowTemplate = $derived(`repeat(${rowCount}, auto)`);
</script>

<section class="comparator" aria-label="Itinerary comparator">
	{#if items.length === 0}
		<EmptyState
			title="Nothing to compare yet"
			description="Select a few itineraries from the results list to line them up here."
		/>
	{:else}
		<p class="comparator-status">
			Comparing {items.length}
			{items.length === 1 ? 'itinerary' : 'itineraries'}
		</p>

		<!-- The WAI-ARIA "scrollable region" pattern: tabindex so it is keyboard-reachable
		     and scrollable on its own, no more specific interactive role fits a region
		     that is not itself a single widget. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<div
			class="comparator-scroll"
			style:grid-template-columns={columnTemplate}
			tabindex="0"
			role="group"
			aria-label="Itinerary columns, scroll to compare"
			onkeydown={handleScrollKeydown}
		>
			{#each items as item (item.id)}
				<Card variant="ticket" class="comparator-card">
					<p class="comparator-card-eyebrow">
						Connecting through {item.itinerary.outboundFlight.arrivalAirport}
					</p>
					<div class="comparator-card-airlines">
						<Chip label={item.itinerary.outboundFlight.carrier.name} />
						{#if item.itinerary.onwardFlight.carrier.iataCode !== item.itinerary.outboundFlight.carrier.iataCode}
							<Chip label={item.itinerary.onwardFlight.carrier.name} />
						{/if}
					</div>
					{#if item.sources && item.sources.length > 0}
						<ul class="comparator-provenance">
							{#each item.sources as source (source.providerId + source.fetchedAt)}
								<li>
									via {providerDisplayName(source.providerId)}, {formatRelativeFetchTime(
										source.fetchedAt
									)}
								</li>
							{/each}
						</ul>
					{:else}
						<p class="comparator-note">Provider data not available yet.</p>
					{/if}
				</Card>
			{/each}

			<div class="comparator-rows" style:grid-template-rows={rowTemplate}>
				{#each items as item (item.id)}
					<ItineraryTimeline itinerary={item.itinerary} subgrid showTotals={false} class="comparator-column" />
				{/each}
			</div>

			<div class="comparator-footer">
				{#each items as item (item.id)}
					<dl class="comparator-footer-column">
						<div class="comparator-total">
							<dt>In-flight</dt>
							<dd class="font-mono tabular-nums">{formatDuration(item.itinerary.times.inFlight)}</dd>
						</div>
						<div class="comparator-total">
							<dt>Airport time</dt>
							<dd class="font-mono tabular-nums">{formatDuration(item.itinerary.times.airportWaiting)}</dd>
						</div>
						<div class="comparator-total">
							<dt>Free time</dt>
							<!-- The share bar lives inside this <dd>, not as a sibling <div> after it: a
							     <dl>'s div-wrapped dt/dd group may only contain dt/dd elements (HTML's own
							     content model for <dl>), and a stray div there is exactly what axe's
							     definition-list check flags. A <dd>'s own content model has no such limit. -->
							<dd class="font-mono tabular-nums">
								{formatDuration(item.itinerary.times.free)}
								<div
									class="comparator-share-track"
									role="img"
									aria-label="{formatDuration(item.itinerary.times.free)} free, {maxFreeTime > 0
										? Math.round(relativeShare(item.itinerary.times.free, maxFreeTime) * 100)
										: 0}% of the longest stopover being compared"
								>
									<span
										class="comparator-share-fill"
										style:width="{relativeShare(item.itinerary.times.free, maxFreeTime) * 100}%"
									></span>
								</div>
							</dd>
						</div>
						<div class="comparator-total">
							<dt>Nights</dt>
							<dd class="font-mono tabular-nums text-stopover">
								{item.itinerary.stay ? item.itinerary.nightsInConnection : 'No stay priced'}
							</dd>
						</div>
						<div class="comparator-total comparator-total-primary">
							<dt>Total price</dt>
							<dd class="font-mono tabular-nums">{formatMoney(item.itinerary.totalPrice)}</dd>
						</div>
					</dl>
				{/each}
			</div>
		</div>
	{/if}
</section>

<style>
	.comparator {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.comparator-status {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	/* The one scrolling element in the whole component. Both axes: horizontal to move
	   between columns (the brief's 375px requirement), vertical because a full itinerary
	   with every row expanded rarely fits in 70dvh. See this file's header comment on
	   `max-height: 70dvh` for why a viewport unit, not a flex fill, is what makes this
	   (and the sticky card/footer below) actually work under this app's shell. */
	.comparator-scroll {
		display: grid;
		max-height: 70dvh;
		overflow: auto;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
		gap: 0 var(--space-4);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		/* No bottom padding here: the sticky footer's `bottom: 0` sticks to this
		   container's padding edge, so a bottom inset here would leave a gap between
		   the footer and the container's true bottom edge with the not-yet-scrolled-to
		   row content underneath still visible through it. The footer supplies its own
		   padding-bottom instead, so its own opaque background covers that space. */
		padding: var(--space-4) var(--space-4) 0;
		background: var(--color-bg-inset);
	}

	.comparator-scroll:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: -2px;
	}

	/* Row 1 of the outer grid: one pinned card per column. `position: sticky` with only
	   `top` set sticks vertically as `.comparator-scroll` scrolls down, while still moving
	   normally with that same container's horizontal scroll — exactly "pinned to the top
	   of each column", not "pinned to the viewport corner". */
	:global(.comparator-card) {
		position: sticky;
		top: 0;
		/* Higher than ItineraryTimeline's own .tl-dot (z-index: 1): a sticky card or
		   footer here floats directly over rows that have not been scrolled past yet
		   (by design — see this file's SHARED SCROLL comment), so it has to fully
		   occlude them, not just paint before them in DOM order. Relying on DOM order
		   as a tie-break at equal z-index is what let a dot bleed through the footer
		   below before this was given the same treatment. */
		z-index: 2;
		margin-bottom: var(--space-4);
	}

	.comparator-card-eyebrow {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-faint);
	}

	.comparator-card-airlines {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}

	.comparator-provenance {
		margin-top: var(--space-3);
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}

	.comparator-note {
		margin-top: var(--space-3);
		font-size: var(--font-size-xs);
		font-style: italic;
		color: var(--color-text-faint);
	}

	/* Row 2: spans every column so it can re-declare them via subgrid for the timelines
	   nested inside it. See this file's header comment ("GRID NESTING") for why this
	   wrapper, rather than the outer grid, is what ItineraryTimeline's `subgrid` prop
	   actually aligns against. */
	.comparator-rows {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
		column-gap: var(--space-4);
	}

	:global(.comparator-column) {
		padding-bottom: var(--space-4);
		border-right: 1px dashed var(--color-border);
	}

	:global(.comparator-column:last-child) {
		border-right: none;
	}

	/* Row 3: the shared bottom bar ItineraryTimeline's own `showTotals` note describes —
	   one bar built here instead of one `<dl>` per column left inline after each timeline,
	   so it can be sticky at the bottom of `.comparator-scroll` regardless of how far the
	   rows above have scrolled. */
	.comparator-footer {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
		position: sticky;
		bottom: 0;
		z-index: 2; /* see .comparator-card's z-index comment above */
		margin-top: var(--space-4);
		padding: var(--space-4) 0; /* bottom half replaces .comparator-scroll's own, see its comment */
		border-top: 2px dashed var(--color-border-strong);
		background: var(--color-bg-inset);
	}

	.comparator-footer-column {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3) var(--space-3);
		border-right: 1px dashed var(--color-border);
	}

	.comparator-footer-column:last-child {
		border-right: none;
	}

	.comparator-total {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-1) var(--space-3);
	}

	.comparator-total dt {
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	.comparator-total dd {
		margin: 0;
		font-size: var(--font-size-sm);
		color: var(--color-text);
	}

	/* The Free time stat is the one row whose <dd> also holds the share bar below (see
	   the template comment on why the bar moved inside <dd>). Forcing that one <dd> onto
	   its own flex line reproduces the old layout, where the bar itself (then a sibling
	   flex item) was what forced the wrap. */
	.comparator-total:has(.comparator-share-track) dd {
		flex-basis: 100%;
	}

	.comparator-total-primary dd {
		font-size: var(--font-size-lg);
		font-weight: var(--font-weight-bold);
	}

	/* The one hybrid touch: a relative-share bar under Free time, scaled against the
	   longest stopover among the compared itineraries. See this file's header comment for
	   why this exists instead of scaling row heights themselves. No background track (see
	   web-design-guidelines: a filled track behind a partial fill reads as dashboard
	   clutter) — the bar's own width against the row's fixed max-width already reads as a
	   share once there is more than one column to compare it against. */
	.comparator-share-track {
		margin-top: var(--space-1);
		width: 100%;
		max-width: 8rem;
		height: 4px;
		border-radius: var(--radius-full);
		background: var(--color-bg-inset);
	}

	.comparator-share-fill {
		display: block;
		height: 100%;
		min-width: 2px;
		border-radius: var(--radius-full);
		background: var(--color-stopover);
	}

	@media (prefers-reduced-motion: no-preference) {
		.comparator-share-fill {
			transition: width var(--transition-base);
		}
	}
</style>
