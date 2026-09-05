<script lang="ts">
	/**
	 * Issue #23: "Filters over price, total duration, nights, connection city, airline,
	 * and free-time length." Plus the sort control (score/price/duration).
	 *
	 * `filters` and `sortMode` are `$bindable` (like Input and Select elsewhere in this
	 * design system) rather than callback props, since the page just needs to reassign its
	 * own `$state` when either changes, no extra shadow state or `$effect` needed here.
	 *
	 * The two chip rails CHOOSE rather than exclude (issue #189). Every chip carries its own
	 * count, so one click has to leave that many results, and nothing chosen means everything
	 * shown. Chip itself owns none of this: `selected` is read straight off `filters` and the
	 * click writes `filters` back, which is the other half of #189.
	 */
	import { Chip, Select } from '$lib/components';
	import type { Duration, IataAirlineCode, IataAirportCode, IsoCurrencyCode } from '$lib/domain';
	import {
		emptyFilters,
		isEmptyFilters,
		type FilterOptions,
		type ResultFilters
	} from '$lib/results/filters';
	import { formatDuration, formatMoney } from '$lib/format';
	import { SORT_MODES, SORT_MODE_LABELS, type SortMode } from '$lib/results/sort';

	interface Props {
		options: FilterOptions;
		filters: ResultFilters;
		sortMode: SortMode;
		currency?: IsoCurrencyCode;
		/** Airlines the SEARCH QUERY asked to avoid, shown as a hint next to the matching chip
		 * so a traveller can tell "the search is already scoring this one down" apart from "I
		 * have not chosen it," never used to preselect or hide anything (either would turn a
		 * soft preference into a filter). */
		avoidedAirlines?: readonly IataAirlineCode[];
		/** Issue #136: connection airport code to the city a traveller would name, so a
		 * control headed "Connection city" says Bergamo rather than BGY. The page resolves
		 * these asynchronously (`getAirport`), so a code missing from this map is the
		 * ordinary state for the first frame, not an error: the chip falls back to the
		 * code alone rather than blocking or guessing. */
		connectionCityNames?: Readonly<Record<IataAirportCode, string>>;
	}

	let {
		options,
		filters = $bindable(),
		sortMode = $bindable(),
		currency = 'EUR',
		avoidedAirlines = [],
		connectionCityNames = {}
	}: Props = $props();

	const uid = $props.id();
	const avoidedSet = $derived(new Set(avoidedAirlines.map((code) => code.toUpperCase())));

	function isSortMode(value: string): value is SortMode {
		return (SORT_MODES as readonly string[]).includes(value);
	}

	function handleSortChange(event: Event) {
		const value = (event.currentTarget as HTMLSelectElement).value;
		if (isSortMode(value)) sortMode = value;
	}

	function toggleSetMember<T>(set: ReadonlySet<T>, value: T): Set<T> {
		const next = new Set(set);
		if (next.has(value)) next.delete(value);
		else next.add(value);
		return next;
	}

	function toggleAirport(code: IataAirportCode) {
		filters = {
			...filters,
			chosenConnectionAirports: toggleSetMember(filters.chosenConnectionAirports, code)
		};
	}

	function toggleAirline(code: IataAirlineCode) {
		filters = { ...filters, chosenAirlines: toggleSetMember(filters.chosenAirlines, code) };
	}

	function clearAll() {
		filters = emptyFilters();
	}

	/** The right-hand readout on a chip group's head, in the same slot where the sliders
	 * print `Any` or their current bound. Naming the single choice rather than counting it
	 * is what makes the group readable when the rail is scrolled and the chips are off
	 * screen on a phone. */
	function chosenSummary(chosen: ReadonlySet<string>): string {
		if (chosen.size === 0) return 'Any';
		if (chosen.size === 1) return [...chosen][0];
		return `${chosen.size} chosen`;
	}

	// Each range's "off" end doubles as "no filter": a max-price slider dragged all the
	// way up means "no price limit," not literally "cap it at today's most expensive
	// result", the latter would silently start hiding a pricier itinerary the moment
	// one streams in.
	function handleMaxPrice(event: Event) {
		const value = Number((event.currentTarget as HTMLInputElement).value);
		const bounds = options.priceRangeMinorUnits;
		filters = { ...filters, maxPriceMinorUnits: bounds && value >= bounds.max ? undefined : value };
	}

	function handleMaxDuration(event: Event) {
		const value = Number((event.currentTarget as HTMLInputElement).value);
		const bounds = options.totalDurationRangeMinutes;
		filters = { ...filters, maxTotalDurationMinutes: bounds && value >= bounds.max ? undefined : value };
	}

	function handleMinNights(event: Event) {
		const value = Number((event.currentTarget as HTMLInputElement).value);
		filters = { ...filters, minNights: value <= 0 ? undefined : value };
	}

	function handleMinFreeTime(event: Event) {
		const value = Number((event.currentTarget as HTMLInputElement).value);
		filters = { ...filters, minFreeTimeMinutes: value <= 0 ? undefined : value };
	}
</script>

<div class="filter-panel">
	<div class="filter-panel-head">
		<Select
			label="Sort by"
			value={sortMode}
			onchange={handleSortChange}
			options={SORT_MODES.map((mode) => ({ value: mode, label: SORT_MODE_LABELS[mode] }))}
		/>
		{#if !isEmptyFilters(filters)}
			<button type="button" class="clear-filters" onclick={clearAll}>Clear filters</button>
		{/if}
	</div>

	{#if options.priceRangeMinorUnits}
		<div class="filter-control">
			<div class="filter-control-head">
				<span>Max price</span>
				<span class="filter-value font-mono tabular-nums">
					{filters.maxPriceMinorUnits === undefined
						? 'Any'
						: formatMoney({ minorUnits: filters.maxPriceMinorUnits, currency })}
				</span>
			</div>
			<input
				type="range"
				min={options.priceRangeMinorUnits.min}
				max={options.priceRangeMinorUnits.max}
				value={filters.maxPriceMinorUnits ?? options.priceRangeMinorUnits.max}
				oninput={handleMaxPrice}
				aria-label="Maximum price"
			/>
		</div>
	{/if}

	{#if options.totalDurationRangeMinutes}
		<div class="filter-control">
			<div class="filter-control-head">
				<span>Max total time</span>
				<span class="filter-value font-mono tabular-nums">
					{filters.maxTotalDurationMinutes === undefined
						? 'Any'
						: formatDuration(filters.maxTotalDurationMinutes as Duration)}
				</span>
			</div>
			<input
				type="range"
				min={options.totalDurationRangeMinutes.min}
				max={options.totalDurationRangeMinutes.max}
				value={filters.maxTotalDurationMinutes ?? options.totalDurationRangeMinutes.max}
				oninput={handleMaxDuration}
				aria-label="Maximum total time"
			/>
		</div>
	{/if}

	{#if options.nightsRange && options.nightsRange.max > 0}
		<div class="filter-control">
			<div class="filter-control-head">
				<span>Minimum nights in the stopover</span>
				<span class="filter-value font-mono tabular-nums">{filters.minNights ?? 'Any'}</span>
			</div>
			<input
				type="range"
				min={0}
				max={options.nightsRange.max}
				value={filters.minNights ?? 0}
				oninput={handleMinNights}
				aria-label="Minimum nights in the stopover"
			/>
		</div>
	{/if}

	{#if options.freeTimeRangeMinutes && options.freeTimeRangeMinutes.max > 0}
		<div class="filter-control">
			<div class="filter-control-head">
				<span>Minimum free time</span>
				<span class="filter-value font-mono tabular-nums">
					{filters.minFreeTimeMinutes === undefined ? 'Any' : formatDuration(filters.minFreeTimeMinutes as Duration)}
				</span>
			</div>
			<input
				type="range"
				min={0}
				max={options.freeTimeRangeMinutes.max}
				value={filters.minFreeTimeMinutes ?? 0}
				oninput={handleMinFreeTime}
				aria-label="Minimum free time"
			/>
		</div>
	{/if}

	{#if options.connectionAirports.length > 0}
		<div class="filter-control">
			<div class="filter-control-head">
				<span id="{uid}-city">Connection city</span>
				<span class="filter-value font-mono tabular-nums">
					{chosenSummary(filters.chosenConnectionAirports)}
				</span>
			</div>
			<!-- A `group`, so a screen reader announces "Connection city" before the first chip
			     and "London LGW 1, toggle button, not pressed" arrives attached to the question
			     it answers rather than floating loose after a slider. -->
			<div class="chip-row" role="group" aria-labelledby="{uid}-city">
				{#each options.connectionAirports as option (option.value)}
					{@const city = connectionCityNames[option.value]}
					<Chip
						interactive
						selected={filters.chosenConnectionAirports.has(option.value)}
						onclick={() => toggleAirport(option.value)}
					>
						<!-- City first, because that is what the traveller is choosing
						     between. The code stays alongside it in mono, the same ticket-stub
						     pairing the result card header uses, since two airports can serve
						     one city and the code is what tells them apart.
						     `title` because Chip truncates its label at 16rem: a long city
						     name would otherwise take the count away with it, leaving no way
						     to read how many results the chip stands for.
						     `translate="no"` so a browser's page translation leaves the IATA
						     code alone. It is an identifier, not a word. -->
						<span title={city ? `${city} (${option.value}), ${option.count}` : undefined}>
							{#if city}
								{city}
								<span class="chip-code font-mono" translate="no">{option.value}</span>
							{:else}
								<span translate="no">{option.value}</span>
							{/if}
							<span class="tabular-nums">({option.count})</span>
						</span>
					</Chip>
				{/each}
			</div>
		</div>
	{/if}

	{#if options.airlines.length > 0}
		<div class="filter-control">
			<div class="filter-control-head">
				<span id="{uid}-airline">Airline</span>
				<span class="filter-value font-mono tabular-nums">
					{chosenSummary(filters.chosenAirlines)}
				</span>
			</div>
			<div class="chip-row" role="group" aria-labelledby="{uid}-airline">
				{#each options.airlines as option (option.value)}
					<Chip
						interactive
						selected={filters.chosenAirlines.has(option.value)}
						onclick={() => toggleAirline(option.value)}
					>
						{option.value} ({option.count}){avoidedSet.has(option.value) ? ' · avoided' : ''}
					</Chip>
				{/each}
			</div>
		</div>
	{/if}
</div>

<style>
	.filter-panel {
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}

	.filter-panel-head {
		display: flex;
		align-items: flex-end;
		gap: var(--space-3);
	}

	.clear-filters {
		height: 2.75rem;
		padding: 0 var(--space-3);
		border-radius: var(--radius-md);
		color: var(--color-text-muted);
		font-size: var(--font-size-sm);
		text-decoration: underline;
	}

	.clear-filters:hover {
		color: var(--color-text);
	}

	.filter-control {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.filter-control-head {
		display: flex;
		justify-content: space-between;
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.filter-value {
		color: var(--color-text);
		font-weight: var(--font-weight-medium);
	}

	input[type='range'] {
		width: 100%;
		accent-color: var(--color-accent);
	}

	.chip-row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	/* The code is the ticket-stub half of the pair, so it reads as one: mono, tracked out,
	   a shade smaller than the city name beside it. Deliberately NOT dimmed with a fixed
	   grey or an opacity: a chip's own background changes between unselected, selected and
	   deprioritized, so any colour picked against one of those three fails the contrast
	   check on another. Inheriting `currentColor` is the only treatment that holds in all
	   three, and the typographic contrast does the separating instead. */
	.chip-code {
		font-size: 0.9em;
		letter-spacing: var(--tracking-wide);
	}
</style>
