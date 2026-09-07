<script lang="ts">
	/**
	 * The trips this browser has kept, in a line each.
	 *
	 * It sits above `RecentSearches` on the search screen, because a trip somebody pressed a
	 * heart on is a stronger intent than a search they happened to run, and the two together
	 * are what a returning traveller opens the app for. A row goes back to the search that
	 * found it, which is also what puts a fresh price in the log.
	 *
	 * The full ledger, with every price and what each one was made of, is `/saved/`. This is
	 * the doorway to it, so it shows the newest few and links onward rather than repeating
	 * the whole thing on a screen whose job is starting a search.
	 *
	 * Nothing renders until `onMount`, for the same reason `RecentSearches` waits: the store
	 * reads `localStorage` in its constructor, which is empty during prerender and full a
	 * millisecond later in a browser, and rendering the difference is a hydration mismatch.
	 */
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { Icon } from '$lib/components';
	import { formatMoney } from '$lib/format';
	import { savedItineraries } from './store.svelte';
	import { priceTrend, summarizeSavedItinerary, trendNote } from './summary';
	import type { SavedSummary, TrendNote } from './summary';
	import type { Money } from '$lib/domain';

	interface Row {
		id: string;
		query: string;
		summary: SavedSummary;
		latest?: Money;
		note?: TrendNote;
	}

	interface Props {
		title?: string;
		class?: string;
		/** How many to draw before the header's link takes over. Three is a glance; the rest
		 * are one tap away. */
		limit?: number;
	}

	let { title = 'Saved trips', class: className, limit = 3 }: Props = $props();

	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});

	const entries = $derived(mounted ? savedItineraries.entries : []);

	const rows = $derived.by<Row[]>(() =>
		entries.slice(0, limit).map((entry) => {
			const trend = priceTrend(entry.prices);
			return {
				id: entry.id,
				query: entry.query,
				summary: summarizeSavedItinerary(entry),
				latest: entry.prices.at(-1)?.total,
				note: trendNote(trend)
			};
		})
	);
</script>

{#if rows.length > 0}
	<section class={['saved', className]} aria-labelledby="saved-trips-title">
		<div class="saved-head">
			<h2 id="saved-trips-title">
				<Icon name="heart" class="saved-mark" />
				{title}
			</h2>
			<a class="saved-all" href={`${base}/saved/`}>
				{entries.length === 1 ? '1 saved trip' : `All ${entries.length} saved trips`}
			</a>
		</div>
		<ul>
			{#each rows as row (row.id)}
				<li>
					<a class="saved-entry" href={`${base}/results/?${row.query}`} aria-label={row.summary.label}>
						<span class="saved-route font-mono">
							{row.summary.originAirport}<span class="arrow" aria-hidden="true">&rarr;</span
							>{row.summary.connectionAirport}<span class="arrow" aria-hidden="true">&rarr;</span
							>{row.summary.destinationAirport}
						</span>
						<span class="saved-meta">{row.summary.dates} &middot; {row.summary.stopover}</span>
						{#if row.latest}
							<span class="saved-price font-mono tabular-nums">{formatMoney(row.latest)}</span>
						{/if}
						{#if row.note}
							<span class={['saved-note', `is-${row.note.direction}`]}>{row.note.short}</span>
						{/if}
					</a>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<style>
	.saved {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.saved-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.saved-head h2 {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-faint);
	}

	/* The heart is the one thing that says which list this is, so it carries the accent
	   rather than the heading's own quiet grey. */
	.saved-head :global(.saved-mark) {
		--icon-size: 0.9375rem;
		color: var(--color-accent);
	}

	.saved-all {
		/* 44px of height, per WCAG 2.5.5, without pushing the row apart: the padding is
		   vertical space this header already has above and below it. */
		display: flex;
		align-items: center;
		min-height: 2.75rem;
		padding-inline: var(--space-2);
		margin-inline-end: calc(var(--space-2) * -1);
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
		text-decoration: underline;
		text-underline-offset: 0.2em;
	}

	.saved-all:hover {
		color: var(--color-text);
	}

	.saved-all:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
		border-radius: var(--radius-sm);
	}

	ul {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	li {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		/* The kept edge, in the accent rather than the stopover teal `RecentSearches` uses.
		   A used ticket stub and a ticket you put in your pocket are different objects, and
		   the colour is the only thing that says which is which at a glance. */
		border-left: 3px solid var(--color-accent);
	}

	/* Two columns on a phone: the trip on the left, its price on the right. The price is
	   what makes this list worth having, so it holds a column of its own rather than
	   trailing the meta line. */
	.saved-entry {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: baseline;
		column-gap: var(--space-3);
		row-gap: var(--space-1);
		padding: var(--space-3) var(--space-4);
		color: var(--color-text);
		text-decoration: none;
		border-radius: var(--radius-md);
	}

	.saved-entry:hover {
		background: var(--color-surface-hover);
	}

	.saved-entry:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: -2px;
	}

	.saved-route {
		grid-column: 1;
		font-size: var(--font-size-lg);
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-tight);
	}

	.arrow {
		padding-inline: var(--space-1);
		color: var(--color-stopover);
	}

	.saved-meta {
		grid-column: 1;
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.saved-price {
		grid-column: 2;
		grid-row: 1;
		font-size: var(--font-size-lg);
		font-weight: var(--font-weight-semibold);
		text-align: end;
	}

	.saved-note {
		grid-column: 2;
		grid-row: 2;
		font-size: var(--font-size-sm);
		text-align: end;
		color: var(--color-text-muted);
	}

	/* Colour repeats the word, never replaces it: "€6.00 cheaper" says the same thing to a
	   reader who cannot tell these two apart. */
	.saved-note.is-cheaper {
		color: var(--color-success);
	}

	.saved-note.is-dearer {
		color: var(--color-danger);
	}
</style>
