<script lang="ts">
	/**
	 * A year as thirteen rows of days, issue #71.
	 *
	 * The shape is a wall planner, not a heatmap: one row per calendar month, one cell per
	 * day of the month, read like the rows of a departure board. That choice is load
	 * bearing rather than decorative. A smooth curve or a sparkline would draw a line
	 * through days nobody has priced, and this app's coverage is genuinely patchy - the
	 * whole feature rests on a month with no data reading as a HOLE at a glance, not as a
	 * quiet dip. So there are three cell states and they look nothing like each other: a
	 * priced day is a solid brass block, a day a source said is unsellable is a hairline
	 * ghost, and a day nobody has looked at is empty.
	 *
	 * The grid is a chart, so its cells are `aria-hidden` and carry no click target: at
	 * 375px a day cell is 8px wide, which is not a tap target and pretending otherwise
	 * would fail every touch guideline in the book. The row is the control. Pressing a
	 * month narrows the whole view to it, which costs zero requests (the aggregation is
	 * pure - `$lib/flexible-dates/aggregate.ts`), and the row's `aria-label` says in words
	 * what its cells say in colour.
	 */
	import { bandOf, datesInMonth, monthLabel, shortMonthLabel, weekdayIndex } from '$lib/flexible-dates';
	import type { MonthCoverage, TripWindow } from '$lib/flexible-dates';
	import { formatMoney } from '$lib/format';
	import type { IsoCalendarDate, IsoCurrencyCode } from '$lib/domain';

	interface Props {
		months: MonthCoverage[];
		/** Cheapest complete trip per outbound departure date. Days absent from this map
		 * have no priced pair, whatever either leg alone knows. */
		windowsByDay: Map<IsoCalendarDate, TripWindow>;
		/** Quantile thresholds from `priceBands`, or `undefined` when nothing is priced. */
		thresholds: number[] | undefined;
		/** Days some source explicitly called unsellable, told apart from days nobody asked
		 * about. */
		blankDates: Set<IsoCalendarDate>;
		currency: IsoCurrencyCode;
		selectedMonth: IsoCalendarDate | undefined;
		onselect: (monthStart: IsoCalendarDate | undefined) => void;
	}

	let { months, windowsByDay, thresholds, blankDates, currency, selectedMonth, onselect }: Props =
		$props();

	/** The longest month decides the column count, so every row's day 1 lines up under
	 * every other row's day 1. Short months leave their tail empty rather than stretching. */
	const COLUMNS = 31;

	type CellState = 'priced' | 'blank' | 'unknown' | 'absent';

	interface Cell {
		date: IsoCalendarDate;
		state: CellState;
		band: number;
		weekend: boolean;
	}

	interface Row {
		monthStart: IsoCalendarDate;
		coverage: MonthCoverage;
		cells: Cell[];
		cheapest: TripWindow | undefined;
	}

	const rows = $derived<Row[]>(
		months.map((coverage) => {
			const dates = datesInMonth(coverage.monthStart);
			let cheapest: TripWindow | undefined;
			const cells: Cell[] = [];

			for (const date of dates) {
				const window = windowsByDay.get(date);
				if (window && (!cheapest || window.totalMinorUnits < cheapest.totalMinorUnits)) {
					cheapest = window;
				}
				const weekday = weekdayIndex(date);
				cells.push({
					date,
					state: window ? 'priced' : blankDates.has(date) ? 'blank' : 'unknown',
					band: window && thresholds ? bandOf(window.totalMinorUnits, thresholds) : 0,
					weekend: weekday >= 5
				});
			}
			while (cells.length < COLUMNS) {
				cells.push({ date: '', state: 'absent', band: 0, weekend: false });
			}
			return { monthStart: coverage.monthStart, coverage, cells, cheapest };
		})
	);

	function rowLabel(row: Row): string {
		const total = row.coverage.pricedDays + row.coverage.blankDays + row.coverage.unknownDays;
		if (row.cheapest) {
			return `${monthLabel(row.monthStart)}: ${windowCount(row)} of ${total} days priced end to end, from ${formatMoney({ minorUnits: row.cheapest.totalMinorUnits, currency })}. Show only this month.`;
		}
		if (row.coverage.blankDays > 0 && row.coverage.pricedDays === 0) {
			return `${monthLabel(row.monthStart)}: every day reported as not sellable. Show only this month.`;
		}
		return `${monthLabel(row.monthStart)}: nothing known. Show only this month.`;
	}

	function windowCount(row: Row): number {
		return row.cells.filter((cell) => cell.state === 'priced').length;
	}
</script>

<div class="year">
	<div class="year-head">
		<h3>The year, day by day</h3>
		<ul class="legend">
			<li><span class="swatch swatch-priced" aria-hidden="true"></span>Priced</li>
			<li><span class="swatch swatch-blank" aria-hidden="true"></span>Nothing on sale</li>
			<li><span class="swatch swatch-unknown" aria-hidden="true"></span>Never looked</li>
		</ul>
	</div>

	<!-- A day ruler, so a column can be read as a date rather than as "somewhere in the
	     middle of the month". Every row's day 1 sits under the same column, which is what
	     makes a seasonal shape legible across thirteen rows. -->
	<div class="ruler" aria-hidden="true">
		<span class="ruler-gutter"></span>
		<span class="ruler-scale font-mono">
			{#each [1, 8, 15, 22, 29] as day (day)}
				<span class="ruler-tick" style={`grid-column: ${day}`}>{day}</span>
			{/each}
		</span>
		<span class="ruler-gutter"></span>
	</div>

	<ol class="rows">
		{#each rows as row (row.monthStart)}
			<li>
				<button
					type="button"
					class={['row', { 'is-selected': selectedMonth === row.monthStart }]}
					aria-pressed={selectedMonth === row.monthStart}
					aria-label={rowLabel(row)}
					onclick={() => onselect(selectedMonth === row.monthStart ? undefined : row.monthStart)}
				>
					<span class="row-month font-mono">{shortMonthLabel(row.monthStart)}</span>
					<span class="row-cells" aria-hidden="true">
						{#each row.cells as cell, index (index)}
							<span
								class={[
									'cell',
									`cell-${cell.state}`,
									cell.state === 'priced' && `band-${cell.band}`,
									{ 'is-weekend': cell.weekend }
								]}
							></span>
						{/each}
					</span>
					<span class="row-price font-mono tabular-nums" aria-hidden="true">
						{#if row.cheapest}
							{formatMoney({ minorUnits: row.cheapest.totalMinorUnits, currency })}
						{:else if row.coverage.pricedDays === 0 && row.coverage.blankDays > 0}
							none
						{:else}
							&nbsp;
						{/if}
					</span>
				</button>
			</li>
		{/each}
	</ol>
</div>

<style>
	.year {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.year-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-2) var(--space-4);
	}

	h3 {
		margin: 0;
		font-size: var(--font-size-lg);
		line-height: var(--line-height-lg);
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-tight);
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-4);
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-muted);
	}

	.legend li {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.swatch {
		width: 0.75rem;
		height: 0.75rem;
		border-radius: 2px;
	}

	.swatch-priced {
		background: var(--color-accent);
	}

	.swatch-blank {
		border: 1px solid var(--color-border-strong);
		background: repeating-linear-gradient(
			135deg,
			transparent 0 2px,
			var(--color-border-strong) 2px 3px
		);
	}

	.swatch-unknown {
		border: 1px dashed var(--color-border);
	}

	.ruler {
		display: grid;
		grid-template-columns: 2.5rem 1fr 4.5rem;
		gap: var(--space-2);
		padding: 0 var(--space-2);
	}

	.ruler-scale {
		display: grid;
		grid-template-columns: repeat(31, 1fr);
		gap: 1px;
		font-size: 0.625rem;
		line-height: 1;
		color: var(--color-text-faint);
	}

	.ruler-tick {
		/* The label is wider than its 1/31 column, so it hangs to the right of its own
		   tick rather than being clipped by the next one. */
		overflow: visible;
		white-space: nowrap;
	}

	.rows {
		margin: 0;
		padding: 0;
		list-style: none;
		border-top: 1px solid var(--color-border);
	}

	.rows li {
		border-bottom: 1px solid var(--color-border);
	}

	/* A row, not a card: at this density a box per month would be thirteen boxes of
	   chrome around one line of data each. */
	.row {
		display: grid;
		grid-template-columns: 2.5rem 1fr 4.5rem;
		align-items: center;
		gap: var(--space-2);
		width: 100%;
		/* 44px, so a thumb has something to hit even though a day cell never does. */
		min-height: 2.75rem;
		padding: var(--space-1) var(--space-2);
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
		transition:
			background-color 120ms ease,
			box-shadow 120ms ease;
	}

	.row:hover {
		background: var(--color-surface-hover);
	}

	.row:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: -2px;
	}

	.row.is-selected {
		background: var(--color-accent-muted);
		box-shadow: inset 3px 0 0 var(--color-accent);
	}

	.row-month {
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		letter-spacing: var(--tracking-wide);
		text-transform: uppercase;
		color: var(--color-text-muted);
	}

	.row.is-selected .row-month {
		color: var(--color-accent);
	}

	.row-cells {
		display: grid;
		grid-template-columns: repeat(31, 1fr);
		gap: 1px;
		min-width: 0;
	}

	.cell {
		height: 1.125rem;
		border-radius: 1px;
	}

	.cell-absent {
		background: transparent;
	}

	/* Never looked. Deliberately the emptiest thing on screen - a month of these has to
	   read as a hole rather than as a cheap month. */
	.cell-unknown {
		background: var(--color-bg-inset);
		box-shadow: inset 0 0 0 1px var(--color-border);
	}

	.cell-unknown.is-weekend {
		background: var(--color-bg);
	}

	/* A source said there is nothing to sell. Hatched, so it cannot be mistaken for either
	   a price or a gap. */
	.cell-blank {
		background: repeating-linear-gradient(
			135deg,
			transparent 0 2px,
			var(--color-text-faint) 2px 3px
		);
		box-shadow: inset 0 0 0 1px var(--color-border);
	}

	/* Four brass steps, cheapest brightest. Quantile bands, so one absurd fare cannot wash
	   the rest of the year into a single shade. */
	.cell-priced.band-0 {
		background: var(--color-accent-hover);
	}

	.cell-priced.band-1 {
		background: var(--color-accent);
	}

	.cell-priced.band-2 {
		background: #8a6224;
	}

	.cell-priced.band-3 {
		background: #55401b;
	}

	.row-price {
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		text-align: right;
		color: var(--color-text-muted);
	}

	.row.is-selected .row-price {
		color: var(--color-text);
	}

	@media (min-width: 40rem) {
		.row,
		.ruler {
			grid-template-columns: 3.5rem 1fr 5.5rem;
		}

		.cell {
			height: 1.5rem;
			border-radius: 2px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.row {
			transition: none;
		}
	}

	@media (prefers-color-scheme: light) {
		.cell-priced.band-2 {
			background: #c08a3a;
		}

		.cell-priced.band-3 {
			background: #e6d3ac;
		}
	}
</style>
