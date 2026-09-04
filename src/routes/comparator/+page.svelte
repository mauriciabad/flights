<script lang="ts">
	/**
	 * Issue #25: the comparator's route. `+layout.svelte`'s "Compare" nav item has
	 * pointed here since #62 landed; this fills the gap that produced a 404.
	 *
	 * Real selection ("which itineraries am I comparing") is the results list's own
	 * state to own (issue #23), which does not exist yet. Rather than invent a
	 * placeholder selection mechanism this issue does not own (AGENTS.md: "define the
	 * narrowest possible interface"), this route has nothing of its own to select from
	 * and shows the Comparator's own empty state — an honest "nothing selected yet",
	 * not a guess at what #23's contract will look like.
	 *
	 * `?demo=1` renders three fixture itineraries instead (see `demo-fixtures.ts`), so
	 * this route has a real, stable URL for automated verification
	 * (tests/e2e/comparator.spec.ts) of the one thing that genuinely needs a real
	 * browser: CSS subgrid row alignment across columns, which jsdom cannot compute
	 * since it does no real layout (Comparator.test.ts covers everything jsdom can).
	 * Safe to remove, or to replace with real selected-itinerary data, once #23 exists.
	 *
	 * Comparator itself is a plain in-flow view, not a dismissible overlay: it lives at
	 * this persistent nav tab alongside search/results/settings (`+layout.svelte`), so
	 * there is no "close" action here, the same as those other tabs never need one.
	 */
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import { Comparator } from '$lib/components';
	import { buildDemoComparedItineraries } from './demo-fixtures';

	// `page.url.searchParams` throws on a prerendered page (no request to read a query
	// string from at build time — see the same guard in routes/+page.svelte), so the
	// prerendered build always starts from the honest empty list; `?demo=1` only ever
	// takes effect once this hydrates in an actual browser.
	const items = $derived(browser && page.url.searchParams.has('demo') ? buildDemoComparedItineraries() : []);
</script>

<svelte:head>
	<title>Compare itineraries — Layover</title>
</svelte:head>

<h1 class="visually-hidden">Compare itineraries</h1>
<Comparator {items} />
