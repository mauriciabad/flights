<script lang="ts">
	/**
	 * One clock reading on a timetable: the wall-clock time at that airport, with its
	 * calendar date and UTC offset shown only when they are not already established by the
	 * cell this one sits beside.
	 *
	 * ## Why conditional, when the old version printed all three every time
	 *
	 * The rule that produced the old behaviour is right and stays: AGENTS.md is explicit
	 * that a 00:30 arrival must never render as the previous day, and the timeline's own
	 * comment reasoned that always printing the date makes that failure impossible to
	 * reintroduce. What it also produced was three stacked lines per reading and four
	 * readings per itinerary, on rows that repeat the same date up to a dozen times. That
	 * is most of why the expanded panel was, in the owner's words, "absurdly large".
	 *
	 * The guarantee survives because suppression requires being handed `reference`, the
	 * neighbouring reading that is already on screen, and finding it provably identical. A
	 * date is hidden only when that same date is visible a few millimetres to the left. Any
	 * difference at all, including the one that matters, prints the new date AND stamps the
	 * day shift beside the clock. The old rule is now enforced by a comparison instead of by
	 * repetition, and `ItineraryTimeline.test.ts` pins the overnight case down.
	 *
	 * The IANA zone name stays on `title` in every case, so the full answer is one hover or
	 * one accessibility-tree read away even when the offset line is suppressed.
	 */
	import type { LocalDateTime } from '$lib/domain';
	import {
		calendarDayOffset,
		formatCalendarDate,
		formatClockTime,
		formatUtcOffset,
		isDifferentCalendarDate
	} from '$lib/format';

	interface Props {
		value: LocalDateTime;
		/** The reading already printed next to this one. Sharing its calendar date drops
		 * this cell's date line; sharing its UTC offset drops the offset line; a different
		 * date prints both the new date and a `+1` stamp beside the clock. Omit it and the
		 * cell prints everything, which is what the first reading in any row needs. */
		reference?: LocalDateTime;
		/** A caption above the clock, e.g. "Free from". */
		caption?: string;
		/** Which edge the three lines hang off. `end` for a right-aligned clock column,
		 * where a left-aligned date under a right-aligned time reads as a mistake. */
		align?: 'start' | 'end';
	}

	let { value, reference, caption, align = 'start' }: Props = $props();

	const showDate = $derived(reference === undefined || isDifferentCalendarDate(reference, value));
	const dayShift = $derived(reference === undefined ? 0 : calendarDayOffset(reference, value));
	const showOffset = $derived(reference === undefined || reference.utcOffsetMinutes !== value.utcOffsetMinutes);
</script>

<span class={['time-cell', `time-cell-${align}`]} title={value.timeZone}>
	{#if caption}<span class="time-cell-caption">{caption}</span>{/if}
	<span class="time-cell-line">
		<span class="tl-time-clock font-mono tabular-nums">{formatClockTime(value)}</span>
		{#if dayShift !== 0}
			<!-- The class name is unchanged from the badge this replaces: it is what
			     ItineraryTimeline.test.ts asserts on for "this flight lands the next day",
			     and the assertion is still exactly the right one to keep. -->
			<span class="tl-note-plusday font-mono tabular-nums"
				>{dayShift > 0 ? '+' : ''}{dayShift}<span class="visually-hidden">
					{dayShift === 1 ? 'day later' : dayShift === -1 ? 'day earlier' : 'days'}</span
				></span
			>
		{/if}
	</span>
	{#if showDate || showOffset}
		<span class="time-cell-meta">
			{#if showDate}<span class="tl-time-date">{formatCalendarDate(value)}</span>{/if}
			{#if showOffset}<span class="tl-time-offset font-mono">{formatUtcOffset(value.utcOffsetMinutes)}</span
				>{/if}
		</span>
	{/if}
</span>

<style>
	.time-cell {
		display: flex;
		flex-direction: column;
		min-width: 0;
		line-height: 1.2;
	}

	.time-cell-end {
		align-items: flex-end;
		text-align: right;
	}

	.time-cell-end .time-cell-line,
	.time-cell-end .time-cell-meta {
		justify-content: flex-end;
	}

	.time-cell-caption {
		font-size: 0.625rem;
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-faint);
	}

	.time-cell-line {
		display: flex;
		align-items: baseline;
		gap: var(--space-1);
	}

	.tl-time-clock {
		font-size: var(--font-size-base);
		font-weight: var(--font-weight-semibold);
		color: var(--color-text);
	}

	.time-cell-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0 var(--space-2);
	}

	.tl-time-date,
	.tl-time-offset {
		font-size: 0.6875rem;
		color: var(--color-text-muted);
	}

	.tl-time-offset {
		color: var(--color-text-faint);
	}

	/* A day change is the one thing on a timetable that silently costs a traveller a
	   night, so it is stamped rather than merely written. */
	.tl-note-plusday {
		padding: 0 var(--space-1);
		border-radius: var(--radius-sm);
		background: var(--color-warning-bg);
		color: var(--color-warning);
		font-size: 0.625rem;
		font-weight: var(--font-weight-bold);
	}
</style>
