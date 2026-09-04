<script lang="ts">
	/**
	 * Issue #23: "Filters over price, total duration, nights, connection city, airline,
	 * and free-time length." Plus the sort control (score/price/duration).
	 *
	 * `filters` and `sortMode` are `$bindable` (like Input/Select/Chip elsewhere in this
	 * design system) rather than callback props, since the page just needs to reassign its
	 * own `$state` when either changes, no extra shadow state or `$effect` needed here.
	 */
	import { Chip, Select } from '$lib/components';
	import type { Duration, IataAirlineCode, IataAirportCode, IsoCurrencyCode } from '$lib/domain';
	import { isEmptyFilters, type FilterOptions, type ResultFilters } from '$lib/results/filters';
	import { formatDuration, formatMoney } from '$lib/results/format';
	import { SORT_MODES, SORT_MODE_LABELS, type SortMode } from '$lib/results/sort';

	interface Props {
		options: FilterOptions;
		filters: ResultFilters;
		sortMode: SortMode;
		currency?: IsoCurrencyCode;
		/** Airlines the SEARCH QUERY asked to avoid, shown as a hint next to the matching
		 * chip so a traveller can tell "greyed by avoid" apart from "just unchecked," never
		 * used to pre-exclude anything (that would turn a soft preference into a filter). */
		avoidedAirlines?: readonly IataAirlineCode[];
	}

	let { options, filters = $bindable(), sortMode = $bindable(), currency = 'EUR', avoidedAirlines = [] }: Props = $props();

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
		filters = { ...filters, excludedConnectionAirports: toggleSetMember(filters.excludedConnectionAirports, code) };
	}

	function toggleAirline(code: IataAirlineCode) {
		filters = { ...filters, excludedAirlines: toggleSetMember(filters.excludedAirlines, code) };
	}

	// Chip's `selected` is `$bindable`, and left unbound here on purpose (each click
	// already recomputes `filters` directly, which is the actual source of truth), but
	// an unbound bindable prop owns its OWN copy after mount, so a click's symmetric
	// flip stays in sync with `filters` by construction, while an external reset like
	// "Clear filters" does NOT flow back into an already-mounted Chip's local copy.
	// Remounting every chip on a reset (via the {#key} blocks below) is the cheap fix.
	let filtersGeneration = $state(0);

	function clearAll() {
		filters = {
			excludedConnectionAirports: new Set(),
			excludedAirlines: new Set()
		};
		filtersGeneration += 1;
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
			<span class="filter-control-head-static">Connection city</span>
			<div class="chip-row">
				{#key filtersGeneration}
					{#each options.connectionAirports as option (option.value)}
						<Chip
							interactive
							selected={!filters.excludedConnectionAirports.has(option.value)}
							onclick={() => toggleAirport(option.value)}
						>
							{option.value} ({option.count})
						</Chip>
					{/each}
				{/key}
			</div>
		</div>
	{/if}

	{#if options.airlines.length > 0}
		<div class="filter-control">
			<span class="filter-control-head-static">Airline</span>
			<div class="chip-row">
				{#key filtersGeneration}
					{#each options.airlines as option (option.value)}
						<Chip
							interactive
							selected={!filters.excludedAirlines.has(option.value)}
							onclick={() => toggleAirline(option.value)}
						>
							{option.value} ({option.count}){avoidedSet.has(option.value) ? ' · avoided' : ''}
						</Chip>
					{/each}
				{/key}
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

	.filter-control-head-static {
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
</style>
