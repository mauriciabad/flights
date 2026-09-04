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
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { Button, Card, EmptyState, Skeleton } from '$lib/components';
	import { getAirport } from '$lib/data/airports';
	import { DEFAULT_SEARCH_CURRENCY } from '$lib/domain';
	import type { Airport, IataAirportCode, SearchQuery, Stay } from '$lib/domain';
	import { keyStore } from '$lib/keys';
	import { buildSearchQuery } from '$lib/search-form/model';
	import { searchParamsToFields } from '$lib/search-form/url-codec';
	import { runSearch, widenSearch, widenWithPriceCalendar } from '$lib/search';
	import type {
		ConnectionTransferOptions,
		ItineraryGroup,
		OuterTransferOptions,
		SearchDependencies,
		SearchSnapshot,
		WidenOption,
		WidenTarget
	} from '$lib/search';
	import { applyFilters, deriveFilterOptions, emptyFilters } from '$lib/results/filters';
	import type { ResultFilters } from '$lib/results/filters';
	import { explainNoResults } from '$lib/results/no-results';
	import { getProviderRegistry } from '$lib/results/provider-setup';
	import { createSearchDependencies } from '$lib/results/search-dependencies';
	import { compareResults, sortResults } from '$lib/results/sort';
	import type { SortMode } from '$lib/results/sort';
	import { insertStable, slotsToResults, toSlot } from '$lib/results/stream-order';
	import type { StreamSlot } from '$lib/results/stream-order';
	import { connectionAirportCode, deriveScoredResult, summarizePriceCalendarOutcome, widenOptionGroupKey } from '$lib/results/types';
	import type { ProviderStatus, WidenOptionGroup } from '$lib/results/types';
	import { comparisonSelection } from '$lib/results/comparison-selection.svelte';
	import { toComparedItinerary } from '$lib/results/to-compared-itinerary';
	import FilterPanel from './FilterPanel.svelte';
	import NoResultsBoard from './NoResultsBoard.svelte';
	import ProviderStatusStrip from './ProviderStatusStrip.svelte';
	import ResultCard from './ResultCard.svelte';
	import ResultDetail from './ResultDetail.svelte';
	import StayKeyNotice from './StayKeyNotice.svelte';
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
	/** Issue #130: how many stopover candidates the primary search ended up ranking. Zero
	 * with an empty result means no free source could connect these two airports at all,
	 * which is a different thing to say than "candidates existed and none priced out" — see
	 * `results/no-results.ts`. Gated to the primary search for the same reason
	 * `directRouteKnown` is. */
	let candidateCount = $state(0);
	/** True once the primary search has yielded its final snapshot. The empty-results board
	 * explains what the providers answered, so it must not render in the frame between this
	 * page mounting and the search starting, when nothing has been asked yet and
	 * `searchesInFlight` is still zero. */
	let primarySearchDone = $state(false);
	let sortMode = $state<SortMode>('score');
	let filters = $state<ResultFilters>(emptyFilters());
	let connectionAirports = $state<Record<string, Airport>>({});
	/** Issue #130: the origin and destination airports' own records, resolved the same lazy
	 * way as the connection ones below, so the empty-results copy can name the city a route
	 * is missing from. Separate from `connectionAirports` because neither endpoint is ever a
	 * stopover, so nothing would put them in that map. */
	let endpointAirports = $state<Record<string, Airport>>({});
	/** How many searches (the primary one, plus any widen the traveller triggers) are
	 * currently streaming, reserve-space skeleton and "still searching" copy key off
	 * this being `> 0`, not off any single stream's own `done` flag. */
	let searchesInFlight = $state(0);
	let pendingWidenKey = $state<string | undefined>(undefined);
	/** Issue #103: which itineraries the traveller picked to line up in the comparator,
	 * keyed by `result.id` (the connection airport code) rather than by index or object
	 * identity. That's the same key `stream-order.ts` already treats as stable across
	 * snapshots (see its own header comment), so a checkbox never drifts onto a different
	 * trip when that connection's price or freshness updates in place mid-search. */
	let selectedIds = $state<Set<string>>(new Set());
	/** Issue #104: which single card, if any, has its timeline/map/pickers open below it. */
	let expandedId = $state<string | null>(null);
	/** Issue #104: the full `ItineraryGroup` behind each connection, kept alongside `order`
	 * only for the alternatives `variants` carries — `ScoredResult` itself only exposes a
	 * `variantCount`, not the variants a flight picker needs to show as rows. */
	let groupsByConnection = $state<Record<string, ItineraryGroup>>({});
	/** Issue #104: `SearchSnapshot.stayCandidatesByConnection`, merged the same way
	 * `providerStatuses` already is below, for `StayPicker`. */
	let stayCandidatesByConnection = $state<Record<string, Stay[]>>({});
	/** Issue #114: `SearchSnapshot.transferOptionsByConnection`/`.outerTransferOptions`,
	 * merged/replaced the same way as their stay/widen-options counterparts above, for
	 * `TransportPicker`. `outerTransferOptions` is replaced wholesale rather than merged —
	 * it is always the one current answer for the whole search, never keyed per connection. */
	let transferOptionsByConnection = $state<Record<string, ConnectionTransferOptions>>({});
	let outerTransferOptions = $state<OuterTransferOptions | undefined>(undefined);

	// Plain mutable bookkeeping, not `$state`: neither needs to trigger a render on its
	// own, only the `$state` fields written from inside the functions below do that.
	const requestedAirportCodes = new Set<string>();
	const requestedEndpointCodes = new Set<string>();
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
	const currency = $derived(results[0]?.itinerary.totalPrice.currency ?? DEFAULT_SEARCH_CURRENCY);
	const filterOptions = $derived(deriveFilterOptions(results));
	const filteredResults = $derived(applyFilters(results, filters));
	const providerStatusList = $derived(Object.values(providerStatuses));
	const stillSearching = $derived(searchesInFlight > 0);

	/** Issue #136: the city name behind each connection code, for the "Connection city"
	 * filter chips. Derived from the same `connectionAirports` records the cards already
	 * use, so a chip and the card it filters can never name the same airport differently. */
	const connectionCityNames = $derived(
		Object.fromEntries(
			Object.entries(connectionAirports).map(([code, airport]) => [code, airport.city.name])
		)
	);

	/** Issue #130: the city name behind each endpoint code, so the empty-results copy can say
	 * "Boa Vista (BVC)" instead of only "BVC". Undefined until the dataset resolves, and the
	 * copy falls back to the bare code rather than waiting or guessing. */
	const origin = $derived({ code: query?.originAirport ?? '', name: endpointAirports[query?.originAirport ?? '']?.city.name });
	const destination = $derived({
		code: query?.destinationAirport ?? '',
		name: endpointAirports[query?.destinationAirport ?? '']?.city.name
	});

	/**
	 * Issue #130: why this finished search has nothing to show, derived from what the
	 * providers actually answered rather than asserted. `undefined` whenever there is
	 * something on screen or something still running, which is what keeps this off every
	 * ordinary search.
	 */
	const noResults = $derived.by(() => {
		if (!query || !primarySearchDone || results.length > 0 || stillSearching) return undefined;
		const registry = getProviderRegistry();
		const usableIds = new Set(registry.usable('flight', keyStore.availableKeys).map((provider) => provider.id));
		return explainNoResults({
			origin,
			destination,
			providers: providerStatusList,
			registeredFlightProviders: registry.ofKind('flight').map((provider) => ({
				id: provider.id,
				label: provider.label,
				needsKey: provider.needsKey,
				usable: usableIds.has(provider.id)
			})),
			candidateCount,
			hasDirectRoute: directRouteKnown
		});
	});

	/**
	 * Issue #158: assembling this moved to `$lib/results/search-dependencies.ts` so it can be
	 * unit tested. All three search calls below (`runSearch`, `widenSearch`,
	 * `widenWithPriceCalendar`) go through this one function, so the currency it names is
	 * what puts `currency_id` on the Agoda request and `currency` on both flight leg queries.
	 * Read live from `keyStore` on every call, never captured once: a key pasted into
	 * settings in another tab has to reach the next search from this one.
	 */
	function deps(): SearchDependencies {
		return createSearchDependencies(keyStore.availableKeys);
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
					candidateCount = snapshot.candidates.length;
					if (snapshot.done) primarySearchDone = true;
				}
				const compare = untrack(() => compareResults(sortMode));
				for (const group of snapshot.itineraryGroups) {
					groupsByConnection = { ...groupsByConnection, [group.connectionAirportCode]: group };
					const scored = deriveScoredResult(group, snapshot, sequenceFor(group.connectionAirportCode));
					order = insertStable(order, toSlot(scored), compare);
				}
				stayCandidatesByConnection = { ...stayCandidatesByConnection, ...snapshot.stayCandidatesByConnection };
				transferOptionsByConnection = { ...transferOptionsByConnection, ...snapshot.transferOptionsByConnection };
				outerTransferOptions = snapshot.outerTransferOptions;
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
		candidateCount = 0;
		primarySearchDone = false;
		sequenceByConnection.clear();
		nextSequence = 1;
		// A new query is an unrelated search: yesterday's connection codes have no business
		// staying "selected" or "expanded" against whatever streams in next.
		selectedIds = new Set();
		expandedId = null;
		groupsByConnection = {};
		stayCandidatesByConnection = {};
		transferOptionsByConnection = {};
		outerTransferOptions = undefined;
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

	/** Resolves the query's own two airports, once per code, for the empty-results copy
	 * (issue #130). Same lazy `getAirport` pattern as the connection lookup below, and the
	 * same reason it is safe inside an effect: nothing here reads the state it writes. */
	$effect(() => {
		const activeQuery = query;
		if (!activeQuery) return;
		for (const code of [activeQuery.originAirport, activeQuery.destinationAirport]) {
			if (requestedEndpointCodes.has(code)) continue;
			requestedEndpointCodes.add(code);
			getAirport(code).then((airport) => {
				if (airport) endpointAirports = { ...endpointAirports, [code]: airport };
			});
		}
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

	function toggleSelected(id: string) {
		const next = new Set(selectedIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selectedIds = next;
	}

	function toggleExpanded(id: string) {
		expandedId = expandedId === id ? null : id;
	}

	function clearSelection() {
		selectedIds = new Set();
	}

	/** Issue #103: hands the comparator exactly the itineraries the traveller picked, as a
	 * snapshot taken at the moment of clicking — see `comparison-selection.svelte.ts`'s own
	 * header comment for why a snapshot rather than a live reference. `results`, not
	 * `filteredResults`: a filter hiding a card from view is not the same as un-selecting
	 * it. */
	function openComparator() {
		const chosen = results.filter((result) => selectedIds.has(result.id)).map(toComparedItinerary);
		comparisonSelection.set(chosen);
		goto(`${base}/comparator/`);
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

		<StayKeyNotice />

		<ProviderStatusStrip statuses={providerStatusList} searching={stillSearching} />

		<div class="results-layout">
			<aside class="results-filters" aria-label="Filters">
				<FilterPanel
					options={filterOptions}
					bind:filters
					bind:sortMode
					{currency}
					avoidedAirlines={query.airlinesToAvoid}
					{connectionCityNames}
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

				{#if noResults}
					<!-- Issue #130, and issue #107's "well served direct" ending folded into the
					     same component: every sentence here is derived from what the providers
					     answered (`results/no-results.ts`), never from what an empty list was
					     assumed to mean. The copy this replaced blamed "no workable connection"
					     on a search where the only keyless provider had said, twice, that it does
					     not serve the origin airport at all. -->
					<NoResultsBoard explanation={noResults} {origin} {destination} />
				{/if}

				<!-- Keyed on result.id (the connection airport code, stable for the whole
				     search per types.ts), so Svelte only ever moves a DOM node when
				     stream-order.ts genuinely repositions it, never recreates one just
				     because its price or freshness changed in place. -->
				<ul class="results-list">
					{#each filteredResults as result (result.id)}
						{@const code = connectionAirportCode(result.itinerary)}
						<li>
							<ResultCard
								{result}
								connectionAirport={connectionAirports[code]}
								selected={selectedIds.has(result.id)}
								expanded={expandedId === result.id}
								onToggleSelect={() => toggleSelected(result.id)}
								onToggleExpand={() => toggleExpanded(result.id)}
							/>
							{#if expandedId === result.id}
								<ResultDetail
									itinerary={result.itinerary}
									group={groupsByConnection[result.id]}
									stayCandidates={stayCandidatesByConnection[code] ?? []}
									transferOptions={transferOptionsByConnection[code]}
									{outerTransferOptions}
									connectionAirport={connectionAirports[code]}
									travellers={query.travellers}
									females={query.females}
									minLayoverTime={query.minLayoverTime}
									searchDone={primarySearchDone && !stillSearching}
								/>
							{/if}
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

				{#if selectedIds.size > 0}
					<!-- Sticks to the bottom of `.app-content`'s own scrollport (the nearest
					     scrolling ancestor — see +layout.svelte), so it stays reachable while
					     scrolling a long results list without covering the tab bar below it,
					     which lives outside `.app-content` entirely. -->
					<div class="compare-bar" role="region" aria-label="Comparison selection">
						<p class="compare-bar-count">
							<span class="font-mono tabular-nums">{selectedIds.size}</span>
							{selectedIds.size === 1 ? 'itinerary' : 'itineraries'} selected
						</p>
						<div class="compare-bar-actions">
							<Button variant="ghost" size="sm" onclick={clearSelection}>Clear</Button>
							<Button size="sm" onclick={openComparator}>Compare</Button>
						</div>
					</div>
				{/if}
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

	/* Sticks to the bottom of `.app-content`'s own scrollport (the nearest ancestor with
	   real overflow — see +layout.svelte's own comment on why that's the element that
	   actually scrolls, not this page), so the action stays reachable without a second
	   click cycle up to the top of a long list, and without covering the tab bar, which is
	   a separate grid area outside `.app-content` entirely. */
	.compare-bar {
		position: sticky;
		bottom: var(--space-4);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		flex-wrap: wrap;
		padding: var(--space-3) var(--space-4);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-lg);
		background: var(--color-bg-elevated);
		box-shadow: var(--shadow-md);
	}

	.compare-bar-count {
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-medium);
		color: var(--color-text);
	}

	.compare-bar-actions {
		display: flex;
		gap: var(--space-2);
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
