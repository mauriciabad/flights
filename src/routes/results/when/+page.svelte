<script lang="ts">
	/**
	 * Issue #71: "when should I go", answered from what this browser already holds.
	 *
	 * ## Where the numbers come from, and what they are not
	 *
	 * Two free sources, both read out of IndexedDB at a cost of zero requests
	 * (`$lib/flexible-dates/collect.ts`): the price ledger, which is every one-adult fare
	 * this app has seen while somebody was searching, whichever provider found it; and
	 * Ryanair's `cheapestPerDay` month grids, which every ordinary search already caches as
	 * a side effect and which cover a whole calendar month per entry. One button on this
	 * page spends anything at all, and what it spends is keyless Ryanair requests, one per
	 * calendar month, after saying how many.
	 *
	 * Nothing here is a quote. A cheapest-fare-per-day figure says which days are worth
	 * pricing properly; confirming a real itinerary still runs a real search, which is what
	 * every "Search these dates" button on this page does.
	 *
	 * ## Why this is its own route rather than a tab on the results list
	 *
	 * It answers a different question. `/results/` answers "what does this trip cost on
	 * these dates"; this answers "which dates". They share the query string exactly, and the
	 * same `SearchSummaryBar` sits at the top of both, so editing the search here submits it
	 * there. That is #182's rule ("results should be merged with search... they are not 2
	 * separate tabs") applied rather than contradicted: picking a week IS running that
	 * search, and pressing it navigates to the answer instead of leaving you here.
	 *
	 * The one extra parameter this route reads is `stops`, the stopover airports to price.
	 * Deliberately not `via`: `via` is a real search constraint (`allowedConnectionAirports`),
	 * and inheriting it silently from a browse screen would narrow a search the traveller
	 * never narrowed. Pressing "Search these dates" DOES set `via`, because by then they
	 * have picked one.
	 */
	import { untrack } from 'svelte';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { Button, EmptyState, ErrorState, Select, Skeleton } from '$lib/components';
	import { getAirport } from '$lib/data/airports';
	import { DEFAULT_SEARCH_CURRENCY } from '$lib/domain';
	import type { IataAirportCode, IsoCalendarDate, IsoCurrencyCode } from '$lib/domain';
	import {
		addDays,
		cheapestByDeparture,
		collectLegFares,
		coverageReport,
		daysInMonth,
		fillLegMonths,
		FLEXIBLE_DATES_DISCLAIMER,
		missingRyanairMonths,
		monthStartsBetween,
		priceBands,
		rankWeeks,
		coverageSentence,
		fillCostSentence,
		freshnessSentence,
		monthLabel,
		sourcesSentence,
		unknownMonthsSentence
	} from '$lib/flexible-dates';
	import type { LegFares, LegKey, RankedWeek } from '$lib/flexible-dates';
	import { keyStore } from '$lib/keys';
	import { getProviderRegistry } from '$lib/results/provider-setup';
	import { buildSearchQuery } from '$lib/search-form/model';
	import { fieldsToSearchParams, searchParamsToFields } from '$lib/search-form/url-codec';
	import { summarizeSearch } from '$lib/search-history';
	import SearchSummaryBar from '../SearchSummaryBar.svelte';
	import WeekStub from './WeekStub.svelte';
	import YearGrid from './YearGrid.svelte';

	/** Not reactive, for the same reason the results page's own `todayIso` is not: this
	 * screen does not need to notice midnight tick over while it is open, and it only ever
	 * hydrates in a real browser. */
	const today: IsoCalendarDate = new Date().toISOString().slice(0, 10);
	/** A year forward. 366 days, so the last day is the same date next year. */
	const horizon: IsoCalendarDate = addDays(today, 365);
	const monthWindow = monthStartsBetween(today, horizon);
	const now = Date.now();

	const searchFields = $derived(
		searchParamsToFields(browser ? page.url.searchParams : new URLSearchParams())
	);
	const parsedQuery = $derived(browser ? buildSearchQuery(searchFields) : null);
	const summary = $derived(parsedQuery ? summarizeSearch(parsedQuery) : undefined);

	/** The stopovers to price, from `stops`. See this component's header for why it is not
	 * `via`. */
	const stopovers = $derived<IataAirportCode[]>(
		(browser ? (page.url.searchParams.get('stops') ?? '') : '')
			.split(',')
			.map((code) => code.trim().toUpperCase())
			.filter(Boolean)
	);

	let chosenStopover = $state<IataAirportCode | undefined>(undefined);
	/** Derived rather than corrected in an effect: an effect that reads and writes the same
	 * state is what froze this app once already (#87, AGENTS.md). */
	const stopover = $derived<IataAirportCode | undefined>(
		chosenStopover && stopovers.includes(chosenStopover) ? chosenStopover : stopovers[0]
	);

	const currency = $derived<IsoCurrencyCode>(keyStore.currency ?? DEFAULT_SEARCH_CURRENCY);

	let minNights = $state(1);
	let maxNights = $state(4);
	let selectedMonth = $state<IsoCalendarDate | undefined>(undefined);

	interface LoadedLegs {
		outbound: LegFares;
		onward: LegFares;
		/** Months no cached Ryanair grid answers for, per leg. What the fill button costs. */
		missing: { outbound: IsoCalendarDate[]; onward: IsoCalendarDate[] };
	}

	let legs = $state<LoadedLegs | undefined>(undefined);
	let loading = $state(false);
	let loadError = $state<string | undefined>(undefined);
	/** Bumped after a fill so the effect below re-reads the cache it just wrote into. */
	let reloadToken = $state(0);

	let stopoverCityName = $state<Record<string, string>>({});
	/** Plain mutable bookkeeping, not `$state` and deliberately not a `SvelteSet`: nothing
	 * renders from it, it only stops the lookup below firing twice for the same code. Same
	 * pattern, and same reasoning, as the results page's own `requestedAirportCodes`. */
	const requestedAirportCodes = new Set<string>();

	const outboundLeg = $derived<LegKey | undefined>(
		parsedQuery && stopover
			? { origin: parsedQuery.originAirport, destination: stopover, currency }
			: undefined
	);
	const onwardLeg = $derived<LegKey | undefined>(
		parsedQuery && stopover
			? { origin: stopover, destination: parsedQuery.destinationAirport, currency }
			: undefined
	);

	async function loadLegs(outbound: LegKey, onward: LegKey, isStale: () => boolean) {
		loading = true;
		loadError = undefined;
		try {
			const outboundFares = await collectLegFares(outbound, monthWindow);
			const onwardFares = await collectLegFares(onward, monthWindow);
			const missingOutbound = await missingRyanairMonths(outbound, monthWindow);
			const missingOnward = await missingRyanairMonths(onward, monthWindow);
			if (isStale()) return;
			legs = {
				outbound: outboundFares,
				onward: onwardFares,
				missing: { outbound: missingOutbound, onward: missingOnward }
			};
		} catch (error) {
			// The store's own words, not a guess at what it meant (AGENTS.md).
			if (!isStale()) loadError = error instanceof Error ? error.message : String(error);
		} finally {
			if (!isStale()) loading = false;
		}
	}

	$effect(() => {
		const outbound = outboundLeg;
		const onward = onwardLeg;
		// Read here, outside `untrack`, so a finished fill re-runs this effect against the
		// cache entries it just wrote.
		const token = reloadToken;
		if (!outbound || !onward) {
			legs = undefined;
			return;
		}
		let stale = false;
		// #87: `loadLegs` is called without `await`, so its synchronous prefix (`loading =
		// true`) runs on this effect's own call stack, and Svelte tracks dependencies by
		// call stack. `untrack` scopes that window out; everything after the first real
		// await is outside any effect's tracking already. The token comparison makes a load
		// that a newer one has overtaken abandon its write rather than clobber it.
		untrack(() => void loadLegs(outbound, onward, () => stale || token !== reloadToken));
		return () => {
			stale = true;
		};
	});

	/** The stopover's city name, resolved lazily and once per code, so a stub can say "3
	 * nights in Vienna" rather than "3 nights in VIE". Falls back to the code. */
	$effect(() => {
		for (const code of stopovers) {
			if (requestedAirportCodes.has(code)) continue;
			requestedAirportCodes.add(code);
			getAirport(code).then((airport) => {
				if (airport) stopoverCityName = { ...stopoverCityName, [code]: airport.city.name };
			});
		}
	});

	const providerLabels = $derived.by(() => {
		const labels: Record<string, string> = {};
		if (!browser) return labels;
		for (const provider of getProviderRegistry().ofKind('flight')) labels[provider.id] = provider.label;
		return labels;
	});

	const nightRange = $derived({ minNights, maxNights: Math.max(minNights, maxNights) });

	/** The grid always shows the whole year: it is the map of what is known, and hiding
	 * eleven months of it because a month filter is on would defeat the point. */
	const yearWindows = $derived(
		legs
			? cheapestByDeparture(legs.outbound.fares, legs.onward.fares, {
					...nightRange,
					from: today,
					to: horizon
				})
			: new Map()
	);
	const bands = $derived(priceBands(yearWindows));
	const blankDates = $derived(
		new Set([...(legs?.outbound.blankDays ?? []), ...(legs?.onward.blankDays ?? [])].map((blank) => blank.date))
	);

	/** The ranking, which the month filter does narrow. Re-derived in memory on every
	 * change: no request, ever (`collect.test.ts` asserts it from the outside). */
	const weeks = $derived<RankedWeek[]>(
		legs
			? rankWeeks(legs.outbound.fares, legs.onward.fares, {
					...nightRange,
					from: selectedMonth ?? today,
					to: selectedMonth ? addDays(selectedMonth, daysInMonth(selectedMonth) - 1) : horizon
				})
			: []
	);

	const report = $derived(
		legs
			? coverageReport(legs.outbound, legs.onward, yearWindows, { from: today, to: horizon })
			: undefined
	);
	const missingMonthCount = $derived(
		(legs?.missing.outbound.length ?? 0) + (legs?.missing.onward.length ?? 0)
	);

	let filling = $state(false);
	let filled = $state(0);
	let fillErrors = $state<string[]>([]);
	let fillController: AbortController | undefined;

	/**
	 * The only thing on this page that spends a request. One keyless Ryanair call per
	 * missing calendar month per leg, sequentially, with the count shown on the button
	 * before it is pressed.
	 */
	async function fillYear() {
		const outbound = outboundLeg;
		const onward = onwardLeg;
		const missing = legs?.missing;
		if (!outbound || !onward || !missing || filling) return;

		filling = true;
		filled = 0;
		fillErrors = [];
		fillController = new AbortController();
		try {
			for (const [leg, months] of [
				[outbound, missing.outbound],
				[onward, missing.onward]
			] as const) {
				for await (const outcome of fillLegMonths(leg, months, fillController.signal)) {
					filled += 1;
					if (!outcome.ok && outcome.error) {
						// Ryanair's own message, verbatim.
						fillErrors = [...fillErrors, `${monthLabel(outcome.monthStart)}: ${outcome.error}`];
					}
				}
			}
		} finally {
			filling = false;
			fillController = undefined;
			reloadToken += 1;
		}
	}

	function cancelFill() {
		fillController?.abort();
	}

	/**
	 * A chosen week becomes a real search on the results page, with the exact date pair
	 * pinned and this stopover named. That is what #182 established: a search you refine is
	 * not a detour from its answers, so this navigates rather than opening a panel.
	 */
	function searchWeek(week: RankedWeek) {
		if (!stopover) return;
		const fields = {
			...searchFields,
			soonestDeparture: week.best.outbound.departureDate,
			latestDepartureOverride: week.best.outbound.departureDate,
			soonestArrivalOverride: week.best.onward.departureDate,
			latestArrival: week.best.onward.arrivalDate,
			allowedConnectionAirports: [stopover]
		};
		void goto(`${base}/results/?${fieldsToSearchParams(fields).toString()}`);
	}

	function submitSearch(next: URLSearchParams) {
		void goto(`${base}/results/?${next.toString()}`);
	}

	const backToResults = $derived(
		browser ? `${base}/results/?${page.url.searchParams.toString()}` : `${base}/results/`
	);

	const nightOptions = Array.from({ length: 15 }, (_, i) => ({
		value: String(i),
		label: i === 1 ? '1 night' : `${i} nights`
	}));

	const stopoverLabel = $derived(stopover ? (stopoverCityName[stopover] ?? stopover) : '');
</script>

<svelte:head>
	<title
		>{summary
			? `When to fly ${summary.originAirport} to ${summary.destinationAirport} - Layover`
			: 'When to go - Layover'}</title
	>
</svelte:head>

<div class="when-page">
	{#if !parsedQuery}
		<EmptyState
			title="No search in this link"
			description="This view prices a search you have already run. Start one, and the results page will offer it."
		>
			{#snippet action()}
				<Button href={`${base}/`}>Go to search</Button>
			{/snippet}
		</EmptyState>
	{:else if summary}
		<SearchSummaryBar
			{summary}
			initialFields={searchFields}
			{today}
			onsearch={submitSearch}
			advisories={[]}
		/>

		<header class="page-head">
			<h2>When should I go?</h2>
			<p class="lede">
				Built from prices this browser already holds. Nothing on this page is fetched to answer a
				question you ask it.
			</p>
		</header>

		{#if stopovers.length === 0}
			<EmptyState
				title="No stopover to price yet"
				description="This view needs a stopover city to price a trip through. Run the search first, and its results page will link back here with the stopovers it found."
			>
				{#snippet action()}
					<Button href={backToResults}>Back to the results</Button>
				{/snippet}
			</EmptyState>
		{:else}
			<div class="controls">
				{#if stopovers.length > 1}
					<fieldset class="stopover-picker">
						<legend>Stopover</legend>
						<div class="stopover-options">
							{#each stopovers as code (code)}
								<label class={['stopover-option', { 'is-checked': stopover === code }]}>
									<input
										type="radio"
										name="stopover"
										value={code}
										checked={stopover === code}
										onchange={() => (chosenStopover = code)}
									/>
									<span class="font-mono">{code}</span>
									<span class="stopover-city">{stopoverCityName[code] ?? ''}</span>
								</label>
							{/each}
						</div>
					</fieldset>
				{/if}

				<div class="nights">
					<Select
						label="Fewest nights"
						options={nightOptions}
						value={String(minNights)}
						onchange={(event: Event) =>
							(minNights = Number((event.currentTarget as HTMLSelectElement).value))}
					/>
					<Select
						label="Most nights"
						options={nightOptions}
						value={String(maxNights)}
						onchange={(event: Event) =>
							(maxNights = Number((event.currentTarget as HTMLSelectElement).value))}
					/>
				</div>
			</div>

			{#if loadError}
				<ErrorState
					severity="error"
					title="The cached prices could not be read"
					message={loadError}
				/>
			{/if}

			{#if loading && !legs}
				<div class="loading" aria-live="polite">
					<p class="visually-hidden">Reading cached prices…</p>
					<Skeleton height="6rem" />
					<Skeleton height="6rem" />
				</div>
			{:else if legs && report}
				<section class="coverage" aria-label="What these prices cover">
					<p class="coverage-line">{coverageSentence(report)}</p>
					{#if unknownMonthsSentence(report)}
						<p class="coverage-gap">{unknownMonthsSentence(report)}</p>
					{/if}
					{#if freshnessSentence(report, now)}
						<p class="coverage-meta">{freshnessSentence(report, now)}</p>
					{/if}
					{#if sourcesSentence(report.providerIds.map((id) => providerLabels[id] ?? id))}
						<p class="coverage-meta">
							{sourcesSentence(report.providerIds.map((id) => providerLabels[id] ?? id))}
						</p>
					{/if}

					<div class="fill">
						<p class="fill-cost">{fillCostSentence(missingMonthCount, 2)}</p>
						<p class="fill-caveat">
							Ryanair publishes a cheapest fare per day for its own network, keylessly. It will
							answer for every day of a month it flies, and report no service at all on a route it
							does not.
						</p>
						{#if filling}
							<p class="fill-progress" aria-live="polite">
								Fetched {filled} of {missingMonthCount} months
							</p>
							<Button variant="secondary" onclick={cancelFill}>Stop</Button>
						{:else if missingMonthCount > 0}
							<Button onclick={fillYear}>Fill the year from Ryanair</Button>
						{/if}
						{#if fillErrors.length > 0}
							<ul class="fill-errors">
								{#each fillErrors as error (error)}
									<li>{error}</li>
								{/each}
							</ul>
						{/if}
					</div>
				</section>

				<section class="weeks" aria-label="Cheapest weeks">
					<div class="weeks-head">
						<!-- Live, because narrowing to a month replaces the whole list below with no
						     other signal that anything happened. -->
						<h3 aria-live="polite">
							{#if selectedMonth}
								Cheapest weeks in {monthLabel(selectedMonth)}
							{:else}
								Cheapest weeks we can price
							{/if}
						</h3>
						{#if selectedMonth}
							<Button variant="ghost" size="sm" onclick={() => (selectedMonth = undefined)}>
								Show the whole year
							</Button>
						{/if}
					</div>

					{#if weeks.length === 0}
						<EmptyState
							title="No week can be priced end to end yet"
							description="A week needs a fare on both legs, with the right number of nights between them. Widen the stopover length, or fill the year from Ryanair above."
						/>
					{:else}
						<ul class="week-list">
							{#each weeks.slice(0, 6) as week, index (week.weekStart)}
								<li>
									<WeekStub
										{week}
										originAirport={parsedQuery.originAirport}
										stopoverAirport={stopover ?? ''}
										destinationAirport={parsedQuery.destinationAirport}
										stopoverName={stopoverLabel}
										{currency}
										{now}
										{providerLabels}
										leading={index === 0 && !selectedMonth}
										onsearch={searchWeek}
									/>
								</li>
							{/each}
						</ul>
						{#if weeks.length > 6}
							<p class="weeks-more">
								{weeks.length - 6} more weeks can be priced. Pick a month below to see them.
							</p>
						{/if}
					{/if}
				</section>

				<section class="year-section" aria-label="Coverage across the year">
					<YearGrid
						months={legs.outbound.months}
						windowsByDay={yearWindows}
						thresholds={bands?.thresholds}
						{blankDates}
						{currency}
						{selectedMonth}
						onselect={(monthStart) => (selectedMonth = monthStart)}
					/>
				</section>

				<p class="disclaimer">{FLEXIBLE_DATES_DISCLAIMER}</p>
			{/if}
		{/if}
	{/if}
</div>

<style>
	.when-page {
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
		padding-bottom: var(--space-8);
	}

	.page-head {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	h2 {
		margin: 0;
		font-size: var(--font-size-2xl);
		line-height: var(--line-height-2xl);
		font-weight: var(--font-weight-bold);
		letter-spacing: var(--tracking-tight);
		text-wrap: balance;
	}

	h3 {
		margin: 0;
		font-size: var(--font-size-lg);
		line-height: var(--line-height-lg);
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-tight);
	}

	.lede,
	.coverage-meta,
	.fill-caveat,
	.weeks-more,
	.disclaimer {
		margin: 0;
		font-size: var(--font-size-sm);
		line-height: var(--line-height-sm);
		color: var(--color-text-muted);
		text-wrap: pretty;
	}

	.disclaimer {
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-faint);
		border-top: 1px solid var(--color-border);
		padding-top: var(--space-3);
	}

	/* Grid, not a wrapping flex row: with flex the two night selects collapsed into a
	   column beside the stopover chips and nothing lined up with anything. */
	.controls {
		display: grid;
		gap: var(--space-4);
		align-items: end;
	}

	.stopover-picker {
		margin: 0;
		padding: 0;
		border: 0;
		min-width: 0;
	}

	.stopover-picker legend {
		padding: 0 0 var(--space-2);
		font-size: var(--font-size-sm);
		line-height: var(--line-height-sm);
		font-weight: var(--font-weight-medium);
		color: var(--color-text-muted);
	}

	.stopover-options {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	/* A split-flap tab per stopover, not a select: the whole point of this screen is
	   comparing two cities, and a collapsed dropdown hides the comparison. */
	.stopover-option {
		/* Positioned so the visually-hidden radio inside stays inside it, rather than being
		   placed against whatever ancestor happens to be positioned. */
		position: relative;
		display: inline-flex;
		align-items: baseline;
		gap: var(--space-2);
		min-height: 2.75rem;
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-md);
		background: var(--color-surface);
		cursor: pointer;
	}

	.stopover-option:hover {
		background: var(--color-surface-hover);
	}

	.stopover-option.is-checked {
		border-color: var(--color-accent);
		background: var(--color-accent-muted);
		color: var(--color-text);
	}

	.stopover-option:focus-within {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	.stopover-option input {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
		pointer-events: none;
	}

	.stopover-city {
		font-size: var(--font-size-sm);
		line-height: var(--line-height-sm);
		color: var(--color-text-muted);
	}

	/* Side by side even at 375px: they are one control with two ends, and stacking them
	   pushed the answer another 90px down the phone screen. */
	.nights {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-3);
	}

	@media (min-width: 48rem) {
		.controls {
			grid-template-columns: 1fr auto;
		}

		.nights {
			grid-template-columns: repeat(2, 9rem);
		}
	}

	.loading {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.coverage {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-4);
		border: 1px solid var(--color-border);
		border-left: 3px solid var(--color-accent);
		border-radius: var(--radius-md);
		background: var(--color-bg-elevated);
	}

	.coverage-line {
		margin: 0;
		font-size: var(--font-size-base);
		line-height: var(--line-height-base);
		font-weight: var(--font-weight-semibold);
	}

	/* The honest half. Same weight as the good news, deliberately. */
	.coverage-gap {
		margin: 0;
		font-size: var(--font-size-base);
		line-height: var(--line-height-base);
		color: var(--color-warning);
	}

	.fill {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-2);
		margin-top: var(--space-2);
		padding-top: var(--space-3);
		border-top: 1px solid var(--color-border);
	}

	.fill-cost,
	.fill-progress {
		margin: 0;
		font-size: var(--font-size-sm);
		line-height: var(--line-height-sm);
		font-weight: var(--font-weight-medium);
	}

	.fill-errors {
		margin: 0;
		padding-left: var(--space-5);
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-danger);
	}

	.weeks {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.weeks-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.week-list {
		display: grid;
		gap: var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	@media (min-width: 48rem) {
		.week-list {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@media (min-width: 64rem) {
		.week-list {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}
</style>
