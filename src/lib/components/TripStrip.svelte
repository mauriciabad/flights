<script lang="ts">
	/**
	 * The whole trip as one horizontal band: every part of the schedule in order, each
	 * sized to its time on a square-root scale. `trip-strip.ts` owns the arithmetic and
	 * says what a linear bar would have cost (issue #209).
	 *
	 * What a reader gets before reading a number: how many nights (each free-time day is
	 * its own teal cell stamped with its weekday, cut at the stopover's own midnight), how
	 * much of the trip is flying (amber, with the carrier's mark), where the airport waits
	 * are (hatched), and that the ground legs exist at all (the thin solid seams), which
	 * the old three-span strip dropped.
	 *
	 * It is a picture, not a control. The captions carry the two flight times and the
	 * nights as real text, the metric rail under it carries the totals, and the whole
	 * thing is announced to a screen reader as one sentence through `aria-label` on a
	 * `role="img"` wrapper, since a bar read cell by cell is worse than useless. Each
	 * cell's `title` names its part and its duration for a pointer.
	 *
	 * The scale is printed on the strip, "√ scale", because a bar that looks proportional
	 * and is not would be the app asserting something untrue about the one quantity this
	 * product exists to talk about.
	 *
	 * The codes and the bar share one grid whose tracks are the segments' shares, so a
	 * code lands on the place it names. Tracks are `minmax(3px, Nfr)` rather than plain
	 * `Nfr`: a plain `fr` track floors at its content's min-content width, so a stamp wider
	 * than its cell would quietly widen the cell and the picture would stop being to
	 * scale, and the 3px keeps a zero-length part (a wait edited down to nothing) a visible
	 * seam. Stamps inside cells are gated on the cell's own width with container queries,
	 * so a narrow cell shows nothing rather than a clipped word.
	 */
	import type { Itinerary } from '$lib/domain';
	import {
		formatCalendarDate,
		formatClockTime,
		formatDuration,
		formatLongDuration,
		formatWeekday,
		formatWeekdayLong
	} from '$lib/format';
	import { transferModeLabel } from './itinerary-timeline-format';
	import { tripStrip } from './trip-strip';
	import type { TripStripFreeSegment, TripStripSegment, TripStripTransferSegment } from './trip-strip';
	import AirlineLogo from './AirlineLogo.svelte';

	interface Props {
		itinerary: Itinerary;
		/** The stopover city's name once the caller has resolved the airport record
		 * (`getAirport` is async). Falls back to the IATA code, never to a guess. */
		connectionLabel?: string;
		/** The stopover's IATA code, when the caller already has it. Defaults to the one
		 * fact the itinerary always carries: where the outbound flight lands. */
		connectionCode?: string;
		/** Colour-only quieting for an itinerary on an avoided airline. */
		deprioritized?: boolean;
	}

	let { itinerary, connectionLabel, connectionCode, deprioritized = false }: Props = $props();

	const strip = $derived(tripStrip(itinerary));
	const stopoverCode = $derived(connectionCode ?? itinerary.outboundFlight.arrivalAirport);
	const stopoverName = $derived(connectionLabel ?? stopoverCode);
	const nights = $derived(itinerary.nightsInConnection);
	const template = $derived(strip.segments.map((segment) => `minmax(3px, ${segment.share.toFixed(4)}fr)`).join(' '));

	// Grid lines are 1-based. The origin code sits over the wait before the outbound
	// flight, the destination code over the onward flight's end, and the stopover code is
	// centred over everything between the two flights: the place the free days happen.
	const originColumn = $derived(String(strip.outboundIndex));
	const stopoverColumns = $derived(`${strip.outboundIndex + 2} / ${strip.onwardIndex + 1}`);
	const destinationColumn = $derived(String(strip.onwardIndex + 1));

	const scaleNote =
		'Widths follow the square root of each part’s time, so a short transfer stays visible beside a multi-day stopover. A part four times as long is drawn twice as wide. The printed durations are exact.';

	/** A free-time piece as a wall-clock reading: the date it falls on, plus the clock
	 * readings at whichever ends are not midnight. */
	function freeTitle(segment: TripStripFreeSegment): string {
		const day = formatCalendarDate(segment.start);
		if (segment.wholeDay) return `All of ${day} free in ${stopoverName}`;
		const from = segment.startsAtMidnight ? '' : ` from ${formatClockTime(segment.start)}`;
		const until = segment.endsAtMidnight ? ' until midnight' : ` until ${formatClockTime(segment.end)}`;
		return `${day}${from}${until}: ${formatDuration(segment.minutes)} free in ${stopoverName}`;
	}

	function transferWhere(segment: TripStripTransferSegment): string {
		switch (segment.leg) {
			case 'to-origin-airport':
				return `to ${itinerary.originAirport.iataCode}`;
			case 'to-city':
				return `into ${stopoverName}`;
			case 'to-connection-airport':
				return `to ${itinerary.onwardFlight.departureAirport}`;
			case 'to-destination':
				return 'to your destination';
		}
	}

	/** The pointer tooltip for one cell. The waits say what they are: the traveller's
	 * own buffer setting, not a measured queue (AGENTS.md, never an estimate as a fact). */
	function cellTitle(segment: TripStripSegment): string {
		switch (segment.kind) {
			case 'wait':
				return `${formatDuration(segment.minutes)} waiting at ${segment.airport}, your buffer before the flight`;
			case 'flight':
				return `${segment.carrier.name} ${segment.from} to ${segment.to}, ${formatDuration(segment.minutes)}`;
			case 'transfer':
				return `${transferModeLabel(segment.mode)} ${transferWhere(segment)}, ${formatDuration(segment.minutes)}`;
			case 'free':
				return freeTitle(segment);
		}
	}

	function weekdayStamp(segment: TripStripFreeSegment): string {
		return formatWeekday(segment.start);
	}

	const TRANSFER_MODE_PHRASES = { walk: 'on foot', transit: 'by public transport', taxi: 'by taxi', drive: 'by car' } as const;

	/** One spoken clause per free piece: "Monday from 09:40", "all Tuesday", "Thursday
	 * until 13:15". The shape the owner asked for by name: nights, not a duration. */
	function freeClause(segment: TripStripFreeSegment): string {
		const weekday = formatWeekdayLong(segment.start);
		if (segment.wholeDay) return `all ${weekday}`;
		if (segment.startsAtMidnight) return `${weekday} until ${formatClockTime(segment.end)}`;
		if (segment.endsAtMidnight) return `${weekday} from ${formatClockTime(segment.start)}`;
		return `${formatDuration(segment.minutes)} on ${weekday}`;
	}

	// The screen-reader sentence. Consecutive free pieces fold into one clause so a
	// three-night stopover is one breath, not four.
	const summary = $derived.by(() => {
		const clauses: string[] = [];
		let freeRun: string[] = [];
		const flushFree = () => {
			if (freeRun.length === 0) return;
			const nightsNote = nights > 0 ? `, ${nights} ${nights === 1 ? 'night' : 'nights'}` : '';
			clauses.push(`${freeRun.join(', ')} in ${stopoverName}${nightsNote}`);
			freeRun = [];
		};
		for (const segment of strip.segments) {
			if (segment.kind === 'free') {
				freeRun.push(freeClause(segment));
				continue;
			}
			flushFree();
			if (segment.kind === 'wait') clauses.push(`${formatDuration(segment.minutes)} waiting at ${segment.airport}`);
			else if (segment.kind === 'flight') clauses.push(`${segment.from} to ${segment.to}, ${formatDuration(segment.minutes)} in the air`);
			else clauses.push(`${formatDuration(segment.minutes)} ${TRANSFER_MODE_PHRASES[segment.mode]} ${transferWhere(segment)}`);
		}
		flushFree();
		return `${clauses.join(', then ')}. Drawn on a square-root time scale.`;
	});
</script>

<div class={['trip-strip', { 'is-quiet': deprioritized }]} role="img" aria-label={summary}>
	<div class="trip-strip-track" style:grid-template-columns={template}>
		<span class="trip-strip-code trip-strip-code-start font-mono" style:grid-column={originColumn}
			>{itinerary.originAirport.iataCode}</span
		>
		<span class="trip-strip-code trip-strip-code-mid font-mono" style:grid-column={stopoverColumns}>{stopoverCode}</span>
		<span class="trip-strip-code trip-strip-code-end font-mono" style:grid-column={destinationColumn}
			>{itinerary.destinationAirport.iataCode}</span
		>

		{#each strip.segments as segment, index (index)}
			<div class={['trip-strip-cell', `trip-strip-cell-${segment.kind}`]} title={cellTitle(segment)}>
				{#if segment.kind === 'flight'}
					<span class="trip-strip-stamp trip-strip-stamp-logo">
						<AirlineLogo iataCode={segment.carrier.iataCode} name={segment.carrier.name} {deprioritized} />
					</span>
				{:else if segment.kind === 'free'}
					<span class="trip-strip-stamp trip-strip-stamp-day font-mono">{weekdayStamp(segment)}</span>
				{/if}
			</div>
		{/each}
	</div>

	<p class="trip-strip-captions">
		<span class="trip-strip-caption font-mono tabular-nums">{formatDuration(itinerary.outboundFlight.duration)}</span>
		<span class="trip-strip-caption trip-strip-caption-mid">
			{#if nights > 0}
				<strong class="trip-strip-nights font-mono tabular-nums">{nights}</strong>
				{nights === 1 ? 'night' : 'nights'} in {stopoverName}
			{:else}
				<strong class="trip-strip-nights font-mono tabular-nums">{formatLongDuration(itinerary.freeTime.duration)}</strong>
				in {stopoverName}
			{/if}
		</span>
		<span class="trip-strip-caption trip-strip-caption-end font-mono tabular-nums">
			{formatDuration(itinerary.onwardFlight.duration)}
			<span class="trip-strip-scale" title={scaleNote}>√ scale</span>
		</span>
	</p>
</div>

<style>
	.trip-strip {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	/* Codes on row 1, cells on row 2, both on the scaled tracks. */
	.trip-strip-track {
		display: grid;
		grid-template-rows: auto auto;
		align-items: center;
		row-gap: var(--space-1);
		column-gap: 2px;
	}

	/* A code marks a place on the line. Overflow stays visible: the row above the cells
	   is otherwise empty, and a clipped airport code is worse than a slightly wide one. */
	.trip-strip-code {
		grid-row: 1;
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.trip-strip-code-start {
		justify-self: start;
	}

	.trip-strip-code-mid {
		justify-self: center;
		color: var(--color-stopover);
	}

	.trip-strip-code-end {
		justify-self: end;
	}

	.trip-strip-cell {
		grid-row: 2;
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 0;
		height: 1.75rem;
		border-radius: var(--radius-sm);
		overflow: hidden;
		/* Each cell measures itself, so the stamps below can appear only where they fit. */
		container-type: inline-size;
	}

	.trip-strip-cell-flight {
		background: var(--color-accent-muted);
		/* A hairline in the accent itself, so the band still reads as a band in the light
		   palette where `--color-accent-muted` is a very pale cream. */
		box-shadow: inset 0 0 0 1px var(--color-accent);
	}

	/* The free days are the thing this app is selling, so they get the reserved teal and
	   the torn-ticket dashes the timeline's own stopover row already uses. */
	.trip-strip-cell-free {
		background: var(--color-stopover-bg);
		border: 1px dashed var(--color-stopover);
	}

	/* Airport waiting: hatched, the Gantt convention for time spent standing still. The
	   pattern, not the colour, is what tells it from a flight or a ground leg, so the
	   quiet treatment below can grey everything and the kinds still read. */
	.trip-strip-cell-wait {
		background:
			repeating-linear-gradient(135deg, var(--color-border-strong) 0 1px, transparent 1px 5px),
			var(--color-bg-inset);
		box-shadow: inset 0 0 0 1px var(--color-border);
	}

	/* A ground leg: a solid seam between an airport and a city. Usually a few pixels
	   wide, which is honest about a 25-minute bus beside a day. */
	.trip-strip-cell-transfer {
		background: var(--color-border-strong);
	}

	/* Hidden until the cell is wide enough to hold it; a clipped mark or a clipped
	   weekday would be worse than none. A container query measures the content box, and
	   the free cell's 1px dashed border sits outside it: a six-night stopover at 375px
	   draws each day at 35px, which is 33px inside the border, and the first threshold
	   tried (34px) hid every weekday on exactly the route this app is judged on. "Wed"
	   in the mono face is about 23px, so 30px leaves it a little air on each side. */
	.trip-strip-stamp {
		display: none;
		align-items: center;
		white-space: nowrap;
	}

	.trip-strip-stamp-day {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-wide);
		color: var(--color-stopover);
	}

	@container (min-width: 1.75rem) {
		.trip-strip-stamp-logo {
			display: flex;
		}
	}

	@container (min-width: 1.875rem) {
		.trip-strip-stamp-day {
			display: inline;
		}
	}

	/* Outside the scaled grid on purpose: a caption's width must never distort a track.
	   The side columns take their content and the middle one gives way, so a long city
	   name ellipsises rather than wrapping the row. */
	.trip-strip-captions {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr) max-content;
		align-items: baseline;
		gap: var(--space-2);
	}

	.trip-strip-caption {
		font-size: var(--font-size-xs);
		line-height: 1.3;
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.trip-strip-caption-mid {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		text-align: center;
		color: var(--color-stopover);
	}

	.trip-strip-caption-end {
		display: inline-flex;
		align-items: baseline;
		gap: var(--space-2);
	}

	.trip-strip-nights {
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-bold);
	}

	/* The scale, printed as a footnote to the onward duration. Faint on purpose: it is
	   there for the reader who would otherwise measure the bar, and it must not compete
	   with the numbers. */
	.trip-strip-scale {
		padding-left: var(--space-2);
		border-left: 1px solid var(--color-border);
		font-weight: var(--font-weight-regular);
		color: var(--color-text-faint);
		cursor: help;
	}

	/* Avoided airlines: quiet, never hidden, and colour only. The teal is what carries the
	   "this is the good part" meaning, so it is the thing that steps back. The ground-leg
	   seams keep their blue-grey: it carries no meaning to step back from, and the quieter
	   border token disappears against the card. */
	.is-quiet .trip-strip-code-mid,
	.is-quiet .trip-strip-caption-mid,
	.is-quiet .trip-strip-stamp-day {
		color: var(--color-text-deprioritized);
	}

	.is-quiet .trip-strip-cell-flight {
		background: var(--color-bg-inset);
		box-shadow: inset 0 0 0 1px var(--color-border-strong);
	}

	.is-quiet .trip-strip-cell-free {
		background: var(--color-bg-inset);
		border-color: var(--color-border-strong);
	}
</style>
