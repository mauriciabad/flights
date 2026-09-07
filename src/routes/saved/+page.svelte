<script lang="ts">
	/**
	 * Every trip this browser has kept, with the whole price log under each one.
	 *
	 * Its own route rather than a panel on the results page, because it outlives any one
	 * search: the trips here came from several searches on several days, and the question it
	 * answers ("has the Vienna one come down yet") is not a question about the search you are
	 * currently running. The search screen carries a short version of this list and links
	 * here, which is where a returning traveller already looks.
	 *
	 * Nothing renders until `onMount`. The store reads `localStorage` in its constructor,
	 * empty during prerender and full a millisecond later in a browser, and rendering the
	 * difference is a hydration mismatch on a prerendered page.
	 */
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { Button, EmptyState, Icon } from '$lib/components';
	import { savedItineraries } from '$lib/saved';
	import type { SavedItinerary } from '$lib/saved';
	import SavedTripCard from './SavedTripCard.svelte';

	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});

	const entries = $derived(mounted ? savedItineraries.entries : []);

	/**
	 * The last trip removed, held so it can be put back.
	 *
	 * Removing a trip throws away a price log that took weeks of visits to build, and a
	 * mis-tap on a phone is one pixel away from the button beside it. `save` restores the
	 * whole record, `savedAt` and log included, because the entry object is still here.
	 */
	let undoable = $state<SavedItinerary | undefined>();

	function remove(entry: SavedItinerary) {
		savedItineraries.remove(entry.id);
		undoable = entry;
	}

	function undo() {
		if (!undoable) return;
		savedItineraries.save(undoable);
		undoable = undefined;
	}
</script>

<svelte:head>
	<title>Saved trips - Layover</title>
	<meta
		name="description"
		content="The layover trips you kept, and what each one has cost every time you came back."
	/>
</svelte:head>

<div class="page">
	<header class="page-intro">
		<h1>Saved trips</h1>
		<p>
			Kept from a search, priced again every time you open one. Each visit adds a line to
			the trip's receipt, so you can see which part moved rather than only that the total did.
		</p>
	</header>

	{#if undoable}
		<div class="undo" role="status">
			<p>Removed {undoable.trip.origin.airport} to {undoable.trip.destination.airport} via {undoable.trip.connection.airport}.</p>
			<button type="button" class="undo-action" onclick={undo}>Put it back</button>
		</div>
	{/if}

	{#if mounted && entries.length === 0}
		<EmptyState
			title="Nothing saved yet"
			description="Press the heart on a result to keep that trip here. Every time you open the search again, its new price joins the list."
		>
			{#snippet icon()}
				<Icon name="heart" />
			{/snippet}
			{#snippet action()}
				<Button href={`${base}/`}>Start a search</Button>
			{/snippet}
		</EmptyState>
	{:else}
		<ul class="trips">
			{#each entries as entry (entry.id)}
				<li><SavedTripCard {entry} onremove={() => remove(entry)} /></li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.page {
		max-width: var(--layout-max-width);
		margin-inline: auto;
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}

	.page-intro {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-1) var(--space-4);
	}

	.page-intro h1 {
		font-size: var(--font-size-2xl);
	}

	.page-intro p {
		flex: 1 1 20rem;
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
		max-width: 44rem;
	}

	.undo {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2) var(--space-4);
		padding: var(--space-2) var(--space-4);
		background: var(--color-bg-elevated);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-md);
		font-size: var(--font-size-sm);
	}

	.undo-action {
		/* 44px, per WCAG 2.5.5, on the one control that reverses a loss. */
		min-height: 2.75rem;
		padding-inline: var(--space-3);
		margin-inline-end: calc(var(--space-3) * -1);
		color: var(--color-accent);
		font-weight: var(--font-weight-semibold);
		text-decoration: underline;
		text-underline-offset: 0.2em;
	}

	.undo-action:hover {
		color: var(--color-accent-hover);
	}

	.undo-action:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
		border-radius: var(--radius-sm);
	}

	.trips {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
</style>
