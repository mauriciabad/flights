<script lang="ts">
	/**
	 * Issue #28's transport picker, per transfer leg: every mode with duration and price,
	 * a transit option's real schedule (the intended departure plus the ones after it), and
	 * the taxi's fare *estimate* kept visibly distinct from a quote (taxi-rate-table.ts).
	 *
	 * The case this whole app exists for: when transit has stopped running for the night,
	 * that is data to show plainly ("no bus until 05:20, four hours after you land"), not an
	 * empty state. The taxi row sits right below it with its own estimate, so the traveller
	 * can see for themselves whether it is worth the saving. `referenceMoment` is
	 * what makes that framing possible: the instant the traveller actually becomes free to
	 * start this leg (a flight's arrival, typically), supplied by whoever assembles the
	 * itinerary (issue #23/#24) since this component has no notion of "the flight before it"
	 * on its own.
	 *
	 * Issue #135 gave every schedule a `plannedFor` moment and this component two jobs it
	 * could not do before. It now says what missing the named departure actually costs —
	 * the next one and how far away, "nothing later at all", or "nothing later arrives in
	 * time" for a leg with a check-in deadline — and, through `transitAnswer`, it
	 * distinguishes a place with no timetable from a lookup that never happened.
	 */
	import type { Duration, Itinerary, LocalDateTime, Transfer, TransferMode } from '../domain';
	import {
		diffTransfers,
		recomputeItinerarySelection,
		type RecomputedSelection
	} from '../algorithm/recompute-selection';
	import { minutesBetween } from '../algorithm/build';
	import { readMissedService } from '../algorithm/transit-schedule';
	import type { MissedService } from '../algorithm/transit-schedule';
	import type { TransitLegAnswer } from '../search/types';
	import type { TaxiFareEstimate } from '../providers/transfers/taxi-rate-table';
	import {
		formatCalendarDate,
		formatClockTime,
		formatDuration,
		formatMoney,
		formatMoneyDelta,
		formatMoneyRange,
		formatTimeDelta,
		isDifferentCalendarDate,
		transferModeLabel,
		unpricedTransferNote
	} from './itinerary-timeline-format';
	import Chip from './Chip.svelte';

	type TransferLegField =
		| 'transferToOriginAirport'
		| 'transferToHotel'
		| 'transferToConnectionAirport'
		| 'transferToDestinationLocation';

	interface Props {
		/** e.g. "Connection airport to hotel". */
		legLabel: string;
		itinerary: Itinerary;
		legField: TransferLegField;
		/** Every mode fetched for this leg. The itinerary's own current transfer is always
		 * shown too, whether or not it appears in this list. */
		alternatives: Transfer[];
		/** OSRM's taxi-rate-table.ts estimate for this leg's `taxi` alternative, kept as its
		 * own type so it can never be mistaken for a confirmed `Transfer.price`. */
		taxiFareEstimate?: TaxiFareEstimate;
		/** The instant the traveller becomes free to start this leg, e.g. the outbound
		 * flight's arrival for a connection-airport-to-hotel leg. Omit for a leg with no such
		 * anchor (an origin-location transfer ahead of any flight event): the schedule still
		 * renders, just without the "X after you land" framing. */
		referenceMoment?: LocalDateTime;
		/** e.g. "you land". Only used when `referenceMoment` is given. */
		referenceLabel?: string;
		/**
		 * Issue #135: what the transit lookup for THIS leg actually said. Rendered only when
		 * no transit row is on offer, which is exactly when a traveller cannot otherwise tell
		 * "there is no bus here" from "nobody looked". Bucharest is the case that made this
		 * necessary: Transitous returned `itineraries: []` and the picker showed Walk 5h 16m,
		 * Drive 59m, Taxi 59m with no hint that a timetable had been asked for and found
		 * empty. Omit it and the picker simply says nothing, same as before.
		 */
		transitAnswer?: TransitLegAnswer;
		minLayoverTime?: Duration;
		onselect: (result: RecomputedSelection) => void;
	}

	let {
		legLabel,
		itinerary,
		legField,
		alternatives,
		taxiFareEstimate,
		referenceMoment,
		referenceLabel = 'the reference time',
		transitAnswer,
		minLayoverTime,
		onselect
	}: Props = $props();

	const uid = $props.id();
	const groupName = `transport-picker-${uid}`;

	// A gap under this is "you'd have waited for it regardless of the flight" rather than a
	// real dead spot in the schedule. The dramatic "no service" framing is reserved for a
	// gap bigger than this, or for a departure the planner found nothing at all after
	// (`readMissedService`'s `last-known`).
	const NORMAL_WAIT_THRESHOLD_MINUTES = 20;

	function getSelectedTransfer(current: Itinerary, field: TransferLegField): Transfer | undefined {
		switch (field) {
			case 'transferToOriginAirport':
				return current.transferToOriginAirport;
			case 'transferToHotel':
				return current.transferToHotel;
			case 'transferToConnectionAirport':
				return current.transferToConnectionAirport;
			case 'transferToDestinationLocation':
				return current.transferToDestinationLocation;
		}
	}

	const selected = $derived(getSelectedTransfer(itinerary, legField));

	const MODE_ORDER: TransferMode[] = ['walk', 'transit', 'drive', 'taxi'];

	function transferKey(transfer: Transfer): string {
		return `${transfer.mode}:${transfer.duration}:${transfer.price?.minorUnits ?? 'none'}:${transfer.legs.length}`;
	}

	interface TransferRow {
		transfer: Transfer;
		isSelected: boolean;
		delta: ReturnType<typeof diffTransfers> | null;
		result: RecomputedSelection;
		gapMinutes?: Duration;
		/** Issue #135: what this row's own schedule says about missing it. Absent for a row
		 * that is not transit, or a transit row with no schedule. */
		missed?: MissedService;
	}

	const taxiRow = $derived(alternatives.find((alternative) => alternative.mode === 'taxi'));

	const rows = $derived.by<TransferRow[]>(() => {
		const byKey = new Map<string, Transfer>();
		if (selected) byKey.set(transferKey(selected), selected);
		for (const alternative of alternatives) byKey.set(transferKey(alternative), alternative);

		const sorted = [...byKey.values()].sort(
			(a, b) => MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode)
		);

		return sorted.map((transfer) => {
			const isSelected = selected !== undefined && transferKey(transfer) === transferKey(selected);
			const result = recomputeItinerarySelection(
				itinerary,
				{ [legField]: transfer },
				minLayoverTime
			);
			const gapMinutes =
				referenceMoment && transfer.transitSchedule
					? minutesBetween(referenceMoment, transfer.transitSchedule.intended)
					: undefined;
			return {
				transfer,
				isSelected,
				delta: selected && !isSelected ? diffTransfers(selected, transfer) : null,
				result,
				gapMinutes,
				missed: transfer.transitSchedule ? readMissedService(transfer.transitSchedule) : undefined
			};
		});
	});

	const currentWarnings = $derived(rows.find((row) => row.isSelected)?.result.warnings ?? []);

	function handleSelect(row: TransferRow) {
		onselect(row.result);
	}

	/**
	 * The honest-gap line, issue #135. Only ever shown when this leg has no transit row at
	 * all — with one on offer the row's own schedule already says everything. Every branch
	 * states what was observed and nothing else: "Transitous answered and had none" is a
	 * different fact from "the request failed" and from "nobody asked", and the traveller
	 * cannot act on the first without being told which one it was.
	 */
	const transitNotice = $derived.by<string | undefined>(() => {
		if (!transitAnswer) return undefined;
		if (rows.some((row) => row.transfer.mode === 'transit')) return undefined;

		const when = transitAnswer.plannedFor
			? ` for ${formatCalendarDate(transitAnswer.plannedFor.time)} at ${formatClockTime(transitAnswer.plannedFor.time)}`
			: '';

		switch (transitAnswer.answer) {
			case 'nothing-found':
				return `No public transport data for this area. The timetable was asked${when} and had no service between these two points.`;
			case 'failed': {
				// AGENTS.md: the provider's own words and status code, verbatim, never a
				// classification standing in for them. `'status' in ...` is how no-results.ts
				// reads the same union, since only some `ProviderError` cases carry one.
				const error = transitAnswer.error;
				const httpStatus = error && 'status' in error ? error.status : undefined;
				return `Public transport could not be checked${when}: ${httpStatus ? `${httpStatus}: ` : ''}${error?.message ?? 'the lookup failed'}`;
			}
			case 'not-asked':
				return transitAnswer.reason === 'budget-spent'
					? `Public transport was not checked for this option: this search had already used its timetable lookups.`
					: `Public transport was not checked: no timetable provider is available.`;
			case 'answered':
				// Answered with a route, yet no transit row reached this picker. Nothing
				// honest to say beyond that, and staying silent would be the same "we do not
				// know why" this notice exists to stop.
				return `A public transport route was found${when}, but it is not among the options here.`;
		}
	});

	function isNoServiceGap(row: TransferRow): boolean {
		if (row.gapMinutes !== undefined && row.gapMinutes > NORMAL_WAIT_THRESHOLD_MINUTES) return true;
		// The planner found nothing at all after this departure. An `arriveBy` leg is
		// deliberately not treated this way: "nothing later arrives in time" is the answer to
		// a question about a deadline, not a dead spot in the timetable, and the row says so
		// in its own words below.
		return row.missed?.outcome === 'last-known';
	}
</script>

<section class="transport-picker">
	<h3 class="picker-title">{legLabel}</h3>
	<div role="radiogroup" aria-label={legLabel} class="picker-list">
		{#each rows as row (transferKey(row.transfer))}
			{@const isTaxiEstimate = row.transfer.mode === 'taxi' && taxiFareEstimate}
			<label
				class={[
					'picker-row',
					{ 'is-selected': row.isSelected, 'has-warning': row.result.warnings.length > 0 }
				]}
			>
				<input
					type="radio"
					name={groupName}
					class="visually-hidden"
					checked={row.isSelected}
					onchange={() => handleSelect(row)}
				/>
				<span class="row-mode">
					<span class="row-mode-label">{transferModeLabel(row.transfer.mode)}</span>
					<span class="row-duration font-mono tabular-nums">{formatDuration(row.transfer.duration)}</span>
				</span>
				<span class="row-price font-mono tabular-nums">
					{#if isTaxiEstimate && taxiFareEstimate}
						{formatMoneyRange(taxiFareEstimate.lowMinorUnits, taxiFareEstimate.highMinorUnits, taxiFareEstimate.currency)}
						<span class="estimate-tag">estimate</span>
					{:else if row.transfer.price}
						{formatMoney(row.transfer.price)}
					{:else}
						<!-- Issue #119: a walk says "No fare", which is a fact about walking, not
						     a gap in what a provider told us. See unpricedTransferNote. -->
						<span class="price-unknown">{unpricedTransferNote(row.transfer.mode)}</span>
					{/if}
				</span>
				<span class="row-delta">
					{#if row.isSelected}
						<Chip variant="accent" label="Current pick" />
					{:else if row.delta}
						<span class="delta-text">
							{#if isTaxiEstimate}
								estimate only
							{:else if row.delta.hasPriceComparison && !row.delta.currencyMismatch}
								{formatMoneyDelta(row.delta.priceDeltaMinorUnits ?? 0, row.transfer.price!.currency)} ·
							{/if}
							{formatTimeDelta(row.delta.durationDeltaMinutes)}
						</span>
					{/if}
				</span>

				{#if row.transfer.legs.length > 1}
					<ul class="row-breakdown">
						{#each row.transfer.legs as legStep, index (index)}
							<li>{legStep.description ?? transferModeLabel(legStep.mode)} ({formatDuration(legStep.duration)})</li>
						{/each}
					</ul>
				{/if}

				{#if row.transfer.mode === 'transit' && row.transfer.transitSchedule}
					{@const schedule = row.transfer.transitSchedule}
					<div class={['row-schedule', { 'is-gap': isNoServiceGap(row) }]}>
						{#if isNoServiceGap(row)}
							<p class="schedule-gap-headline">
								No {transferModeLabel(row.transfer.mode).toLowerCase()} until {formatClockTime(schedule.intended)}{#if row.gapMinutes !== undefined && row.gapMinutes > 0}, that is {formatDuration(row.gapMinutes)} after {referenceLabel}{/if}.
							</p>
							{#if taxiRow && taxiFareEstimate}
								<p class="schedule-gap-alternative">
									A taxi now takes about {formatDuration(taxiRow.duration)} and costs roughly
									{formatMoneyRange(taxiFareEstimate.lowMinorUnits, taxiFareEstimate.highMinorUnits, taxiFareEstimate.currency)}.
								</p>
							{/if}
						{:else}
							<p class="schedule-line">
								Departs {formatClockTime(schedule.intended)}{#if row.gapMinutes !== undefined && row.gapMinutes > 0} ({formatDuration(row.gapMinutes)} after {referenceLabel}){/if}
							</p>
						{/if}
						{#if row.missed?.outcome === 'last-in-time'}
							<p class="schedule-line schedule-missed">
								The last one that gets you there by {formatClockTime(schedule.plannedFor.time)}. Miss it and
								nothing later arrives in time.
							</p>
						{:else if row.missed?.outcome === 'last-known'}
							<p class="schedule-line schedule-missed">Nothing runs after it for the rest of the timetable.</p>
						{:else if row.missed?.outcome === 'long-gap' && row.missed.next && row.missed.gap !== undefined}
							<p class="schedule-line schedule-missed">
								Miss it and the next one is {formatClockTime(row.missed.next)}, {formatDuration(row.missed.gap)}
								later.
							</p>
						{/if}
						{#if schedule.earlier && schedule.earlier.length > 0}
							<p class="schedule-line schedule-following">
								Earlier and still in time: {schedule.earlier.map((departure) => formatClockTime(departure)).join(', ')}
							</p>
						{/if}
						{#if schedule.following.length > 0}
							<p class="schedule-line schedule-following">
								Next: {schedule.following
									.map(
										(departure) =>
											formatClockTime(departure) +
											(isDifferentCalendarDate(schedule.intended, departure) ? ' (next day)' : '')
									)
									.join(', ')}
							</p>
						{/if}
						<p class="schedule-planned">
							Planned for {formatCalendarDate(schedule.plannedFor.time)},
							{schedule.plannedFor.arriveBy ? 'arriving by' : 'leaving after'}
							{formatClockTime(schedule.plannedFor.time)}
						</p>
					</div>
				{/if}

				{#if isTaxiEstimate && taxiFareEstimate}
					<!-- The <label> above (this row) re-fires a click on its own <input> for any
					     bubbled click whose target is not itself a form control, and <summary> gets
					     no such exemption. Stopping propagation here is what keeps opening the
					     citation from also silently selecting this row, same reasoning as Chip.svelte's
					     own remove-button handler. -->
					<details class="taxi-citation">
						<summary onclick={(event) => event.stopPropagation()}>
							{taxiFareEstimate.rateSource === 'fallback' ? 'Approximate rate (no country-specific data)' : 'Where this estimate comes from'}
						</summary>
						<p>{taxiFareEstimate.citation}</p>
					</details>
				{/if}

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

	{#if transitNotice}
		<p class="transit-notice" data-testid="transit-notice" data-transit-answer={transitAnswer?.answer}>
			{transitNotice}
		</p>
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
	.transport-picker {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.picker-title {
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		color: var(--color-text-muted);
	}

	.picker-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.picker-row {
		display: grid;
		grid-template-columns: 1fr auto auto;
		align-items: center;
		gap: var(--space-1) var(--space-4);
		padding: var(--space-3) var(--space-4);
		min-height: 3.5rem;
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-md);
		background: var(--color-surface);
		cursor: pointer;
		transition:
			border-color var(--transition-fast),
			background-color var(--transition-fast);
	}

	.picker-row:hover {
		background: var(--color-surface-hover);
	}

	.picker-row:has(input:focus-visible) {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	.picker-row.is-selected {
		border-color: var(--color-accent);
		background: var(--color-accent-muted);
	}

	.picker-row.has-warning:not(.is-selected) {
		border-color: var(--color-warning);
	}

	.row-mode {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.row-mode-label {
		font-weight: var(--font-weight-medium);
	}

	.row-duration {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.row-price {
		font-size: var(--font-size-base);
		font-weight: var(--font-weight-semibold);
		white-space: nowrap;
		text-align: right;
	}

	.estimate-tag {
		display: block;
		font-family: var(--font-sans);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-regular);
		color: var(--color-text-faint);
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
	}

	.price-unknown {
		font-family: var(--font-sans);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-regular);
		color: var(--color-text-faint);
	}

	.row-delta {
		display: flex;
		justify-content: flex-end;
		min-width: 6rem;
	}

	.delta-text {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.row-breakdown {
		grid-column: 1 / -1;
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-3);
		margin-top: var(--space-1);
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}

	.row-breakdown li {
		white-space: nowrap;
	}

	.row-schedule {
		grid-column: 1 / -1;
		margin-top: var(--space-2);
		padding-top: var(--space-2);
		border-top: 1px dashed var(--color-border);
	}

	.row-schedule.is-gap {
		border-top-color: var(--color-warning);
	}

	.schedule-line {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.schedule-gap-headline {
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		color: var(--color-warning);
	}

	.schedule-gap-alternative {
		margin-top: var(--space-1);
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.schedule-following {
		margin-top: var(--space-1);
		font-family: var(--font-mono);
	}

	/* The answer to "what if I miss it" reads at the same weight as the departure itself:
	   for a night arrival or a check-in deadline it is the more consequential of the two. */
	.schedule-missed {
		margin-top: var(--space-1);
		font-weight: var(--font-weight-medium);
		color: var(--color-text);
	}

	/* Deliberately the quietest line on the row. It is the receipt for the schedule above —
	   which journey moment it was planned for — not something to read on every glance. */
	.schedule-planned {
		margin-top: var(--space-2);
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	.transit-notice {
		padding: var(--space-2) var(--space-3);
		border-left: 2px solid var(--color-border-strong);
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.taxi-citation {
		grid-column: 1 / -1;
		margin-top: var(--space-1);
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	.taxi-citation summary {
		cursor: pointer;
		color: var(--color-accent);
	}

	.taxi-citation p {
		margin-top: var(--space-1);
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
		padding: var(--space-3) var(--space-4);
		border: 1px solid var(--color-warning);
		border-radius: var(--radius-md);
		background: var(--color-warning-bg);
		color: var(--color-warning);
		font-size: var(--font-size-sm);
	}

	@media (max-width: 32rem) {
		.picker-row {
			grid-template-columns: 1fr auto;
		}

		.row-delta {
			grid-column: 1 / -1;
			justify-content: flex-start;
		}
	}
</style>
