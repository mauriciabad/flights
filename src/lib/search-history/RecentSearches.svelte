<script lang="ts">
	/**
	 * The searches this browser has run before, one tap from running again.
	 *
	 * It sits above the empty search form because that is where a returning visitor
	 * looks first, and because the alternative to remembering is retyping four fields to
	 * see a page you already saw this morning.
	 *
	 * Issue #351 gave it a second home, inside the editor the results page's summary bar
	 * opens, so a traveller comparing two trips does not have to retype one of them. There
	 * it is passed `currentQuery`. That is what tells the two homes apart. On the results
	 * page one of these searches is the page itself.
	 *
	 * Nothing renders until `onMount`. The store reads `localStorage` in its constructor,
	 * which is empty during prerender and full a millisecond later in the browser, and
	 * rendering the difference is how you get a hydration mismatch on a prerendered page.
	 */
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { Icon } from '$lib/components';
	import { buildSearchQuery } from '$lib/search-form/model';
	import { searchParamsToFields } from '$lib/search-form/url-codec';
	import { searchHistory } from './store.svelte';
	import { summarizeSearch } from './summary';

	/** One history entry, decoded and ready to draw. `current` is what the two homes of
	 * this list disagree about, so it rides with the row rather than being recomputed
	 * wherever the row is drawn. */
	interface Row {
		query: string;
		summary: ReturnType<typeof summarizeSearch>;
		current: boolean;
	}

	interface Props {
		title?: string;
		class?: string;
		/**
		 * The normalised query on screen right now, when this list is rendered beside its own
		 * results (issue #351). That entry becomes a label instead of a link: it is almost
		 * always in the history, and a link back to the page you are reading is a dead end.
		 * Absent on the search screen, where no search is on screen to be current.
		 */
		currentQuery?: string;
	}

	let { title = 'Recent searches', class: className, currentQuery }: Props = $props();

	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});

	const rows = $derived.by<Row[]>(() => {
		if (!mounted) return [];
		return searchHistory.entries
			.map((entry) => {
				const params = new URLSearchParams(entry.query);
				const query = buildSearchQuery(searchParamsToFields(params));
				// An entry that no longer decodes to a whole search cannot be replayed, so it
				// is skipped rather than rendered as a link that goes nowhere useful.
				if (!query) return undefined;
				return {
					query: entry.query,
					summary: summarizeSearch(query),
					current: entry.query === currentQuery
				};
			})
			.filter((row) => row !== undefined);
	});

	/**
	 * Issue #351: whether this list has anywhere to send anybody. One entry that is the
	 * search already on screen is a heading over a dead end, so the whole section stays
	 * away until there is a second search to go to.
	 */
	const hasSomewhereToGo = $derived(rows.some((row) => !row.current));
</script>

{#snippet trip(row: Row)}
	<span class="recent-top">
		<span class="recent-route font-mono">
			{row.summary.originAirport}<span class="arrow" aria-hidden="true">&rarr;</span><span
				class="visually-hidden"
			>
				to
			</span>{row.summary.destinationAirport}
		</span>
		{#if row.current}<span class="recent-here-tag">On screen now</span>{/if}
	</span>
	<span class="recent-meta">
		{row.summary.dates} &middot; {row.summary.travellers}
	</span>
{/snippet}

{#if hasSomewhereToGo}
	<section class={['recent', className]} aria-labelledby="recent-searches-title">
		<div class="recent-head">
			<h2 id="recent-searches-title">{title}</h2>
			<button type="button" class="clear-all" onclick={() => searchHistory.clear()}>
				Clear all
			</button>
		</div>
		<ul>
			{#each rows as row (row.query)}
				<li class={{ 'is-current': row.current }}>
					{#if row.current}
						<!-- Not a link, and no Forget button beside it. This row says where you
						     are rather than offering somewhere to go. Following it would reload the
						     page it is printed on, and forgetting the search you are looking at is
						     undone by the results page re-filing it on the next load anyway. -->
						<p class="recent-entry recent-here" aria-current="true">
							{@render trip(row)}
						</p>
					{:else}
						<a class="recent-entry recent-link" href={`${base}/results/?${row.query}`}>
							{@render trip(row)}
						</a>
						<button
							type="button"
							class="recent-remove"
							onclick={() => searchHistory.remove(row.query)}
							aria-label={`Forget the search ${row.summary.label}`}
						>
							<Icon name="x" />
						</button>
					{/if}
				</li>
			{/each}
		</ul>
	</section>
{/if}

<style>
	.recent {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.recent-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.recent-head h2 {
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-faint);
	}

	.clear-all {
		background: none;
		border: none;
		padding: var(--space-2);
		color: var(--color-text-muted);
		font-family: inherit;
		font-size: var(--font-size-sm);
		text-decoration: underline;
		text-underline-offset: 0.2em;
		cursor: pointer;
	}

	.clear-all:hover {
		color: var(--color-text);
	}

	.clear-all:focus-visible {
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
		display: flex;
		align-items: stretch;
		gap: var(--space-1);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		/* The stub edge of a used ticket: this is a trip you already looked at. */
		border-left: 3px solid var(--color-stopover);
	}

	.recent-entry {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		padding: var(--space-3) var(--space-4);
		color: var(--color-text);
		text-decoration: none;
		border-radius: var(--radius-md);
	}

	.recent-link:hover {
		background: var(--color-surface-hover);
	}

	.recent-link:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: -2px;
	}

	/* The row you are already reading recedes. No coloured stub edge, which on the other
	   rows means a ticket you can still pick up, and no hover. */
	li.is-current {
		border-left-color: var(--color-border);
		background: transparent;
	}

	.recent-here {
		color: var(--color-text-muted);
	}

	/* The tag sits against the route rather than against the far edge of the row. Pushed
	   apart, on a 1,248px row it ends up a screen's width from the airports it is talking
	   about, and it is the one thing on this row stopping a wasted click. */
	.recent-top {
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
	}

	.recent-here-tag {
		flex: none;
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-muted);
	}

	.recent-route {
		font-size: var(--font-size-lg);
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-tight);
	}

	.arrow {
		padding-inline: var(--space-2);
		color: var(--color-stopover);
	}

	.recent-meta {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.recent-remove {
		display: flex;
		align-items: center;
		justify-content: center;
		/* 44px, per WCAG 2.5.5. Issue #139 found several targets in this app under 30px. */
		min-width: 2.75rem;
		padding-inline: var(--space-2);
		background: none;
		border: none;
		color: var(--color-text-faint);
		cursor: pointer;
		border-radius: var(--radius-md);
	}

	.recent-remove :global(svg) {
		width: 1.125rem;
		height: 1.125rem;
	}

	.recent-remove:hover {
		color: var(--color-danger);
		background: var(--color-surface-hover);
	}

	.recent-remove:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: -2px;
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
