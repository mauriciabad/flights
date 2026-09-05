<script lang="ts">
	/**
	 * The search that produced these results, kept at the top of them and editable in
	 * place.
	 *
	 * The owner asked for exactly this: "results should be merged with search, you first
	 * pick the search and then shows results, they are not 2 separate tabs." Collapsed it
	 * is two lines, which is what keeps the first result near the top of a phone screen
	 * (issue #139 measured the old page's first card at about 1,650px down). Expanded it
	 * is the same form as the search screen, prefilled with this search, so refining is a
	 * change to what you are looking at rather than a trip to another route.
	 *
	 * Sticky while collapsed, static while expanded: a two-line strip is worth the space
	 * it holds on screen and a whole form is not.
	 */
	import { tick } from 'svelte';
	import { Icon } from '$lib/components';
	import type { SearchFormFields } from '$lib/search-form/model';
	import SearchForm from '$lib/search-form/SearchForm.svelte';
	import { RecentSearches, type SearchSummary } from '$lib/search-history';

	interface Props {
		summary: SearchSummary;
		initialFields: SearchFormFields;
		today: string;
		onsearch: (params: URLSearchParams) => void;
		/** Things that are true but not fatal, such as dates that have already passed.
		 * Blocking problems are the results page's own business, not this strip's. */
		advisories?: string[];
		/** Passed through to the form: show every problem on open, rather than waiting for
		 * a blur that will never come, when the search on screen is the broken thing. */
		revealIssues?: boolean;
		expanded?: boolean;
		/** The normalised query on screen, so the history below the form can mark the entry
		 * that is this page rather than offer it as somewhere to go. */
		currentQuery: string;
	}

	let {
		summary,
		initialFields,
		today,
		onsearch,
		advisories = [],
		revealIssues = false,
		expanded = $bindable(false),
		currentQuery
	}: Props = $props();

	let editorEl = $state<HTMLDivElement | undefined>();

	async function toggle() {
		expanded = !expanded;
		if (!expanded) return;
		// Focus the region rather than its first input: on a phone, focusing a text field
		// throws the keyboard up over the results the traveller just asked to keep in view.
		// `preventScroll` keeps the query line and the Close button on screen, which the
		// default scroll-into-view pushes off the top.
		await tick();
		editorEl?.focus({ preventScroll: true });
	}
</script>

<section class={['summary', { 'is-expanded': expanded }]} aria-label="Your search">
	<div class="summary-bar">
		<div class="summary-text">
			<h1 class="summary-route font-mono">
				{summary.originAirport}<span class="arrow" aria-hidden="true">&rarr;</span><span
					class="visually-hidden"
				>
					to
				</span>{summary.destinationAirport}
			</h1>
			<!-- One traveller is the default and saying so on every search is a line of
			     nothing on a 375px screen, where this strip has to stay short enough to
			     leave the first result on the first screen. -->
			<p class="summary-meta">
				{summary.dates}{#if summary.travellerCount > 1}
					&middot; {summary.travellers}{/if}
			</p>
		</div>
		<button
			type="button"
			class="edit-toggle"
			aria-expanded={expanded}
			aria-controls="search-editor"
			onclick={toggle}
		>
			<!-- Issue #311: the icon follows the label. This control already read "Close" when
			     the editor was open and went on drawing a pencil, so the two channels a
			     traveller reads disagreed about what pressing it would do. -->
			<span class="edit-icon" aria-hidden="true">
				{#if expanded}
					<Icon name="x" />
				{:else}
					<Icon name="pencil" />
				{/if}
			</span>
			{expanded ? 'Close' : 'Edit search'}
		</button>
	</div>

	{#if advisories.length > 0}
		<ul class="advisories">
			{#each advisories as advisory (advisory)}
				<li>{advisory}</li>
			{/each}
		</ul>
	{/if}

	<div id="search-editor" class="editor" hidden={!expanded}>
		<div bind:this={editorEl} class="editor-inner" tabindex="-1">
			{#if expanded}
				<!-- Mounted only while open, so the form always opens seeded from the URL
				     that is on screen rather than from whatever was typed two searches ago. -->
				<SearchForm
					{initialFields}
					{today}
					{revealIssues}
					submitLabel="Search again"
					{onsearch}
					oncancel={() => (expanded = false)}
				/>

				<!-- Issue #351. Changing the search and picking one already run are the same
				     errand, so they share one control and one panel rather than competing for
				     room in a two-line strip that has to leave the first result on the first
				     screen. Below the form, not above it. This button says "Edit search", and
				     the person who pressed it came for the fields.

				     Opening this panel navigates nowhere. The results stay mounted underneath,
				     with every bed, waiting time and swapped flight the traveller has picked,
				     because none of that is in the URL. Only choosing a row is a navigation. -->
				<div class="editor-history">
					<RecentSearches title="Or pick up a recent search" {currentQuery} />
				</div>
			{/if}
		</div>
	</div>
</section>

<style>
	.summary {
		position: sticky;
		top: 0;
		z-index: var(--z-sticky);
		background: var(--color-bg);
	}

	/* Sticky offsets resolve against the scroll container's content box, and
	   `.app-content` has `var(--space-4)` of padding, so this strip parks 16px below the
	   header rather than against it. Result cards scroll through that band in the open,
	   which on a phone reads as a card torn in half under the header.
	   The previous attempt was a negative top margin, which cannot work: a margin moves
	   the box but backgrounds never paint on one, so the gap stayed transparent while the
	   element merely started higher. Measured at 375px: the strip's border box sat at
	   y=65 with the header ending at y=49, and `.trip-strip-track` was the element
	   answering `elementFromPoint` at y=52, 58 and 64.
	   So paint the band instead of moving into it. Sticky makes this element a containing
	   block, so the cover rides with it. */
	.summary::before {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		bottom: 100%;
		height: var(--space-4);
		background: var(--color-bg);
	}

	/* An open form is taller than the viewport, so pinning it would mean scrolling the
	   results underneath a form that never moves. */
	.summary.is-expanded {
		position: static;
		z-index: auto;
	}

	.summary-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4);
		background: var(--color-bg-elevated);
		border: 1px solid var(--color-border);
		/* The stub edge of a boarding pass, in the colour this app reserves for the
		   stopover itself. */
		border-left: 3px solid var(--color-stopover);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-sm);
	}

	.summary-text {
		min-width: 0;
	}

	.summary-route {
		font-size: var(--font-size-xl);
		font-weight: var(--font-weight-bold);
		letter-spacing: var(--tracking-tight);
		line-height: 1.2;
	}

	.arrow {
		padding-inline: var(--space-2);
		color: var(--color-stopover);
	}

	.summary-meta {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.edit-toggle {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		flex: none;
		/* 44px minimum, per WCAG 2.5.5. */
		min-height: 2.75rem;
		padding-inline: var(--space-4);
		background: var(--color-surface);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-full);
		color: var(--color-text);
		font-family: inherit;
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		white-space: nowrap;
		cursor: pointer;
		transition:
			background-color var(--transition-fast),
			border-color var(--transition-fast),
			color var(--transition-fast);
	}

	.edit-toggle:hover {
		background: var(--color-surface-hover);
		border-color: var(--color-accent);
		color: var(--color-accent);
	}

	.edit-toggle:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	.edit-toggle:active {
		transform: scale(0.98);
	}

	.edit-icon :global(svg) {
		width: 1.125rem;
		height: 1.125rem;
		display: block;
	}

	.advisories {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		margin-top: var(--space-2);
		padding: var(--space-2) var(--space-4);
		background: var(--color-warning-bg);
		border-left: 3px solid var(--color-warning);
		border-radius: var(--radius-md);
		color: var(--color-text);
		font-size: var(--font-size-sm);
	}

	.editor {
		margin-top: var(--space-4);
	}

	/* The rule sits on the child's own section rather than on this wrapper, so a history
	   with nowhere to send anybody draws no line under the form. `RecentSearches` renders
	   nothing at all in that case, and a bordered wrapper would still be a border. */
	.editor-history :global(.recent) {
		margin-top: var(--space-5);
		padding-top: var(--space-5);
		border-top: 1px solid var(--color-border);
	}

	.editor-inner:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 4px;
		border-radius: var(--radius-lg);
	}

	@media (min-width: 48rem) {
		.summary {
			margin-top: calc(var(--space-6) * -1);
			padding-top: var(--space-6);
		}

		.summary-route {
			font-size: var(--font-size-2xl);
		}
	}
</style>
