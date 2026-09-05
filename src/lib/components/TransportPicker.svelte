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
	 *
	 * These rows render inside the timeline step they belong to, which is why the list
	 * carries no heading and no card chrome of its own: the step already names the leg,
	 * and a bordered card inside a bordered row was the box-in-a-box look this replaces.
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
	import { MAX_TRANSIT_LOOKUPS_PER_SEARCH } from '../search/transit-schedule';
	import Button from './Button.svelte';
	import ModeIcon from './ModeIcon.svelte';
	import {
		formatCalendarDate,
		formatClockTime,
		formatDuration,
		formatKilometres,
		formatMoney,
		formatMoneyDelta,
		formatMoneyRange,
		formatTimeDelta,
		isDifferentCalendarDate,
		summariseTransferLegs,
		transferModeLabel,
		transferFareNote
	} from './itinerary-timeline-format';

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
		/**
		 * Issue #267: run a timetable lookup for this leg, when there is one worth running
		 * and the traveller asks for it. Given only while asking would tell them something
		 * they do not already know, so the button appears exactly when the notice above it
		 * says the timetable belongs to a different bed. Omit it and the notice stands
		 * alone, which is what it did before this existed.
		 */
		oncheckTransit?: () => void;
		/** A lookup started by `oncheckTransit` is in flight. */
		transitChecking?: boolean;
		minLayoverTime?: Duration;
		onselect: (result: RecomputedSelection) => void;
	}

	let {
		legLabel,
		itinerary,
		legField,
		alternatives,
		referenceMoment,
		referenceLabel = 'the reference time',
		transitAnswer,
		oncheckTransit,
		transitChecking = false,
		minLayoverTime,
		onselect
	}: Props = $props();

	/** The cost, named before the button is pressed rather than after. Two `/plan`
	 * requests, one per direction, out of `MAX_TRANSIT_LOOKUPS_PER_SEARCH` for the whole
	 * search. The owner should never be surprised by a request he did not know he was
	 * authorising, and Transitous is run by volunteers. */
	const TRANSIT_CHECK_REQUESTS = 2;

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
				// Issue #267: three different reasons nobody asked, and a traveller can act
				// on only one of them. Naming the property one is what stops a road-only
				// answer reading as "a taxi is how you get there".
				if (transitAnswer.reason === 'other-property') {
					return `Road journey only. Public transport was not looked up for this property: the timetable belongs to the bed the search picked.`;
				}
				return transitAnswer.reason === 'budget-spent'
					? `Public transport was not checked for this option: this search had already used its timetable lookups.`
					: `Public transport was not checked: no timetable provider is available.`;
			case 'answered': {
				// Issue #220. There is one known reason a route can be answered and still not
				// reach this picker, and when it is the reason, the row says so with the
				// numbers it was judged on rather than leaving the traveller to guess. The
				// alternative wording, "no service between these two points", would be a
				// different claim and a false one: Transitous answered.
				const withheld = transitAnswer.withheld;
				if (withheld) {
					const route =
						withheld.count === 1
							? 'The only route that came back took'
							: `The quickest of the ${withheld.count} routes that came back took`;
					return `Public transport was checked${when}. ${route} ${formatDuration(withheld.quickest)} to cover ${formatKilometres(withheld.straightLineKm)} in a straight line, so it is not offered as a transfer.`;
				}
				// Answered with a route, yet no transit row reached this picker, and not for
				// that reason. Nothing honest to say beyond that, and staying silent would be
				// the same "we do not know why" this notice exists to stop.
				return `A public transport route was found${when}, but it is not among the options here.`;
			}
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
	<div role="radiogroup" aria-label={legLabel} class="picker-list">
		{#each rows as row (transferKey(row.transfer))}
			<!-- Issue #249: the rate-card range rides on the transfer that was routed, so a
			     taxi swapped in from this very list carries its own estimate rather than
			     depending on a prop about the leg. -->
			{@const taxiFare = row.transfer.fareEstimate}
			{@const summary = summariseTransferLegs(row.transfer.legs)}
			<!-- Issue #249: five answers, one function. A walk says "No fare", which is a fact
			     about walking rather than a gap in what a provider told us (#119); a rate-card
			     range says roughly what the meter will read; a ride past that card's range says
			     so and leaves the reason to the disclosure below, which the price column is far
			     too narrow for (#246). -->
			{@const fare = transferFareNote(row.transfer)}
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
					<span class="row-mode-label">
						<!-- Issue #119: "the transport picker is text only for Walk, Public transport,
						     Drive and Taxi". The pictogram is what a traveller reads first; the word
						     stays because a picture of a bus does not say "public transport" to
						     everyone, and a screen reader gets the word alone (`ModeIcon` is always
						     aria-hidden). -->
						<ModeIcon kind={row.transfer.mode} />
						{transferModeLabel(row.transfer.mode)}
					</span>
					<span class="row-duration">
						<span class="font-mono tabular-nums">{formatDuration(row.transfer.duration)}</span>
						{#if summary}<span class="row-summary">&middot; {summary}</span>{/if}
					</span>
				</span>
				<span class="row-price font-mono tabular-nums">
					{#if fare.unknown}
						<span class="price-unknown">{fare.text}</span>
					{:else}
						{fare.text}{#if fare.estimated}<span class="estimate-tag">estimate</span>{/if}
					{/if}
				</span>
				<span class="row-delta">
					{#if row.isSelected}
						<span class="row-current">Current pick</span>
					{:else if row.delta}
						<span class="delta-text">
							{#if taxiFare?.kind === 'estimate'}
								estimate only
							{:else if row.delta.hasPriceComparison && !row.delta.currencyMismatch}
								{formatMoneyDelta(row.delta.priceDeltaMinorUnits ?? 0, row.transfer.price!.currency)} ·
							{/if}
							{formatTimeDelta(row.delta.durationDeltaMinutes)}
						</span>
					{/if}
				</span>

				{#if row.transfer.legs.length > 1}
					<!-- Issue #220. The leg list used to print unconditionally, as one wrapped
					     line of comma-joined sentences, and a nine-leg journey made the row
					     unreadable. It is the same information, in order, one step per line,
					     behind a disclosure: the summary above answers "what is this", this
					     answers "how exactly", and only somebody who has chosen this option
					     needs the second answer.

					     The click handler is the same one `.taxi-citation` below needs and for
					     the same reason: this <summary> sits inside the row's <label>, which
					     re-fires a click on its own radio for any bubbled click that is not
					     itself a form control. Without it, opening the steps would also pick
					     the row. -->
					<details class="row-steps">
						<summary onclick={(event) => event.stopPropagation()}>
							{row.transfer.legs.length} steps
						</summary>
						<ol class="step-list">
							{#each row.transfer.legs as legStep, index (index)}
								<li class={['step', { 'is-walk': legStep.mode === 'walk' }]}>
									<span class="step-time font-mono tabular-nums">
										{legStep.departure ? formatClockTime(legStep.departure) : ''}
									</span>
									<span class="step-what">
										<ModeIcon kind={legStep.mode} class="step-icon" />
										{legStep.description ?? transferModeLabel(legStep.mode)}</span
									>
									<span class="step-duration font-mono tabular-nums">{formatDuration(legStep.duration)}</span>
								</li>
							{/each}
						</ol>
					</details>
				{/if}

				{#if row.transfer.mode === 'transit' && row.transfer.transitSchedule}
					{@const schedule = row.transfer.transitSchedule}
					<div class={['row-schedule', { 'is-gap': isNoServiceGap(row) }]}>
						{#if isNoServiceGap(row)}
							<p class="schedule-gap-headline">
								No {transferModeLabel(row.transfer.mode).toLowerCase()} until {formatClockTime(schedule.intended)}{#if row.gapMinutes !== undefined && row.gapMinutes > 0}, that is {formatDuration(row.gapMinutes)} after {referenceLabel}{/if}.
							</p>
							{#if taxiRow?.fareEstimate?.kind === 'estimate'}
								{@const taxiFareEstimate = taxiRow.fareEstimate}
								<p class="schedule-gap-alternative">
									A taxi now takes about {formatDuration(taxiRow.duration)} and costs roughly
									{formatMoneyRange(taxiFareEstimate.lowMinorUnits, taxiFareEstimate.highMinorUnits, taxiFareEstimate.currency)}.
								</p>
							{:else if taxiRow?.fareEstimate?.kind === 'out-of-range'}
								{@const taxiFareEstimate = taxiRow.fareEstimate}
								<!-- Issue #246: the duration is measured and stays. The fare is the half
								     nothing here knows, and "roughly £268-£431" was the app inventing it. -->
								<p class="schedule-gap-alternative">
									A taxi now takes about {formatDuration(taxiRow.duration)} over
									{formatKilometres(taxiFareEstimate.distanceKm)}. No rate card here reaches that far, so
									the fare is unknown.
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

				{#if taxiFare}
					<!-- The <label> above (this row) re-fires a click on its own <input> for any
					     bubbled click whose target is not itself a form control, and <summary> gets
					     no such exemption. Stopping propagation here is what keeps opening the
					     citation from also silently selecting this row, same reasoning as Chip.svelte's
					     own remove-button handler. -->
					<details class="taxi-citation">
						<summary onclick={(event) => event.stopPropagation()}>
							{#if taxiFare.kind === 'out-of-range'}
								Why there is no fare estimate
							{:else if taxiFare.rateSource === 'fallback'}
								Approximate rate (no country-specific data)
							{:else}
								Where this estimate comes from
							{/if}
						</summary>
						<!-- Issue #246: the card that would have answered is still named, because
						     "nothing here can price this" is worth more with the reason attached. -->
						{#if taxiFare.kind === 'out-of-range'}
							<p>
								{formatKilometres(taxiFare.distanceKm)} is past the city rate card these estimates come from,
								which covers rides up to {formatKilometres(taxiFare.ratedUpToKm)}. Stretched that far it put
								this transfer above the price of the flight it connects to, so it is not stretched.
							</p>
						{/if}
						<p>{taxiFare.citation}</p>
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
		<!-- Issue #267: the one case where the traveller can do something about the notice
		     above. Pressing it is what authorises the requests, and the count is on the row
		     before the press rather than reported afterwards. -->
		{#if oncheckTransit}
			<div class="transit-check">
				<Button variant="secondary" size="sm" loading={transitChecking} onclick={oncheckTransit}>
					Check public transport
				</Button>
				<span class="transit-check-cost"
					>{TRANSIT_CHECK_REQUESTS} timetable lookups, of the {MAX_TRANSIT_LOOKUPS_PER_SEARCH} this
					search may spend</span
				>
			</div>
		{/if}
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
		grid-template-columns: 1fr auto auto;
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

	.row-mode {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.row-mode-label {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-medium);
	}

	/* The pictogram carries the row's mode, so it takes the row's accent when the row is
	   the current pick and the label's own colour otherwise. Nothing quieter: at 15px an
	   icon at --color-text-faint is a smudge. */
	.picker-row.is-selected .row-mode-label {
		color: var(--color-accent);
	}

	.step-what :global(.step-icon) {
		margin-right: var(--space-1);
		color: var(--color-text-muted);
	}

	.row-duration {
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
		text-wrap: pretty;
	}

	/* Deliberately the same colour as the duration it sits beside, not quieter. It is real
	   content, and --color-text-faint is 4.2:1 on --color-surface in the dark theme, which
	   is under AA for text this size. The middot is enough separation. */
	.row-summary {
		color: inherit;
	}

	.row-price {
		font-size: var(--font-size-sm);
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
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.row-steps {
		grid-column: 1 / -1;
		margin-top: var(--space-1);
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}

	.row-steps summary {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		/* A 44px target on a line of 10px type, without the line itself growing: the padding
		   is negative-margined back out so the row keeps the height it had. */
		padding: var(--space-2) var(--space-2) var(--space-2) 0;
		margin: calc(var(--space-2) * -1) 0;
		cursor: pointer;
		color: var(--color-accent);
		list-style: none;
	}

	.row-steps summary::-webkit-details-marker {
		display: none;
	}

	/* The disclosure's own mark, drawn rather than borrowed from the browser so it matches
	   the chevron the timeline row already turns. */
	.row-steps summary::before {
		content: '';
		width: 0.4rem;
		height: 0.4rem;
		border-right: 1.5px solid currentColor;
		border-bottom: 1.5px solid currentColor;
		transform: rotate(-45deg) translate(-1px, -1px);
		transition: transform var(--transition-fast);
	}

	.row-steps[open] summary::before {
		transform: rotate(45deg) translate(-1px, -1px);
	}

	@media (prefers-reduced-motion: reduce) {
		.row-steps summary::before {
			transition: none;
		}
	}

	/* A timetable, not a paragraph: departure, what you board, how long it takes, one line
	   each and every column aligned down the list. */
	.step-list {
		display: grid;
		grid-template-columns: auto 1fr auto;
		gap: 0 var(--space-3);
		margin-top: var(--space-2);
		list-style: none;
	}

	.step {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
		align-items: baseline;
		padding: 0.15rem 0;
	}

	/* The walks between rides are the connective tissue, not the journey. Kept (a 679 m
	   walk between two stations is a real thing to know about) and set back, in the token
	   that exists for exactly this and is contrast-checked for it, rather than in
	   --color-text-faint, which is under AA on this surface in the dark theme. */
	.step.is-walk .step-what,
	.step.is-walk .step-duration,
	.step-time {
		color: var(--color-text-deprioritized);
	}

	.step-what {
		min-width: 0;
		overflow-wrap: break-word;
	}

	.step-duration {
		text-align: right;
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
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}

	/* Sits under the notice it answers, sharing its left rule so the two read as one
	   block: here is what is missing, and here is what asking for it costs. Wraps rather
	   than truncating, because the cost is the half that must survive a narrow screen. */
	.transit-check {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		padding: 0 var(--space-3) var(--space-2);
		border-left: 2px solid var(--color-border-strong);
	}

	.transit-check-cost {
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
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
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--color-warning);
		border-radius: var(--radius-md);
		background: var(--color-warning-bg);
		color: var(--color-warning);
		font-size: var(--font-size-xs);
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
