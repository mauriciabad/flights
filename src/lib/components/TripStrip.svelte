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
	 * The captions carry the two flight times and the nights as real text, the metric rail
	 * under it carries the totals, and the whole thing is announced to a screen reader as
	 * one sentence through `aria-label`, since a bar read cell by cell is worse than
	 * useless.
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
	 *
	 * ## Issue #227: it stopped being only a picture
	 *
	 * A row of transparent buttons now sits over the cells on the same grid row, one per
	 * flight, wait and ground leg, and one spanning the whole run of free-time cells. Each
	 * opens `SegmentStub`, which says what that part is, when it runs and what it costs.
	 *
	 * They are siblings of the cells rather than the cells themselves, so a cell keeps its
	 * entire visual and a button carries only the hit area, the ring and the semantics. The
	 * hit area is 44px tall against a 28px cell and never narrower than 24px, centred on
	 * the cell it stands for; the cell's own width never changes, because the strip's one
	 * contract is that width is time. A 3px transfer seam therefore has a target smaller
	 * than the 44x44 guideline, which this design accepts rather than hides: widening the
	 * cell would lie about the schedule, and a mis-tap opens a neighbour whose panel names
	 * itself in its first line, so the correction costs one more tap.
	 *
	 * The strip is a `role="group"` rather than a `role="img"` now that it contains
	 * controls, keeping the same one-sentence label. One tab stop per strip, with roving
	 * `tabindex` and arrow keys inside it: without that, a page of twenty cards would be
	 * two hundred tab stops.
	 *
	 * Hover is not the only input, and this app is read on a phone. Hover opens after
	 * 100ms so the strip does not flicker as a pointer crosses it and closes after a 150ms
	 * grace; focus opens with no delay and blur closes; a tap opens and pins, and a second
	 * tap on the same target closes. Escape and a click outside come free from
	 * `popover="auto"`, as does closing card one's panel when card two's opens.
	 */
	import type { Airport, Itinerary } from '$lib/domain';
	import { formatClockTime, formatDuration, formatLongDuration, formatWeekday, formatWeekdayLong } from '$lib/format';
	import { segmentStub, stripTargets } from './segment-stub';
	import { tripStrip } from './trip-strip';
	import type { TripStripFreeSegment, TripStripTransferSegment } from './trip-strip';
	import AirlineLogo from './AirlineLogo.svelte';
	import SegmentStub from './SegmentStub.svelte';

	interface Props {
		itinerary: Itinerary;
		/** The stopover city's name once the caller has resolved the airport record
		 * (`getAirport` is async). Falls back to the IATA code, never to a guess. */
		connectionLabel?: string;
		/** The stopover's IATA code, when the caller already has it. Defaults to the one
		 * fact the itinerary always carries: where the outbound flight lands. */
		connectionCode?: string;
		/** The whole stopover airport record, when the page has resolved it. Its name is
		 * what lets the wait panel say "London Gatwick" instead of "LGW", and its
		 * coordinates are what put a distance on the bed (issue #219). */
		connectionAirport?: Airport;
		/** Colour-only quieting for an itinerary on an avoided airline. */
		deprioritized?: boolean;
	}

	let { itinerary, connectionLabel, connectionCode, connectionAirport, deprioritized = false }: Props = $props();

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

	function weekdayStamp(segment: TripStripFreeSegment): string {
		return formatWeekday(segment.start);
	}

	const TRANSFER_MODE_PHRASES = { walk: 'on foot', transit: 'by public transport', taxi: 'by taxi', drive: 'by car' } as const;

	/** One spoken clause per free piece: "Monday from 9:40am", "all Tuesday", "Thursday
	 * until 1:15pm". The shape the owner asked for by name: nights, not a duration. */
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

	const targets = $derived(stripTargets(strip.segments));
	const stubContext = $derived({
		itinerary,
		connectionLabel: stopoverName,
		connectionCode: stopoverCode,
		connectionAirport,
		deprioritized
	});
	const stubs = $derived(targets.map((target) => segmentStub(strip.segments, target, stubContext)));

	const panelId = $props.id();

	/** How the panel that is up got there. A hover must not close a panel a tap pinned,
	 * and a blur must not close one a hover is still over, so the opening gesture is state
	 * rather than three booleans that can disagree. */
	type OpenedBy = 'hover' | 'focus' | 'tap';

	/** Long enough that a pointer crossing the strip does not flash four panels. */
	const OPEN_DELAY = 100;
	/** The gap between a cell and its panel is real, so leaving one has to forgive the
	 * moment before entering the other. */
	const CLOSE_GRACE = 150;

	let activeIndex = $state<number | null>(null);
	/** What the panel holds while it fades out, so an exit is not a blank rectangle. */
	let shownIndex = $state(0);
	let openedBy = $state<OpenedBy | null>(null);
	let focusIndex = $state(0);
	let hits = $state<(HTMLButtonElement | undefined)[]>([]);

	let openTimer: ReturnType<typeof setTimeout> | undefined;
	let closeTimer: ReturnType<typeof setTimeout> | undefined;
	// The browser light-dismisses an auto popover on pointerup, before our own click
	// handler runs. A pointer that went down on a hit target is a toggle, and the click
	// handler is what decides whether it opens or closes; treating that pointerup as a
	// dismissal would close and immediately reopen, which reads as a flash.
	let gestureOnHit = false;
	let pointerSnapshot: { index: number | null; by: OpenedBy | null } | null = null;

	const lastTarget = $derived(Math.max(0, targets.length - 1));
	const panelIndex = $derived(Math.min(activeIndex ?? shownIndex, lastTarget));
	// Clamped rather than read raw: an itinerary that loses a segment (a nights change
	// rebuilds the strip) would otherwise leave the one `tabindex="0"` past the end, and
	// the whole strip would drop out of the tab order.
	const rovingIndex = $derived(Math.min(focusIndex, lastTarget));
	const anchor = $derived(activeIndex === null ? undefined : hits[activeIndex]);

	function stopTimers() {
		clearTimeout(openTimer);
		clearTimeout(closeTimer);
		openTimer = undefined;
		closeTimer = undefined;
	}

	function open(index: number, by: OpenedBy) {
		stopTimers();
		activeIndex = index;
		shownIndex = index;
		openedBy = by;
	}

	function close() {
		stopTimers();
		activeIndex = null;
		openedBy = null;
	}

	function onHitEnter(index: number, event: PointerEvent) {
		// A touch fires pointerenter too, right before the click that pins the panel.
		// Letting it also open by hover would make the click read as a second tap.
		if (event.pointerType !== 'mouse') return;
		clearTimeout(closeTimer);
		if (openedBy === 'tap') return;
		if (activeIndex !== null) {
			open(index, 'hover');
			return;
		}
		clearTimeout(openTimer);
		openTimer = setTimeout(() => open(index, 'hover'), OPEN_DELAY);
	}

	function onHitLeave(event: PointerEvent) {
		if (event.pointerType !== 'mouse') return;
		clearTimeout(openTimer);
		startGrace();
	}

	function startGrace() {
		if (openedBy !== 'hover') return;
		clearTimeout(closeTimer);
		closeTimer = setTimeout(() => {
			if (openedBy === 'hover') close();
		}, CLOSE_GRACE);
	}

	function onHitPointerDown() {
		gestureOnHit = true;
		pointerSnapshot = { index: activeIndex, by: openedBy };
	}

	/** A pointer that went down on a hit and never produced a click, a drag off the strip,
	 * must not leave the dismissal suppressed. The click, when there is one, is dispatched
	 * in the same task as the pointerup, so a zero-delay timeout lands after it. */
	function onHitPointerUp() {
		setTimeout(() => {
			gestureOnHit = false;
		}, 0);
	}

	function onHitActivate(index: number, event: MouseEvent) {
		// `detail === 0` is Enter or Space on the focused button, which has no pointerdown
		// before it and so no snapshot; the live state is the right thing to compare.
		const before = event.detail === 0 ? { index: activeIndex, by: openedBy } : (pointerSnapshot ?? { index: activeIndex, by: openedBy });
		pointerSnapshot = null;
		gestureOnHit = false;
		if (before.index === index && before.by === 'tap') {
			close();
			return;
		}
		open(index, 'tap');
	}

	function onHitFocus(index: number) {
		focusIndex = index;
		if (openedBy === 'tap') return;
		open(index, 'focus');
	}

	function onHitBlur() {
		if (openedBy === 'focus') close();
	}

	function onHitKeydown(event: KeyboardEvent, index: number) {
		const last = targets.length - 1;
		let next: number;
		if (event.key === 'ArrowRight') next = Math.min(index + 1, last);
		else if (event.key === 'ArrowLeft') next = Math.max(index - 1, 0);
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = last;
		else return;
		event.preventDefault();
		focusIndex = next;
		hits[next]?.focus();
	}

	function onDismiss() {
		if (gestureOnHit) return;
		close();
	}

	// A panel in the top layer does not travel with the card it describes, so a scroll or a
	// resize closes it rather than leaving it pointing at nothing. Both listeners are
	// attached only while one is up. `close` runs from an event rather than from inside
	// this effect, so it cannot retrigger it (AGENTS.md, the `$effect` trap).
	$effect(() => {
		if (activeIndex === null) return;
		const dismiss = () => close();
		window.addEventListener('scroll', dismiss, { capture: true, passive: true });
		window.addEventListener('resize', dismiss, { passive: true });
		return () => {
			window.removeEventListener('scroll', dismiss, true);
			window.removeEventListener('resize', dismiss);
		};
	});

	$effect(() => () => stopTimers());
</script>

<div class={['trip-strip', { 'is-quiet': deprioritized }]} role="group" aria-label={summary}>
	<div class="trip-strip-track" style:grid-template-columns={template}>
		<span class="trip-strip-code trip-strip-code-start font-mono" style:grid-column={originColumn}
			>{itinerary.originAirport.iataCode}</span
		>
		<span class="trip-strip-code trip-strip-code-mid font-mono" style:grid-column={stopoverColumns}>{stopoverCode}</span>
		<span class="trip-strip-code trip-strip-code-end font-mono" style:grid-column={destinationColumn}
			>{itinerary.destinationAirport.iataCode}</span
		>

		{#each strip.segments as segment, index (index)}
			<div class={['trip-strip-cell', `trip-strip-cell-${segment.kind}`]} aria-hidden="true">
				{#if segment.kind === 'flight'}
					<span class="trip-strip-stamp trip-strip-stamp-logo">
						<AirlineLogo iataCode={segment.carrier.iataCode} name={segment.carrier.name} {deprioritized} />
					</span>
				{:else if segment.kind === 'free'}
					<span class="trip-strip-stamp trip-strip-stamp-day font-mono">{weekdayStamp(segment)}</span>
				{/if}
			</div>
		{/each}

		{#each targets as target, index (index)}
			<button
				bind:this={hits[index]}
				type="button"
				class={['trip-strip-hit', `trip-strip-hit-${target.kind}`, { 'is-active': activeIndex === index }]}
				style:grid-column={`${target.from + 1} / ${target.to + 2}`}
				tabindex={index === rovingIndex ? 0 : -1}
				aria-label={stubs[index]?.label}
				aria-expanded={activeIndex === index}
				aria-describedby={activeIndex === index ? panelId : undefined}
				onpointerenter={(event) => onHitEnter(index, event)}
				onpointerleave={onHitLeave}
				onpointerdown={onHitPointerDown}
				onpointerup={onHitPointerUp}
				onpointercancel={onHitPointerUp}
				onclick={(event) => onHitActivate(index, event)}
				onfocus={() => onHitFocus(index)}
				onblur={onHitBlur}
				onkeydown={(event) => onHitKeydown(event, index)}
			></button>
		{/each}
	</div>

	{#if stubs[panelIndex]}
		<SegmentStub
			stub={stubs[panelIndex]}
			id={panelId}
			{anchor}
			open={activeIndex !== null}
			{itinerary}
			connectionLabel={stopoverName}
			{deprioritized}
			{onDismiss}
			onPointerEnter={() => clearTimeout(closeTimer)}
			onPointerLeave={startGrace}
		/>
	{/if}

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

	/* The hit target for one part of the trip. Transparent and on the cells' own row, so
	   the picture is untouched and this carries only the tap area, the ring and the name. */
	.trip-strip-hit {
		grid-row: 2;
		position: relative;
		min-width: 0;
		/* The cell's own height, so the ring lands on the cell and the button has a box at
		   all: an empty grid item would otherwise collapse to nothing and only its extended
		   pseudo-element would be hittable. */
		height: 1.75rem;
		padding: 0;
		border: 0;
		border-radius: var(--radius-sm);
		background: none;
		cursor: pointer;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
	}

	/* 44px tall out of a 28px cell, never narrower than 24px, centred on the cell it
	   stands for. The cell keeps its true width: widening it would lie about time, which
	   is the one thing this strip exists to tell the truth about. */
	.trip-strip-hit::before {
		content: '';
		position: absolute;
		top: -8px;
		bottom: -8px;
		left: 50%;
		width: max(100%, 24px);
		translate: -50% 0;
	}

	/* A 3px seam beside a 35px day: the thin one wins the overlap, or it could never be
	   hit at all. */
	.trip-strip-hit-transport,
	.trip-strip-hit-wait {
		z-index: 1;
	}

	/* One ring for hover, focus and tap, so there is one thing to learn. Accent gold on
	   every card including an avoided-airline one: it is an interaction colour, not a
	   content colour. Nothing else on the strip changes, because dimming the neighbours
	   would remove the comparison the strip exists for. */
	.trip-strip-hit.is-active,
	.trip-strip-hit:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 1px;
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
