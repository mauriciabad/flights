<script lang="ts">
	/**
	 * Issue #28: "alternatives on the same route, each showing the DIFFERENCE from the
	 * currently selected flight... 'Plus 12 euro and 40 minutes later' is the comparison a
	 * person actually makes." One of these renders per leg (outbound or onward); the
	 * itinerary results page (#23/#24) is what will decide which alternatives to fetch and
	 * pass in. This component only ever compares what it is given.
	 *
	 * Every alternative is previewed through `recomputeItinerarySelection` before the
	 * traveller ever clicks anything, so a pick that would break the minimum layover shows
	 * its warning right on the row, not as a surprise after selecting it. Selecting it
	 * anyway is never blocked, though: AGENTS.md's "surface it, don't silently render an
	 * impossible trip" leaves the choice with the traveller, not this component.
	 *
	 * `alternatives` is only ever what a plain `runSearch` (issue #56, `search/pipeline.ts`)
	 * already found for free. Seeing more than that costs a metered request, so when the
	 * caller has a `SearchSnapshot.widenOptions` entry for this leg's connection airport,
	 * `widenOptions` renders it as its own row with the request cost shown BEFORE the
	 * traveller commits, not after. This component never spends the request itself: it only
	 * reports which option was picked (`onWiden`), since building the `WidenRequest` and
	 * calling `widenSearch`/`widenWithPriceCalendar` needs the `SearchDependencies` and the
	 * search's own date range, neither of which this component is given.
	 *
	 * These rows render inside the timeline step they belong to, which is why the list
	 * carries no heading and no card chrome of its own: the step already names the leg,
	 * and a bordered card inside a bordered row was the box-in-a-box look this replaces.
	 */
	import type { Duration, FlightOffer, Itinerary } from '../domain';
	import type { WidenOption } from '../search/types';
	import {
		diffFlightOffers,
		recomputeItinerarySelection,
		type RecomputedSelection
	} from '../algorithm/recompute-selection';
	import {
		formatClockTime,
		formatDuration,
		formatMoney,
		formatMoneyDelta,
		formatTimeDelta
	} from './itinerary-timeline-format';
	import { describeFlightOptions } from './flight-picker-summary';
	// Shared with ResultDetail's "is there anything to swap" check (issue #140), so the
	// hint above the pickers can never claim a choice this list collapses into one row.
	import { flightKey } from './picker-alternatives';

	type FlightLeg = 'outbound' | 'onward';

	interface Props {
		/** e.g. "Outbound: LGW to VIE". */
		legLabel: string;
		itinerary: Itinerary;
		leg: FlightLeg;
		/** Same-route candidates. The itinerary's own current flight for this leg is always
		 * shown too, whether or not it appears in this list. */
		alternatives: FlightOffer[];
		minLayoverTime?: Duration;
		/** From `SearchSnapshot.widenOptions` (issue #56), computed with no network call.
		 * Only entries with `kind: 'flight'` whose `candidateAirportCode` matches this leg's
		 * connection airport (or carries none at all) are shown; pass the whole snapshot
		 * array through unfiltered, this component does the matching itself. */
		widenOptions?: WidenOption[];
		/** Fired when the traveller asks to spend one of `widenOptions`. See the file header
		 * for why this component never calls `widenSearch` itself. */
		onWiden?: (option: WidenOption) => void;
		onselect: (result: RecomputedSelection) => void;
	}

	let { legLabel, itinerary, leg, alternatives, minLayoverTime, widenOptions, onWiden, onselect }: Props =
		$props();

	const uid = $props.id();
	const groupName = `flight-picker-${uid}`;

	const selected = $derived(leg === 'outbound' ? itinerary.outboundFlight : itinerary.onwardFlight);

	interface FlightRow {
		flight: FlightOffer;
		isSelected: boolean;
		delta: ReturnType<typeof diffFlightOffers> | null;
		result: RecomputedSelection;
	}

	const rows = $derived.by<FlightRow[]>(() => {
		const byKey = new Map<string, FlightOffer>();
		byKey.set(flightKey(selected), selected);
		for (const alternative of alternatives) byKey.set(flightKey(alternative), alternative);

		const sortedFlights = [...byKey.values()].sort((a, b) =>
			a.departure.local < b.departure.local ? -1 : a.departure.local > b.departure.local ? 1 : 0
		);

		return sortedFlights.map((flight) => {
			const isSelected = flightKey(flight) === flightKey(selected);
			const overrides = leg === 'outbound' ? { outboundFlight: flight } : { onwardFlight: flight };
			const result = recomputeItinerarySelection(itinerary, overrides, minLayoverTime);
			return {
				flight,
				isSelected,
				delta: isSelected ? null : diffFlightOffers(selected, flight),
				result
			};
		});
	});

	// Issue #137: how wide this list actually is, stated rather than left to be inferred
	// from its length. Derived from `rows` (the deduplicated, current-pick-included list the
	// radio group renders) so the caption can never disagree with what is on screen.
	const optionsSummary = $derived(describeFlightOptions(rows.map((row) => row.flight)));

	// The itinerary as it stands right now, warnings included, shown once beneath the
	// list rather than duplicated per row, since it describes the CURRENT pick, not a
	// hypothetical one. A row's own warning (via `row.result.warnings`) is what tells the
	// traveller a *different* row would break something.
	const currentWarnings = $derived(rows.find((row) => row.isSelected)?.result.warnings ?? []);

	function handleSelect(row: FlightRow) {
		onselect(row.result);
	}

	// Same physical stopover either way an itinerary is valid: the outbound flight's own
	// arrival airport is where the onward flight departs from, so either leg's flight names
	// the connection a WidenOption would be scoped to.
	const connectionAirportCode = $derived(itinerary.outboundFlight.arrivalAirport);

	const relevantWidenOptions = $derived(
		(widenOptions ?? []).filter(
			(option) =>
				option.kind === 'flight' &&
				(option.candidateAirportCode === undefined || option.candidateAirportCode === connectionAirportCode)
		)
	);

	function widenOptionKey(option: WidenOption): string {
		return `${option.providerId}:${option.tier}`;
	}

	function widenOptionCopy(option: WidenOption): string {
		return option.tier === 'calendar'
			? `${option.label}: check cheaper dates`
			: `${option.label}: confirm this exact date`;
	}
</script>

<section class="flight-picker">
	{#if optionsSummary}
		<p class="picker-provenance">{optionsSummary}</p>
	{/if}
	<div role="radiogroup" aria-label={legLabel} class="picker-list">
		{#each rows as row (flightKey(row.flight))}
			<label class={['picker-row', { 'is-selected': row.isSelected, 'has-warning': row.result.warnings.length > 0 }]}>
				<input
					type="radio"
					name={groupName}
					class="visually-hidden"
					checked={row.isSelected}
					onchange={() => handleSelect(row)}
				/>
				<span class="row-schedule">
					<span class="font-mono tabular-nums row-time">{formatClockTime(row.flight.departure)}</span>
					<svg class="row-arrow" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
						<path
							d="M2 8h11M9 4l4 4-4 4"
							fill="none"
							stroke="currentColor"
							stroke-width="1.5"
							stroke-linecap="round"
							stroke-linejoin="round"
						/>
					</svg>
					<span class="font-mono tabular-nums row-time">{formatClockTime(row.flight.arrival)}</span>
				</span>
				<span class="row-meta">
					<span class="row-carrier">{row.flight.carrier.iataCode} {row.flight.flightNumber}</span>
					<span class="row-duration font-mono tabular-nums">{formatDuration(row.flight.duration)}</span>
				</span>
				<span class="row-price font-mono tabular-nums">{formatMoney(row.flight.price)}</span>
				<span class="row-delta">
					{#if row.isSelected}
						<span class="row-current">Current pick</span>
					{:else if row.delta}
						<span class="delta-text" class:is-cheaper={((row.delta.priceDeltaMinorUnits ?? 0) < 0)}>
							{row.delta.currencyMismatch
								? formatMoney(row.flight.price)
								: formatMoneyDelta(row.delta.priceDeltaMinorUnits ?? 0, row.flight.price.currency)}
							· {formatTimeDelta(row.delta.departureDeltaMinutes)}
						</span>
					{/if}
				</span>
				{#if row.result.warnings.length > 0}
					<p class="row-warning">
						{#each row.result.warnings as warning (warning.code)}
							{warning.message}
						{/each}
					</p>
				{/if}
			</label>
		{/each}
	</div>

	{#if relevantWidenOptions.length > 0}
		<div class="widen-options">
			<p class="widen-options-label">See more alternatives</p>
			{#each relevantWidenOptions as option (widenOptionKey(option))}
				<button
					type="button"
					class={['widen-option', `widen-option-${option.tier}`]}
					disabled={option.requiresKey}
					onclick={() => onWiden?.(option)}
				>
					<span class="widen-option-copy">
						<span class="widen-option-tier">{option.tier === 'calendar' ? 'Cheap' : 'Expensive'}</span>
						{widenOptionCopy(option)}
					</span>
					<span class="widen-option-cost font-mono tabular-nums">
						{#if option.requiresKey}
							needs a key
						{:else}
							~{option.requests} request{option.requests === 1 ? '' : 's'}
						{/if}
					</span>
				</button>
			{/each}
		</div>
	{/if}

	{#if currentWarnings.length > 0}
		<div class="current-warning" role="alert">
			{#each currentWarnings as warning (warning.code)}
				<p>{warning.message}</p>
			{/each}
		</div>
	{/if}
</section>

<style>
	.flight-picker {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	/* The picker's first line, and its quietest: it frames the list rather than competing
	   with the flights in it. */
	.picker-provenance {
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	.picker-list {
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	/* Hairlines between rows, not a border around each: inside a timeline step this list
	   is a timetable, and a bordered card per option was a box inside a box. */
	.picker-row + .picker-row {
		border-top: 1px solid var(--color-border);
	}

	/* 2.75rem keeps every row a full-size touch target now that the type inside it is
	   smaller than it was. */
	.picker-row {
		display: grid;
		grid-template-columns: auto 1fr auto auto;
		align-items: center;
		gap: var(--space-1) var(--space-3);
		padding: var(--space-2);
		min-height: 2.75rem;
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition:
			background-color var(--transition-fast),
			box-shadow var(--transition-fast);
	}

	.picker-row:hover {
		background: var(--color-surface-hover);
	}

	.picker-row:has(input:focus-visible) {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	/* The same inset bar ItineraryTimeline draws on its selected step, so the picked
	   option and the picked step share one mark. */
	.picker-row.is-selected {
		background: var(--color-accent-muted);
		box-shadow: inset 3px 0 0 var(--color-accent);
	}

	.picker-row.has-warning:not(.is-selected) {
		box-shadow: inset 3px 0 0 var(--color-warning);
	}

	.row-schedule {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--font-size-sm);
	}

	.row-arrow {
		width: 1rem;
		height: 1rem;
		color: var(--color-text-faint);
		flex-shrink: 0;
	}

	.row-meta {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}

	.row-carrier {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.row-price {
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		white-space: nowrap;
	}

	.row-delta {
		display: flex;
		justify-content: flex-end;
		min-width: 5rem;
	}

	/* Mono caps at the size TimeCell and MetricRail use for their labels, so "current
	   pick" reads as a stamp on the timetable rather than a chip floating over it. */
	.row-current {
		font-family: var(--font-mono);
		font-size: 0.625rem;
		font-weight: var(--font-weight-semibold);
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		color: var(--color-accent);
		white-space: nowrap;
	}

	.delta-text {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
		color: var(--color-text);
		white-space: nowrap;
	}

	.delta-text.is-cheaper {
		color: var(--color-success);
	}

	.row-warning {
		grid-column: 1 / -1;
		margin-top: var(--space-1);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
		color: var(--color-warning);
	}

	.current-warning {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--color-warning);
		border-radius: var(--radius-md);
		background: var(--color-warning-bg);
		color: var(--color-warning);
		font-size: var(--font-size-xs);
	}

	.widen-options {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding-top: var(--space-1);
	}

	.widen-options-label {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
		color: var(--color-text-faint);
	}

	/* Both tiers share this shape; the colour split below is what keeps a traveller from
	   mistaking a "confirm this date" button (roughly 10x the request cost) for the cheap
	   "check cheaper dates" one next to it. */
	.widen-option {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		min-height: 2.75rem;
		padding: var(--space-2) var(--space-4);
		border-radius: var(--radius-md);
		font-size: var(--font-size-sm);
		text-align: left;
		transition:
			border-color var(--transition-fast),
			background-color var(--transition-fast);
	}

	.widen-option:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}

	.widen-option-calendar {
		border: 1px solid var(--color-border-strong);
		background: var(--color-surface);
		color: var(--color-text);
	}

	.widen-option-calendar:not(:disabled):hover {
		background: var(--color-surface-hover);
	}

	/* The expensive tier: a visibly heavier, warning-tinted treatment so it never reads as
	   the same weight of decision as the calendar tier above it. */
	.widen-option-confirm {
		border: 1px solid var(--color-warning);
		background: var(--color-warning-bg);
		color: var(--color-warning);
		font-weight: var(--font-weight-medium);
	}

	.widen-option-confirm:not(:disabled):hover {
		background: var(--color-warning);
		color: var(--color-accent-text);
	}

	.widen-option-copy {
		min-width: 0;
	}

	.widen-option-tier {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		margin-right: var(--space-2);
	}

	.widen-option-cost {
		flex-shrink: 0;
		white-space: nowrap;
	}

	@media (max-width: 32rem) {
		.picker-row {
			grid-template-columns: 1fr auto;
			grid-template-areas:
				'schedule delta'
				'meta price';
		}

		.row-schedule {
			grid-area: schedule;
		}

		.row-delta {
			grid-area: delta;
		}

		.row-meta {
			grid-area: meta;
			flex-direction: row;
			gap: var(--space-3);
		}

		.row-price {
			grid-area: price;
			text-align: right;
		}
	}
</style>
