<script lang="ts">
	/**
	 * Issue #23: the results list. Reads the `SearchQuery` the search form (issue #16)
	 * already put in a URL's params (same codec: `$lib/search-form`), runs it through the
	 * real search pipeline (issue #56, `$lib/search`), and keeps the on-screen order
	 * stable while more arrives (`$lib/results/stream-order.ts`) so the traveller can
	 * filter and re-sort what has already streamed in without it moving under them.
	 *
	 * `getProviderRegistry()` (`$lib/results/provider-setup.ts`) is the first place in this
	 * codebase anything actually assembles a `ProviderRegistry` with every real adapter.
	 * Confirmed by grepping `src/` for `new ProviderRegistry` before writing it, per
	 * AGENTS.md's "check whether another issue owns it": nothing else does yet, and the
	 * search form's own comment already names this as "the results issue's job."
	 */
	import { untrack } from 'svelte';
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import { Button, Card, EmptyState, Skeleton } from '$lib/components';
	import { getAirport } from '$lib/data/airports';
	import type { Airport, IataAirportCode, SearchQuery } from '$lib/domain';
	import { keyStore } from '$lib/keys';
	import { buildSearchQuery } from '$lib/search-form/model';
	import { searchParamsToFields } from '$lib/search-form/url-codec';
	import { runSearch, widenSearch, widenWithPriceCalendar } from '$lib/search';
	import type { SearchDependencies, SearchSnapshot, WidenOption, WidenTarget } from '$lib/search';
	import { applyFilters, deriveFilterOptions, emptyFilters } from '$lib/results/filters';
	import type { ResultFilters } from '$lib/results/filters';
	import { getProviderRegistry } from '$lib/results/provider-setup';
	import { compareResults, sortResults } from '$lib/results/sort';
	import type { SortMode } from '$lib/results/sort';
	import { insertStable, slotsToResults, toSlot } from '$lib/results/stream-order';
	import type { StreamSlot } from '$lib/results/stream-order';
	import { connectionAirportCode, deriveScoredResult, summarizePriceCalendarOutcome, widenOptionGroupKey } from '$lib/results/types';
	import type { ProviderStatus, WidenOptionGroup } from '$lib/results/types';
	import FilterPanel from './FilterPanel.svelte';
	import ProviderStatusStrip from './ProviderStatusStrip.svelte';
	import ResultCard from './ResultCard.svelte';
	import WidenOptionsPanel from './WidenOptionsPanel.svelte';

	/**
	 * `null` when the URL doesn't carry a full query yet (soonest departure, latest
	 * arrival and both airports are all required, `buildSearchQuery`'s own contract).
	 * That's the ordinary state for someone who hasn't searched yet, not an error.
	 *
	 * `url.searchParams` throws on a prerendered page (there is no real request to read
	 * a query string from at build time, the same guard the search form's own
	 * `+page.svelte` uses), so the prerendered build always starts with no query; the
	 * real params take over the moment this hydrates in an actual browser.
	 */
	const query = $derived<SearchQuery | null>(
		browser ? buildSearchQuery(searchParamsToFields(page.url.searchParams)) : null
	);

	let order = $state<StreamSlot[]>([]);
	let providerStatuses = $state<Record<string, ProviderStatus>>({});
	let widenOptions = $state<WidenOption[]>([]);
	let calendarSummaries = $state<string[]>([]);
	/** Issue #107: set from the primary search's final snapshot only (never a widen's, same
	 * gating `trackWidenOptions` already uses for `widenOptions` below), and only meaningful
	 * once `results.length === 0 && !stillSearching`, the one place the empty-results copy
	 * needs to tell "no stopover beats a direct flight" apart from "found nothing at all."
	 * See `types.ts`'s `SearchSnapshot.hasDirectRoute` doc comment for why it's `false` on
	 * every other snapshot, not only an absent one. */
	let directRouteKnown = $state(false);
	let sortMode = $state<SortMode>('score');
	let filters = $state<ResultFilters>(emptyFilters());
	let connectionAirports = $state<Record<string, Airport>>({});
	/** How many searches (the primary one, plus any widen the traveller triggers) are
	 * currently streaming, reserve-space skeleton and "still searching" copy key off
	 * this being `> 0`, not off any single stream's own `done` flag. */
	let searchesInFlight = $state(0);
	let pendingWidenKey = $state<string | undefined>(undefined);

	// Plain mutable bookkeeping, not `$state`: neither needs to trigger a render on its
	// own, only the `$state` fields written from inside the functions below do that.
	const requestedAirportCodes = new Set<string>();
	const sequenceByConnection = new Map<string, number>();
	let nextSequence = 1;

	function sequenceFor(code: string): number {
		let sequence = sequenceByConnection.get(code);
		if (sequence === undefined) {
			sequence = nextSequence++;
			sequenceByConnection.set(code, sequence);
		}
		return sequence;
	}

	const results = $derived(slotsToResults(order));
	const currency = $derived(results[0]?.itinerary.totalPrice.currency ?? 'EUR');
	const filterOptions = $derived(deriveFilterOptions(results));
	const filteredResults = $derived(applyFilters(results, filters));
	const providerStatusList = $derived(Object.values(providerStatuses));
	const stillSearching = $derived(searchesInFlight > 0);

	function deps(): SearchDependencies {
		return { registry: getProviderRegistry(), keys: keyStore.availableKeys };
	}

	/**
	 * Drains one search stream (the primary `runSearch`, or a `widenSearch` the
	 * traveller triggered) into the shared page state. Every itinerary group merges
	 * through `insertStable` keyed by connection airport, so a widen result for a
	 * stopover already on screen updates that card in place rather than adding a
	 * second one or reordering the list, the "already on screen do not move"
	 * guarantee `stream-order.ts` provides applies here exactly as it does to the
	 * initial free-tier stream.
	 */
	async function consumeSearch(stream: AsyncGenerator<SearchSnapshot>, options: { trackWidenOptions: boolean }) {
		searchesInFlight += 1;
		try {
			for await (const snapshot of stream) {
				providerStatuses = { ...providerStatuses, ...snapshot.providers };
				if (options.trackWidenOptions) {
					widenOptions = snapshot.widenOptions;
					directRouteKnown = snapshot.hasDirectRoute;
				}
				const compare = untrack(() => compareResults(sortMode));
				for (const group of snapshot.itineraryGroups) {
					const scored = deriveScoredResult(group, snapshot, sequenceFor(group.connectionAirportCode));
					order = insertStable(order, toSlot(scored), compare);
				}
			}
		} finally {
			searchesInFlight -= 1;
		}
	}

	/** Runs the free tier once per distinct `query`, `runSearch` has no code path to a
	 * metered provider at all, so this alone never spends a request. */
	$effect(() => {
		const activeQuery = query;
		order = [];
		providerStatuses = {};
		widenOptions = [];
		calendarSummaries = [];
		directRouteKnown = false;
		sequenceByConnection.clear();
		nextSequence = 1;
		if (!activeQuery) return;

		// Issue #87: `consumeSearch` is only "async" in name here — it's called without
		// `await`, so its body runs synchronously (up to its first real suspend point,
		// deep inside `runSearch`'s first `for await`) on THIS effect's own call stack.
		// Svelte tracks dependencies by call stack, not lexical scope, so `searchesInFlight
		// += 1` (a read then a write of the same $state, consumeSearch's very first line)
		// was counted as this effect reading AND writing `searchesInFlight` — the effect
		// wrote a value it also read, so every write re-triggered it, forever, tripping
		// Svelte's effect_update_depth_exceeded guard before a single snapshot ever
		// rendered. `untrack` scopes out just that synchronous window; consumeSearch's
		// later writes (from inside the `for await` loop, resumed after a real await) are
		// naturally outside any effect's tracking already and need no wrapping.
		const controller = new AbortController();
		untrack(() =>
			consumeSearch(runSearch(activeQuery, deps(), { signal: controller.signal }), { trackWidenOptions: true })
		);
		return () => controller.abort();
	});

	/** An explicit sort-mode change re-sorts everything gathered so far, a deliberate
	 * user action, unlike the streaming merge above, so a full re-sort here is expected
	 * (see sort.ts's own comment on `sortResults`). Reads/writes `order` `untrack`'d so
	 * this effect's only real dependency is `sortMode` itself, not every streamed
	 * arrival. */
	$effect(() => {
		const mode = sortMode;
		untrack(() => {
			order = sortResults(slotsToResults(order), mode).map(toSlot);
		});
	});

	/** Resolves each connection airport's full record (for its city name and flag) as
	 * new codes show up among the results, lazily and once per code, since
	 * `getAirport` is async and this effect re-runs on every new arrival. */
	$effect(() => {
		const codes = new Set(results.map((result) => connectionAirportCode(result.itinerary)));
		for (const code of codes) {
			if (requestedAirportCodes.has(code)) continue;
			requestedAirportCodes.add(code);
			getAirport(code).then((airport) => {
				if (airport) connectionAirports = { ...connectionAirports, [code]: airport };
			});
		}
	});

	/** The narrowest possible confirm-tier target: the exact date this candidate's
	 * itinerary already found, never the query's whole range, PROVIDERS.md's own
	 * warning ("a pipeline that loops over dates... is broken by construction") is
	 * exactly what a wider window here would risk. Falls back to the query's soonest
	 * departure only for a candidate with no itinerary on screen yet. */
	function buildConfirmTarget(option: WidenOption, activeQuery: SearchQuery): WidenTarget | undefined {
		if (!option.candidateAirportCode) return undefined;
		const existing = results.find((result) => result.id === option.candidateAirportCode);
		const date = existing?.itinerary.outboundFlight.departure.local.slice(0, 10) ?? activeQuery.soonestDeparture;
		return { candidateAirportCode: option.candidateAirportCode, earliestDeparture: date, latestDeparture: date };
	}

	/** Issue #96: the panel now shows one row per provider, summing cost across every
	 * candidate that provider's tier covers (`WidenOptionGroup`), rather than one row per
	 * candidate. Spending it means widening every one of `group.options`' candidates in a
	 * single call sharing `group.requests` as one ceiling. Both `widenSearch` (its
	 * `targets` array) and `widenWithPriceCalendar` (its `candidateAirportCodes` array)
	 * already accept many candidates behind one shared budget, so this is not a new
	 * capability, only a caller that finally uses it for more than one candidate at a time. */
	async function handleWiden(group: WidenOptionGroup) {
		const activeQuery = query;
		if (!activeQuery) return;
		const key = widenOptionGroupKey(group);
		pendingWidenKey = key;
		const controller = new AbortController();
		try {
			if (group.tier === 'confirm') {
				const targets = group.options
					.map((option) => buildConfirmTarget(option, activeQuery))
					.filter((target): target is WidenTarget => target !== undefined);
				if (targets.length === 0) return;
				await consumeSearch(
					widenSearch(activeQuery, { targets, maxMeteredRequests: group.requests }, deps(), {
						signal: controller.signal
					}),
					{ trackWidenOptions: false }
				);
			} else {
				const candidateAirportCodes = group.options
					.map((option) => option.candidateAirportCode)
					.filter((code): code is IataAirportCode => code !== undefined);
				if (candidateAirportCodes.length === 0) return;
				searchesInFlight += 1;
				try {
					for await (const outcome of widenWithPriceCalendar(
						activeQuery,
						{ candidateAirportCodes, maxMeteredRequests: group.requests },
						deps(),
						{ signal: controller.signal }
					)) {
						calendarSummaries = [...calendarSummaries, summarizePriceCalendarOutcome(outcome)];
					}
				} finally {
					searchesInFlight -= 1;
				}
			}
		} finally {
			if (pendingWidenKey === key) pendingWidenKey = undefined;
		}
	}

	function clearFilters() {
		filters = emptyFilters();
	}
</script>

<svelte:head>
	<title>Results, Layover</title>
</svelte:head>

<div class="results-page">
	{#if !query}
		<EmptyState
			title="Start a search first"
			description="This page renders whatever search you save on the search screen, there isn't one yet."
		>
			{#snippet action()}
				<Button href="/">Go to search</Button>
			{/snippet}
		</EmptyState>
	{:else}
		<header class="results-header">
			<h1>
				{query.originAirport} <span aria-hidden="true">→</span> {query.destinationAirport}
			</h1>
			<p class="results-subhead">
				{filteredResults.length} of {results.length}
				{results.length === 1 ? 'itinerary' : 'itineraries'} shown
				{#if stillSearching}<span class="still-searching">· still searching</span>{/if}
			</p>
		</header>

		<ProviderStatusStrip statuses={providerStatusList} />

		<div class="results-layout">
			<aside class="results-filters" aria-label="Filters">
				<FilterPanel
					options={filterOptions}
					bind:filters
					bind:sortMode
					{currency}
					avoidedAirlines={query.airlinesToAvoid}
				/>
				<WidenOptionsPanel options={widenOptions} onWiden={handleWiden} pendingKey={pendingWidenKey} />
				{#if calendarSummaries.length > 0}
					<div class="calendar-summaries">
						<p class="calendar-summaries-label">Calendar results</p>
						<ul>
							{#each calendarSummaries as summary, index (index)}
								<li>{summary}</li>
							{/each}
						</ul>
					</div>
				{/if}
			</aside>

			<div class="results-list-column">
				{#if filteredResults.length === 0 && results.length > 0}
					<EmptyState
						title="No itineraries match your filters"
						description="Loosen a filter to see more of what's already come back."
					>
						{#snippet action()}
							<Button variant="secondary" onclick={clearFilters}>Clear filters</Button>
						{/snippet}
					</EmptyState>
				{/if}

				{#if results.length === 0 && !stillSearching}
					{#if directRouteKnown}
						<!-- Issue #107: this app only ever searches for a stopover, so an empty result
						     here just as often means "the direct flight is the better answer" as it
						     means "nothing works." For a well-served route like BCN to CDG, it's almost
						     always the former. Saying so plainly is the whole point; dressing a good
						     outcome up as a failure ("try a different destination") is exactly what
						     issue #107 reported. -->
						<EmptyState
							title="Well served direct"
							description={`${query.originAirport} to ${query.destinationAirport} is well served direct, so there's no stopover here worth turning into a trip. That's not a claim no flights exist, just that a stopover isn't the better answer this time.`}
						/>
					{:else}
						<EmptyState
							title="No itineraries found"
							description="None of the free providers above found a workable connection for this search. Widen the search above, or try a different destination."
						/>
					{/if}
				{/if}

				<!-- Keyed on result.id (the connection airport code, stable for the whole
				     search per types.ts), so Svelte only ever moves a DOM node when
				     stream-order.ts genuinely repositions it, never recreates one just
				     because its price or freshness changed in place. -->
				<ul class="results-list">
					{#each filteredResults as result (result.id)}
						<li>
							<ResultCard {result} connectionAirport={connectionAirports[connectionAirportCode(result.itinerary)]} />
						</li>
					{/each}
					{#if stillSearching}
						<li aria-hidden="true">
							<Card class="result-card-skeleton" padded={false}>
								<div class="skeleton-body">
									<Skeleton height="2rem" width="40%" />
									<Skeleton height="1rem" width="70%" />
									<Skeleton height="4rem" />
									<Skeleton height="1.5rem" width="60%" />
								</div>
							</Card>
						</li>
					{/if}
				</ul>
			</div>
		</div>
	{/if}
</div>

<style>
	.results-page {
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
		max-width: var(--layout-max-width);
		margin: 0 auto;
	}

	.results-header h1 {
		font-size: var(--font-size-2xl);
		font-family: var(--font-mono);
	}

	.results-subhead {
		color: var(--color-text-muted);
		font-size: var(--font-size-sm);
	}

	.still-searching {
		color: var(--color-accent);
	}

	.results-layout {
		display: grid;
		grid-template-columns: 1fr;
		gap: var(--space-6);
	}

	.results-filters {
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}

	.calendar-summaries {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-3);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
	}

	.calendar-summaries-label {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-faint);
	}

	.calendar-summaries ul {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		font-size: var(--font-size-sm);
	}

	.results-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.results-list li {
		list-style: none;
	}

	.skeleton-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: var(--space-5);
	}

	:global(.result-card-skeleton) {
		min-height: 15rem;
	}

	@media (min-width: 64rem) {
		.results-layout {
			grid-template-columns: 18rem 1fr;
			align-items: start;
		}

		.results-filters {
			position: sticky;
			top: var(--space-4);
		}
	}
</style>
