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
	 *
	 * Since the search and results screens were merged, this page also owns the query
	 * itself: `SearchSummaryBar` keeps it visible at the top and opens the real search
	 * form in place, and `$lib/search-form/validation` gets a look at the URL before any
	 * provider does. A link carrying `from=BCN&to=BCN` or `people=0` used to run a full
	 * search to discover it could not answer.
	 */
	import { untrack } from 'svelte';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { Button, Card, EmptyState, ErrorState, Skeleton } from '$lib/components';
	import { getAirport } from '$lib/data/airports';
	import { DEFAULT_SEARCH_CURRENCY } from '$lib/domain';
	import type { Airport, IataAirportCode, SearchQuery, Stay } from '$lib/domain';
	import { recordItineraryGroup } from '$lib/flexible-dates';
	import { keyStore } from '$lib/keys';
	import { buildSearchQuery } from '$lib/search-form/model';
	import { searchParamsToFields } from '$lib/search-form/url-codec';
	import { hasBlockingIssue, validateSearchFields } from '$lib/search-form/validation';
	import { normalizeQuery, RecentSearches, searchHistory, summarizeSearch } from '$lib/search-history';
	import SearchSummaryBar from './SearchSummaryBar.svelte';
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
	const searchFields = $derived(
		searchParamsToFields(browser ? page.url.searchParams : new URLSearchParams())
	);
	const parsedQuery = $derived<SearchQuery | null>(
		browser ? buildSearchQuery(searchFields) : null
	);

	/** Not reactive: a results page does not need to notice midnight ticking over while
	 * it is open, and a wrong build date costs nothing because this only ever hydrates in
	 * a real browser. */
	const todayIso = new Date().toISOString().slice(0, 10);

	const issues = $derived(validateSearchFields(searchFields, { today: todayIso }));
	/** A query that cannot describe a trip on any date. Nothing is asked of any provider
	 * until it is fixed, which is the point: the traveller sees the reason in the field
	 * instead of waiting out a search that was never going to answer. */
	const blockingIssues = $derived(parsedQuery && hasBlockingIssue(issues) ? issues.filter((issue) => issue.severity === 'blocking') : []);
	/** True but not fatal, such as dates that have already passed. Said out loud, and the
	 * search still runs: a link shared last week going dead at midnight would surprise its
	 * reader more than a sentence explaining what happened. */
	const advisories = $derived(
		issues.filter((issue) => issue.severity === 'advisory').map((issue) => issue.message)
	);

	const query = $derived<SearchQuery | null>(blockingIssues.length > 0 ? null : parsedQuery);
	const summary = $derived(parsedQuery ? summarizeSearch(parsedQuery) : undefined);
	const normalizedQuery = $derived(
		browser ? normalizeQuery(page.url.searchParams) : ''
	);

	/** Opened by hand from the summary bar, or forced open when the URL's own search is
	 * the thing that needs fixing. */
	let editorOpen = $state(false);
	$effect(() => {
		if (blockingIssues.length > 0) editorOpen = true;
	});

	/**
	 * Every search that actually ran is remembered, whether it came from the form next
	 * door or from a link someone sent. Deduplicated and capped by the store itself.
	 * `untrack` because `record` writes state this component also reads further down, and
	 * an effect that reads what it writes is what froze this page once already (#87).
	 */
	$effect(() => {
		const params = normalizedQuery;
		if (!query || !params) return;
		untrack(() => searchHistory.record(new URLSearchParams(params)));
	});

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
	/**
	 * Issue #224: how many nights the traveller has chosen for a given stopover, for the
	 * ones they have touched. Absent means "whatever the card opens on", which is the
	 * shortest length that connection can do.
	 *
	 * It lives here rather than inside `ResultCard` because a card's price, trip strip and
	 * metric rail all derive from one itinerary, and the pipeline replaces every group on
	 * every snapshot: a length held inside the card would be overwritten the moment an
	 * unrelated provider answered. Kept per connection code, the same key `order` and
	 * `sequenceByConnection` already use, so a card's chosen length survives the group
	 * behind it being rebuilt.
	 */
	let chosenNightsByConnection = $state<Record<string, number>>({});

	// Plain mutable bookkeeping, not `$state`: neither needs to trigger a render on its
	// own, only the `$state` fields written from inside the functions below do that.
	const requestedAirportCodes = new Set<string>();
	const requestedEndpointCodes = new Set<string>();
	/** Issue #71: what has already gone into the price ledger, keyed by the fares themselves
	 * (`ledgerSignature`). Not `$state`: nothing renders from it. Never cleared between
	 * searches on purpose, since the same fares have nothing new to record whichever search
	 * yielded them. */
	const recordedToLedger = new Set<string>();
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

	/**
	 * Issue #224: the stopover length one connection should be showing. The traveller's own
	 * pick wins; failing that, a nights filter is a request for that many nights, so the
	 * cards show trips of that length instead of leaving somebody to press + on every one
	 * of them. `undefined` leaves `deriveScoredResult` to open at the shortest length.
	 *
	 * A length this connection cannot do falls back to the shortest, inside
	 * `deriveScoredResult`, rather than being rounded to the nearest. See its doc comment.
	 */
	function requestedNightsFor(code: string): number | undefined {
		return chosenNightsByConnection[code] ?? filters.minNights;
	}

	/**
	 * Records the length the traveller picked. Nothing else: `results` below re-derives
	 * that card from the group it already has, so the card's content changes and its
	 * POSITION does not. A list that reordered itself under the finger that just pressed +
	 * is the exact instability `stream-order.ts` exists to prevent, and leaving `order`
	 * alone is the cheapest possible way to guarantee it.
	 *
	 * Zero provider requests, now or ever. Every length is a flight pairing this search
	 * already fetched, and the bed's nightly rate was quoted once for the whole stay;
	 * `buildItineraries` multiplied it out per pairing when the search ran.
	 */
	function chooseNights(code: string, nights: number) {
		chosenNightsByConnection = { ...chosenNightsByConnection, [code]: nights };
	}

	/**
	 * The cards, in their standing order, each at the stopover length it should be showing.
	 *
	 * The re-derivation is here rather than in an `$effect` writing back into `order` on
	 * purpose: an effect that reads and writes the same state is the shape that froze this
	 * page once already (AGENTS.md, "The Svelte trap that cost us a working search"). A
	 * `$derived` cannot loop, and `order` stays exactly what the stream put there.
	 */
	const results = $derived(
		slotsToResults(order).map((result) => {
			const requested = requestedNightsFor(result.id);
			if (requested === undefined || requested === result.itinerary.nightsInConnection) return result;
			const group = groupsByConnection[result.id];
			if (!group) return result;
			return deriveScoredResult(
				group,
				{ providers: providerStatuses, done: primarySearchDone && !stillSearching },
				result.sequence,
				requested
			);
		})
	);
	const currency = $derived(results[0]?.itinerary.totalPrice.currency ?? DEFAULT_SEARCH_CURRENCY);
	const filterOptions = $derived(deriveFilterOptions(results));
	const filteredResults = $derived(applyFilters(results, filters));
	const providerStatusList = $derived(Object.values(providerStatuses));
	const stillSearching = $derived(searchesInFlight > 0);

	/**
	 * Issue #71: the stopovers this search has actually surfaced, handed to `/results/when/`
	 * so it knows which two legs to price a year of.
	 *
	 * Passed as `stops`, deliberately NOT as `via`. `via` is a real search constraint
	 * (`allowedConnectionAirports`), and writing the stopovers this search happened to find
	 * into it would narrow the next search to them behind the traveller's back. The when-view
	 * sets `via` only once somebody has picked one.
	 */
	const flexibleDatesStopovers = $derived(
		[...new Set(results.map((result) => connectionAirportCode(result.itinerary)))]
	);
	const flexibleDatesHref = $derived.by(() => {
		if (!browser) return `${base}/results/when/`;
		const params = new URLSearchParams(page.url.searchParams);
		if (flexibleDatesStopovers.length > 0) params.set('stops', flexibleDatesStopovers.join(','));
		const query = params.toString();
		return query ? `${base}/results/when/?${query}` : `${base}/results/when/`;
	});

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
	 * settings in another tab has to reach the next search from this one, and so does a
	 * currency picked there.
	 */
	function deps(): SearchDependencies {
		return createSearchDependencies(keyStore.availableKeys, keyStore.currency);
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
					// Issue #71: write this group's per-day fares into the price ledger, so a later
					// "which week is cheapest" can answer from prices this search already paid for.
					// Zero requests, deliberately not awaited: it is bookkeeping for a future visit,
					// and `recordItineraryGroup` never rejects (see its own doc comment), so nothing
					// here can delay or fail the results the traveller is waiting on.
					// `recordedToLedger` is this page's memo of what it has already written, so the
					// pipeline re-yielding an unchanged group does not re-run a read-modify-write
					// against the same IndexedDB store the search is reading from.
					void recordItineraryGroup(group, keyStore.currency ?? DEFAULT_SEARCH_CURRENCY, {
						alreadyWritten: recordedToLedger
					});
					// Issue #224: a re-yielded group keeps whatever length the traveller
					// chose for it, rather than snapping back to the shortest while they
					// are reading it.
					const scored = deriveScoredResult(
						group,
						snapshot,
						sequenceFor(group.connectionAirportCode),
						untrack(() => requestedNightsFor(group.connectionAirportCode))
					);
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
		// staying "expanded" against whatever streams in next.
		expandedId = null;
		// Issue #224: a new query is a new set of stopovers, so a length chosen for
		// yesterday's London card has no business applying to whatever LGW turns out to be
		// this time.
		chosenNightsByConnection = {};
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

	function toggleExpanded(id: string) {
		expandedId = expandedId === id ? null : id;
	}

	/** A refined search is a navigation to this same page with different params, which is
	 * what makes the browser's back button walk back through the searches the traveller
	 * actually ran. The query effect above tears the old results down. */
	function submitSearch(next: URLSearchParams) {
		editorOpen = false;
		void goto(`${base}/results/?${next.toString()}`);
	}

	/**
	 * Filters and the widen panel are a sidebar on a wide screen and a collapsed sheet on
	 * a phone. Issue #139 measured the first result card at about 1,650px down a 375px
	 * viewport, behind the sort control, four range sliders, two chip rows and four widen
	 * blocks: "The person who typed a search wants the answer."
	 *
	 * Read from `matchMedia` rather than branched on in CSS alone so `aria-expanded` and
	 * `hidden` tell the truth at both widths. The initial value is computed inline, not in
	 * an effect, so a desktop browser hydrates with the panel already open.
	 */
	let sidebarIsColumn = $state(browser ? window.matchMedia('(min-width: 64rem)').matches : false);
	$effect(() => {
		const media = window.matchMedia('(min-width: 64rem)');
		const sync = () => (sidebarIsColumn = media.matches);
		sync();
		media.addEventListener('change', sync);
		return () => media.removeEventListener('change', sync);
	});
	let filtersOpenOnPhone = $state(false);
	const filtersVisible = $derived(sidebarIsColumn || filtersOpenOnPhone);
	const activeFilterCount = $derived(
		[
			filters.maxPriceMinorUnits !== undefined,
			filters.maxTotalDurationMinutes !== undefined,
			filters.minNights !== undefined,
			filters.minFreeTimeMinutes !== undefined,
			filters.excludedConnectionAirports.size > 0,
			filters.excludedAirlines.size > 0
		].filter(Boolean).length
	);
</script>

<svelte:head>
	<title
		>{summary
			? `${summary.originAirport} to ${summary.destinationAirport} - Layover`
			: 'Results - Layover'}</title
	>
</svelte:head>

<div class="results-page">
	{#if !parsedQuery}
		<EmptyState
			title="No search in this link"
			description="A results page is a search plus its answers, and this link carries no search. Start one, or pick up where you left off."
		>
			{#snippet action()}
				<Button href={`${base}/`}>Go to search</Button>
			{/snippet}
		</EmptyState>
		<RecentSearches title="Pick up a recent search" />
	{:else if summary}
		<SearchSummaryBar
			{summary}
			initialFields={searchFields}
			today={todayIso}
			onsearch={submitSearch}
			{advisories}
			revealIssues={blockingIssues.length > 0}
			bind:expanded={editorOpen}
		/>

		{#if blockingIssues.length > 0}
			<!-- Nothing has been asked of any provider. This search describes a trip that
			     cannot exist on any date (an origin equal to its destination, an arrival
			     before its own departure, a party of nobody), so running it would spend
			     requests to rediscover that. The form above is already open on the fields
			     that need changing. -->
			<ErrorState
				severity="error"
				title="This search cannot be run as it stands"
				message="No provider was asked anything. The form above says what to change."
			/>
		{:else if query}
			<p class="results-subhead" aria-live="polite">
				{filteredResults.length} of {results.length}
				{results.length === 1 ? 'itinerary' : 'itineraries'} shown
				{#if stillSearching}<span class="still-searching">&middot; still searching</span>{/if}
			</p>

			<!-- Issue #71. One line, above the results rather than below them, because somebody
			     whose dates are flexible decides that before reading a single card. A link, not
			     a button: it is a place, it deep-links, and cmd-click has to open it in a tab
			     like everything else. -->
			<a class="when-link" href={flexibleDatesHref}>
				<span class="when-link-icon" aria-hidden="true">
					<svg viewBox="0 0 24 24" fill="none">
						<rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.7" />
						<path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
						<path d="M7.5 14h2M12 14h2M16.5 17h1" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
					</svg>
				</span>
				<span class="when-link-text">
					Flexible dates? See which week is cheapest
					{#if flexibleDatesStopovers.length > 0}
						<span class="when-link-note"
							>from prices already cached for {flexibleDatesStopovers.length}
							{flexibleDatesStopovers.length === 1 ? 'stopover' : 'stopovers'}</span
						>
					{/if}
				</span>
			</a>

			<div class="results-layout">
				<aside class="results-filters" aria-label="Filters and sorting">
					<!-- On a phone this whole panel starts closed behind one button, because
					     issue #139 measured the first result card at about 1,650px down with
					     it open: "The person who typed a search wants the answer." On a wide
					     screen it is a sidebar and the button is not rendered at all. -->
					<button
						type="button"
						class="filters-toggle"
						aria-expanded={filtersVisible}
						aria-controls="results-filters-body"
						onclick={() => (filtersOpenOnPhone = !filtersOpenOnPhone)}
					>
						<span class="filters-toggle-icon" aria-hidden="true">
							<svg viewBox="0 0 24 24" fill="none">
								<path
									d="M4 6h16M7 12h10M10 18h4"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
								/>
							</svg>
						</span>
						Filter and sort
						{#if activeFilterCount > 0}
							<span class="filters-count">{activeFilterCount}</span>
						{/if}
					</button>
					<div id="results-filters-body" class="results-filters-body" hidden={!filtersVisible}>
						<FilterPanel
							options={filterOptions}
							bind:filters
							bind:sortMode
							{currency}
							avoidedAirlines={query.airlinesToAvoid}
							{connectionCityNames}
						/>
					</div>
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
									expanded={expandedId === result.id}
									onToggleExpand={() => toggleExpanded(result.id)}
									onNightsChange={(nights) => chooseNights(result.id, nights)}
								/>
								{#if expandedId === result.id}
									<!-- Keyed on the stopover length: `ResultDetail` freezes its itinerary
									     at mount so a streaming snapshot cannot wipe out a traveller's
									     in-progress pick, which also means it cannot follow a length
									     change made on the card above it. Remounting is the honest
									     answer rather than the cheap one: a different length is a
									     different onward flight, so any flight or transfer picked inside
									     the panel was for a trip that no longer exists. -->
									{#key result.itinerary.nightsInConnection}
									<ResultDetail
										itinerary={result.itinerary}
										atDefaultLength={result.itinerary.nightsInConnection === result.stopover.minimum}
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
									{/key}
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

					<!-- Everything that explains the results rather than being one, gathered
					     below them: which providers answered, why no bed is priced, and what
					     spending a metered request would buy. All three used to sit between
					     the search and the first card. -->
					<section class="results-context" aria-label="About these results">
						<ProviderStatusStrip statuses={providerStatusList} searching={stillSearching} />
						<StayKeyNotice />
						<WidenOptionsPanel
							options={widenOptions}
							onWiden={handleWiden}
							pendingKey={pendingWidenKey}
						/>
						{#if calendarSummaries.length > 0}
							<div class="calendar-summaries">
								<p class="calendar-summaries-label">Calendar results</p>
								<ul>
									{#each calendarSummaries as calendarSummary, index (index)}
										<li>{calendarSummary}</li>
									{/each}
								</ul>
							</div>
						{/if}
					</section>
				</div>
			</div>
		{/if}
	{/if}
</div>

<style>
	/* Issue #71's entry point. A single row, not a card: it sits between the result count
	   and the results themselves, and #139's lesson is that anything with a box around it
	   up here pushes the answer down the page. */
	.when-link {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-height: 2.75rem;
		padding: var(--space-2) var(--space-3);
		border: 1px dashed var(--color-border-strong);
		border-radius: var(--radius-md);
		color: var(--color-text);
		text-decoration: none;
		font-size: var(--font-size-sm);
		line-height: var(--line-height-sm);
	}

	.when-link:hover {
		border-color: var(--color-accent);
		background: var(--color-accent-muted);
	}

	.when-link:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	.when-link-icon {
		flex: none;
		display: inline-flex;
		width: 1.25rem;
		height: 1.25rem;
		color: var(--color-accent);
	}

	.when-link-icon svg {
		width: 100%;
		height: 100%;
	}

	.when-link-text {
		min-width: 0;
	}

	.when-link-note {
		display: block;
		color: var(--color-text-muted);
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
	}

	.results-page {
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
		max-width: var(--layout-max-width);
		margin: 0 auto;
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
		gap: var(--space-5);
	}

	.results-filters {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		min-width: 0;
	}

	/* A grid item's `min-width` is `auto`, so the widest thing inside a result card (a
	   route line with three airports and their flags) was stretching this column past the
	   viewport and clipping every card's right-hand edge on a phone. `0` lets the column
	   take the track's width and the content inside wrap or scroll on its own terms. */
	.results-list-column {
		min-width: 0;
	}

	.filters-toggle {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		align-self: start;
		/* 44px, per WCAG 2.5.5. */
		min-height: 2.75rem;
		padding-inline: var(--space-4);
		background: var(--color-surface);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-full);
		color: var(--color-text);
		font-family: inherit;
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		cursor: pointer;
		transition:
			background-color var(--transition-fast),
			border-color var(--transition-fast),
			color var(--transition-fast);
	}

	.filters-toggle:hover {
		background: var(--color-surface-hover);
		border-color: var(--color-accent);
		color: var(--color-accent);
	}

	.filters-toggle:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	.filters-toggle-icon svg {
		width: 1.125rem;
		height: 1.125rem;
		display: block;
	}

	/* How many filters are on, so a closed panel is never silent state. */
	.filters-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.375rem;
		height: 1.375rem;
		padding-inline: 0.375rem;
		border-radius: var(--radius-full);
		background: var(--color-accent);
		color: var(--color-accent-text);
		font-family: var(--font-mono);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-bold);
	}

	.results-filters-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
		min-width: 0;
	}

	/* `display: flex` above beats the user-agent's own `[hidden] { display: none }`, so
	   without this the panel stays on screen while `aria-expanded` says it is closed. */
	.results-filters-body[hidden] {
		display: none;
	}

	/* Provider chips, the missing-stay-key notice and the widen panel: context for the
	   answer rather than the answer, so it reads after it. */
	.results-context {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		margin-top: var(--space-2);
		padding-top: var(--space-5);
		border-top: 1px dashed var(--color-border);
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
			gap: var(--space-6);
		}

		.results-filters {
			position: sticky;
			/* Clears the search summary strip pinned above it, so the two never overlap. */
			top: 6rem;
		}

		/* A sidebar is already open; a button that says so would be a control with
		   nothing to do. */
		.filters-toggle {
			display: none;
		}
	}
</style>
