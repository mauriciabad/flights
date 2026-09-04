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
	 */
	import type { Duration, Itinerary, LocalDateTime, Transfer, TransferMode } from '../domain';
	import {
		diffTransfers,
		recomputeItinerarySelection,
		type RecomputedSelection
	} from '../algorithm/recompute-selection';
	import { minutesBetween } from '../algorithm/build';
	import type { TaxiFareEstimate } from '../providers/transfers/taxi-rate-table';
	import {
		formatClockTime,
		formatDuration,
		formatMoney,
		formatMoneyDelta,
		formatMoneyRange,
		formatTimeDelta,
		isDifferentCalendarDate,
		transferModeLabel
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
		minLayoverTime,
		onselect
	}: Props = $props();

	const uid = $props.id();
	const groupName = `transport-picker-${uid}`;

	// A gap under this is "you'd have waited for it regardless of the flight" rather than a
	// real dead spot in the schedule. The dramatic "no service" framing is reserved for a
	// gap bigger than this, or for the intended departure being the last one of the day
	// (`following.length === 0`).
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
		isLastForToday: boolean;
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
				isLastForToday: transfer.transitSchedule?.following.length === 0
			};
		});
	});

	const currentWarnings = $derived(rows.find((row) => row.isSelected)?.result.warnings ?? []);

	function handleSelect(row: TransferRow) {
		onselect(row.result);
	}

	function isNoServiceGap(row: TransferRow): boolean {
		return row.isLastForToday || (row.gapMinutes !== undefined && row.gapMinutes > NORMAL_WAIT_THRESHOLD_MINUTES);
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
						<span class="price-unknown">Price not available</span>
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
