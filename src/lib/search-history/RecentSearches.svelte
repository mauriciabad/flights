<script lang="ts">
	/**
	 * The searches this browser has run before, one tap from running again.
	 *
	 * It sits above the empty search form because that is where a returning visitor
	 * looks first, and because the alternative to remembering is retyping four fields to
	 * see a page you already saw this morning.
	 *
	 * Nothing renders until `onMount`. The store reads `localStorage` in its constructor,
	 * which is empty during prerender and full a millisecond later in the browser, and
	 * rendering the difference is how you get a hydration mismatch on a prerendered page.
	 */
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { buildSearchQuery } from '$lib/search-form/model';
	import { searchParamsToFields } from '$lib/search-form/url-codec';
	import { searchHistory } from './store.svelte';
	import { summarizeSearch } from './summary';

	interface Props {
		title?: string;
		/** The query currently on screen, so the results page can leave it out of its own
		 * "recent" list instead of offering the traveller the page they are looking at. */
		excludeQuery?: string;
		class?: string;
	}

	let { title = 'Recent searches', excludeQuery, class: className }: Props = $props();

	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});

	const rows = $derived.by(() => {
		if (!mounted) return [];
		return searchHistory.entries
			.filter((entry) => entry.query !== excludeQuery)
			.map((entry) => {
				const params = new URLSearchParams(entry.query);
				const query = buildSearchQuery(searchParamsToFields(params));
				return query ? { query: entry.query, summary: summarizeSearch(query) } : undefined;
			})
			.filter((row) => row !== undefined);
	});
</script>

{#if rows.length > 0}
	<section class={['recent', className]} aria-labelledby="recent-searches-title">
		<div class="recent-head">
			<h2 id="recent-searches-title">{title}</h2>
			<button type="button" class="clear-all" onclick={() => searchHistory.clear()}>
				Clear all
			</button>
		</div>
		<ul>
			{#each rows as row (row.query)}
				<li>
					<a class="recent-link" href={`${base}/results/?${row.query}`}>
						<span class="recent-route font-mono">
							{row.summary.originAirport}<span class="arrow" aria-hidden="true">&rarr;</span
							><span class="visually-hidden"> to </span>{row.summary.destinationAirport}
						</span>
						<span class="recent-meta">
							{row.summary.dates} &middot; {row.summary.travellers}
						</span>
					</a>
					<button
						type="button"
						class="recent-remove"
						onclick={() => searchHistory.remove(row.query)}
						aria-label={`Forget the search ${row.summary.label}`}
					>
						<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
							<path
								d="M6 6l12 12M18 6L6 18"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
							/>
						</svg>
					</button>
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

	.recent-link {
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

	.recent-remove svg {
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
