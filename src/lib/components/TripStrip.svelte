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
	 * The captions carry the two flight times and the nights as real text, on the same grid
	 * tracks as the blocks they name (issue #315: they were a three-item flex under a
	 * seven-block strip, so each flight's duration printed under the airport wait beside it,
	 * on every card). The metric rail under the strip carries the totals, and the whole
	 * thing is announced to a screen reader as one sentence through `aria-label`, since a
	 * bar read cell by cell is worse than useless. That sentence is also where the scale is
	 * now stated: issue #310 took the printed "√ scale" footnote off at the owner's request,
	 * and the scale itself is unchanged.
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
	 * hit area is 44px tall against a 28px cell and exactly as wide as the track.
	 *
	 * Issue #316 is why "exactly as wide" rather than "never narrower than 24px". That
	 * earlier version gave a 15px transfer a 24px hit area, which reads as compliant and is
	 * not: measured on production at 375px, adjacent blocks were 2px apart, so two 24px
	 * areas centred 17px apart overlapped and a z-index decided who won the tap. The block
	 * a traveller worries about most was the hardest one on the card to hit, wedged between
	 * two targets three times its width. So the floor moved into the track itself: every
	 * non-free segment is at least 24px drawn, which is the only version where the thing
	 * you can hit and the thing you can see are the same object. The free day cells keep
	 * the 3px floor, because their target is one button spanning the whole run.
	 *
	 * `share` is untouched by that floor. Every track above it is still proportional to the
	 * square root of its time.
	 *
	 * The strip is a `role="group"` rather than a `role="img"` now that it contains
	 * controls, keeping the same one-sentence label. One tab stop per strip, with roving
	 * `tabindex` and arrow keys inside it: without that, a page of twenty cards would be
	 * two hundred tab stops.
	 *
	 * Hover opens after 100ms so the strip does not flicker as a pointer crosses it and
	 * closes after a 150ms grace; keyboard focus opens with no delay and blur closes.
	 * Escape and a click outside come free from `popover="auto"`, as does closing card
	 * one's panel when card two's opens.
	 *
	 * ## Issue #278: it became a selector, and the preview became the expander
	 *
	 * Activating a cell hands its segment to the customise rail (a column beside the
	 * results list on a wide screen, a sheet at the foot of a phone), which is where every
	 * picker moved to. That rail's header prints this stub's own eyebrow, title, clocks
	 * and duration from the same `segment-stub.ts` model, so a tap shows strictly more
	 * than the pinned panel it replaced; what it no longer does is leave a popover over
	 * the strip, which on a phone would sit on top of the sheet the tap just opened.
	 *
	 * Selection deliberately does NOT follow focus. Arrow keys walk the strip previewing
	 * each segment, and Enter or Space is what moves the rail. W3C's APG names the reason:
	 * selection following focus is "devastating" when displaying a new panel is not
	 * instantaneous, and this panel mounts a stay list, a flight radiogroup or a transport
	 * radiogroup.
	 *
	 * The stopover caption is now the control that unfolds the full timeline, because the
	 * thing being unfolded is this preview and "1 night in Vienna" is the honest name for
	 * the trip it opens. It costs the card no row: the control it replaced was a 54px band
	 * under a dashed rule.
	 */
	import type { Airport, Itinerary } from '$lib/domain';
	import { transferRideDuration } from '$lib/domain';
	import { formatClockTime, formatDuration, formatLongDuration, formatWeekday, formatWeekdayLong } from '$lib/format';
	import type { ItinerarySegmentId } from '$lib/itinerary-map/segment-id';
	import { segmentStub, stripTargets } from './segment-stub';
	import { segmentIdOf, tripStrip } from './trip-strip';
	import type { TripStripFreeSegment, TripStripTransferSegment } from './trip-strip';
	import AirlineLogo from './AirlineLogo.svelte';
	import Icon from './Icon.svelte';
	import ModeIcon from './ModeIcon.svelte';
	import { transferIconKind } from './mode-icon';
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
		/**
		 * Issue #278: which stretch of the trip the customise rail is showing, in the
		 * vocabulary `ItineraryMap` and `ItineraryTimeline` already share. Read only. The
		 * strip never owns the selection, because the rail shows one segment of one card
		 * and the page is the only thing that can know which.
		 */
		selectedSegmentId?: ItinerarySegmentId | null;
		/** Activating a segment. Absent on a strip with nowhere to put a selection, which
		 * makes the cells hover-and-focus previews and nothing more. */
		onSelectSegment?: (segment: ItinerarySegmentId) => void;
		/** Whether the full timeline is unfolded under this strip. */
		expanded?: boolean;
		onToggleExpanded?: () => void;
		/** `id` of the element the caption button unfolds, for `aria-controls`. */
		controlsId?: string;
	}

	let {
		itinerary,
		connectionLabel,
		connectionCode,
		connectionAirport,
		deprioritized = false,
		selectedSegmentId = null,
		onSelectSegment,
		expanded = false,
		onToggleExpanded,
		controlsId
	}: Props = $props();

	const strip = $derived(tripStrip(itinerary));
	const stopoverCode = $derived(connectionCode ?? itinerary.outboundFlight.arrivalAirport);
	const stopoverName = $derived(connectionLabel ?? stopoverCode);
	const nights = $derived(itinerary.nightsInConnection);
	/**
	 * Issue #316: how narrow a track is allowed to get.
	 *
	 * Every non-free segment is a tap target in its own right, and WCAG 2.2 SC 2.5.8 wants
	 * 24 CSS pixels with 24px between the centres of neighbours. Measured on production at
	 * 375px, a ground transfer drew at 15px with a 2px gap to each side, so a 24px circle
	 * centred on it overlapped both neighbours: the Spacing exception could not rescue it,
	 * and the block a traveller worries about most was the hardest one on the card to hit.
	 * Padding cannot fix that. Two 24px hit areas centred 17px apart still collide, whatever
	 * they are made of, so the drawn width is what has to change.
	 *
	 * The free days keep the 3px floor. Their target is one button spanning the whole run
	 * (`stripTargets`), so an individual day cell is never a target of its own, and holding
	 * each of six of them at 24px would take the picture away from the part of the trip this
	 * app exists to sell.
	 *
	 * This is a floor, not a rescaling: `share` is untouched, every track above the floor is
	 * still proportional to the square root of its time, and the strip's own screen-reader
	 * sentence still says so.
	 */
	const template = $derived(
		strip.segments
			.map((segment) => `minmax(${segment.kind === 'free' ? '3px' : '24px'}, ${segment.share.toFixed(4)}fr)`)
			.join(' ')
	);

	// Grid lines are 1-based. The origin code sits over the wait before the outbound
	// flight, the destination code over the onward flight's end, and the stopover code is
	// centred over everything between the two flights: the place the free days happen.
	const originColumn = $derived(String(strip.outboundIndex));
	const stopoverColumns = $derived(`${strip.outboundIndex + 2} / ${strip.onwardIndex + 1}`);
	const destinationColumn = $derived(String(strip.onwardIndex + 1));
	// Issue #315: the two flight captions ride their own flights' tracks. Same 1-based grid
	// lines the cells are placed on, read from the same `strip`, so a caption cannot end up
	// over a block it is not about.
	const outboundFlightColumn = $derived(String(strip.outboundIndex + 1));
	const onwardFlightColumn = $derived(String(strip.onwardIndex + 1));

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
			else {
				// Issue #290: a leg that starts at a runway spends its first minutes getting out
				// of the terminal, and folding those into "by taxi" is what this sentence used to
				// do. Two clauses, so the ride is the ride and the spoken journey still covers
				// every minute the bar beside it covers.
				const walkOut = segment.transfer.landingBuffer;
				if (walkOut) clauses.push(`${formatDuration(walkOut)} getting out of the airport`);
				clauses.push(
					`${formatDuration(transferRideDuration(segment.transfer))} ${TRANSFER_MODE_PHRASES[segment.mode]} ${transferWhere(segment)}`
				);
			}
		}
		flushFree();
		return `${clauses.join(', then ')}. Drawn on a square-root time scale.`;
	});

	const targets = $derived(stripTargets(strip.segments));
	// Each target's stretch of the trip, in the shared vocabulary. A stopover target
	// covers a run of day cells and they all answer `free-time`, which is the same row the
	// timeline selects and the same key the stay picker has always been filed under.
	const targetSegments = $derived(targets.map((target) => segmentIdOf(strip, target.from)));
	const stubContext = $derived({
		itinerary,
		connectionLabel: stopoverName,
		connectionCode: stopoverCode,
		connectionAirport,
		deprioritized
	});
	const stubs = $derived(targets.map((target) => segmentStub(strip.segments, target, stubContext)));

	const panelId = $props.id();

	/** How the panel that is up got there. A blur must not close one a hover is still
	 * over, so the opening gesture is state rather than two booleans that can disagree.
	 *
	 * Issue #278 removed the third value, `tap`. A tap now selects the segment, and the
	 * customise rail it opens carries this panel's own facts in its header, built from the
	 * same `segment-stub.ts` model. So the stub is the hover and keyboard preview and
	 * nothing pins it, which also means there is no pinned panel left to suppress the
	 * light-dismiss for. */
	type OpenedBy = 'hover' | 'focus';

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
	/** True for the length of one pointer gesture on a hit target. Plain bookkeeping: the
	 * focus handler reads it, nothing renders from it. Cleared in a macrotask, which lands
	 * after the focus and the click the same press dispatches. */
	let focusFromPointer = false;

	function onHitPointerDown() {
		focusFromPointer = true;
		setTimeout(() => {
			focusFromPointer = false;
		}, 0);
	}

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

	/**
	 * Issue #278. Activating a segment hands it to the customise rail, and closes the
	 * hover preview: on a phone the rail is a sheet at the foot of the screen and a
	 * popover left up over the strip would sit on top of it. The rail's header prints
	 * this segment's eyebrow, title, both clock readings and its duration from the same
	 * `segment-stub.ts` model the panel uses, so nothing a tap used to show is lost.
	 *
	 * A second activation of the same segment clears the selection, which is how a
	 * traveller closes the rail from the strip rather than hunting for the close button.
	 */
	function onHitActivate(index: number) {
		const segment = targetSegments[index];
		if (segment) onSelectSegment?.(segment);
		close();
	}

	/**
	 * A click focuses the button it lands on, and on a touch screen that focus is the only
	 * thing that fires before the click. Opening the preview on every focus would put a
	 * popover over the sheet the same tap opens, so a focus that arrives mid-gesture opens
	 * nothing and the keyboard's own focus still does.
	 *
	 * Deliberately a flag rather than `matches(':focus-visible')`. That pseudo-class is a
	 * browser heuristic about the last input a person used, and it does not apply to a
	 * programmatic `element.focus()` with no keyboard interaction before it, which is
	 * exactly what a test driver does. The behaviour under test would then depend on how
	 * the test reached the button.
	 */
	function onHitFocus(index: number) {
		focusIndex = index;
		if (focusFromPointer) return;
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
	<!-- Issue #318: `toolbar`, because this is a roving-tabindex composite and without a role
	     on the container nothing tells a screen-reader user that six of the seven steps are
	     reached with the arrow keys rather than with Tab. The arrow keys already work; this
	     is the attribute that says so. `toolbar` rather than `tablist`, because these are
	     controls that act on the trip, not tabs selecting one panel of several. -->
	<div
		class="trip-strip-track"
		role="toolbar"
		aria-label="Steps of this trip, use the arrow keys"
		aria-orientation="horizontal"
		style:grid-template-columns={template}
	>
		<span class="trip-strip-code trip-strip-code-start font-mono" style:grid-column={originColumn}
			>{itinerary.originAirport.iataCode}</span
		>
		<span class="trip-strip-code trip-strip-code-mid font-mono" style:grid-column={stopoverColumns}>{stopoverCode}</span>
		<span class="trip-strip-code trip-strip-code-end font-mono" style:grid-column={destinationColumn}
			>{itinerary.destinationAirport.iataCode}</span
		>

		{#each strip.segments as segment, index (index)}
			<!-- The column is explicit because the hit buttons below are explicitly placed on this
			     same row. CSS grid positions definite items first, so auto-placed cells found row 2
			     already full and spilled into implicit zero-width columns: every segment rendered at
			     0-2px with its colour intact, which reads as an invisible strip rather than a
			     misplaced one. -->
			<div
				class={['trip-strip-cell', `trip-strip-cell-${segment.kind}`]}
				style:grid-column={index + 1}
				aria-hidden="true"
			>
				{#if segment.kind === 'flight'}
					<span class="trip-strip-stamp trip-strip-stamp-logo">
						<AirlineLogo iataCode={segment.carrier.iataCode} name={segment.carrier.name} {deprioritized} />
					</span>
				{:else if segment.kind === 'transfer'}
					<!-- Issue #322: the flight cell says who is flying you, so the ground cell says
					     what is carrying you, in the same slot under the same rule. How specific
					     the icon is allowed to be is `mode-icon.ts`'s decision, not this file's. -->
					<span class="trip-strip-stamp trip-strip-stamp-mode">
						<ModeIcon kind={transferIconKind(segment.transfer)} />
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
				class={[
					'trip-strip-hit',
					`trip-strip-hit-${target.kind}`,
					{ 'is-active': activeIndex === index, 'is-selected': targetSegments[index] === selectedSegmentId }
				]}
				style:grid-column={`${target.from + 1} / ${target.to + 2}`}
				tabindex={index === rovingIndex ? 0 : -1}
				aria-label={stubs[index]?.label}
				aria-pressed={targetSegments[index] === selectedSegmentId}
				aria-describedby={activeIndex === index ? panelId : undefined}
				onpointerenter={(event) => onHitEnter(index, event)}
				onpointerleave={onHitLeave}
				onpointerdown={onHitPointerDown}
				onclick={() => onHitActivate(index)}
				onfocus={() => onHitFocus(index)}
				onblur={onHitBlur}
				onkeydown={(event) => onHitKeydown(event, index)}
			></button>
		{/each}

		<!-- Issue #315: the captions sit on this grid, in their own segments' columns, and
		     that is the whole fix. They used to be a three-item `space-between` flex laid
		     under a seven-block strip, so the leftmost caption landed under the wrong block
		     every time: measured at 1280px, a flight's "2h 55m" spanned x 381-424 while the
		     flight it named ran 448-526 and the airport wait it was sitting over ran 381-446.
		     Three cards, three identical misses, on the one picture on the card. Sharing the
		     cells' own tracks makes that unrepresentable rather than merely corrected, since
		     there is no second copy of the geometry left to drift. -->
		<span
			class="trip-strip-caption trip-strip-caption-leg font-mono tabular-nums"
			style:grid-column={outboundFlightColumn}>{formatDuration(itinerary.outboundFlight.duration)}</span
		>

		<!-- Issue #278: the preview is what unfolds, so the control lives on the preview and
		     on its loudest line. The nights ARE the trip this app is selling, so "1 night in
		     Vienna" is both the caption a reader wants and the honest label for "show me
		     this trip in full". It costs the card no row of its own, which is the point: the
		     control it replaced was a 54px band with a dashed rule above it.

		     The visible words come first in the accessible name and the rest is appended
		     out of sight, which is what WCAG 2.5.3 asks for; an `aria-label` starting with
		     "Show the full timeline" would have put the spoken name and the printed one in
		     different orders. -->
		{#if onToggleExpanded}
			<button
				type="button"
				class="trip-strip-caption trip-strip-caption-mid trip-strip-unfold"
				style:grid-column={stopoverColumns}
				aria-expanded={expanded}
				aria-controls={controlsId}
				onclick={() => onToggleExpanded?.()}
			>
				<span class="trip-strip-unfold-text">
					{#if nights > 0}
						<strong class="trip-strip-nights font-mono tabular-nums">{nights}</strong>
						{nights === 1 ? 'night' : 'nights'} in {stopoverName}{:else}<strong
							class="trip-strip-nights font-mono tabular-nums"
							>{formatLongDuration(itinerary.freeTime.duration)}</strong
						>
						in {stopoverName}{/if}<!--
					Issue #318: no whitespace between the name and the comma. The indentation
					between two elements is a text node, and it put a space in front of the
					comma in the accessible name: "8h 22m in Napoli , show the full timeline".
					--><span class="visually-hidden">, {expanded ? 'hide' : 'show'} the full timeline</span>
				</span>
				<Icon name="chevron-down" class={['trip-strip-chevron', { 'is-open': expanded }]} />
			</button>
		{:else}
			<span class="trip-strip-caption trip-strip-caption-mid" style:grid-column={stopoverColumns}>
				{#if nights > 0}
					<strong class="trip-strip-nights font-mono tabular-nums">{nights}</strong>
					{nights === 1 ? 'night' : 'nights'} in {stopoverName}
				{:else}
					<strong class="trip-strip-nights font-mono tabular-nums">{formatLongDuration(itinerary.freeTime.duration)}</strong>
					in {stopoverName}
				{/if}
			</span>
		{/if}

		<!-- Issue #310 took the "√ scale" footnote off the caption that used to carry it. The
		     fact it printed is true and still holds: widths follow the square root of each
		     part's time, so a 40-minute hop stays visible beside a 14-hour flight. What
		     changed is that the owner does not want it on screen. It is still in the strip's
		     own screen-reader sentence, which ends "Drawn on a square-root time scale." -->
		<span
			class="trip-strip-caption trip-strip-caption-leg font-mono tabular-nums"
			style:grid-column={onwardFlightColumn}>{formatDuration(itinerary.onwardFlight.duration)}</span
		>
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
</div>

<style>
	.trip-strip {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	/* Codes on row 1, cells on row 2, captions on row 3, all three on the scaled tracks.
	   Issue #315 moved the captions in here: a caption's only job is to name a block, and
	   the one arrangement in which it cannot name the wrong one is the one where it shares
	   that block's own grid column. */
	.trip-strip-track {
		display: grid;
		grid-template-rows: auto auto auto;
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

	/* 44px tall out of a 28px cell, centred on the cell it stands for.
	   Issue #316 took the `width: max(100%, 24px)` off this. It gave a 15px transfer a 24px
	   hit area, which reads as compliant and is not: two of those centred 17px apart still
	   overlap, so the neighbour's z-index decided who won the tap. The width is now the
	   track's, and the track has a 24px floor (see `template`), which is the only version of
	   this where the thing you can hit and the thing you can see are the same object. */
	.trip-strip-hit::before {
		content: '';
		position: absolute;
		inset: -8px 0;
	}

	/* A 3px seam beside a 35px day: the thin one wins the overlap, or it could never be
	   hit at all. */
	.trip-strip-hit-transport,
	.trip-strip-hit-wait {
		z-index: 1;
	}

	/* One ring for hover and focus, so there is one thing to learn. Accent gold on every
	   card including an avoided-airline one: it is an interaction colour, not a content
	   colour. Nothing else on the strip changes, because dimming the neighbours would
	   remove the comparison the strip exists for. */
	.trip-strip-hit.is-active,
	.trip-strip-hit:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 1px;
	}

	/* Selected is a ring INSIDE the cell, where the transient ones sit outside it. That is
	   deliberate: focus and selection are different facts, a keyboard user has both at
	   once while arrowing along a selected strip, and a design that drew them the same way
	   would leave that reader unable to tell which segment the rail is showing. Drawn with
	   `box-shadow` rather than `outline` so both can be on one element at one time. */
	.trip-strip-hit.is-selected {
		box-shadow: inset 0 0 0 2px var(--color-accent);
		border-radius: var(--radius-sm);
	}

	/* The unfold control: the stopover caption, with a chevron. Styled from the caption it
	   replaces so the row reads as text with an affordance rather than as a button bar. */
	.trip-strip-unfold {
		position: relative;
		display: inline-flex;
		align-items: baseline;
		justify-content: center;
		gap: var(--space-1);
		min-width: 0;
		padding-inline: 0;
		border: 0;
		background: none;
		font: inherit;
		cursor: pointer;
		transition: color var(--transition-fast);
	}

	/* Issue #316: the control's own box is 24px tall, not a 19px box with a taller
	   pseudo-element over it. An audit reads `getBoundingClientRect()`, and so does anyone
	   checking this against SC 2.5.8; a target whose measured height is 19px is a finding
	   whatever is painted around it. Padding grows the box and a matching negative margin
	   gives the height back to the layout, so the strip is exactly as tall as it was.

	   The `::before` still extends the area downward into the card's own gap, which is free
	   room below the last row of the strip. It stops short of the cells' 44px hit areas
	   above rather than overlapping them. */
	.trip-strip-unfold {
		padding-block: 0.3rem;
		margin-block: -0.3rem;
	}

	.trip-strip-unfold::before {
		content: '';
		position: absolute;
		top: -0.2rem;
		right: -0.25rem;
		bottom: -0.5rem;
		left: -0.25rem;
	}

	.trip-strip-unfold:hover {
		color: var(--color-accent);
	}

	.trip-strip-unfold:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 3px;
		border-radius: var(--radius-sm);
	}

	.trip-strip-unfold-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* The one mark on this row that says "this does something". The words stay teal because
	   teal is what the stopover is, and the chevron takes the accent because accent is what
	   is interactive everywhere else in this app. Without it the control reads as a caption:
	   a phone has no hover to discover it with, and colour alone would be the only signal. */
	/* `:global` throughout for the icons: the `<svg>` is `Icon.svelte`'s element, not one
	   this component's scoping class lands on. */
	.trip-strip-unfold :global(.trip-strip-chevron) {
		width: 0.85rem;
		height: 0.85rem;
		align-self: center;
		color: var(--color-accent);
		transition:
			transform var(--transition-fast),
			color var(--transition-fast);
	}

	.trip-strip-unfold:hover :global(.trip-strip-chevron) {
		color: var(--color-accent-hover);
	}

	.trip-strip-unfold :global(.trip-strip-chevron.is-open) {
		transform: rotate(180deg);
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

	/* The mode icon (issue #322) is the ground cell's answer to the airline logo, so it
	   appears under the same rule and hides for the same reason: a clipped mark is worse
	   than none. Its own threshold rather than the logo's, because the two marks are
	   different widths and the threshold is only ever about clipping — the logo is 20px in
	   a 28px cell, this is 15px, and 20px leaves it the same air on each side. That matters
	   here: a ground leg is drawn on the square root of its minutes, so on a two-night
	   stopover its cell is 10 to 22px depending on the width of the screen, and a threshold
	   copied from the logo would hide the icon on every one of them. Measured at BCN to TLL:
	   22.5px and 15.2px at 1280, 14.5px and 9.8px at 375, so the longer leg carries its icon
	   on a desktop and the strip stays a plain seam where there is genuinely no room. */
	@container (min-width: 1.25rem) {
		.trip-strip-stamp-mode {
			display: flex;
		}
	}

	/* Knocked out of the band rather than drawn on it. The transfer cell is a solid
	   `--color-border-strong` seam, which in both palettes is the mid tone furthest from
	   the page, so the page's own background is what has contrast against it. */
	.trip-strip-stamp-mode {
		color: var(--color-bg);
	}

	@container (min-width: 1.875rem) {
		.trip-strip-stamp-day {
			display: inline;
		}
	}

	.trip-strip-caption {
		grid-row: 3;
		font-size: var(--font-size-xs);
		line-height: 1.3;
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	/* A flight's duration, centred on that flight's own track. Overflow stays visible, the
	   same choice the codes on row 1 make and for the same reason: a track is sized by time,
	   so a caption that could widen one would put the picture out. `min-width: 0` is what
	   stops a grid item's automatic minimum size doing exactly that. */
	.trip-strip-caption-leg {
		justify-self: center;
		min-width: 0;
	}

	/* The stopover caption spans everything between the two flights, which is the stretch it
	   is about, and gives way rather than pushing: a long city name ellipsises. */
	.trip-strip-caption-mid {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		text-align: center;
		color: var(--color-stopover);
	}

	.trip-strip-nights {
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-bold);
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

	/* The hover colour is an interaction colour, so it stays accent gold even here; what
	   steps back is the resting state, which the rule above already handles. */
	.is-quiet .trip-strip-unfold:hover {
		color: var(--color-accent);
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
