<script lang="ts">
	/**
	 * Issue #24: the itinerary timeline. Renders exactly the schedule from
	 * docs/prompts/001-initial-brief.md lines 44-53: origin location, transfer to origin
	 * airport, waiting time, outbound flight, transfer to hotel, free time, transfer to
	 * connection airport, waiting time, onward flight, transfer to destination location.
	 *
	 * ## Shape: a timetable, not a stack of cards
	 *
	 * The owner's verdict on the previous version was "a terrible layout and poorely
	 * displayed, it is pathetic", and the specific complaint was size. Every row was a
	 * stack of paragraphs: a label, a detail line, then for a flight two time badges each
	 * printing a clock, a full calendar date and a UTC offset on three lines of their own.
	 * Eleven rows of that is most of a phone screen per itinerary.
	 *
	 * So each row is now four grid columns, the same four for every row, exactly like a
	 * printed departure board: WHEN, the rail, WHAT, and HOW MUCH. A reader scans one
	 * column at a time instead of re-parsing a paragraph per step. Three specific things
	 * shrank it:
	 *
	 * - `TimeCell` prints a date only when it differs from the reading before it, and a UTC
	 *   offset only when the trip actually crossed into a different one. The reference is
	 *   the previous reading in schedule order, not the one in the same row, so a whole
	 *   itinerary that happens on one day prints that day once. On the fixture below that
	 *   took ten date and offset lines down to four. See `TimeCell` for why this keeps
	 *   AGENTS.md's "a 00:30 arrival must never render as the previous day" guarantee
	 *   intact rather than trading it away for space.
	 * - The waiting rows lost "Buffer before Ryanair FR1234 boards". The very next row is
	 *   that flight, with that flight number on it.
	 *   The stepper moved onto the label's own line.
	 * - The totals bar is now `MetricRail`, shared with the results card, which is what
	 *   stopped the two of them disagreeing about which figures an itinerary even has.
	 *
	 * ## DOM shape
	 *
	 * This component's root is the `<ol>` itself, with no wrapping `<div>`, followed by a
	 * sibling totals rail. Each schedule step is one `<li class="tl-row">`, always in the
	 * same order, and every row has exactly four children which subgrid this list's four
	 * columns. That is a change from two, and it is what makes clocks line up under clocks
	 * and prices under prices however tall any one row turns out to be.
	 *
	 * Issue #73 makes each `<li>` clickable (to drive `ItineraryMap`'s selection, issue
	 * #26), by adding attributes and handlers directly to that same `<li>`, no wrapping
	 * element, so the shape above still holds.
	 *
	 * ## The expansion: a leg's alternatives unfold under the leg
	 *
	 * Issue #104's brief asks for a picker "next to each leg". `ResultDetail` used to print
	 * every leg's alternatives in a second list under this timeline, on the belief that a
	 * picker inside a row would need a wrapper and a wrapper would break the subgrid. It
	 * does not. The `expansion` snippet renders as a fifth child of the selected `<li>`,
	 * spanning all four columns (`grid-column: 1 / -1`), so the four cells above it keep
	 * their tracks and the picker sits directly under the step it changes. Rows stay flat,
	 * and the four-column contract above is untouched.
	 *
	 * Selecting is therefore a toggle: clicking the selected row again clears
	 * `selectedSegmentId`, which folds its expansion away and lets the map show the whole
	 * route again. A click that lands on a control inside the row, the waiting-time stepper
	 * or anything in the expansion, leaves the selection alone, or picking an alternative
	 * would fold away the picker that offered it.
	 */
	import type { Snippet } from 'svelte';
	import type { Airport, Duration, FlightOffer, Itinerary, LocalDateTime, Location, TransitLegField } from '../domain';
	import { recomputeItineraryWaitingTimes } from '../algorithm/build';
	import type { WaitingTimeOverrides } from '../algorithm/build';
	import { isOvernightWait } from '../algorithm/nights';
	import { readMissedService, readStaleSchedule } from '../algorithm/transit-schedule';
	import type { ItinerarySegmentId } from '../itinerary-map/segment-id';
	import {
		formatClockTime,
		formatDuration,
		formatLongDuration,
		formatMoney,
		formatPropertyRating,
		staleScheduleNote,
		transferDetailLine,
		transferFareNote,
		unroutedLegNote
	} from './itinerary-timeline-format';
	import type { UnroutedLeg } from './itinerary-timeline-format';
	import type { WithheldRoutes } from '../search/types';
	import { freeTimeDays } from './free-time-days';
	import { ALL_METRIC_IDS } from './itinerary-metrics';
	import { technicalStopDetail } from './technical-stop-note';
	import AirlineLogo from './AirlineLogo.svelte';
	import ModeIcon from './ModeIcon.svelte';
	import type { ModeIconKind } from './ModeIcon.svelte';
	import MetricRail from './MetricRail.svelte';
	import TimeCell from './TimeCell.svelte';

	interface Props {
		/** Bindable, because the waiting-time stepper in the rows below edits it (issue
		 * #250). A caller that binds gets the traveller's edit; one that only passes a value
		 * gets a timeline that edits its own copy, which is what the unit tests mount. */
		itinerary: Itinerary;
		/**
		 * Issue #73: the selection half of the contract `ItineraryMap` (issue #26) already
		 * implements on its own `selectedSegmentId` prop. One `ItinerarySegmentId` value
		 * (`../itinerary-map/segment-id.ts`) is the single place a "which stretch of the
		 * trip is picked" fact lives; a parent binds the same variable to both components
		 * (`bind:selectedSegmentId` here and on the map) rather than each side keeping its
		 * own copy, so the two can never drift apart. No translation table exists because
		 * none is needed: this component's rows already carry these same eleven strings as
		 * their `data-segment` attribute, checked directly against the map's source.
		 */
		selectedSegmentId?: ItinerarySegmentId | null;
		/**
		 * Issue #136: the connection airport's full record, when the caller has resolved it
		 * (`getAirport` is async, so the results page has it a beat after the itinerary).
		 * `Itinerary` itself only ever carries the connection as the two flights' IATA
		 * codes, which is why this component used to print "Stopover in BGY" rather than
		 * fabricate a name. Given the record it can say the city; without it, it still says
		 * the code and never guesses.
		 */
		connectionAirport?: Airport;
		/** Rendered inside every row as a fifth, full-width grid child below the four
		 * columns, only while that row is selected. ResultDetail hands in the picker for
		 * that step, so a leg's alternatives unfold under the leg instead of being printed
		 * again in a second list below the timeline. */
		expansion?: Snippet<[ItinerarySegmentId]>;
		/** A short mark printed at the end of a row's first content line when the step has
		 * something to swap, e.g. "2 flights" or "3 options". The caller decides the wording
		 * and which rows get one; this component only makes the affordance visible. On the
		 * label's own line rather than in the HOW MUCH column, where it cost every flight
		 * and transfer row a third line. */
		optionMarks?: Partial<Record<ItinerarySegmentId, string>>;
		/**
		 * Issue #119: for each leg with no transfer, what `search/resources.ts` refused to
		 * offer there. Only ever set when a router really did answer and the road rule judged
		 * the answer implausible, which is the one case every sentence in `unroutedLegNote`
		 * gets wrong — they all say nothing was routed. Omit it and the rows read exactly as
		 * they did before.
		 */
		withheldRoad?: Partial<Record<UnroutedLeg, WithheldRoutes>>;
		/** Applied to the row list; the totals block keeps its own fixed class. */
		class?: string;
	}

	let {
		itinerary = $bindable(),
		selectedSegmentId = $bindable(null),
		connectionAirport,
		expansion,
		optionMarks,
		withheldRoad,
		class: className
	}: Props = $props();

	/** The origin buffer has no domain-side ceiling (unlike the connection buffer, it never
	 * borrows from free time), so this is purely a sane upper bound for the number input. */
	const ORIGIN_WAITING_TIME_INPUT_MAX_MINUTES = 720 as Duration;

	/**
	 * The inline waiting-time editor (brief lines 39 & 69: "airport waiting times can be
	 * edited afterwards", called out twice) writes the edited itinerary straight back to
	 * the caller.
	 *
	 * Issue #250: it used to keep the edit in two private override fields and render a
	 * derived copy nobody outside this component could see. `ResultDetail` puts
	 * `StopoverBlock` eight lines above this timeline off the same itinerary, so pushing
	 * the connection buffer to 700 minutes dropped the bed out of the total printed here
	 * while the block above went on naming that bed, its nightly rate and a checkout time
	 * the trip no longer had. Two trips, one screen. Editing the caller's itinerary is what
	 * makes that unrepresentable rather than merely fixed.
	 *
	 * The reset effect that used to clear those overrides on a new itinerary identity went
	 * with them: there is no second copy left to fall out of step, and a caller that wants
	 * the search's own buffers back re-mounts or re-assigns.
	 */
	function editWaitingTimes(overrides: WaitingTimeOverrides) {
		itinerary = recomputeItineraryWaitingTimes(itinerary, overrides);
	}

	/** "Bergamo", or "BGY" until the airport record resolves. Never both, and never a
	 * guess: the code is a fact this component always has. */
	const connectionLabel = $derived(connectionAirport?.city.name ?? itinerary.outboundFlight.arrivalAirport);

	/**
	 * The reading each clock is compared against: the one directly before it in schedule
	 * order, so a date or an offset prints exactly when it changes and never again.
	 *
	 * Reading order is fixed by the schedule, so this is a plain lookup rather than
	 * anything the rows have to coordinate. The first entry deliberately has no reference:
	 * something has to anchor the calendar, and it is the moment the traveller leaves.
	 */
	const timeReferences = $derived({
		outboundDeparture: undefined,
		outboundArrival: itinerary.outboundFlight.departure,
		freeStart: itinerary.outboundFlight.arrival,
		freeEnd: itinerary.freeTime.start,
		onwardDeparture: itinerary.freeTime.end,
		onwardArrival: itinerary.onwardFlight.departure
	});

	// The connection buffer can grow only as far as free time allows before it would push
	// freeTime.duration negative. It is a UI input range, not a rule the domain model itself
	// enforces, so it lives here rather than in recomputeItineraryWaitingTimes. The sum
	// holds still while the buffer is edited, which is why it can be read off the edited
	// itinerary: every minute the buffer takes is a minute free time gives up, both carved
	// from one fixed layover (`recomputeItineraryWaitingTimes`'s own doc comment).
	const maxConnectionWaitingTime = $derived(
		(itinerary.connectionWaitingTime + itinerary.freeTime.duration) as Duration
	);

	function clamp(value: number, min: number, max: number): number {
		return Math.min(Math.max(value, min), max);
	}

	function adjustOriginWaitingTime(deltaMinutes: number) {
		editWaitingTimes({
			originWaitingTime: clamp(
				itinerary.originWaitingTime + deltaMinutes,
				0,
				ORIGIN_WAITING_TIME_INPUT_MAX_MINUTES
			) as Duration
		});
	}

	function adjustConnectionWaitingTime(deltaMinutes: number) {
		editWaitingTimes({
			connectionWaitingTime: clamp(
				itinerary.connectionWaitingTime + deltaMinutes,
				0,
				maxConnectionWaitingTime
			) as Duration
		});
	}

	function handleOriginWaitingTimeInput(event: Event & { currentTarget: HTMLInputElement }) {
		const minutes = event.currentTarget.valueAsNumber;
		if (!Number.isFinite(minutes)) return;
		editWaitingTimes({
			originWaitingTime: clamp(minutes, 0, ORIGIN_WAITING_TIME_INPUT_MAX_MINUTES) as Duration
		});
	}

	function handleConnectionWaitingTimeInput(event: Event & { currentTarget: HTMLInputElement }) {
		const minutes = event.currentTarget.valueAsNumber;
		if (!Number.isFinite(minutes)) return;
		editWaitingTimes({ connectionWaitingTime: clamp(minutes, 0, maxConnectionWaitingTime) as Duration });
	}

	// A second activation of the selected row clears the selection: that is how a traveller
	// folds a row's expansion away and hands the map back the whole route.
	function selectSegment(segment: ItinerarySegmentId) {
		selectedSegmentId = selectedSegmentId === segment ? null : segment;
	}

	// The row's onclick fires for any click inside the `<li>`, and once a picker is unfolded
	// in it that includes every radio, button and link the picker draws. Picking an
	// alternative must not also fold the picker that offered it, and a press on the
	// waiting-time stepper never meant "show me this on the map" either.
	//
	// Issue #141's third defect is the stepper half of that sentence: minus and plus used
	// to bubble up here, select the row, and fly the map to that airport, so four nudges of
	// a buffer meant four flights of the map and the traveller's panned view thrown away
	// each time. `button, input` is what stops it; `ItineraryTimeline.test.ts` holds that
	// down from both directions, including that the number still changes and that a
	// selection already on the row survives being adjusted.
	function handleRowClick(event: MouseEvent, segment: ItinerarySegmentId) {
		const target = event.target as Element | null;
		if (target?.closest('.tl-expansion, button, input, label, a, select, summary, details')) return;
		selectSegment(segment);
	}

	// Every row's selectable state lives on the `<li>` itself rather than a wrapping
	// element: a wrapper would have to re-declare this list's four columns as its own
	// subgrid, which is the alignment the whole timetable reading depends on.
	//
	// This used to be a `role="listbox"`/`role="option"` list (matching "a single-select
	// list of steps"), until axe caught what that pattern actually requires: EVERY owned
	// element of a listbox must be an option, while ARIA's `option` role forbids
	// interactive descendants outright — and the two waiting-time rows nest a real
	// stepper (button/input/button), so they can never legally be options. Swapping just
	// those two rows to `role="group"` traded that violation for a worse one
	// (`aria-required-children`, since a listbox missing even one option-or-group-of-
	// options child is invalid full stop) — there is no per-row role that satisfies both
	// "conforms to listbox" and "may contain a real widget."
	//
	// So none of the rows carry a widget role at all: the `<li>`s stay plain, native
	// listitems (a `<ol>`'s implicit role already reads as a sequence — the one override
	// that stays is `role="list"` on the `<ol>` itself, since this app's own
	// `ul, ol { list-style: none }` reset is exactly the thing that makes Safari/
	// VoiceOver stop announcing list semantics otherwise), each with a real
	// `<button>`/`<input>` free to live inside without any nested-interactive
	// complaint. `aria-roledescription="selectable step"` is what tells a screen reader
	// this particular listitem is worth acting on, without touching its actual role or
	// tripping any parent/child conformance rule the way a widget role would.
	// `aria-current` marks whichever row is currently shown on the map, and a plain
	// onclick/onkeydown handles the actual selection.
	//
	// The trade-off: Svelte's own a11y linter does not know `aria-roledescription` is a
	// legitimate way to mark a plain listitem as actionable, so it flags a real tabindex/
	// click/keydown on a "non-interactive" `<li>` (`a11y_no_noninteractive_tabindex`,
	// `a11y_no_noninteractive_element_interactions`) and the same for `onkeydown` on the
	// `<ol>` itself. Each is silenced with a `<!-- svelte-ignore -->` at its own spot: a
	// linter heuristic, not an ARIA rule, and axe itself is clean against a real build
	// (verified per issue #19).
	function handleRowKeydown(event: KeyboardEvent & { currentTarget: HTMLLIElement }, segment: ItinerarySegmentId) {
		if (event.target !== event.currentTarget) return;
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		selectSegment(segment);
	}

	// Arrow/Home/End convenience on top of the plain Tab order every row already has:
	// a sequence of eleven separate tab stops is correct but slow, so this lets a
	// keyboard or screen-reader user jump directly between rows the way a listbox would,
	// without this list actually having to conform to one (see the comment above).
	// `[data-segment]` identifies a row regardless of which of the two roles above it
	// carries. Guarded the same way `handleRowKeydown` is: only when a row `<li>` itself
	// has focus, not a nested control (the waiting-time stepper's number input already
	// owns Up/Down for its own value).
	function handleListKeydown(event: KeyboardEvent & { currentTarget: HTMLOListElement }) {
		const target = event.target as HTMLElement;
		if (!target.hasAttribute('data-segment')) return;
		const rows = Array.from(event.currentTarget.children).filter((child): child is HTMLElement =>
			child.hasAttribute('data-segment')
		);
		const index = rows.indexOf(target);
		if (index === -1) return;
		let nextIndex: number;
		switch (event.key) {
			case 'ArrowDown':
				nextIndex = Math.min(index + 1, rows.length - 1);
				break;
			case 'ArrowUp':
				nextIndex = Math.max(index - 1, 0);
				break;
			case 'Home':
				nextIndex = 0;
				break;
			case 'End':
				nextIndex = rows.length - 1;
				break;
			default:
				return;
		}
		event.preventDefault();
		rows[nextIndex]?.focus();
	}

	// Accommodation subtotal for the free-time row: not stored anywhere on Itinerary
	// (totalPrice is the door-to-door figure), but it is exactly nights × nightly rate, and
	// both of those already live on the itinerary. `undefined` when no stay was priced for this
	// connection (issue #94) — there is no nightly rate to multiply.
	const staySubtotal = $derived(
		itinerary.stay
			? {
					minorUnits: itinerary.stay.pricePerNight.minorUnits * itinerary.nightsInConnection,
					currency: itinerary.stay.pricePerNight.currency
				}
			: undefined
	);

	const uid = $props.id();

	const routeDescription = $derived(
		`Itinerary from ${itinerary.originAirport.iataCode} to ${itinerary.destinationAirport.iataCode} via ${itinerary.outboundFlight.arrivalAirport}`
	);
</script>

{#snippet dot(kind: 'point' | 'event' | 'stopover')}
	<span
		class="tl-dot"
		class:tl-dot-event={kind === 'event'}
		class:tl-dot-stopover={kind === 'stopover'}
		aria-hidden="true"
	></span>
{/snippet}

<!--
	Issue #119, the owner's own words: **"every segment is a coloured dot on a vertical line.
	Flight, transfer, waiting and stopover look the same at a glance; only the heading text
	tells them apart"**. So the rail draws what the step IS, not a dot in a different colour.

	Colour still separates them, because the dot's colour was doing real work and losing it
	would be a trade rather than a fix: the flight keeps the accent, the stopover keeps the
	green block's own colour, an unpriced or unrouted step keeps the muted grey. What is new
	is that the shape says it too, which is the half a colour cannot do for a reader who
	cannot separate the two colours or is scanning too fast to compare them.

	Only a start or end place still gets the plain dot from `dot` above. A place is not a
	mode, and drawing something there would put a picture on the one row that is already the
	shortest word on screen.
-->
{#snippet marker(kind: ModeIconKind, tone: 'accent' | 'stopover' | 'muted')}
	<span class={['tl-mark', `tl-mark-${tone}`]} aria-hidden="true">
		<ModeIcon {kind} size="md" />
	</span>
{/snippet}

{#snippet optionMark(segment: ItinerarySegmentId)}
	{@const mark = optionMarks?.[segment]}
	{#if mark}
		<span class="tl-options">
			{mark}
			<svg class="tl-options-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
				<path
					d="M4 6l4 4 4-4"
					fill="none"
					stroke="currentColor"
					stroke-width="1.5"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			</svg>
		</span>
	{/if}
{/snippet}

{#snippet rowExpansion(segment: ItinerarySegmentId)}
	{#if expansion && selectedSegmentId === segment}
		<div class="tl-expansion">{@render expansion(segment)}</div>
	{/if}
{/snippet}

{#snippet locationRow(location: Location, label: string, segment: ItinerarySegmentId)}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<li
		class="tl-row"
		class:is-selected={selectedSegmentId === segment}
		data-segment={segment}
		tabindex="0"
		aria-roledescription="selectable step"
		aria-label={`${label}: ${location.label}`}
		aria-current={selectedSegmentId === segment ? 'true' : undefined}
		onclick={(event) => handleRowClick(event, segment)}
		onkeydown={(event) => handleRowKeydown(event, segment)}
	>
		<span class="tl-when"></span>
		<span class="tl-rail">{@render dot('point')}</span>
		<div class="tl-content">
			<p class="tl-label">
				{label}<span class="tl-detail-inline">{location.label}</span>{@render optionMark(segment)}
			</p>
		</div>
		<div class="tl-meta"></div>
		{@render rowExpansion(segment)}
	</li>
{/snippet}

{#snippet transferRow(field: TransitLegField, label: string, segment: ItinerarySegmentId, leg: UnroutedLeg)}
	{@const transfer = itinerary[field]}
	<!-- Issue #266: the timetable on this leg was fetched for one moment, and an edit moves
	     that moment without being able to refetch. A waiting-time change does it to a leg that ends
	     at a gate, a flight swap on one that starts at a runway. `readStaleSchedule` returns
	     the moment the leg happens at NOW when the two have parted company, and the row then
	     says what it was planned for instead of printing departures for a trip nobody is
	     taking. -->
	{@const staleAt = readStaleSchedule(itinerary, field)}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<li
		class="tl-row"
		class:is-selected={selectedSegmentId === segment}
		data-segment={segment}
		tabindex="0"
		aria-roledescription="selectable step"
		aria-label={label}
		aria-current={selectedSegmentId === segment ? 'true' : undefined}
		onclick={(event) => handleRowClick(event, segment)}
		onkeydown={(event) => handleRowKeydown(event, segment)}
	>
		<span class="tl-when">
			{#if transfer?.transitSchedule && !staleAt}
				<span class="tl-when-clock font-mono tabular-nums">
					{formatClockTime(transfer.transitSchedule.intended)}
				</span>
			{/if}
		</span>
		<span class="tl-rail">{@render marker(transfer?.mode ?? 'walk', 'muted')}</span>
		<div class="tl-content">
			{#if transfer}
				<!-- Issue #220: one summary, not every leg's full description joined by commas.
				     The separator is a real character rather than a margin, so the row reads the
				     same to a screen reader and to anything that takes the page's text: the
				     owner's own report of this row began "To Birmingham Central
				     BackpackersPublic transport·". See summariseTransferLegs. -->
				<p class="tl-label">
					{label}<span class="tl-detail-inline"
						>&nbsp;&middot; {transferDetailLine(transfer)}</span
					>{@render optionMark(segment)}
				</p>
				{#if transfer.mode === 'transit' && transfer.transitSchedule}
					{@const schedule = transfer.transitSchedule}
					{#if staleAt}
						<p class="tl-note tl-note-warning">{staleScheduleNote(schedule.plannedFor, staleAt)}</p>
					{:else}
						{@const missed = readMissedService(schedule)}
						{#if missed.outcome === 'last-in-time'}
							<p class="tl-note tl-note-warning">
								Last departure that still gets you there by {formatClockTime(schedule.plannedFor.time)}.
							</p>
						{:else if missed.outcome === 'last-known'}
							<p class="tl-note tl-note-warning">No later service runs for the rest of the timetable.</p>
						{:else if missed.outcome === 'long-gap' && missed.next && missed.gap !== undefined}
							<p class="tl-note tl-note-warning">
								Miss it and the next is {formatClockTime(missed.next)}, {formatDuration(missed.gap)} later.
							</p>
						{:else}
							<p class="tl-note">Next: {schedule.following.map((time) => formatClockTime(time)).join(', ')}</p>
						{/if}
					{/if}
				{/if}
			{:else}
				<!-- Issue #140: why this leg has no route, never "not available yet".
				     See unroutedLegNote for what each case actually observed. -->
				<p class="tl-label">
					{label}<span class="tl-detail-inline tl-detail-absent"
						>&nbsp;&middot; {unroutedLegNote(leg, {
							hasStay: itinerary.stay !== undefined,
							nightsInConnection: itinerary.nightsInConnection,
							overnightWait: isOvernightWait(itinerary.freeTime.start, itinerary.freeTime.end),
							transferAnchor: itinerary.transferAnchor,
							withheldRoad: withheldRoad?.[leg]
						})}</span
					>{@render optionMark(segment)}
				</p>
			{/if}
		</div>
		<div class="tl-meta">
			{#if transfer}
				<span class="tl-duration font-mono tabular-nums">{formatDuration(transfer.duration)}</span>
				{@const fare = transferFareNote(transfer, true)}
				<!-- Issue #119: "no fare" for a walk, "price n/a" for a mode that has one and
				     nobody quoted it. Issue #249 adds the rate-card range and #246's refusal
				     to guess past it, which is why one function decides all five and this row
				     only chooses a class. -->
				<span class={fare.unknown ? 'tl-price-unknown' : 'tl-price font-mono tabular-nums'}>
					{fare.text}{#if fare.estimated}<span class="tl-price-estimate">est</span>{/if}
				</span>
			{/if}
		</div>
		{@render rowExpansion(segment)}
	</li>
{/snippet}

{#snippet waitingRow(
	airportLabel: string,
	code: string,
	minutes: Duration,
	segment: ItinerarySegmentId,
	onAdjust: (delta: number) => void,
	onInput: (event: Event & { currentTarget: HTMLInputElement }) => void,
	maxMinutes: number
)}
	{@const inputId = `${uid}-${segment}`}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<li
		class="tl-row"
		class:is-selected={selectedSegmentId === segment}
		data-segment={segment}
		tabindex="0"
		aria-label={`Waiting time at ${airportLabel}`}
		aria-roledescription="selectable step"
		aria-current={selectedSegmentId === segment ? 'true' : undefined}
		onclick={(event) => handleRowClick(event, segment)}
		onkeydown={(event) => handleRowKeydown(event, segment)}
	>
		<span class="tl-when"></span>
		<span class="tl-rail">{@render marker('wait', 'muted')}</span>
		<div class="tl-content tl-content-waiting">
			<!-- The code, not the airport's name: the flight row directly under this one prints
			     the same code, and the name is one hover (or one aria-label read) away. -->
			<p class="tl-label" title={airportLabel}>Waiting at {code}{@render optionMark(segment)}</p>
			<!-- The stepper sits on the label's own line rather than under it. It is the
			     only editable thing in the whole timeline (brief lines 39 and 69), so it
			     stays a real 44px target; what it stopped doing is claiming a third row of
			     its own on every itinerary. -->
			<div class="tl-waiting-editor">
				<label class="visually-hidden" for={inputId}>Waiting time at {airportLabel}, in minutes</label>
				<button
					type="button"
					class="tl-stepper-btn"
					onclick={() => onAdjust(-15)}
					disabled={minutes <= 0}
					aria-label="Decrease waiting time by 15 minutes"
				>
					&minus;
				</button>
				<input
					id={inputId}
					type="number"
					inputmode="numeric"
					class="tl-stepper-input font-mono tabular-nums"
					min="0"
					max={maxMinutes}
					step="5"
					value={minutes}
					oninput={onInput}
				/>
				<button
					type="button"
					class="tl-stepper-btn"
					onclick={() => onAdjust(15)}
					disabled={minutes >= maxMinutes}
					aria-label="Increase waiting time by 15 minutes"
				>
					&plus;
				</button>
			</div>
		</div>
		<div class="tl-meta">
			<span class="tl-duration font-mono tabular-nums">{formatDuration(minutes)}</span>
		</div>
		{@render rowExpansion(segment)}
	</li>
{/snippet}

{#snippet flightRow(
	flight: FlightOffer,
	label: string,
	segment: ItinerarySegmentId,
	departureReference: LocalDateTime | undefined,
	arrivalReference: LocalDateTime
)}
	{@const technicalStops = technicalStopDetail(flight)}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<li
		class="tl-row tl-row-flight"
		class:is-selected={selectedSegmentId === segment}
		data-segment={segment}
		tabindex="0"
		aria-roledescription="selectable step"
		aria-label={label}
		aria-current={selectedSegmentId === segment ? 'true' : undefined}
		onclick={(event) => handleRowClick(event, segment)}
		onkeydown={(event) => handleRowKeydown(event, segment)}
	>
		<span class="tl-when tl-when-pair">
			<TimeCell value={flight.departure} reference={departureReference} align="end" />
			<TimeCell value={flight.arrival} reference={arrivalReference} align="end" />
		</span>
		<span class="tl-rail">{@render marker('flight', 'accent')}</span>
		<div class="tl-content">
			<p class="tl-label tl-label-route">
				<span class="font-mono">{flight.departureAirport}</span>
				<span class="tl-route-arrow" aria-hidden="true">→</span>
				<span class="font-mono">{flight.arrivalAirport}</span>
				{@render optionMark(segment)}
			</p>
			<p class="tl-carrier">
				<AirlineLogo iataCode={flight.carrier.iataCode} name={flight.carrier.name} />
				<span class="tl-carrier-name"
					>{flight.carrier.name}
					<span class="font-mono">{flight.flightNumber}</span
					>{#if flight.aircraft}&nbsp;&middot; {flight.aircraft}{/if}</span
				>
			</p>
			<!-- Issue #210: this row's two airport codes and one duration would otherwise
			     read as a nonstop, and the duration silently includes the time parked at
			     the stop. Saying so is the whole point — a traveller who is not told is
			     surprised on the ground somewhere they cannot leave. -->
			{#if technicalStops}
				<p class="tl-technical-stop">{technicalStops}</p>
			{/if}
		</div>
		<div class="tl-meta">
			<span class="tl-duration font-mono tabular-nums">{formatDuration(flight.duration)}</span>
			<span class="tl-price font-mono tabular-nums">{formatMoney(flight.price)}</span>
		</div>
		{@render rowExpansion(segment)}
	</li>
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<ol
	class={['itinerary-timeline', className]}
	aria-label={routeDescription}
	role="list"
	onkeydown={handleListKeydown}
>
	{#if itinerary.originLocation}
		{@render locationRow(itinerary.originLocation, 'Start', 'origin-location')}
		{@render transferRow(
			'transferToOriginAirport',
			'To the airport',
			'transfer-to-origin-airport',
			'to-origin-airport'
		)}
	{/if}

	{@render waitingRow(
		`${itinerary.originAirport.name} (${itinerary.originAirport.iataCode})`,
		itinerary.originAirport.iataCode,
		itinerary.originWaitingTime,
		'origin-waiting',
		adjustOriginWaitingTime,
		handleOriginWaitingTimeInput,
		ORIGIN_WAITING_TIME_INPUT_MAX_MINUTES
	)}

	{@render flightRow(
		itinerary.outboundFlight,
		`Flight to ${itinerary.outboundFlight.arrivalAirport}`,
		'outbound-flight',
		timeReferences.outboundDeparture,
		timeReferences.outboundArrival
	)}

	{@render transferRow(
		'transferToHotel',
		itinerary.stay ? `To ${itinerary.stay.property.name}` : 'To the stopover',
		'transfer-to-hotel',
		'to-hotel'
	)}

	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<li
		class="tl-row tl-row-stopover"
		class:is-selected={selectedSegmentId === 'free-time'}
		data-segment="free-time"
		tabindex="0"
		aria-roledescription="selectable step"
		aria-label={`The stopover, in ${connectionLabel}`}
		aria-current={selectedSegmentId === 'free-time' ? 'true' : undefined}
		onclick={(event) => handleRowClick(event, 'free-time')}
		onkeydown={(event) => handleRowKeydown(event, 'free-time')}
	>
		<span class="tl-when tl-when-pair">
			<TimeCell value={itinerary.freeTime.start} reference={timeReferences.freeStart} align="end" />
			<TimeCell value={itinerary.freeTime.end} reference={timeReferences.freeEnd} align="end" />
		</span>
		<span class="tl-rail">{@render marker('stopover', 'stopover')}</span>
		<div class="tl-content tl-stopover">
			<p class="tl-stopover-nights">
				<!-- Issue #140: the night count comes off the flight schedule alone (build.ts's
				     `nightsBetween`, issue #105), never off whether a bed was priced, so it
				     leads here whether or not a stay provider is configured. Zero nights is a
				     same-day connection, a fact about the schedule, not a missing purchase. -->
				{#if itinerary.nightsInConnection > 0}
					<strong class="font-mono tabular-nums">{itinerary.nightsInConnection}</strong>
					{itinerary.nightsInConnection === 1 ? 'night' : 'nights'} in {connectionLabel}
				{:else}
					Day stopover in {connectionLabel}
				{/if}
				{@render optionMark('free-time')}
			</p>
			<!-- Issue #185: the row names the bed when there is one and says nothing when
			     there is not. It used to print "No bed priced yet." here, which was the fourth
			     of seven places on one screen saying so, and this row is the one that adds
			     least: the line above it already says how many nights, the price line on the
			     card carries the chip that qualifies the number, and the fold this row opens
			     is where the reason and the fix live (`stays/no-stays-reason.ts`). The
			     zero-night line went with it, because "Day stopover in London" one line up
			     already says no night is spent here. -->
			{#if itinerary.stay}
				<!-- Issue #245: `&nbsp;&middot;` rather than a newline before the separator.
				     Svelte trims the whitespace at the start of an `{#if}` block, so the
				     indented version rendered as "dorm· rated" on production. Same
				     `&nbsp;&middot;` the unrouted-leg row above uses, for the same reason. -->
				<p class="tl-stopover-stay">
					{itinerary.stay.property.name} &middot; {itinerary.stay.roomKind}{#if itinerary.stay.property.rating}&nbsp;&middot;
						rated {formatPropertyRating(itinerary.stay.property.rating)}{/if}
				</p>
			{/if}
		</div>
		<div class="tl-meta">
			<!-- Issue #228: this cell read "2d 15h free", the owner's own example of the
			     thing that is "misleading and wrong". A duration flatters a stopover that is
			     really two evenings and a morning. The count is the honest headline, and
			     `StopoverBlock` above the timeline carries the two edge times with it. -->
			<span class="tl-duration tl-duration-free font-mono tabular-nums"
				>{freeTimeDays(itinerary.freeTime.start, itinerary.freeTime.end)?.count ?? 'No full days'}</span
			>
			{#if staySubtotal && itinerary.nightsInConnection > 0}
				<span class="tl-price font-mono tabular-nums">{formatMoney(staySubtotal)}</span>
			{/if}
		</div>
		{@render rowExpansion('free-time')}
	</li>

	{@render transferRow(
		'transferToConnectionAirport',
		'To the connection airport',
		'transfer-to-connection-airport',
		'from-hotel'
	)}

	{@render waitingRow(
		// Itinerary never stores a full Airport record for the connection, only the two
		// flights that touch it (see domain/itinerary.ts), so this shows the one fact we
		// actually have (the IATA code) rather than fabricating a name, city or country.
		`the connection airport (${itinerary.outboundFlight.arrivalAirport})`,
		itinerary.outboundFlight.arrivalAirport,
		itinerary.connectionWaitingTime,
		'connection-waiting',
		adjustConnectionWaitingTime,
		handleConnectionWaitingTimeInput,
		maxConnectionWaitingTime
	)}

	{@render flightRow(
		itinerary.onwardFlight,
		`Flight to ${itinerary.destinationAirport.iataCode}`,
		'onward-flight',
		timeReferences.onwardDeparture,
		timeReferences.onwardArrival
	)}

	{#if itinerary.destinationLocation}
		{@render transferRow(
			'transferToDestinationLocation',
			'To the destination',
			'transfer-to-destination-location',
			'to-destination-location'
		)}
		{@render locationRow(itinerary.destinationLocation, 'Arrive', 'destination-location')}
	{/if}
</ol>

<MetricRail {itinerary} ids={ALL_METRIC_IDS} class="itinerary-timeline-totals" />

<style>
	/* ---------------------------------------------------------------------
	 * Four columns, the same four on every row: WHEN, the rail, WHAT, HOW
	 * MUCH. Every row subgrids them, so clocks line up under clocks and
	 * prices under prices no matter how tall any one row's content is,
	 * which is the whole reason this reads as a timetable rather than as a
	 * stack of little cards.
	 * ------------------------------------------------------------------- */
	.itinerary-timeline {
		position: relative;
		display: grid;
		/* 8rem holds "Mon, 8 Mar UTC+1" on one line at this column's own type size, so a
		   reading is two lines (clock, then date and offset together) rather than three.
		   The old 5rem fitted the date alone and pushed the offset onto a line of its own,
		   which made every flight row four lines tall. */
		/* The rail column carries a 1.5rem marker plate since issue #119, up from the
		   0.875rem a bare dot needed. It costs the content column 10px, which is the whole
		   price of a reader knowing what a step is without reading it. */
		grid-template-columns: 8rem 1.5rem minmax(0, 1fr) auto;
		column-gap: var(--space-2);
		row-gap: 0;
	}

	.tl-row {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
		/* A second row track, empty on every row but the selected one, holds the expansion.
		   Declaring it lets the rail span both tracks, so its line runs behind an open fold
		   instead of stopping above it and restarting at the next dot.

		   Every child below names its column AND its row. Grid placement positions items
		   with a definite row before it auto-places the rest, so a rail locked to `1 / -1`
		   with an auto column was placed first, took column 1, and pushed the clocks into
		   the 0.875rem rail column, where a date wrapped onto three lines. */
		grid-template-rows: auto auto;
		align-items: start;
		/* Dense by default. Hairline rules between rows instead of gaps: a timetable's
		   rows touch, and the space a gap would have taken is space the panel does not
		   need to be. */
		padding: var(--space-2) var(--space-2) var(--space-2) 0;
		border-top: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		/* The interactive role (issue #73, the map selection contract) lives on the `<li>`
		   itself, not a wrapper: a wrapper would need its own `grid-template-columns:
		   subgrid`, breaking the four-column contract every row here relies on. */
		cursor: pointer;
		transition: background-color var(--transition-fast);
	}

	.tl-row:first-child {
		border-top: none;
	}

	.tl-row:hover {
		background: var(--color-surface-hover);
	}

	/* A box-shadow, not `outline`: `outline` is reserved for the global `:focus-visible` ring,
	   so a row that is both selected and keyboard-focused still shows both, rather than
	   one replacing the other under the same CSS property. */
	.tl-row.is-selected {
		background: var(--color-accent-muted);
		box-shadow: inset 3px 0 0 0 var(--color-accent);
	}

	/* ---------------------------------------------------------------------
	 * WHEN. The clock column a reader scans straight down.
	 * ------------------------------------------------------------------- */
	.tl-when {
		grid-column: 1;
		grid-row: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		text-align: right;
		align-items: flex-end;
	}

	/* Departure over arrival, joined by a rule down the left of the pair, which is how a
	   printed timetable shows a leg's two ends without repeating a header. */
	.tl-when-pair {
		gap: var(--space-1);
	}

	.tl-when-clock {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	/* ---------------------------------------------------------------------
	 * The rail: a continuous line down the middle of its column with a
	 * marker per row. Built from one pseudo-element per row rather than one
	 * absolutely positioned line for the whole list, so it lines up however
	 * tall each row's own content turns out to be.
	 * ------------------------------------------------------------------- */
	.tl-rail {
		position: relative;
		grid-column: 2;
		grid-row: 1 / -1;
		display: flex;
		justify-content: center;
		height: 100%;
		min-height: 1.25rem;
	}

	.tl-rail::before {
		content: '';
		position: absolute;
		top: 0;
		bottom: calc(-1 * var(--space-4));
		left: 50%;
		width: 2px;
		background: var(--color-border-strong);
		transform: translateX(-50%);
	}

	.tl-row:last-child .tl-rail::before {
		display: none;
	}

	.tl-dot {
		position: relative;
		z-index: 1;
		width: 0.4rem;
		height: 0.4rem;
		margin-top: 0.4rem;
		border-radius: var(--radius-full);
		background: var(--color-border-strong);
	}

	.tl-dot-event {
		width: 0.7rem;
		height: 0.7rem;
		margin-top: 0.25rem;
		background: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.tl-dot-stopover {
		width: 0.9rem;
		height: 0.9rem;
		margin-top: 0.2rem;
		background: var(--color-stopover);
		box-shadow: 0 0 0 3px var(--color-stopover-bg);
	}

	/* The marker plate. Opaque on the row's own ground rather than transparent, because the
	   rail's 2px line runs behind it and a line crossing a pictogram makes it unreadable at
	   18px. Circular, matching the dot it replaces, so a place row's dot and a flight row's
	   plane still read as points on one line. */
	.tl-mark {
		position: relative;
		z-index: 1;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		margin-top: 0.05rem;
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-full);
		background: var(--color-surface);
	}

	.tl-mark-accent {
		border-color: var(--color-accent);
		background: var(--color-accent-muted);
		color: var(--color-accent);
	}

	.tl-mark-stopover {
		border-color: var(--color-stopover);
		background: var(--color-stopover-bg);
		color: var(--color-stopover);
	}

	.tl-mark-muted {
		color: var(--color-text-muted);
	}

	/* On the selected row the plate's ground is the row's own tint, so an opaque plate in
	   --color-surface reads as a hole punched in it. */
	.tl-row.is-selected .tl-mark-muted {
		background: var(--color-bg-elevated);
	}

	/* ---------------------------------------------------------------------
	 * WHAT.
	 * ------------------------------------------------------------------- */
	.tl-content {
		grid-column: 3;
		grid-row: 1;
		min-width: 0;
	}

	.tl-label {
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		line-height: 1.35;
		color: var(--color-text);
	}

	/* The detail rides on the label's own line and wraps under it only when it has to,
	   instead of claiming a paragraph of its own on every row. Two facts, one line.

	   The middot that separates it from the label is a character in the markup, not a
	   margin: issue #220's report of this row read "To Birmingham Central
	   BackpackersPublic transport", because a gap drawn in CSS is not a gap in the text.
	   So the separation is a non-breaking space and a middot in the markup, and there is no
	   margin here at all. The space is non-breaking so a wrap can never leave the middot
	   stranded at the start of a line, away from the label it belongs to. */
	.tl-detail-inline {
		font-weight: var(--font-weight-regular);
		color: var(--color-text-muted);
	}

	.tl-detail-absent {
		font-style: italic;
		color: var(--color-text-faint);
	}

	.tl-label-route {
		display: flex;
		align-items: baseline;
		gap: var(--space-1);
		font-size: var(--font-size-base);
		letter-spacing: var(--tracking-wide);
	}

	.tl-route-arrow {
		color: var(--color-text-faint);
	}

	.tl-carrier {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-top: 2px;
	}

	.tl-carrier-name {
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}

	.tl-technical-stop {
		margin-top: var(--space-1);
		font-size: var(--font-size-xs);
		/* Muted, not faint: this one corrects what the row above it appears to say, so it
		   has to survive the greyed-out treatment a deprioritised airline gets. */
		color: var(--color-text-muted);
	}

	.tl-note {
		margin-top: var(--space-1);
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	.tl-note-warning {
		color: var(--color-warning);
	}

	/* ---------------------------------------------------------------------
	 * HOW MUCH.
	 * ------------------------------------------------------------------- */
	.tl-meta {
		grid-column: 4;
		grid-row: 1;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0;
		text-align: right;
		line-height: 1.3;
	}

	.tl-duration {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.tl-duration-free {
		color: var(--color-stopover);
		font-weight: var(--font-weight-semibold);
	}

	.tl-price {
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		color: var(--color-text);
	}

	.tl-price-unknown {
		font-size: var(--font-size-xs);
		font-style: italic;
		color: var(--color-text-faint);
	}

	/* "2 flights", "3 options": the one visible sign that a row unfolds into a choice.
	   Accent-coloured because it is the only text on the line that invites a click, and
	   the chevron turns with the row so an open fold reads as open. */
	.tl-options {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		margin-left: var(--space-2);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
		color: var(--color-accent);
		white-space: nowrap;
	}

	.tl-options-chevron {
		width: 0.75rem;
		height: 0.75rem;
		transition: transform var(--transition-fast);
	}

	.tl-row.is-selected .tl-options-chevron {
		transform: rotate(180deg);
	}

	/* ---------------------------------------------------------------------
	 * Waiting-time editor (brief lines 39 & 69: editable inline).
	 * ------------------------------------------------------------------- */
	/* No wrapping: "Waiting at LGW" plus the stepper fits one line even at 375px, and
	   letting the stepper drop under the label is what used to make these rows two
	   stepper-heights tall on a phone. */
	.tl-content-waiting {
		display: flex;
		flex-wrap: nowrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.tl-waiting-editor {
		display: flex;
		align-items: center;
		gap: var(--space-1);
	}

	.tl-stepper-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		/* 44px square, matching Button.svelte's own md size: WCAG 2.5.5, and this app is
		   meant to be used one-handed. The row around it is dense; the control inside it is
		   not, which is the correct place to spend the pixels. Shrinking the height to
		   36px did save two rows a few pixels each and it was the wrong trade. */
		width: 2.75rem;
		height: 2.75rem;
		flex-shrink: 0;
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-md);
		background: var(--color-surface);
		color: var(--color-text);
		font-size: var(--font-size-lg);
		line-height: 1;
		transition:
			background-color var(--transition-fast),
			border-color var(--transition-fast);
	}

	.tl-stepper-btn:hover:not(:disabled) {
		background: var(--color-surface-hover);
		border-color: var(--color-accent);
	}

	/* Tactile press feedback, matching Button.svelte's own convention. Reduced-motion users
	   still get the instant state change, just without the tween (handled globally in
	   app.css, which sets every transition-duration to near-zero under that preference). */
	.tl-stepper-btn:not(:disabled):active {
		transform: translateY(1px);
	}

	.tl-stepper-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.tl-stepper-input {
		width: 3.25rem;
		height: 2.75rem;
		padding: 0 var(--space-1);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-md);
		background: var(--color-surface);
		color: var(--color-text);
		font-size: var(--font-size-sm);
		text-align: center;
	}

	.tl-stepper-input:focus-visible {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	/* ---------------------------------------------------------------------
	 * The stopover row: the emotional payload of the product, so it reads
	 * as the good part rather than as one row among ten. The teal tint
	 * and the torn-ticket dashes sit on the row itself now, not on a box
	 * inside the WHAT column: that box paid for a padding ring and four
	 * borders of its own, while the row already had a left edge and two
	 * rules waiting to be coloured.
	 * ------------------------------------------------------------------- */
	.tl-row-stopover {
		background: var(--color-stopover-bg);
		box-shadow: inset 3px 0 0 var(--color-stopover);
		border-top: 1px dashed var(--color-stopover);
		border-bottom: 1px dashed var(--color-stopover);
	}

	/* The row after it would otherwise lay its own solid rule over the dashed one. */
	.tl-row-stopover + .tl-row {
		border-top: none;
	}

	/* Stays teal when hovered or selected; only the edge bar changes colour to say
	   "selected", since swapping the tint for the accent wash would lose the one row
	   the whole product is about. */
	.tl-row-stopover:hover,
	.tl-row-stopover.is-selected {
		background: var(--color-stopover-bg);
	}

	.tl-row-stopover.is-selected {
		box-shadow: inset 3px 0 0 var(--color-accent);
	}

	.tl-stopover {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.tl-stopover-nights {
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		color: var(--color-text);
	}

	.tl-stopover-nights strong {
		font-size: var(--font-size-lg);
		font-weight: var(--font-weight-bold);
		color: var(--color-stopover);
	}

	.tl-stopover-stay {
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}

	/* ---------------------------------------------------------------------
	 * The expansion: the selected row's fifth child, under its four cells
	 * and across all four columns, where ResultDetail unfolds that step's
	 * picker (see the header comment).
	 * ------------------------------------------------------------------- */
	.tl-expansion {
		grid-column: 1 / -1;
		grid-row: 2;
		margin-top: var(--space-2);
		padding: var(--space-2) var(--space-3);
		border-top: 1px dashed var(--color-border-strong);
		border-radius: var(--radius-sm);
		/* Its own ground, one step darker than the selected row: a picker marks its current
		   pick with the same accent wash the selected row wears, so on the row's own tint
		   that pick vanished. */
		background: var(--color-bg-inset);
		/* The rail's line is an absolutely positioned pseudo-element, so it paints in the
		   positioned layer, above an in-flow box's background whatever the DOM order. The
		   line runs through this box on purpose (.tl-rail spans the row's second track), and
		   a 2px line crossing a picker's cards reads as a rendering fault, so this box is
		   positioned too and stacked above it. Level 1 is what .tl-dot uses; the two never
		   share a row area. */
		position: relative;
		z-index: 1;
		cursor: default;
	}

	/* The caller's snippet renders nothing for a step with nothing to swap (a location, a
	   waiting row), and Svelte leaves only comment anchors behind, which `:empty` ignores.
	   Without this a selected "Start" row would open onto a dashed, padded box of air. */
	.tl-expansion:empty {
		display: none;
	}

	/* ---------------------------------------------------------------------
	 * Totals. `MetricRail` draws them; this only places the block.
	 * ------------------------------------------------------------------- */
	:global(.itinerary-timeline-totals) {
		margin-top: var(--space-4);
		padding-top: var(--space-3);
		border-top: 2px dashed var(--color-border-strong);
	}

	/* ---------------------------------------------------------------------
	 * Narrow: four columns stop being a timetable and start being four
	 * squeezed paragraphs. Below 34rem the row folds to two lines: the
	 * clocks on one, then the content with the duration and price kept
	 * beside it on the right, the way the wide layout has them. A third
	 * line existed for the duration and price and cost every flight row a
	 * line for two short figures. Same children, same order, same
	 * `data-segment` contract, placed differently.
	 * ------------------------------------------------------------------- */
	@media (max-width: 34rem) {
		.itinerary-timeline {
			grid-template-columns: 1.5rem minmax(0, 1fr) auto;
		}

		.tl-row {
			grid-template-rows: auto auto auto;
			row-gap: var(--space-1);
		}

		.tl-rail {
			grid-column: 1;
			grid-row: 1 / -1;
		}

		.tl-when {
			grid-column: 2 / -1;
			grid-row: 1;
			flex-direction: row;
			flex-wrap: wrap;
			align-items: baseline;
			justify-content: flex-start;
			gap: var(--space-1) var(--space-3);
			text-align: left;
		}

		/* One line per reading: a phone has the width for "08:00 Mon, 8 Mar UTC+1" but not
		   the height for three lines of it twice per flight. `TimeCell`'s own class, hence
		   :global. */
		.tl-when :global(.time-cell) {
			flex-direction: row;
			align-items: baseline;
			gap: var(--space-2);
		}

		/* Stacked, the order alone said which reading was the departure. Side by side it
		   needs the arrow. */
		.tl-when-pair :global(.time-cell + .time-cell)::before {
			content: '→';
			color: var(--color-text-faint);
		}

		/* `TimeCell` is told to hang off its right edge for the wide layout's right-aligned
		   clock column. Laid out in a row it has to hang off the left instead, or the clock
		   floats to the right of its own (wider) date line and reads as an indent. */
		.tl-when :global(.time-cell-end),
		.tl-when :global(.time-cell-end .time-cell-line),
		.tl-when :global(.time-cell-end .time-cell-meta) {
			align-items: flex-start;
			justify-content: flex-start;
			text-align: left;
		}

		/* Empty on the rows that carry no clock, and an empty flex box still takes its
		   row's gap. Collapsing it keeps a waiting row one line tall, not two. */
		.tl-when:empty {
			display: none;
		}

		.tl-content {
			grid-column: 2;
			grid-row: 2;
		}

		.tl-meta {
			grid-column: 3;
			grid-row: 2;
		}

		.tl-meta:empty {
			display: none;
		}

		.tl-expansion {
			grid-column: 1 / -1;
			grid-row: 3;
		}
	}
</style>
