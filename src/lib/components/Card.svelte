<script lang="ts">
	import type { Snippet } from 'svelte';

	type Variant = 'default' | 'ticket';

	interface Props {
		/** "ticket" swaps the header/body divider for a perforated tear
		    line, for itinerary and boarding-pass-shaped content. */
		variant?: Variant;
		elevated?: boolean;
		padded?: boolean;
		class?: string;
		/** Issue #117: an anchor id a caller can link straight to, e.g. a settings
		    row a results-page notice deep-links into (`/settings/#agoda`) instead
		    of a bare `/settings/` that leaves the traveller to scroll and guess. */
		id?: string;
		header?: Snippet;
		footer?: Snippet;
		children: Snippet;
	}

	let {
		variant = 'default',
		elevated = false,
		padded = true,
		class: className,
		id,
		header,
		footer,
		children
	}: Props = $props();
</script>

<div
	{id}
	class={[
		'card',
		`card-${variant}`,
		{ 'card-elevated': elevated, 'card-padded': padded },
		className
	]}
>
	{#if header}
		<div class="card-header">{@render header()}</div>
	{/if}
	<div class="card-body">{@render children()}</div>
	{#if footer}
		<div class="card-footer">{@render footer()}</div>
	{/if}
</div>

<style>
	.card {
		display: flex;
		flex-direction: column;
		/* A hair of gradient instead of a flat fill, so the surface has
		   some material to it rather than reading as a plain rectangle. */
		background: linear-gradient(180deg, var(--color-surface-hover) 0%, var(--color-surface) 14%);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		min-width: 0;
	}

	.card-elevated {
		box-shadow: var(--shadow-md);
	}

	.card-header {
		padding: var(--space-4) var(--space-5);
		border-bottom: 1px solid var(--color-border);
		font-weight: var(--font-weight-semibold);
	}

	.card-footer {
		padding: var(--space-4) var(--space-5);
		border-top: 1px solid var(--color-border);
	}

	.card-body {
		min-width: 0;
	}

	.card-padded .card-body {
		padding: var(--space-5);
	}

	.card-padded .card-header,
	.card-padded .card-footer {
		padding: var(--space-4) var(--space-5);
	}

	/* The stub: a warm-tinted header and a dashed tear line where a real
	   ticket would perforate, for itinerary summaries and boarding-pass
	   shaped content elsewhere in the app. */
	.card-ticket .card-header {
		background: var(--color-accent-muted);
		border-bottom: 2px dashed var(--color-border-strong);
	}

	.card-ticket .card-footer {
		border-top: 2px dashed var(--color-border-strong);
	}
</style>
