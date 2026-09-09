<script lang="ts">
	/**
	 * The one thing a visitor needs to know before they trust an answer this app gives them:
	 * the project was abandoned in September 2026, nobody is fixing it, and the data it
	 * ships with stopped being refreshed on the day the repo was archived.
	 *
	 * The owner asked for this after the README note: "in the ui would be nice to state the
	 * things that wont update". A README is for whoever finds the repo. Anybody who reaches
	 * flights.mauri.app instead sees a working search box and no reason to doubt it, and the
	 * numbers behind it go staler every week.
	 *
	 * ## Why a disclosure and not a paragraph
	 *
	 * The sentence that changes a decision is short, and eight dated rows are not. So the
	 * sentence is the `<summary>` and is always on screen, closed or open, and the rows are
	 * behind one press for the reader who wants to know how bad it is. A `<details>` does
	 * that with no state, no script and no hydration cost, which matters here because this
	 * sits above the search form on a prerendered page.
	 *
	 * ## Why it names live data too
	 *
	 * Half of what this app shows is still fetched from the provider on every search, and a
	 * banner that only said "the data is old" would tell people to distrust a fare that came
	 * in ninety seconds ago. `FROZEN_DATASETS` is the frozen half and its doc says why the
	 * live half must never be added to it.
	 */
	import { FROZEN_DATASETS, formatFrozenDate } from '$lib/data/frozen-datasets';
	import Icon from './Icon.svelte';
</script>

<details class="archived">
	<summary>
		<Icon name="alert-triangle" class="archived-mark" />
		<span>
			<strong>Abandoned in September 2026.</strong> The search still runs, but nothing here is
			maintained and the built-in data stopped updating.
		</span>
		<Icon name="chevron-down" class="archived-chevron" />
	</summary>

	<div class="archived-body">
		<p>
			Flights, beds and timetables are fetched from the providers while you search, so those
			are as current as the provider is. Everything the app carries with it is frozen on the
			day beside it and drifts further out every week: a route that opened since then is
			invisible, one that closed is still offered, and a fare estimate is converted at last
			September's rates.
		</p>

		<ul class="frozen">
			{#each FROZEN_DATASETS as dataset (dataset.name)}
				<li>
					<p class="frozen-name">{dataset.name}</p>
					<p class="frozen-feeds">{dataset.feeds}, from {dataset.source}</p>
					<time class="frozen-date" datetime={dataset.fetchedOn}>
						{formatFrozenDate(dataset.fetchedOn)}
					</time>
				</li>
			{/each}
		</ul>

		<p class="frozen-footnote">
			The code is on <a href="https://github.com/mauriciabad/flights">GitHub</a>, archived and
			read only.
		</p>
	</div>
</details>

<style>
	.archived {
		border: 1px solid var(--color-warning);
		border-radius: var(--radius-md);
		background: var(--color-warning-bg);
		color: var(--color-text);
		font-size: var(--font-size-sm);
	}

	/* The sentence, the mark that draws the eye to it, and the chevron that says there is
	   more. Three columns so a summary wrapping to two lines keeps both glyphs on the first,
	   beside the text rather than centred against the block. */
	summary {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: start;
		gap: var(--space-2);
		padding: var(--space-3);
		cursor: pointer;
		list-style: none;
	}

	/* Safari draws its own triangle through `::-webkit-details-marker`, which `list-style`
	   alone does not reach, and it would sit beside the chevron below. */
	summary::-webkit-details-marker {
		display: none;
	}

	summary:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
		border-radius: var(--radius-md);
	}

	.archived :global(.archived-mark) {
		--icon-size: 1.125rem;
		color: var(--color-warning);
		/* The cap height of the line beside it, so the triangle sits on the text's shoulder
		   rather than floating above it. */
		margin-top: 0.05rem;
	}

	.archived :global(.archived-chevron) {
		--icon-size: 1rem;
		color: var(--color-text-muted);
		margin-top: 0.15rem;
		transition: rotate var(--transition-fast);
	}

	.archived[open] :global(.archived-chevron) {
		rotate: 180deg;
	}

	.archived-body {
		padding: 0 var(--space-3) var(--space-3);
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	/* Direct children only: the rows below carry their own weight and colour, and a bare
	   `.archived-body p` would outrank the single class on each of them. */
	.archived-body > p {
		margin: 0;
		max-width: 60ch;
		color: var(--color-text-muted);
		font-size: var(--font-size-xs);
		line-height: var(--line-height-sm);
	}

	.frozen {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* Name and date on one row with the date pinned right, the explanation under the name.
	   Reading down the right edge answers "how old is all this" in one pass, which is the
	   question somebody opens this to ask. */
	.frozen li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 0 var(--space-3);
		padding-top: var(--space-2);
		border-top: 1px solid var(--color-border);
	}

	.frozen-name {
		margin: 0;
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		color: var(--color-text);
	}

	.frozen-feeds {
		grid-column: 1;
		margin: 0;
		font-size: var(--font-size-xs);
		line-height: var(--line-height-sm);
		color: var(--color-text-muted);
	}

	.frozen-date {
		grid-row: 1;
		grid-column: 2;
		font-size: var(--font-size-xs);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		color: var(--color-text-muted);
	}

	/* Matched through the parent for the same reason: this is one of the direct children the
	   rule above claims, and one class alone loses to it. */
	.archived-body > .frozen-footnote {
		color: var(--color-text-faint);
	}
</style>
