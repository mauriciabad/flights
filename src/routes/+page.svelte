<script lang="ts">
	/**
	 * The search screen: recent searches, then the form. Submitting goes straight to the
	 * results for that search.
	 *
	 * This used to end in a "Search ready" card with a "View results" button, because
	 * Search and Results were two peer tabs and the form's whole job was to write a URL.
	 * The owner: "the UX of goig from search to result makes no fucking sense. you
	 * should get redirected and searches should be saved in some history". So the form
	 * navigates, the searches are remembered (`$lib/search-history`), and Results is no
	 * longer a tab of its own.
	 */
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { buildSearchQuery, createDefaultFormFields } from '$lib/search-form/model';
	import SearchForm from '$lib/search-form/SearchForm.svelte';
	import { searchParamsToFields } from '$lib/search-form/url-codec';
	import { normalizeQuery, RecentSearches } from '$lib/search-history';

	// `url.searchParams` throws on a prerendered page (there is no request to read a
	// query string from at build time), so the prerendered build starts blank and the
	// real params take over the moment this hydrates in an actual browser.
	const params = $derived(browser ? page.url.searchParams : new URLSearchParams());
	const initialFields = $derived(
		browser ? searchParamsToFields(page.url.searchParams) : createDefaultFormFields()
	);

	/**
	 * Old links still point here with a whole search in them, because for a while this
	 * page was where a search lived. Those go to their results, the same as a fresh
	 * submit does, rather than showing a filled-in form with the answer one more click
	 * away. `replaceState` keeps the back button pointing at wherever they came from.
	 */
	$effect(() => {
		if (!browser) return;
		const complete = buildSearchQuery(searchParamsToFields(page.url.searchParams));
		if (!complete) return;
		void goto(`${base}/results/?${normalizeQuery(page.url.searchParams)}`, { replaceState: true });
	});

	/** Read once per page load, not reactive: a form does not need to notice midnight
	 * ticking over while it is open, and the prerendered build's date never reaches a
	 * browser because this only matters once hydrated. */
	const todayIso = new Date().toISOString().slice(0, 10);

	function runSearch(next: URLSearchParams) {
		void goto(`${base}/results/?${next.toString()}`);
	}
</script>

<svelte:head>
	<title>Search - Layover</title>
	<meta
		name="description"
		content="Set your dates, airports and layover rules, and see the trips your connection could become."
	/>
</svelte:head>

<div class="page">
	<header class="page-intro">
		<h1>Search a layover trip</h1>
		<p>Two flights instead of one, with enough time in the middle to make that city a trip of its own.</p>
	</header>

	<RecentSearches />

	{#key params.toString()}
		<SearchForm {initialFields} today={todayIso} onsearch={runSearch} />
	{/key}

	<footer class="page-footer">
		<p>Transit data by <a href="https://transitous.org">Transitous</a>.</p>
	</footer>
</div>

<style>
	/* Wider than the app's usual reading column (#277: "the screen is big, we can use full
	   width on desktop to fit more elements in 1 screen"). A form is a control panel, not
	   prose, so there is no measure here to protect by keeping it narrow. */
	.page {
		max-width: var(--layout-max-width-wide);
		margin-inline: auto;
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}

	/* The title and its one line of explanation share a row once there is room, rather than
	   spending two stacked blocks of a phone screen on the same sentence. */
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
		flex: 1 1 18rem;
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
		max-width: 40rem;
	}

	.page-footer {
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
		padding-top: var(--space-4);
		border-top: 1px solid var(--color-border);
	}
</style>
