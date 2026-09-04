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
	import type { SearchFormFields } from '$lib/search-form/model';
	import SearchForm from '$lib/search-form/SearchForm.svelte';
	import type { SearchSummary } from '$lib/search-history';

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
	}

	let {
		summary,
		initialFields,
		today,
		onsearch,
		advisories = [],
		revealIssues = false,
		expanded = $bindable(false)
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
			<span class="edit-icon" aria-hidden="true">
				<svg viewBox="0 0 24 24" fill="none">
					<path
						d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4Z"
						stroke="currentColor"
						stroke-width="1.8"
						stroke-linejoin="round"
					/>
				</svg>
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
			{/if}
		</div>
	</div>
</section>

<style>
	.summary {
		/* Vertical-only negative margin, matching `.app-content`'s own padding, so the
		   strip's background covers the gap above it instead of letting results scroll
		   through it. Horizontal stays put: the strip is exactly as wide as the results
		   column it belongs to. */
		position: sticky;
		top: 0;
		z-index: var(--z-sticky);
		margin-top: calc(var(--space-4) * -1);
		padding-top: var(--space-4);
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

	.edit-icon svg {
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
