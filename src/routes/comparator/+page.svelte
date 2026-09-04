<script lang="ts">
	/**
	 * Issue #25: the comparator's route. `+layout.svelte`'s "Compare" nav item has
	 * pointed here since #62 landed; this fills the gap that produced a 404.
	 *
	 * Issue #103: real selection now exists. The results list
	 * (`routes/results/+page.svelte`) owns picking which itineraries to compare and
	 * writes them into `comparisonSelection` (`$lib/results/comparison-selection.svelte.ts`)
	 * the moment its "Compare" button is pressed, then navigates here — see that store's
	 * own header comment for why a plain client-side module, not a URL param or a fresh
	 * search, is what carries the selection across the navigation.
	 *
	 * `?demo=1` still renders three fixture itineraries instead, ahead of anything the
	 * store holds: this route keeps a real, stable URL for automated verification
	 * (tests/e2e/comparator.spec.ts) of the one thing that genuinely needs a real
	 * browser: CSS subgrid row alignment across columns, which jsdom cannot compute
	 * since it does no real layout (Comparator.test.ts covers everything jsdom can).
	 *
	 * Comparator itself is a plain in-flow view, not a dismissible overlay: it lives at
	 * this persistent nav tab alongside search/results/settings (`+layout.svelte`), so
	 * there is no "close" action here, the same as those other tabs never need one.
	 */
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import { Comparator } from '$lib/components';
	import { comparisonSelection } from '$lib/results/comparison-selection.svelte';
	import { buildDemoComparedItineraries } from './demo-fixtures';

	// `page.url.searchParams` throws on a prerendered page (no request to read a query
	// string from at build time — see the same guard in routes/+page.svelte), so the
	// prerendered build always starts from the honest empty list; `?demo=1` only ever
	// takes effect once this hydrates in an actual browser.
	const items = $derived(
		browser && page.url.searchParams.has('demo') ? buildDemoComparedItineraries() : comparisonSelection.items
	);
</script>

<svelte:head>
	<title>Compare itineraries — Layover</title>
</svelte:head>

<h1 class="visually-hidden">Compare itineraries</h1>
<Comparator {items} />
