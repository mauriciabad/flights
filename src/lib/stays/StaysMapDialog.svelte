<script lang="ts">
	/**
	 * Every stay near this connection, on one map, with the one you point at open beside it.
	 *
	 * Issue #319, the owner: **"there should be a map i can expand with all the locations,
	 * and each point should be clicked to show the hotel info in a sidebar on the same
	 * dialog."** The last four words are the requirement. Comparing two properties is one
	 * click and then one more click, never open, read, close, open.
	 *
	 * ## The shape is the one accommodation search settled on
	 *
	 * List and details beside a map: the list of candidates on the left, the map on the
	 * right, selecting either one selecting the other, and the detail replacing the list in
	 * the same panel rather than opening on top of it. Two things in that pattern are easy
	 * to get wrong and both are handled below. Leaving a detail restores the extent the
	 * reader came from, so they do not lose their place on the map. And the detail needs
	 * more horizontal room than the list, so below 52rem the panel stops being a side and
	 * becomes the lower half, which `MapDialog` now applies to every map dialog in the app.
	 *
	 * ## The surface itself is `MapDialog`
	 *
	 * Issue #324 extracted the near-fullscreen shell this file shipped with, which was a
	 * verbatim copy of `RouteMapDialog`'s and was about to be copied a third time. The margin
	 * token, the safe-area insets, the scrim tint, the focus restore, the body scroll lock,
	 * the 52rem split worked out below, and the "existing is being open" lifecycle all live
	 * there now, with the argument for each. That lifecycle is load-bearing rather than
	 * stylistic: `StaysMap` holds the only MapLibre instance on the page, so mounting is
	 * creation and unmounting is `map.remove()`, with no second source of truth that could
	 * leave one behind. Issue #280 measured what happens when they accumulate; Chromium
	 * evicts the oldest past sixteen live WebGL contexts and the map simply goes blank, an
	 * hour after the dialogs that caused it.
	 *
	 * ## The sidebar list carries no photographs, on purpose
	 *
	 * Hostelworld is the keyless default and serves the photographer's originals - 2.8 MB,
	 * no resize, no CDN (issue #284). A thumbnail on every row of a thirty-property list
	 * would fetch one per visible row for a panel the reader is scanning by name and price.
	 * So the list is text, and the only photographs in this dialog are the open property's,
	 * one at a time, behind a click that already says the traveller is interested. Nothing
	 * is fetched here until a point is chosen.
	 */
	import { Button, Icon, MapDialog } from '$lib/components';
	import type { Airport, Stay } from '$lib/domain';
	import { formatPropertyRating } from '$lib/format';
	import { describePriceComparison, stayDistances, type StayChoice } from './choice';
	import PhotoCarousel from './PhotoCarousel.svelte';
	import { formatMoney } from './pricing';
	import StaysMap from './StaysMap.svelte';

	interface Props {
		choices: readonly StayChoice[];
		connectionAirport: Airport;
		nights: number;
		/** Picks a property's cheapest bookable room without closing the dialog: the whole
		 * point of the sidebar is comparing, and every delta on screen re-bases on the new
		 * pick the moment it lands, which is what "the difference from the currently picked"
		 * means. */
		onchoose: (stay: Stay) => void;
		/** Fired for every way out: Escape, the close button, the backdrop. The parent stops
		 * rendering this component in response, which is what closes it. */
		onclose: () => void;
	}

	let { choices, connectionAirport, nights, onchoose, onclose }: Props = $props();

	/** The property whose detail the sidebar shows, or `null` for the list. Starts at the
	 * list: the dialog is "all the locations" first, which is what the owner asked to be
	 * able to expand, and one click from there is any of them. */
	let selectedKey = $state<string | null>(null);

	const open = $derived(choices.find((choice) => choice.key === selectedKey));
	const openDelta = $derived(open ? describePriceComparison(open.comparison, nights) : undefined);

</script>

<MapDialog title="Stays near {connectionAirport.city.name}" {onclose} class="stays-dialog">
	{#snippet panel()}
		<div class="stays-sidebar" data-testid="stays-sidebar">
			{#if open}
				<button type="button" class="stays-back" onclick={() => (selectedKey = null)}>
					<Icon name="chevron-left" />
					All {choices.length} stays
				</button>

				<!-- Keyed on the property, for the reason `StopoverBlock` keys its own copy:
				     `PhotoCarousel` counts which photograph the reader has reached, and
				     carrying that count from one hostel to the next opens the new one on its
				     second picture and fetches it unasked. Two clicks around this sidebar is
				     exactly the journey that would do it. -->
				{#key open.key}
					<PhotoCarousel images={open.property.images} name={open.property.name} />
				{/key}

				<h3 class="stays-detail-name">
					{open.property.name}
					{#if open.property.rating !== undefined}
						<span class="stays-detail-rating font-mono tabular-nums"
							>{formatPropertyRating(open.property.rating)}</span
						>
					{/if}
				</h3>

				{#if open.isPicked || open.property.womenOnly}
					<p class="stays-detail-tags">
						{#if open.isPicked}<span class="stays-tag is-picked">Current pick</span>{/if}
						{#if open.property.womenOnly}<span class="stays-tag">Women only</span>{/if}
					</p>
				{/if}

				<dl class="stays-detail-rail">
					{#each stayDistances(open) as line (line.from)}
						<div class="stays-figure">
							<dt class="stays-figure-label font-mono">From {line.from}</dt>
							<dd class="stays-figure-value font-mono tabular-nums">{line.distance}</dd>
						</div>
					{/each}
					{#if open.cheapest}
						<div class="stays-figure">
							<dt class="stays-figure-label font-mono">Per night</dt>
							<dd class="stays-figure-value font-mono tabular-nums">
								{formatMoney(open.cheapest.stay.pricePerNight)}
							</dd>
						</div>
					{/if}
					{#if open.total && nights > 0}
						<div class="stays-figure">
							<dt class="stays-figure-label font-mono">{nights} {nights === 1 ? 'night' : 'nights'}</dt>
							<dd class="stays-figure-value font-mono tabular-nums">{formatMoney(open.total)}</dd>
						</div>
					{/if}
				</dl>

				{#if openDelta}
					<p class={['stays-detail-delta', { 'is-cheaper': openDelta.cheaper }]}>
						{openDelta.headline}{#if openDelta.overStay}<span class="stays-detail-delta-stay"
								>{openDelta.overStay}</span
							>{/if}
					</p>
				{/if}

				{#if open.unavailableReason}
					<p class="stays-detail-note">{open.unavailableReason}</p>
				{:else if open.cheapest && !open.isPicked}
					{@const room = open.cheapest.stay}
					<Button fullWidth onclick={() => onchoose(room)}>Use this stay</Button>
				{/if}
			{:else}
				<p class="stays-sidebar-lead">
					Pick a point on the map, or a row here, to see that property. Prices compare against the
					stay this trip books now.
				</p>
				<ul class="stays-list">
					{#each choices as choice (choice.key)}
						{@const delta = describePriceComparison(choice.comparison, nights)}
						<li>
							<button
								type="button"
								class={['stays-row', { 'is-picked': choice.isPicked }]}
								onclick={() => (selectedKey = choice.key)}
							>
								<span class="stays-row-name">{choice.property.name}</span>
								<span class="stays-row-meta">{stayDistances(choice)[0].distance} from airport</span>
								{#if choice.cheapest}
									<span class="stays-row-price font-mono tabular-nums">
										{formatMoney(choice.cheapest.stay.pricePerNight)}<span class="stays-row-unit"
											>/night</span
										>
									</span>
								{/if}
								{#if choice.isPicked}
									<span class="stays-row-delta is-current">Current pick</span>
								{:else if delta}
									<span class={['stays-row-delta', { 'is-cheaper': delta.cheaper }]}>{delta.headline}</span>
								{:else if choice.unavailableReason}
									<!-- `rank.ts` sorts a property nobody in this group can book last rather
									     than dropping it, so the map shows its point and this row has to say
									     why there is no price beside it. -->
									<span class="stays-row-delta is-unavailable">Can't book</span>
								{/if}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>

	{/snippet}
	{#snippet map()}
		<div class="stays-dialog-map">
			<StaysMap {choices} airport={connectionAirport} bind:selectedKey />
		</div>
	{/snippet}
</MapDialog>

<style>
	/* The sidebar's own scroll and rhythm. Everything about the surface it sits in, the
	   near-fullscreen margin, the head, the close button and the 52rem split, is
	   `MapDialog`'s (issue #324). This file used to carry a copy of all of it. */
	.stays-sidebar {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		min-height: 0;
		height: 100%;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding-right: var(--space-1);
	}

	.stays-dialog-map {
		height: 100%;
	}

	.stays-back:focus-visible,
	.stays-row:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	.stays-sidebar-lead {
		margin: 0;
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-muted);
	}

	.stays-back {
		display: inline-flex;
		align-self: flex-start;
		align-items: center;
		gap: var(--space-2);
		min-height: 2.75rem;
		padding: 0 var(--space-3) 0 var(--space-2);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-full);
		background: var(--color-surface);
		color: var(--color-text);
		font: inherit;
		font-size: var(--font-size-xs);
		cursor: pointer;
		touch-action: manipulation;
	}

	.stays-back:hover {
		border-color: var(--color-border-strong);
	}

	.stays-back :global(svg) {
		width: 0.75rem;
		height: 0.75rem;
	}

	.stays-detail-name {
		margin: 0;
		font-size: var(--font-size-base);
		font-weight: var(--font-weight-semibold);
		line-height: var(--line-height-sm);
		/* Provider free text, some of it very long with nothing to break on. */
		overflow-wrap: anywhere;
	}

	.stays-detail-rating {
		margin-left: var(--space-2);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
		color: var(--color-text-muted);
	}

	.stays-detail-tags {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin: 0;
	}

	.stays-tag {
		padding: 2px var(--space-2);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-full);
		font-size: 0.625rem;
		font-weight: var(--font-weight-medium);
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-muted);
	}

	.stays-tag.is-picked {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}

	.stays-detail-rail {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(6rem, 1fr));
		gap: var(--space-2) var(--space-3);
		margin: 0;
	}

	.stays-figure {
		min-width: 0;
	}

	.stays-figure-label {
		font-size: 0.625rem;
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-muted);
	}

	.stays-figure-value {
		margin: 0;
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
	}

	/* The answer the traveller came for, so it is the loudest line in the panel after the
	   name. Sign as well as colour, since colour is never the only channel (WCAG 1.4.1). */
	.stays-detail-delta {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0 var(--space-2);
		margin: 0;
		font-size: var(--font-size-base);
		font-weight: var(--font-weight-semibold);
		font-variant-numeric: tabular-nums;
		color: var(--color-text);
	}

	.stays-detail-delta.is-cheaper {
		color: var(--color-success);
	}

	.stays-detail-delta-stay {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-regular);
		color: var(--color-text-muted);
	}

	.stays-detail-note {
		margin: 0;
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-muted);
	}

	.stays-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* Placed rather than auto-flowed. A property this group cannot book has no price cell,
	   and under auto-placement its distance would slide up into the money column. */
	.stays-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: baseline;
		gap: 0 var(--space-2);
		width: 100%;
		min-height: 44px;
		padding: var(--space-2);
		text-align: left;
		border: 1px solid transparent;
		border-radius: var(--radius-md);
		background: none;
		color: var(--color-text);
		font: inherit;
		cursor: pointer;
		touch-action: manipulation;
	}

	.stays-row:hover {
		background: var(--color-surface-hover);
	}

	.stays-row.is-picked {
		border-color: var(--color-accent);
	}

	.stays-row-name {
		grid-area: 1 / 1;
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-medium);
		overflow-wrap: anywhere;
	}

	.stays-row-price {
		grid-area: 1 / 2;
		font-size: var(--font-size-sm);
		white-space: nowrap;
	}

	.stays-row-unit,
	.stays-row-meta {
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}

	.stays-row-meta {
		grid-area: 2 / 1;
	}

	.stays-row-delta {
		grid-area: 2 / 2;
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
		font-variant-numeric: tabular-nums;
		text-align: right;
		white-space: nowrap;
	}

	.stays-row-delta.is-cheaper {
		color: var(--color-success);
	}

	.stays-row-delta.is-unavailable {
		color: var(--color-text-faint);
	}

	.stays-row-delta.is-current {
		font-family: var(--font-mono);
		font-size: 0.625rem;
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		color: var(--color-accent);
	}
</style>
