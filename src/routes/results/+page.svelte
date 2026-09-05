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
	import { tick, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { onRevalidationSettled } from '$lib/cache';
	import { Button, EmptyState, ErrorState, Icon } from '$lib/components';
	import { getAirport } from '$lib/data/airports';
	import { knownAirportCodes } from '$lib/data/known-airports.svelte';
	import { DEFAULT_MIN_LAYOVER_TIME_MINUTES, DEFAULT_SEARCH_CURRENCY } from '$lib/domain';
	import type { Airport, IataAirportCode, Itinerary, SearchQuery, Stay } from '$lib/domain';
	import type { ItinerarySegmentId } from '$lib/itinerary-map/segment-id';
	import { BOTTOM_SHEET_ATTRIBUTE } from '$lib/results/reveal-scroll';
	import { recordItineraryGroup } from '$lib/flexible-dates';
	import { keyStore } from '$lib/keys';
	import { buildSearchQuery } from '$lib/search-form/model';
	import { searchParamsToFields } from '$lib/search-form/url-codec';
	import { hasBlockingIssue, REQUIRED_SEARCH_FIELDS, validateSearchFields } from '$lib/search-form/validation';
	import { normalizeQuery, RecentSearches, searchHistory, summarizeSearch } from '$lib/search-history';
	import SearchSummaryBar from './SearchSummaryBar.svelte';
	import {
		confirmTargetFor,
		createTransitLookupBudget,
		runSearch,
		widenSearch,
		widenWithPriceCalendar
	} from '$lib/search';
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
	import type { PriceBand } from '$lib/results/price-band';
	import { collectPriceBand } from '$lib/results/price-band-source';
	import { ItineraryDraft } from '$lib/results/itinerary-draft.svelte';
	import { getProviderRegistry, stayProviderOutcomes } from '$lib/results/provider-setup';
	import { createSearchDependencies } from '$lib/results/search-dependencies';
	import { recordChoice } from '$lib/results/traveller-choices';
	import type { TravellerChoicesByResult } from '$lib/results/traveller-choices';
	import {
		buildConnectionsMapModel,
		ConnectionsMapDialog,
		type ConnectionBlock
	} from '$lib/connections-map';
	import { compareResults, sortResults } from '$lib/results/sort';
	import type { SortMode } from '$lib/results/sort';
	import { insertStable, insertWithoutDisplacing, slotsToResults, toSlot } from '$lib/results/stream-order';
	import type { StreamSlot } from '$lib/results/stream-order';
	import { connectionAirportCode, deriveScoredResult, summarizePriceCalendarOutcome, widenOptionGroupKey } from '$lib/results/types';
	import type { AffordableWiden, ProviderStatus, ScoredResult, WidenOptionGroup } from '$lib/results/types';
	import FilterPanel from './FilterPanel.svelte';
	import NoResultsBoard from './NoResultsBoard.svelte';
	import ProviderStatusStrip from './ProviderStatusStrip.svelte';
	import ResultCard from './ResultCard.svelte';
	import ResultCardSkeleton from './ResultCardSkeleton.svelte';
	import ResultDetail from './ResultDetail.svelte';
	import SegmentCustomiser from './SegmentCustomiser.svelte';
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

	/**
	 * Issue #327: whether each airport code in the URL is one this app has ever heard of.
	 * `undefined` until the dataset lands, which `validateSearchFields` reads as "not
	 * checked yet" rather than as a verdict, and which `query` below waits out. A search
	 * started before this could answer is precisely the one that reached `runSearch` with
	 * `ZZZ` in it and threw where nobody would read it.
	 */
	const airportCodes = $derived(knownAirportCodes());
	const issues = $derived(
		validateSearchFields(searchFields, {
			today: todayIso,
			knowsAirport: airportCodes ? (code: string) => airportCodes.has(code) : undefined
		})
	);
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

	const query = $derived<SearchQuery | null>(
		blockingIssues.length > 0 || !airportCodes ? null : parsedQuery
	);

	/**
	 * Issue #327: the reasons themselves, where the results would have been.
	 *
	 * The one sentence this replaced was true and named nothing. Someone following a link
	 * with a retired airport code in it read a page that never said which code, which end
	 * of the trip it was on, or that a code was the problem at all.
	 */
	const blockingSummary = $derived(
		[
			...blockingIssues.map((issue) => issue.message),
			'No provider was asked anything. The form above is open on what to change.'
		].join(' ')
	);

	/**
	 * Issue #327: a link carrying half a search is not a link carrying none.
	 *
	 * `buildSearchQuery` only ever answers "are the four required fields here", so a URL
	 * that lost its `to=` on the way through a chat app landed on the same "this link
	 * carries no search" as an ordinary bare visit to `/results/`. That reads as a shrug to
	 * the one person who can see their origin and their dates still in the address bar.
	 */
	const noQueryCopy = $derived.by(() => {
		const missing = issues.filter(
			(issue) => REQUIRED_SEARCH_FIELDS.has(issue.field) && issue.severity === 'blocking'
		);
		// Every required field empty is a bare visit rather than a broken link, and
		// listing four things nobody has filled in yet helps nobody.
		if (missing.length === 0 || missing.length === REQUIRED_SEARCH_FIELDS.size) {
			return {
				title: 'No search in this link',
				description:
					'A results page is a search plus its answers, and this link carries no search. Start one, or pick up where you left off.'
			};
		}
		return {
			title: 'This link is missing part of its search',
			description: `${missing.map((issue) => issue.message).join(' ')} The rest of it is filled in already.`
		};
	});
	const summary = $derived(parsedQuery ? summarizeSearch(parsedQuery) : undefined);
	const normalizedQuery = $derived(
		browser ? normalizeQuery(page.url.searchParams) : ''
	);
	/** Issue #327: exactly what the link carried, unnormalised, for the way back to the
	 * search screen. Same prerender guard as `searchFields`: reading `searchParams` at
	 * build time throws. */
	const searchParamsFromLink = $derived(browser ? page.url.searchParams.toString() : '');

	/** Opened by hand from the summary bar, or forced open when the URL's own search is
	 * the thing that needs fixing. */
	let editorOpen = $state(false);
	$effect(() => {
		if (blockingIssues.length > 0) editorOpen = true;
	});

	/**
	 * Every search a traveller made is remembered, whether it came from the form next door
	 * or from a link someone sent. Deduplicated and capped by the store itself. `untrack`
	 * because `record` writes state this component also reads further down, and an effect
	 * that reads what it writes is what froze this page once already (#87).
	 *
	 * Issue #358: this reads `parsedQuery` rather than `query` on purpose. `query` stays
	 * null until the 150KB airports dataset lands, so that no provider is asked about a code
	 * this app has never heard of, and filing history behind that download lost the search
	 * for anyone who left before it arrived. Measured with `tools/probe-history-write-timing.mjs`:
	 * the heading is on screen at 57ms and the write happens 12ms after the dataset chunk,
	 * so delaying that chunk by 1.5s delays the write by 1.53s. Whether the two codes are
	 * real is a different question from whether a search was made, and only the second one
	 * decides this. A link carrying a retired code is therefore remembered too, which leaves
	 * it one tap from the page that says what is wrong with it.
	 */
	$effect(() => {
		const params = normalizedQuery;
		if (!parsedQuery || blockingIssues.length > 0 || !params) return;
		untrack(() => searchHistory.record(new URLSearchParams(params)));
	});

	let order = $state<StreamSlot[]>([]);
	/**
	 * Issue #314: the results that are on screen but not where the sort control says they
	 * should be, because putting them there would have pushed a card the traveller can see
	 * off the bottom of the screen.
	 *
	 * Ids rather than a count, so a provider re-answering the same stopover twice does not
	 * offer to re-sort the same trip twice. The status line above the list offers to put them
	 * right, and `showHeldResults` does it in one go.
	 */
	let arrivedOutOfOrder = $state<string[]>([]);
	/** The `<ul>` itself, so `displacedCardIsOffScreen` can find a card by its id and ask
	 * the browser where it ended up. */
	let listEl = $state<HTMLUListElement | undefined>(undefined);
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
	/**
	 * Issue #324: every connection the search ranked, and why each one that produced nothing
	 * produced nothing. Both come straight off the snapshot; the map re-derives neither.
	 *
	 * Kept even though `results` already carries the ones that worked, because the whole
	 * point of the connections map is the ones that did not: a city with no viable pairing
	 * never becomes a card, so the results list is the one place it can never appear.
	 */
	let candidateCodes = $state<IataAirportCode[]>([]);
	/**
	 * Issue #350: the stopovers candidate discovery confirmed on both flights and then
	 * dropped, because the candidate cap was already full.
	 *
	 * Separate from `candidateCodes` above, which is what the search is actually pursuing.
	 * These airports get no card, no arc and no point, because nothing was ever priced for
	 * them — they exist here so the page can say they exist, which is the entire difference
	 * between "six stopovers" and "six is how many we priced".
	 */
	let confirmedBeyondCap = $state<IataAirportCode[]>([]);
	let blockedConnections = $state<Record<string, ConnectionBlock>>({});
	let connectionsMapOpen = $state(false);
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
	/**
	 * Issue #278: which single card, if any, has its full timeline unfolded under its trip
	 * strip. One at a time, the same rule the card-level expander had: two timelines open
	 * is a wall of rows to scroll past, and this list exists for comparing cards.
	 */
	let openTimelineId = $state<string | null>(null);

	/**
	 * Issue #278: which card the customise rail is showing, and which stretch of it.
	 *
	 * One selection for the whole page, not one per card. There is one rail, so picking a
	 * segment on card B has to clear card A's, and a per-card copy would leave two cards
	 * both drawing themselves as selected. The strip, the timeline and the map all read
	 * this same value, which is what issue #73's shared `ItinerarySegmentId` vocabulary
	 * exists for.
	 */
	let customising = $state<{ resultId: string; segment: ItinerarySegmentId | null } | null>(null);

	/**
	 * Issue #278: the trip each card is showing, once the traveller has changed something
	 * about it.
	 *
	 * Absent means "whatever the stream last said", which is every card until somebody
	 * edits one. A draft is created on the first edit and never re-synced afterwards:
	 * `SearchSnapshot.itineraryGroups` is rebuilt whole on every snapshot, so a card that
	 * re-read its prop would throw away the flight the traveller just picked the moment an
	 * unrelated provider answered. `ResultDetail` used to freeze its own copy for exactly
	 * this reason; the copy moved out here because the rail that edits it is a sibling of
	 * the card that shows it, not a child.
	 *
	 * A `SvelteMap` because the cards read it while the handlers below write it.
	 */
	const drafts = new SvelteMap<string, ItineraryDraft>();
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
	 * Issue #267: this search's ration of Transitous lookups, owned here because two
	 * different things spend it. `runSearch` and `widenSearch` take it as an option, and
	 * `ResultDetail`'s "check public transport" claims from the same object, so the twelve
	 * are twelve across both rather than twelve each. Replaced with the query, in the same
	 * effect that clears everything else a new search invalidates.
	 */
	let transitLookupBudget = $state(createTransitLookupBudget());
	/**
	 * Issues #224 and #367: everything the traveller has decided about a stopover, for the
	 * ones they have touched. An absent field means "whatever the app recommends", so an
	 * absent record is a card nobody has edited.
	 *
	 * It lives here rather than inside `ResultCard` because a card's price, trip strip and
	 * metric rail all derive from one itinerary, and the pipeline replaces every group on
	 * every snapshot: a decision held inside the card would be overwritten the moment an
	 * unrelated provider answered. `chooseNights` below destroys and rebuilds the whole
	 * `ItineraryDraft` as well, so the draft cannot hold them either. Kept per connection
	 * code, the same key `order` and `sequenceByConnection` already use, so a card's
	 * decisions survive the group behind it being rebuilt.
	 */
	let choicesByResult = $state<TravellerChoicesByResult>({});

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
	/**
	 * Issue #293: a background revalidation has landed since this page last read the cache,
	 * so the fetch times and prices on screen are behind what the app is holding.
	 *
	 * Not `$state`, and the refresh it schedules is not an `$effect`. An effect that both
	 * read this flag and called `consumeSearch` would read and write `searchesInFlight` on
	 * its own call stack, which is #87's `effect_update_depth_exceeded` exactly. The two
	 * places a refresh can become due are both plain function bodies instead: the moment an
	 * announcement arrives, and the moment the last search in flight finishes.
	 */
	let revalidationPending = false;
	/**
	 * How many background refreshes are running. Counted apart from `searchesInFlight`, and
	 * not `$state`, because a refresh is not a search a traveller is waiting on: nothing on
	 * screen is missing while it runs, so "still searching" and the reserve-space skeleton
	 * have nothing to say about it. Counting them together flashed "still searching" nine
	 * times at a finished page, because a warm reload's revalidations arrive over about
	 * twenty-five seconds rather than together.
	 */
	let refreshesInFlight = 0;
	/** The current query's controller, so a refresh started outside the search effect is
	 * still cancelled by navigating away from the query it belongs to. */
	let searchController: AbortController | undefined;

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
		return choicesByResult[code]?.nights ?? filters.minNights;
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
	function chooseNights(result: ScoredResult, nights: number) {
		choicesByResult = recordChoice(choicesByResult, result.id, { nights });
		// A different length is a different onward flight, so any flight, transfer or bed
		// picked against the old one was for a trip that no longer exists. The draft starts
		// again from the trip at the new length, taken off the very option the ladder just
		// priced rather than derived a second time here: `StopoverLengthOption` carries the
		// itinerary precisely so a control can price a rung before it is taken.
		const option = result.stopover.options.find((candidate) => candidate.nights === nights);
		if (option) drafts.set(result.id, new ItineraryDraft(option.itinerary));
		else drafts.delete(result.id);
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

	/**
	 * Issue #314: how many card-shaped slots the list holds open for results that have not
	 * arrived yet.
	 *
	 * The reservation has one job: put everything under the list below the fold and keep it
	 * there, so the provider strip's 594px of growth and every later arrival land off screen.
	 * Two slots is the smallest number that does it. The list starts 383px down a 375x812
	 * phone and 272px down a 1280x900 desktop, so it needs to be over 429px and 630px tall
	 * respectively, and two 480px slots is 960px.
	 *
	 * Reserving more is not free, which is why this is two and not six. Whatever the search
	 * does not fill is withdrawn when it finishes, and `.results-list-reserved`'s floor is
	 * what stops that collapse reaching the provider strip. Two slots keeps the amount being
	 * withdrawn inside what the floor covers; six would not.
	 *
	 * Not one per candidate, which is what #314 suggested. `candidateCount` only lands with
	 * the first snapshot, and revising the reservation down at that point is the same
	 * collapse happening earlier rather than a way of avoiding it.
	 */
	const RESERVED_RESULT_SLOTS = 2;
	// Issue #203: what the stay providers did in this search, for the one place per stopover
	// that says why a bed is missing. Derived from the same `providerStatuses` the strip
	// below the list renders, so the two cannot disagree about whether Hostelworld failed.
	const stayProviders = $derived(stayProviderOutcomes(providerStatusList));
	const stillSearching = $derived(searchesInFlight > 0);
	/**
	 * Issue #314: which slots are still waiting for a card, so the list is the same length at
	 * the first frame as it is three results later and nothing under it moves.
	 *
	 * The values are absolute slot positions, not a count, and that is the whole trick. The
	 * skeletons are keyed on them, so the first result consumes the placeholder at slot 0 and
	 * leaves slots 1 and 2 holding the same two DOM nodes they already had. Keyed on a count
	 * instead, Svelte drops the *last* placeholder and the two survivors are pushed down a
	 * whole card by the one arriving above them: measured at 0.42 of layout shift per result,
	 * three times a run, which is worse than the reservation is worth.
	 *
	 * `!primarySearchDone` and not `stillSearching` alone. `searchesInFlight` is still zero
	 * on the frame this branch first renders, because the effect that starts the search runs
	 * after it, and skeletons appearing one frame late would push the provider strip down
	 * exactly the way a card does.
	 */
	const pendingResultSlots = $derived.by(() => {
		if (!stillSearching && primarySearchDone) return [];
		const slots = [];
		for (let slot = filteredResults.length; slot < RESERVED_RESULT_SLOTS; slot++) {
			slots.push(slot);
		}
		return slots;
	});

	/**
	 * Issue #337: where this page's search has got to, as an attribute a test can wait for.
	 *
	 * The traveller has only ever been told two of these three. "Still searching" is on
	 * screen or it is not, and it is absent both before the search starts and after it
	 * ends, which is correct for a person watching one page and useless as a signal: 34
	 * spec files waited for that text to be missing, and nine runs in ten that wait returned
	 * about 3.8 seconds before the first card existed, because the text was missing for the
	 * "not started" reason. `results-stream-consumption.spec.ts` is the sharpest case — the
	 * regression guard for #87, a page frozen before it renders anything, was passing on a
	 * page that had rendered nothing.
	 *
	 * `settled` is the one a test wants and the DOM could not express: `primarySearchDone`
	 * is only ever set from a snapshot carrying `done`, so no page that has not run a search
	 * can reach it. `searching` covers a widen the traveller triggered as well as the
	 * primary run, for the same reason `stillSearching` does.
	 *
	 * Deliberately NOT counting `refreshesInFlight`. A background revalidation must not
	 * make either the page or this attribute claim a search is running (#293), and a spec
	 * that needs the network quiet as well should say so.
	 */
	const searchPhase: 'idle' | 'searching' | 'settled' = $derived(
		stillSearching ? 'searching' : primarySearchDone ? 'settled' : 'idle'
	);

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

	/**
	 * Issue #324: the connections map's whole picture, rebuilt on every snapshot.
	 *
	 * `undefined` until both endpoint airports have resolved out of the dataset, because
	 * every arc and the baseline are measured from their coordinates. That is the same lazy
	 * `getAirport` resolution the cards already wait on, and it is why the button that opens
	 * this is disabled rather than absent while it settles: an affordance that appears late
	 * is one a traveller has already decided is not there.
	 */
	const connectionsMapModel = $derived.by(() => {
		const activeQuery = query;
		if (!activeQuery) return undefined;
		const originAirport = endpointAirports[activeQuery.originAirport];
		const destinationAirport = endpointAirports[activeQuery.destinationAirport];
		if (!originAirport || !destinationAirport) return undefined;
		return buildConnectionsMapModel({
			originAirport,
			destinationAirport,
			minLayoverTime: activeQuery.minLayoverTime ?? DEFAULT_MIN_LAYOVER_TIME_MINUTES,
			candidateCodes,
			airports: connectionAirports,
			groups: Object.values(groupsByConnection),
			blocked: blockedConnections
		});
	});

	/**
	 * The currency the price ledger is KEYED by, which is the one `recordItineraryGroup`
	 * writes with a few hundred lines below.
	 *
	 * Deliberately not this page's own `currency`, which is read off the first result's
	 * price and falls back to the default when a search returned nothing. The two agree on
	 * every search that found something and disagree on exactly the searches whose calendars
	 * are worth reading, so using the other one would have left the strips permanently empty
	 * for a traveller who set a currency and got no results.
	 */
	const ledgerCurrency = $derived(keyStore.currency ?? DEFAULT_SEARCH_CURRENCY);

	/** Upper-cased once here rather than per flight in the panel, and only ever used to quiet
	 * a logo: the brief keeps an avoided airline in the results, greyed and scored down. */
	const avoidedCarriers = $derived(
		new Set((query?.airlinesToAvoid ?? []).map((code) => code.toUpperCase()))
	);

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
	 * Issue #314: whether the card a new arrival would push down is somewhere the traveller
	 * can see it.
	 *
	 * Measured rather than reasoned about, because it depends on the viewport, on how far
	 * down the page they have scrolled, and on how tall the cards above it turned out to be.
	 * Absent from the DOM means a filter is hiding it, which is another way of being invisible.
	 *
	 * Above the viewport counts as off screen too. Inserting there is the case the browser's
	 * own scroll anchoring already handles: it holds the scroll position against content
	 * appearing above it, so nothing on screen moves and no shift is recorded.
	 */
	function displacedCardIsOffScreen(displaced: StreamSlot): boolean {
		const card = listEl?.querySelector(`[data-result-id="${CSS.escape(displaced.id)}"]`);
		if (!card) return true;
		const box = card.getBoundingClientRect();
		return box.bottom <= 0 || box.top >= window.innerHeight;
	}

	function noteOutOfOrder(id: string): void {
		if (!arrivedOutOfOrder.includes(id)) arrivedOutOfOrder = [...arrivedOutOfOrder, id];
	}

	/**
	 * Issue #314: the traveller asking for the list to be put in order.
	 *
	 * Through `sortResults`, which is the reordering path, because this is the case that
	 * function was written for: a re-sort somebody asked for, where the list moving is the
	 * answer rather than a jump. The layout shift it causes carries `hadRecentInput`, which
	 * is the browser's own way of saying the same thing.
	 */
	function sortArrivalsIntoPlace(): void {
		order = sortResults(slotsToResults(order), sortMode).map(toSlot);
		arrivedOutOfOrder = [];
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
	async function consumeSearch(
		stream: AsyncGenerator<SearchSnapshot>,
		options: { trackWidenOptions: boolean; background?: boolean }
	) {
		if (options.background) refreshesInFlight += 1;
		else searchesInFlight += 1;
		try {
			for await (const snapshot of stream) {
				providerStatuses = { ...providerStatuses, ...snapshot.providers };
				if (options.trackWidenOptions) {
					widenOptions = snapshot.widenOptions;
					directRouteKnown = snapshot.hasDirectRoute;
					candidateCount = snapshot.candidates.length;
					candidateCodes = snapshot.candidates.map((candidate) => candidate.airportCode);
					confirmedBeyondCap = snapshot.confirmedBeyondCap;
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
					// Issue #314: a result whose sorted place would push a card the traveller can
					// see off the bottom of a phone goes to the end of the list instead. It is on
					// screen either way; what waits is the reordering, and the status row offers
					// it.
					const placement = insertWithoutDisplacing(
						order,
						toSlot(scored),
						compare,
						displacedCardIsOffScreen
					);
					order = placement.order;
					if (!placement.sortedIntoPlace) noteOutOfOrder(scored.id);
				}
				stayCandidatesByConnection = { ...stayCandidatesByConnection, ...snapshot.stayCandidatesByConnection };
				transferOptionsByConnection = { ...transferOptionsByConnection, ...snapshot.transferOptionsByConnection };
				outerTransferOptions = snapshot.outerTransferOptions;
				// Replaced whole rather than merged: a refusal that no longer applies, because a
				// widen finally priced that city, has to disappear rather than linger under the
				// new itinerary. `pipeline.ts`'s `recordBlock` maintains the same invariant on
				// its side.
				blockedConnections = { ...snapshot.blockedConnections };
			}
		} finally {
			if (options.background) refreshesInFlight -= 1;
			else searchesInFlight -= 1;
			refreshAfterRevalidation();
		}
	}

	/**
	 * Issue #293: runs the search a second time off the cache a background revalidation has
	 * just warmed, so the fetch times and prices on the cards become the ones the app is
	 * actually holding.
	 *
	 * Every adapter that serves a cached answer past its TTL refetches behind it, and until
	 * this existed the fresher value reached the next reload and never the page that had
	 * asked for it. `tools/probe-card-age.mjs` against a real build: 76 provider responses
	 * land inside 3 seconds, every Kiwi, Ryanair and Hostelworld entry comes back 0 minutes
	 * old, and the cards go on saying "fetched 3 hours ago" for as long as you watch them.
	 * The brief's third rule is "stale first, then fresh ... update in place", and this is
	 * the half that was missing.
	 *
	 * It reads the cache, not the network. What a revalidation has just written is inside its
	 * own TTL again, so the adapters hand it back without refetching: the probe measures the
	 * flight and stay providers at zero requests across every refresh in a run.
	 *
	 * How often it runs is set by what lands, not by a timer. A warm reload's revalidations do
	 * not arrive together, and Transitous answers one leg at a time over about twenty-five
	 * seconds whether or not anything is refreshing (6 requests after the page went quiet
	 * without this function, 8 with it). Every landing is a card that can now say something
	 * truer, so every landing gets a run, and a run that finds nothing changed costs a cache
	 * read and rewrites the same numbers. It terminates because an announcement follows a
	 * write that made its own entry fresh, and the stale entries are a set every round shrinks.
	 *
	 * Held until nothing else is streaming. A refresh racing the search it is refreshing would
	 * merge two readings of the same cache into one list for no gain, and announcements that
	 * arrive while one is running are coalesced into the run that follows.
	 *
	 * Its own `createTransitLookupBudget()` rather than the query's. That ration caps what one
	 * pass may ask a volunteer-run service, and the previous pass has spent some or all of it.
	 * Handing over the remainder would make the refreshed card LOSE transit legs the traveller
	 * can already see (`'budget-spent'`), which is a worse answer than the one it replaces.
	 * The new ration buys cache reads, since it asks the legs the pass before it just
	 * answered.
	 */
	function refreshAfterRevalidation(): void {
		if (!revalidationPending || searchesInFlight > 0 || refreshesInFlight > 0) return;
		const activeQuery = query;
		const controller = searchController;
		if (!activeQuery || !controller || controller.signal.aborted) return;
		revalidationPending = false;
		void consumeSearch(
			runSearch(activeQuery, deps(), {
				signal: controller.signal,
				transitLookupBudget: createTransitLookupBudget()
			}),
			{ trackWidenOptions: true, background: true }
		);
	}

	/** Issue #293. Not an `$effect` around the refresh itself, deliberately: see
	 * `revalidationPending`. This one only registers the listener and hands Svelte the
	 * unsubscribe. */
	$effect(() =>
		onRevalidationSettled(() => {
			revalidationPending = true;
			refreshAfterRevalidation();
		})
	);

	/** Runs the free tier once per distinct `query`, `runSearch` has no code path to a
	 * metered provider at all, so this alone never spends a request. */
	$effect(() => {
		const activeQuery = query;
		order = [];
		arrivedOutOfOrder = [];
		providerStatuses = {};
		widenOptions = [];
		calendarSummaries = [];
		directRouteKnown = false;
		candidateCount = 0;
		primarySearchDone = false;
		sequenceByConnection.clear();
		nextSequence = 1;
		// Issue #293: yesterday's revalidation has nothing to say about this query's cards.
		revalidationPending = false;
		// A new query is an unrelated search: yesterday's connection codes have no business
		// staying open, selected, or carrying an edit against whatever streams in next.
		openTimelineId = null;
		customising = null;
		drafts.clear();
		// Issue #224: a new query is a new set of stopovers, so a length or a bed chosen for
		// yesterday's London card has no business applying to whatever LGW turns out to be
		// this time.
		choicesByResult = {};
		groupsByConnection = {};
		candidateCodes = [];
		confirmedBeyondCap = [];
		blockedConnections = {};
		connectionsMapOpen = false;
		stayCandidatesByConnection = {};
		transferOptionsByConnection = {};
		outerTransferOptions = undefined;
		// Issue #267: one timetable ration per query, held here rather than inside the
		// search, because the search is no longer the only thing that spends it. The detail
		// panel's "check public transport" draws from this same object, so twelve lookups
		// against a volunteer-run service stay twelve however the traveller spends them.
		// Replaced on every new query, for the same reason every line above is reset: a new
		// query is a new search and gets its own allowance.
		transitLookupBudget = createTransitLookupBudget();
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
		searchController = controller;
		untrack(() =>
			consumeSearch(runSearch(activeQuery, deps(), { signal: controller.signal, transitLookupBudget }), {
				trackWidenOptions: true
			})
		);
		return () => {
			controller.abort();
			// Issue #293: a refresh reads this to find out whether the query it would be
			// refreshing is still the one on screen.
			if (searchController === controller) searchController = undefined;
		};
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
			// Issue #314: a full re-sort puts every arrival where it belongs, including the
			// ones that had been appended, so there is nothing left to offer.
			arrivedOutOfOrder = [];
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
		// Issue #324 widened this from "codes among the results" to "codes the search ranked".
		// A connection with no viable pairing never becomes a result, and the connections map
		// cannot draw a point for a city it has no coordinates for, so it would have silently
		// dropped exactly the stopovers it exists to explain.
		const codes = new Set([...results.map((result) => connectionAirportCode(result.itinerary)), ...candidateCodes]);
		for (const code of codes) {
			if (requestedAirportCodes.has(code)) continue;
			requestedAirportCodes.add(code);
			getAirport(code).then((airport) => {
				if (airport) connectionAirports = { ...connectionAirports, [code]: airport };
			});
		}
	});

	/**
	 * Issue #232: one price band for the whole search, read out of #200's ledger.
	 *
	 * One rather than one per card, because the band answers "is this a good price for
	 * getting from here to there" and the stopover is the variable that question holds
	 * still. Every card is then marked against the same distribution with the same
	 * denominator, so the page makes its comparison claim once.
	 *
	 * Only once the search has settled. A band built while stopovers are still arriving
	 * would be recomputed on every snapshot, and each recomputation is a few dozen
	 * IndexedDB reads against the store the search itself is using.
	 *
	 * `priceBandKey` is a plain `let`, not `$state`: it is this effect's memo of what it
	 * has already asked for, and making it reactive would have the effect depend on its own
	 * write. `collectPriceBand` makes no request in any path (`price-band-source.ts`), so a
	 * results page cannot spend anything on this.
	 */
	let priceBand = $state<PriceBand | undefined>(undefined);
	let priceBandKey = '';

	$effect(() => {
		const activeQuery = query;
		if (!activeQuery || !primarySearchDone || stillSearching) return;

		const stopovers = [...new Set(results.map((result) => connectionAirportCode(result.itinerary)))].sort();
		if (stopovers.length === 0) return;

		const currency = keyStore.currency ?? DEFAULT_SEARCH_CURRENCY;
		const key = [activeQuery.originAirport, activeQuery.destinationAirport, currency, ...stopovers].join('|');
		if (key === priceBandKey) return;
		priceBandKey = key;

		collectPriceBand({ query: activeQuery, stopovers, currency }).then((band) => {
			// A second search can settle while this read is in flight. Only the answer to the
			// question still being asked is allowed to land.
			if (priceBandKey === key) priceBand = band;
		});
	});

	/** The band as a card can use it: present only when there is genuinely enough history,
	 * so `ResultCard` never has to know what "not enough" looks like. */
	const shownPriceBand = $derived(priceBand?.kind === 'band' ? priceBand : undefined);

	/** The narrowest possible confirm-tier target: the exact dates this candidate's
	 * itinerary already found, one per leg, never the query's whole range — PROVIDERS.md's
	 * own warning ("a pipeline that loops over dates... is broken by construction") is
	 * exactly what a wider window here would risk. `confirmTargetFor` is shared with the
	 * cost estimate the panel showed (issue #244), so the row's number is this request's
	 * real price rather than a second, larger guess at it. */
	function buildConfirmTarget(option: WidenOption, activeQuery: SearchQuery): WidenTarget | undefined {
		if (!option.candidateAirportCode) return undefined;
		const existing = results.find((result) => result.id === option.candidateAirportCode);
		return confirmTargetFor(option.candidateAirportCode, activeQuery, existing?.itinerary);
	}

	/** Issue #96: the panel shows one row per provider, summing cost across every candidate
	 * that provider's tier covers (`WidenOptionGroup`), rather than one row per candidate.
	 * Spending it means widening those candidates in a single call sharing one ceiling. Both
	 * `widenSearch` (its `targets` array) and `widenWithPriceCalendar` (its
	 * `candidateAirportCodes` array) already accept many candidates behind one shared budget,
	 * so this is not a new capability, only a caller that finally uses it for more than one
	 * candidate at a time.
	 *
	 * Issue #244: `affordable` is what the row actually offered, which is the whole group
	 * whenever the month can pay for it and a prefix of it when it cannot. Spending
	 * `group.requests` instead would quietly exceed the cap the panel just quoted against. */
	async function handleWiden(group: WidenOptionGroup, affordable: AffordableWiden) {
		const activeQuery = query;
		if (!activeQuery) return;
		const key = widenOptionGroupKey(group);
		pendingWidenKey = key;
		const controller = new AbortController();
		try {
			if (group.tier === 'confirm') {
				const targets = affordable.options
					.map((option) => buildConfirmTarget(option, activeQuery))
					.filter((target): target is WidenTarget => target !== undefined);
				if (targets.length === 0) return;
				await consumeSearch(
					widenSearch(activeQuery, { targets, maxMeteredRequests: affordable.requests }, deps(), {
						signal: controller.signal,
						transitLookupBudget
					}),
					{ trackWidenOptions: false }
				);
			} else {
				const candidateAirportCodes = affordable.options
					.map((option) => option.candidateAirportCode)
					.filter((code): code is IataAirportCode => code !== undefined);
				if (candidateAirportCodes.length === 0) return;
				searchesInFlight += 1;
				try {
					for await (const outcome of widenWithPriceCalendar(
						activeQuery,
						{ candidateAirportCodes, maxMeteredRequests: affordable.requests },
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

	/**
	 * Issue #324: leaves the map on the card for the stopover the traveller picked.
	 *
	 * The map answers "which stopovers exist and what is each worth"; choosing one, swapping
	 * its flights and pricing its bed all still belong to the card, so this hands over rather
	 * than growing a second place to do them. Scrolling is deferred to `tick()` because the
	 * card's timeline has to exist before it can be brought into view.
	 */
	function openStopoverFromMap(code: IataAirportCode) {
		connectionsMapOpen = false;
		const result = results.find((candidate) => candidate.id === code);
		if (!result) return;
		openTimelineId = result.id;
		draftFor(result.id, result.itinerary);
		void tick().then(() => {
			document
				.querySelector(`[data-result-id="${CSS.escape(result.id)}"]`)
				?.scrollIntoView({ block: 'start', behavior: 'smooth' });
		});
	}

	function toggleTimeline(result: ScoredResult) {
		const opening = openTimelineId !== result.id;
		openTimelineId = opening ? result.id : null;
		if (opening) draftFor(result.id, result.itinerary);
	}

	/**
	 * The trip one card is showing. Its draft once there is one, and the stream's own
	 * itinerary until then. Every surface for that card is handed this same value, which
	 * is the invariant #243, #250, #264, #265 and #266 each restored after something broke
	 * it.
	 */
	function shownItinerary(id: string, streamed: Itinerary): Itinerary {
		return drafts.get(id)?.itinerary ?? streamed;
	}

	/**
	 * The draft for one card, made if it does not exist yet.
	 *
	 * Only ever called from an event handler. Writing a `SvelteMap` while a template or a
	 * `$derived` is evaluating is `state_unsafe_mutation`, and a lazily-created draft read
	 * during render is exactly that. Every path that can lead to an edit goes through a
	 * handler first: you unfold a timeline or pick a segment before you can change
	 * anything, and both of those create the draft on the way in.
	 */
	function draftFor(id: string, streamed: Itinerary): ItineraryDraft {
		const existing = drafts.get(id);
		if (existing) return existing;
		const created = new ItineraryDraft(streamed);
		drafts.set(id, created);
		return created;
	}

	/** The render-safe half: reads, never writes. */
	function draftOf(id: string): ItineraryDraft | undefined {
		return drafts.get(id);
	}

	/**
	 * Picking a stretch of one trip, from the strip, the timeline or the map. `null` is
	 * that surface clearing its own selection, which leaves the rail on this card with
	 * nothing picked rather than closing it: on a wide screen the rail is always there,
	 * and on a phone the sheet then closes on its own because it only mounts with a
	 * segment.
	 *
	 * ## Focus goes to the panel, and comes back
	 *
	 * The panel is the last thing in the layout on a wide screen and a fixed overlay on a
	 * phone, so without this a keyboard user who pressed Enter on a strip segment would
	 * have to tab through every remaining card, the provider strip and the widen panel to
	 * reach the control they just asked for. Moving focus in response to a deliberate
	 * activation is the ordinary contract for a panel a control opens; what makes it safe
	 * is the other half, that closing it puts focus back on the segment that opened it.
	 *
	 * The panel is a `tabindex="-1"` region rather than a control, so a mouse user sees
	 * nothing change: there is no focus ring on it and nothing about the pointer path
	 * moves.
	 */
	function selectSegment(id: string, streamed: Itinerary, segment: ItinerarySegmentId | null) {
		draftFor(id, streamed);
		const opening = segment !== null;
		if (opening && !focusReturn && document.activeElement instanceof HTMLElement) {
			focusReturn = document.activeElement;
		}
		customising = { resultId: id, segment };
		if (opening) void focusPanel();
		else restoreFocus();
	}

	function closeCustomiser() {
		customising = null;
		restoreFocus();
	}

	/** The control the panel was opened from, so closing it hands the traveller back to
	 * the segment they were on rather than to the top of the document. Plain bookkeeping:
	 * nothing renders from it. */
	let focusReturn: HTMLElement | null = null;
	let panelEl = $state<HTMLElement>();

	async function focusPanel() {
		// After the render that mounts or refills it. `tick` rather than an effect: this
		// runs from a click handler and writes no state, so there is no reactive loop to
		// create (AGENTS.md, the `$effect` trap).
		await tick();
		// Issue #308: `preventScroll`, because focusing an element scrolls it into view by
		// default and the panel is the second thing that was moving the page under a
		// traveller who only tapped a segment. The panel is sticky at the top of its own
		// column, and the sheet is fixed to the foot of the viewport, so both are already on
		// screen when they are focused.
		//
		// Issue #318: the sheet too, not only the desktop rail. Focus stayed on the trigger
		// button outside the sheet, so nothing announced that a panel had opened, which is
		// half of why a bare `<aside>` was not enough.
		(panelEl ?? sheetEl)?.focus({ preventScroll: true });
	}

	function restoreFocus() {
		const target = focusReturn;
		focusReturn = null;
		// A card can have been re-ordered or filtered away while the panel was open, and
		// focusing a detached node silently drops the traveller at the top of the page.
		if (target && document.contains(target)) target.focus();
	}

	/**
	 * Whether this viewport has room for side columns. Issue #139 measured the first result
	 * card at about 1,650px down a 375px viewport, behind the sort control, four range
	 * sliders, two chip rows and four widen blocks: "The person who typed a search wants
	 * the answer." So the filters collapse behind a button on a phone, and issue #278's
	 * customise panel becomes a sheet.
	 *
	 * Read from `matchMedia` rather than branched on in CSS alone, because `aria-expanded`,
	 * `hidden` and which of the two customise containers is mounted all have to tell the
	 * truth at both widths. The initial value is computed inline, not in an effect, so a
	 * desktop browser hydrates with the columns already open.
	 */
	let sidebarIsColumn = $state(browser ? window.matchMedia('(min-width: 64rem)').matches : false);
	$effect(() => {
		const media = window.matchMedia('(min-width: 64rem)');
		const sync = () => (sidebarIsColumn = media.matches);
		sync();
		media.addEventListener('change', sync);
		return () => media.removeEventListener('change', sync);
	});

	/** The card the rail is about. `undefined` when a filter has taken that card off the
	 * list since it was picked, which is the one way the rail can outlive its subject. */
	const customisingResult = $derived.by(() => {
		const picked = customising;
		return picked ? filteredResults.find((result) => result.id === picked.resultId) : undefined;
	});
	const customisingCode = $derived(
		customisingResult ? connectionAirportCode(customisingResult.itinerary) : undefined
	);
	const customisingSegment = $derived(customisingResult ? (customising?.segment ?? null) : null);
	const customisingDraft = $derived(customisingResult ? draftOf(customisingResult.id) : undefined);
	/** The sheet only exists on a phone, and only with something picked. A sheet holding
	 * the idle prompt would cover the results to say nothing. */
	const sheetIsOpen = $derived(!sidebarIsColumn && customisingResult !== undefined && customisingSegment !== null);

	/** A refined search is a navigation to this same page with different params, which is
	 * what makes the browser's back button walk back through the searches the traveller
	 * actually ran. The query effect above tears the old results down. */
	function submitSearch(next: URLSearchParams) {
		editorOpen = false;
		void goto(`${base}/results/?${next.toString()}`);
	}

	/**
	 * Issue #278, the phone half of the owner's sidebar. There is no room for a third
	 * column at 375px, so the customise panel becomes a sheet at the foot of the screen:
	 * out of the card's flow, so choosing never makes the card taller, and non-modal, so
	 * the price it changes stays readable above it while it is up. NN/g's own split is
	 * that a modal sheet is for something you must resolve and a non-modal one is for
	 * reference alongside the page, which is exactly this.
	 *
	 * Three ways out, because #227's popover gave a tap-opened panel light dismissal and a
	 * sheet that only closed on a button press would be a step backwards: a visible close
	 * button (NN/g again: a grab handle alone is not enough), Escape, a pointer down
	 * outside it, and a downward drag on the handle.
	 */
	let sheetEl = $state<HTMLElement>();
	/** How far the sheet has been dragged down, in px, while a drag is in progress. */
	let sheetDragY = $state(0);
	let sheetDragFrom: number | null = null;
	/** Far enough that it reads as a deliberate throw rather than a slipped thumb. */
	const SHEET_DISMISS_PX = 64;

	function onSheetDragStart(event: PointerEvent) {
		sheetDragFrom = event.clientY;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function onSheetDragMove(event: PointerEvent) {
		if (sheetDragFrom === null) return;
		// Downward only: dragging up would let the sheet cover the card it describes.
		sheetDragY = Math.max(0, event.clientY - sheetDragFrom);
	}

	function onSheetDragEnd() {
		if (sheetDragFrom === null) return;
		const travelled = sheetDragY;
		sheetDragFrom = null;
		sheetDragY = 0;
		if (travelled > SHEET_DISMISS_PX) closeCustomiser();
	}

	/** A pointer down anywhere that is neither the sheet nor a card closes it. Cards are
	 * excluded because every way of picking a segment is inside one, and closing on the
	 * gesture that selects would open and shut in the same tap. */
	function onDocumentPointerDown(event: PointerEvent) {
		if (!sheetIsOpen) return;
		const target = event.target;
		if (!(target instanceof Node)) return;
		if (sheetEl?.contains(target)) return;
		if (target instanceof Element && target.closest('.result-card')) return;
		closeCustomiser();
	}

	function onDocumentKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || !customising) return;
		// Whatever is in the top layer owns Escape while it is up, and issue #280's route map
		// is a real `<dialog>` reached from a ground preview inside the timeline. A press
		// there means "close the map", and closing the customise panel underneath it as well
		// would take away the selection the map just made. The dialog is still open when this
		// runs: its own close is the keydown's default action, which happens after listeners.
		if (document.querySelector('dialog[open]')) return;
		closeCustomiser();
	}

	let filtersOpenOnPhone = $state(false);
	const filtersVisible = $derived(sidebarIsColumn || filtersOpenOnPhone);
	const activeFilterCount = $derived(
		[
			filters.maxPriceMinorUnits !== undefined,
			filters.maxTotalDurationMinutes !== undefined,
			filters.minNights !== undefined,
			filters.minFreeTimeMinutes !== undefined,
			filters.chosenConnectionAirports.size > 0,
			filters.chosenAirlines.size > 0
		].filter(Boolean).length
	);
</script>

<svelte:window onpointerdown={onDocumentPointerDown} onkeydown={onDocumentKeydown} />

<!-- One panel, two containers. The rail and the sheet are never both mounted, so there is
     one `SegmentCustomiser` instance at a time and no pair of them to disagree. -->
{#snippet customisePanel()}
	{#if customisingResult && customisingDraft && customisingCode && query}
		<SegmentCustomiser
			draft={customisingDraft}
			segment={customisingSegment}
			stopoverOptions={customisingResult.stopover.options}
			isFlightChange={customisingResult.stopover.isFlightChange}
			atDefaultLength={shownItinerary(customisingResult.id, customisingResult.itinerary).nightsInConnection ===
				customisingResult.stopover.minimum}
			group={groupsByConnection[customisingResult.id]}
			stayCandidates={stayCandidatesByConnection[customisingCode] ?? []}
			transferOptions={transferOptionsByConnection[customisingCode]}
			{outerTransferOptions}
			connectionAirport={connectionAirports[customisingCode]}
			travellers={query.travellers}
			females={query.females}
			minLayoverTime={query.minLayoverTime}
			searchDone={primarySearchDone && !stillSearching}
			{stayProviders}
			{transitLookupBudget}
			onNightsChange={(nights) => chooseNights(customisingResult, nights)}
		/>
	{:else}
		<p class="customise-idle">
			Pick a step on any trip to change it here. Flights, ground transport, how many nights
			you stay and where you sleep.
		</p>
	{/if}
{/snippet}

{#snippet customiseSubject()}
	{#if customisingResult}
		{@const trip = shownItinerary(customisingResult.id, customisingResult.itinerary)}
		<p class="customise-subject font-mono">
			{trip.originAirport.iataCode}
			<span aria-hidden="true">&rarr;</span>
			<span class="customise-subject-stop">{connectionAirportCode(trip)}</span>
			<span aria-hidden="true">&rarr;</span>
			{trip.destinationAirport.iataCode}
		</p>
	{/if}
{/snippet}

<svelte:head>
	<title
		>{summary
			? `${summary.originAirport} to ${summary.destinationAirport} - Layover`
			: 'Results - Layover'}</title
	>
</svelte:head>

<div class="results-page" data-search-phase={searchPhase}>
	{#if !parsedQuery}
		<EmptyState title={noQueryCopy.title} description={noQueryCopy.description}>
			{#snippet action()}
				<!-- Issue #327: carries whatever the link did have. The search screen fills its
				     form from these same params, so someone whose URL lost only its `to=`
				     arrives with their origin and their dates already in place, and
				     `buildSearchQuery` returning null there is what stops it bouncing straight
				     back here. -->
				<Button href={`${base}/?${searchParamsFromLink}`}>Go to search</Button>
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
			currentQuery={normalizedQuery}
			bind:expanded={editorOpen}
		/>

		{#if blockingIssues.length > 0}
			<!-- Nothing has been asked of any provider. This search names a place that is not
			     an airport, or describes a trip that cannot exist on any date (an origin
			     equal to its destination, an arrival before its own departure, a party of
			     nobody), so running it would spend requests to rediscover that. The form
			     above is already open on the fields that need changing.

			     Issue #327: the message carries the reasons, not a pointer to them. What
			     stood here said "the form above says what to change" and left the traveller
			     to go and read it, and until #327 an unknown airport code did not reach this
			     branch at all. It reached `runSearch`, which threw, above a page reading
			     "0 of 0 itineraries shown". -->
			<ErrorState
				severity="error"
				title="This search cannot be run as it stands"
				message={blockingSummary}
			/>
		{:else if query}
			<!-- Issue #314. The count and the held-results control share one row, and the row
			     keeps its height whether or not the control is in it. It sits directly above
			     the whole results layout, so a row that grew when the first trip was held
			     would move every card on screen to say so. -->
			<div class="results-status">
				<p class="results-subhead" aria-live="polite">
					{filteredResults.length} of {results.length}
					{results.length === 1 ? 'itinerary' : 'itineraries'} shown
					{#if stillSearching}<span class="still-searching">&middot; still searching</span>{/if}
				</p>
				<!-- Outside the live region on purpose: the count next door re-announces on every
				     arrival, and a button inside it would be read out again each time. -->
				{#if arrivedOutOfOrder.length > 0}
					<button type="button" class="sort-arrivals" onclick={sortArrivalsIntoPlace}>
						Sort {arrivedOutOfOrder.length}
						{arrivedOutOfOrder.length === 1 ? 'trip' : 'trips'} into place
					</button>
				{/if}
			</div>

			<!-- Issue #71. One line, above the results rather than below them, because somebody
			     whose dates are flexible decides that before reading a single card. A link, not
			     a button: it is a place, it deep-links, and cmd-click has to open it in a tab
			     like everything else. -->
			<a class="when-link" href={flexibleDatesHref}>
				<span class="when-link-icon" aria-hidden="true">
					<Icon name="calendar-month" />
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

			<!-- Issue #324. Beside the flexible-dates link and above the list, because "which
			     stopovers exist at all" is a question about the whole route, decided before
			     the first card is read, exactly like "which week is cheapest". A button
			     rather than a link: it opens a dialog over this page and takes no URL of its
			     own. -->
			<button
				type="button"
				class="connections-map-link"
				disabled={!connectionsMapModel || connectionsMapModel.connections.length === 0}
				onclick={() => (connectionsMapOpen = true)}
			>
				<span class="connections-map-link-icon" aria-hidden="true">
					<svg viewBox="0 0 24 24" fill="none">
						<path
							d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20z"
							stroke="currentColor"
							stroke-width="1.7"
							stroke-linejoin="round"
						/>
						<path d="M9 4v13.5M15 6.5V20" stroke="currentColor" stroke-width="1.7" />
					</svg>
				</span>
				<span class="connections-map-link-text">
					See every connection on a map
					{#if connectionsMapModel && connectionsMapModel.connections.length > 0}
						<!-- Issue #350: the count on its own read as "these are the stopovers", when it
						     only ever meant "these are the stopovers we priced". The second clause is
						     here rather than only inside the dialog because this is the line a
						     traveller reads while counting the cards; which airports they are is
						     detail, and detail belongs behind the tap. -->
						<span class="connections-map-link-note"
							>{connectionsMapModel.connections.length} airports considered, including the ones with no
							trip{#if confirmedBeyondCap.length > 0}, and {confirmedBeyondCap.length} more confirmed
								but not priced{/if}</span
						>
					{/if}
				</span>
			</button>

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
							<Icon name="adjustments-horizontal" />
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
					<ul
						class={[
							'results-list',
							// Only when there is a list. An empty one under "no itineraries match
							// your filters" would be a screenful of nothing between that sentence
							// and the panel explaining it.
							{ 'results-list-reserved': filteredResults.length + pendingResultSlots.length > 0 }
						]}
						bind:this={listEl}
					>
						{#each filteredResults as result (result.id)}
							{@const code = connectionAirportCode(result.itinerary)}
							{@const itinerary = shownItinerary(result.id, result.itinerary)}
							{@const selected = customising?.resultId === result.id ? customising.segment : null}
							<li data-result-id={result.id}>
								<ResultCard
									{result}
									{itinerary}
									connectionAirport={connectionAirports[code]}
									priceBand={shownPriceBand}
									selectedSegmentId={selected}
									onSelectSegment={(segment) =>
										selectSegment(result.id, result.itinerary, selected === segment ? null : segment)}
									timelineOpen={openTimelineId === result.id}
									onToggleTimeline={() => toggleTimeline(result)}
								>
									{#snippet timeline()}
										{@const draft = draftOf(result.id)}
										{#if draft}
										<ResultDetail
											{draft}
											selectedSegmentId={selected}
											onSelectSegment={(segment) => selectSegment(result.id, result.itinerary, segment)}
											group={groupsByConnection[result.id]}
											stayCandidates={stayCandidatesByConnection[code] ?? []}
											transferOptions={transferOptionsByConnection[code]}
											{outerTransferOptions}
											connectionAirport={connectionAirports[code]}
											minLayoverTime={query.minLayoverTime}
										/>
										{/if}
									{/snippet}
								</ResultCard>
							</li>
						{/each}
						<!-- Issue #314: the space the results will need, held open from the first
						     frame at roughly the height they will need it. Keyed on the slot's
						     own position so a card consumes the placeholder it replaces and the
						     ones below it keep their nodes and their places. -->
						{#each pendingResultSlots as slot (slot)}
							<li aria-hidden="true">
								<ResultCardSkeleton />
							</li>
						{/each}
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

				<!-- Issue #278, the owner: "in the desktop we can make that we have a right
				     sidebar, like the filters, that dynamically shows the customizing options
				     for the selected segment, so we dont make the card larger." A sibling of
				     the filter rail, on the other side, and sticky for the same reason: the
				     thing it is about is a card you are scrolling past.

				     Rendered only when it is a column. Below 64rem the same panel is the sheet
				     at the foot of this file, and mounting both would put two copies of every
				     picker on the page. -->
				{#if sidebarIsColumn}
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<aside
						bind:this={panelEl}
						class="results-customise"
						aria-label="Customise the selected trip"
						tabindex="-1"
					>
						<div class="results-customise-head">
							<h2 class="results-customise-title">Customise</h2>
							{#if customisingResult}
								{@render customiseSubject()}
								<!-- Issue #318: "Done", on both surfaces, because both call the same
								     function and it discards nothing the traveller chose. "Clear"
								     next to a panel of pickers reads as "throw my edits away", and
								     `closeCustomiser` only drops which segment is selected; the
								     drafts survive. Two words for one action was the defect. -->
								<button type="button" class="customise-close" onclick={closeCustomiser}>
									Done
								</button>
							{/if}
						</div>
						{@render customisePanel()}
					</aside>
				{/if}
			</div>
		{/if}
	{/if}
</div>

<!-- Issue #278's mobile answer. A phone has no room for a third column, so the same panel
     becomes a sheet: fixed to the foot of the viewport, out of the card's flow so picking
     never makes the card taller, and non-modal so the price it changes stays readable
     above it. Capped well under half the screen, because a sheet that covered the strip
     the traveller just tapped would take away the thing that made the tap mean something.

     Issue #318: `role="dialog"` and no `aria-modal`. The `<aside>` this replaced was chosen
     so the sheet would not be a thing to be trapped in, and it still is not: focus can leave
     it, the page behind stays readable, and Escape closes it. What the bare `<aside>` did not
     do was tell a screen-reader user that anything had opened, because focus stayed on the
     button outside it. A non-modal dialog says what this is without trapping anybody. -->
{#if sheetIsOpen}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<aside
		bind:this={sheetEl}
		class="customise-sheet"
		{...{ [BOTTOM_SHEET_ATTRIBUTE]: '' }}
		role="dialog"
		aria-label="Customise the selected trip"
		tabindex="-1"
		style:translate={sheetDragY > 0 ? `0 ${sheetDragY}px` : undefined}
		style:transition={sheetDragY > 0 ? 'none' : undefined}
	>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="customise-sheet-grip"
			onpointerdown={onSheetDragStart}
			onpointermove={onSheetDragMove}
			onpointerup={onSheetDragEnd}
			onpointercancel={onSheetDragEnd}
		>
			<span class="customise-sheet-handle" aria-hidden="true"></span>
		</div>
		<div class="customise-sheet-head">
			{@render customiseSubject()}
			<button type="button" class="customise-close" onclick={closeCustomiser}>Done</button>
		</div>
		<div class="customise-sheet-body">
			{@render customisePanel()}
		</div>
	</aside>
{/if}

<!-- Issue #324. Rendering it is what opens it and removing it is what closes it, which is
     `MapDialog`'s contract and the reason exactly one MapLibre instance can exist: the map
     inside is unmounted with this block, so its `map.remove()` runs on every close. -->
{#if connectionsMapOpen && connectionsMapModel && query}
	<ConnectionsMapDialog
		model={connectionsMapModel}
		window={{ from: query.soonestDeparture, to: query.latestArrival }}
		currency={ledgerCurrency}
		{avoidedCarriers}
		{confirmedBeyondCap}
		onopen={openStopoverFromMap}
		onclose={() => (connectionsMapOpen = false)}
	/>
{/if}

<style>
	/* Issue #71's entry point. A single row, not a card: it sits between the result count
	   and the results themselves, and #139's lesson is that anything with a box around it
	   up here pushes the answer down the page. */
	.when-link {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		/* Room for the note before there is a note. `when-link-note` renders as soon as the
		   first result lands, which on a cold load is ten seconds in, and it is a second line
		   (measured: `.when-link-text` 20px to 36px). This row sits directly above the whole
		   results layout, so those 16px moved every card on screen: 0.22 of issue #314's
		   phone CLS, the second largest shift on the page and the only one above the list.
		   Reserving the line costs 12px of empty row until the note arrives, which is the
		   trade web.dev's "reserve the space in the initial layout" describes. */
		min-height: 3.5rem;
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

	.when-link-icon :global(svg) {
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

	/* Issue #310, the owner: "the search results page could be wider in desktop to use mroe
	   space". It was capped at `--layout-max-width` (72rem), which the search form itself had
	   already outgrown: that page uses the wide token. Measured fraction of the viewport in
	   use, before and after: 90% and 98% at 1280, 80% and 98% at 1440, 60% and 80% at 1920.

	   The list is not the only thing that grows. #278 put a customise panel on the right at
	   64rem, so three columns share this row, and stretching only the middle one would leave
	   a stay list and a filter rail at their phone widths beside a very wide card. Both side
	   columns take a share at the widest breakpoint below. */

	/* Issue #324's entry point, deliberately the same row shape as the flexible-dates link
	   above it. They are two answers to the same kind of question, asked before any card is
	   read, and giving one of them a card of its own would push the first result further
	   down the page for no reason (#139). */
	.connections-map-link {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		width: 100%;
		min-height: 2.75rem;
		padding: var(--space-2) var(--space-3);
		border: 1px dashed var(--color-border-strong);
		border-radius: var(--radius-md);
		background: none;
		color: var(--color-text);
		font: inherit;
		font-size: var(--font-size-sm);
		line-height: var(--line-height-sm);
		text-align: left;
		cursor: pointer;
		touch-action: manipulation;
	}

	.connections-map-link:hover:not(:disabled) {
		border-color: var(--color-accent);
		background: var(--color-accent-muted);
	}

	/* Disabled while the two endpoint airports resolve out of the dataset, which is a few
	   milliseconds. Present and dimmed rather than absent, because a control that appears
	   late is one the traveller has already decided is not there. */
	.connections-map-link:disabled {
		color: var(--color-text-muted);
		cursor: default;
	}

	.connections-map-link:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	.connections-map-link-icon {
		flex: none;
		display: inline-flex;
		width: 1.25rem;
		height: 1.25rem;
		color: var(--color-stopover);
	}

	.connections-map-link:disabled .connections-map-link-icon {
		color: var(--color-text-faint);
	}

	.connections-map-link-icon svg {
		width: 100%;
		height: 100%;
	}

	.connections-map-link-text {
		min-width: 0;
	}

	.connections-map-link-note {
		display: block;
		color: var(--color-text-muted);
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
	}

	.results-page {
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
		max-width: var(--layout-max-width-wide);
		margin: 0 auto;
	}

	/* Two rows of room, held from the first frame, whether or not there is a control to put
	   in the second one. This row sits above the whole results layout, so anything that
	   changes its height moves every card on screen.

	   Both states measure 60px: the count alone against the floor, or the count plus the
	   control on the row below it. Reserving it costs 36px of quiet space above the list on
	   a page that never holds anything back. Measured, the alternative was 0.195 of layout
	   shift when the row collapsed from two lines to one, which happened at the end of every
	   search that had held a trip: "still searching" left the count, the control fitted
	   beside it, and the whole page rose 12px (issue #314). */
	.results-status {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-1) var(--space-3);
		min-height: 3.75rem;
	}

	.results-subhead {
		color: var(--color-text-muted);
		font-size: var(--font-size-sm);
		margin: 0;
	}

	/* The one control on this page that undoes a decision the page made for the traveller,
	   so it reads as an offer rather than a warning: the accent the "still searching" note
	   beside it already uses, underlined so it is not colour alone. */
	.sort-arrivals {
		/* Always its own row, never beside the count. Letting it share a line when the line
		   happens to be short is what made the row's height depend on whether the search was
		   still running. */
		flex-basis: 100%;
		/* A full-width button centres its own text, which put this in the middle of the page
		   looking like a heading. It lines up with the count above it. */
		text-align: left;
		padding: var(--space-1) 0;
		border: 0;
		background: none;
		color: var(--color-accent);
		font: inherit;
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		text-decoration: underline;
		text-underline-offset: 0.2em;
		cursor: pointer;
	}

	.sort-arrivals:hover {
		color: var(--color-text);
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

	/* Issue #310: "the sort by haas no padding top and when scroll it is too close to the top
	   element". The rail is sticky below 64rem's breakpoint and parks under the search summary
	   strip, and `Sort by`'s label was the first pixel of it, so the two met with nothing
	   between them the moment the list scrolled. The resting state looked fine, which is why
	   this survived: the owner was reading the scrolled one.

	   Padding rather than a bigger `top` offset alone, because the offset decides where the
	   rail parks and this decides how the first control sits inside it. Both changed: the
	   offset below now clears the strip with room, and this keeps the label off the rail's
	   own top edge. */
	.results-filters-body {
		padding-top: var(--space-2);
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

	.filters-toggle-icon :global(svg) {
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

	/**
	 * Issue #314: the list reaches the bottom of the screen whenever it holds anything at
	 * all, so what sits under it starts below the fold and stays there.
	 *
	 * The skeleton slots alone are not enough. They are given up one at a time as the search
	 * resolves, and the last one going is the provider strip climbing 480px into view: 0.11
	 * of layout shift on a desktop, measured on a search that found two trips and held one.
	 * A floor cannot be given up, so nothing below the list ever climbs.
	 *
	 * `100vh - 14rem` because what it has to clear is the distance from the top of the list
	 * to the bottom of the screen, and the list starts 383px down a 375x812 phone and 272px
	 * down a 1280x900 desktop. Subtracting 224px leaves margin on both and holds as long as
	 * the rows above the list are at least that tall.
	 *
	 * What it costs is quiet space under the last card on a search that finds less than a
	 * screenful: 226px on a desktop showing one trip, none at all from two trips up. That is
	 * the trade, and it is the right way round. The space sits below the answer, where the
	 * section break already was, instead of above it where issue #139 measured what a box
	 * costs.
	 */
	.results-list-reserved {
		min-height: calc(100vh - 14rem);
	}

	.results-list li {
		list-style: none;
	}

	/* ---------------------------------------------------------------------
	 * Issue #278: the customise surface. One panel, two containers, never
	 * both mounted at once.
	 * ------------------------------------------------------------------- */

	.results-customise {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		min-width: 0;
	}

	.results-customise-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-2) var(--space-3);
		padding-bottom: var(--space-3);
		border-bottom: 1px solid var(--color-border);
	}

	.results-customise-title {
		margin: 0;
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-faint);
	}

	/* Which card the panel is about. Three codes rather than three city names: it sits
	   beside a list where every card prints both, and the code is what fits a 16rem rail
	   without wrapping. */
	.customise-subject {
		margin: 0;
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		color: var(--color-text-muted);
	}

	.customise-subject-stop {
		color: var(--color-stopover);
	}

	.customise-close {
		margin-left: auto;
		min-height: 2.75rem;
		touch-action: manipulation;
		padding-inline: var(--space-2);
		border-radius: var(--radius-md);
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-medium);
		color: var(--color-accent);
		transition: color var(--transition-fast);
	}

	.customise-close:hover {
		color: var(--color-accent-hover);
	}

	.customise-close:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	.customise-idle {
		margin: 0;
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
		text-wrap: pretty;
	}

	/* Focused on open so a keyboard reaches the controls it just asked for, which is why
	   it must not draw a ring: it is a region, not a control, and a ring here would read as
	   "you are on something you can press". */
	.results-customise:focus,
	.customise-sheet:focus {
		outline: none;
	}

	.customise-sheet {
		position: fixed;
		inset-inline: 0;
		bottom: 0;
		z-index: var(--z-overlay);
		display: flex;
		flex-direction: column;
		/* Under half the screen, so the card and the strip that was tapped stay readable
		   above it. `dvh` rather than `vh`: a phone browser's address bar is the difference
		   between a sheet that fits and one whose close button is off screen. */
		max-height: min(50dvh, 26rem);
		background: var(--color-bg-elevated);
		border-top: 2px dashed var(--color-border-strong);
		border-radius: var(--radius-xl) var(--radius-xl) 0 0;
		box-shadow: var(--shadow-lg);
		/* Issue #318: scrolling to the bottom of the sheet used to chain into scrolling the
		   page behind it, so the card the sheet is about slid away under a finger that was
		   only trying to reach the last picker. */
		overscroll-behavior: contain;
		transition: translate var(--transition-base);
	}

	/* The drag target. Its own row rather than a decoration on the header, so a thumb
	   landing anywhere along the top of the sheet starts the drag. */
	.customise-sheet-grip {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 1.75rem;
		flex-shrink: 0;
		/* The browser must not claim the vertical drag for scrolling, and a mouse drag along
		   the top of the sheet must not select the text under it. */
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
		cursor: grab;
	}

	.customise-sheet-handle {
		width: 2.5rem;
		height: 0.25rem;
		border-radius: var(--radius-full);
		background: var(--color-border-strong);
	}

	.customise-sheet-head {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-shrink: 0;
		padding: 0 var(--space-4) var(--space-2);
		border-bottom: 1px solid var(--color-border);
	}

	.customise-sheet-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		/* The home indicator on a phone without a hardware button sits over the last few
		   pixels of anything flush to the bottom edge. */
		padding: var(--space-4) var(--space-4) calc(var(--space-4) + env(safe-area-inset-bottom));
	}

	@media (min-width: 64rem) {
		.results-layout {
			/* The filter rail, the answers, and the controls for whichever trip is being
			   customised. The middle column takes what is left, which is what keeps a card
			   from growing when a picker opens. */
			grid-template-columns: 17rem minmax(0, 1fr) 20rem;
			align-items: start;
			gap: var(--space-6);
		}

		.results-filters,
		.results-customise {
			position: sticky;
			/* Clears the search summary strip pinned above it with room to spare. At 6rem the
			   two did not overlap and did touch, which is issue #310: the strip's own bottom
			   edge and `Sort by`'s label met with nothing between them as soon as the list
			   scrolled. */
			top: 7.5rem;
		}

		/* The rail can outrun the viewport once a stay list is in it, and a sticky column
		   taller than the screen strands its own bottom. */
		.results-customise {
			max-height: calc(100dvh - 9.5rem);
			overflow-y: auto;
			overscroll-behavior: contain;
			padding-right: var(--space-2);
		}

		/* A sidebar is already open; a button that says so would be a control with
		   nothing to do. */
		.filters-toggle {
			display: none;
		}
	}

	/* Issue #310: past the three-column breakpoint there is real room, and the side columns
	   take a share of it rather than leaving the list to absorb all of it. A filter rail at
	   its phone width beside a 900px card reads as an oversight, and the customise panel is
	   the one that holds a stay list with photographs. */
	@media (min-width: 90rem) {
		.results-layout {
			grid-template-columns: 19rem minmax(0, 1fr) 24rem;
		}
	}

	/* Between the phone and the three-column desktop there is room for the filters beside
	   the answers but not for a third column, so the sheet covers that band too. */
	@media (min-width: 48rem) and (max-width: 63.99rem) {
		.results-layout {
			grid-template-columns: 16rem minmax(0, 1fr);
			align-items: start;
			gap: var(--space-5);
		}
	}
</style>
