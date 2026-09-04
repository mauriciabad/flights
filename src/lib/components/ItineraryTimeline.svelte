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
	 */
	import type { Airport, Duration, FlightOffer, Itinerary, LocalDateTime, Location, Transfer } from '../domain';
	import { recomputeItineraryWaitingTimes } from '../algorithm/build';
	import { readMissedService } from '../algorithm/transit-schedule';
	import type { ItinerarySegmentId } from '../itinerary-map/segment-id';
	import {
		formatClockTime,
		formatDuration,
		formatLongDuration,
		formatMoney,
		transferModeLabel,
		unpricedTransferNote,
		unroutedLegNote
	} from './itinerary-timeline-format';
	import type { UnroutedLeg } from './itinerary-timeline-format';
	import { ALL_METRIC_IDS } from './itinerary-metrics';
	import AirlineLogo from './AirlineLogo.svelte';
	import MetricRail from './MetricRail.svelte';
	import TimeCell from './TimeCell.svelte';

	interface Props {
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
		/** Applied to the row list; the totals block keeps its own fixed class. */
		class?: string;
	}

	let {
		itinerary,
		selectedSegmentId = $bindable(null),
		connectionAirport,
		class: className
	}: Props = $props();

	/** The origin buffer has no domain-side ceiling (unlike the connection buffer, it never
	 * borrows from free time), so this is purely a sane upper bound for the number input. */
	const ORIGIN_WAITING_TIME_INPUT_MAX_MINUTES = 720 as Duration;

	// Waiting-time overrides from the inline editor below (brief lines 39 & 69: "airport
	// waiting times can be edited afterwards", called out twice). `undefined` means "use
	// the itinerary's own value". See recomputeItineraryWaitingTimes in algorithm/build.ts.
	let originWaitingTimeOverride = $state<Duration | undefined>(undefined);
	let connectionWaitingTimeOverride = $state<Duration | undefined>(undefined);

	// A new `itinerary` object identity (a fresh search, a different offer picked in the
	// results list) means any hand-tuned buffer belonged to the *previous* itinerary in this
	// slot and must not silently carry over. Reading `itinerary` here, rather than
	// diffing it against a locally tracked "previous" value, is what makes this effect
	// re-run exactly when the prop identity changes; Svelte already tracks that for us.
	$effect(() => {
		void itinerary;
		originWaitingTimeOverride = undefined;
		connectionWaitingTimeOverride = undefined;
	});

	const shown = $derived(
		recomputeItineraryWaitingTimes(itinerary, {
			originWaitingTime: originWaitingTimeOverride,
			connectionWaitingTime: connectionWaitingTimeOverride
		})
	);

	/** "Bergamo", or "BGY" until the airport record resolves. Never both, and never a
	 * guess: the code is a fact this component always has. */
	const connectionLabel = $derived(connectionAirport?.city.name ?? shown.outboundFlight.arrivalAirport);

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
		outboundArrival: shown.outboundFlight.departure,
		freeStart: shown.outboundFlight.arrival,
		freeEnd: shown.freeTime.start,
		onwardDeparture: shown.freeTime.end,
		onwardArrival: shown.onwardFlight.departure
	});

	// The connection buffer can grow only as far as the *original* free time allows before
	// it would push freeTime.duration negative. It is a UI input range, not a rule the domain
	// model itself enforces, so it lives here rather than in recomputeItineraryWaitingTimes.
	const maxConnectionWaitingTime = $derived(
		(itinerary.connectionWaitingTime + itinerary.freeTime.duration) as Duration
	);

	function clamp(value: number, min: number, max: number): number {
		return Math.min(Math.max(value, min), max);
	}

	function adjustOriginWaitingTime(deltaMinutes: number) {
		originWaitingTimeOverride = clamp(
			shown.originWaitingTime + deltaMinutes,
			0,
			ORIGIN_WAITING_TIME_INPUT_MAX_MINUTES
		) as Duration;
	}

	function adjustConnectionWaitingTime(deltaMinutes: number) {
		connectionWaitingTimeOverride = clamp(
			shown.connectionWaitingTime + deltaMinutes,
			0,
			maxConnectionWaitingTime
		) as Duration;
	}

	function handleOriginWaitingTimeInput(event: Event & { currentTarget: HTMLInputElement }) {
		const minutes = event.currentTarget.valueAsNumber;
		if (!Number.isFinite(minutes)) return;
		originWaitingTimeOverride = clamp(minutes, 0, ORIGIN_WAITING_TIME_INPUT_MAX_MINUTES) as Duration;
	}

	function handleConnectionWaitingTimeInput(event: Event & { currentTarget: HTMLInputElement }) {
		const minutes = event.currentTarget.valueAsNumber;
		if (!Number.isFinite(minutes)) return;
		connectionWaitingTimeOverride = clamp(minutes, 0, maxConnectionWaitingTime) as Duration;
	}

	function selectSegment(segment: ItinerarySegmentId) {
		selectedSegmentId = segment;
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
	// both of those already live on `shown`. `undefined` when no stay was priced for this
	// connection (issue #94) — there is no nightly rate to multiply.
	const staySubtotal = $derived(
		shown.stay
			? {
					minorUnits: shown.stay.pricePerNight.minorUnits * shown.nightsInConnection,
					currency: shown.stay.pricePerNight.currency
				}
			: undefined
	);

	const uid = $props.id();

	const routeDescription = $derived(
		`Itinerary from ${shown.originAirport.iataCode} to ${shown.destinationAirport.iataCode} via ${shown.outboundFlight.arrivalAirport}`
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
		onclick={() => selectSegment(segment)}
		onkeydown={(event) => handleRowKeydown(event, segment)}
	>
		<span class="tl-when"></span>
		<span class="tl-rail">{@render dot('point')}</span>
		<div class="tl-content">
			<p class="tl-label">{label}<span class="tl-detail-inline">{location.label}</span></p>
		</div>
		<div class="tl-meta"></div>
	</li>
{/snippet}

{#snippet transferRow(transfer: Transfer | undefined, label: string, segment: ItinerarySegmentId, leg: UnroutedLeg)}
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
		onclick={() => selectSegment(segment)}
		onkeydown={(event) => handleRowKeydown(event, segment)}
	>
		<span class="tl-when">
			{#if transfer?.transitSchedule}
				<span class="tl-when-clock font-mono tabular-nums">
					{formatClockTime(transfer.transitSchedule.intended)}
				</span>
			{/if}
		</span>
		<span class="tl-rail">{@render dot('point')}</span>
		<div class="tl-content">
			{#if transfer}
				<p class="tl-label">
					{label}<span class="tl-detail-inline">
						{transferModeLabel(transfer.mode)}{#if transfer.legs.some((leg) => leg.description)}
							&middot; {transfer.legs
								.map((leg) => leg.description)
								.filter(Boolean)
								.join(', ')}{/if}
					</span>
				</p>
				{#if transfer.mode === 'transit' && transfer.transitSchedule}
					{@const schedule = transfer.transitSchedule}
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
			{:else}
				<!-- Issue #140: why this leg has no route, never "not available yet".
				     See unroutedLegNote for what each case actually observed. -->
				<p class="tl-label">
					{label}<span class="tl-detail-inline tl-detail-absent">
						{unroutedLegNote(leg, {
							hasStay: shown.stay !== undefined,
							nightsInConnection: shown.nightsInConnection
						})}
					</span>
				</p>
			{/if}
		</div>
		<div class="tl-meta">
			{#if transfer}
				<span class="tl-duration font-mono tabular-nums">{formatDuration(transfer.duration)}</span>
				{#if transfer.price}
					<span class="tl-price font-mono tabular-nums">{formatMoney(transfer.price)}</span>
				{:else}
					<!-- Issue #119: "no fare" for a walk, "price n/a" for a mode that has one
					     and nobody quoted it. See unpricedTransferNote. -->
					<span class="tl-price-unknown">{unpricedTransferNote(transfer.mode, true)}</span>
				{/if}
			{/if}
		</div>
	</li>
{/snippet}

{#snippet waitingRow(
	airportLabel: string,
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
		onclick={() => selectSegment(segment)}
		onkeydown={(event) => handleRowKeydown(event, segment)}
	>
		<span class="tl-when"></span>
		<span class="tl-rail">{@render dot('event')}</span>
		<div class="tl-content tl-content-waiting">
			<p class="tl-label">Waiting at {airportLabel}</p>
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
	</li>
{/snippet}

{#snippet flightRow(
	flight: FlightOffer,
	label: string,
	segment: ItinerarySegmentId,
	departureReference: LocalDateTime | undefined,
	arrivalReference: LocalDateTime
)}
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
		onclick={() => selectSegment(segment)}
		onkeydown={(event) => handleRowKeydown(event, segment)}
	>
		<span class="tl-when tl-when-pair">
			<TimeCell value={flight.departure} reference={departureReference} align="end" />
			<TimeCell value={flight.arrival} reference={arrivalReference} align="end" />
		</span>
		<span class="tl-rail">{@render dot('event')}</span>
		<div class="tl-content">
			<p class="tl-label tl-label-route">
				<span class="font-mono">{flight.departureAirport}</span>
				<span class="tl-route-arrow" aria-hidden="true">→</span>
				<span class="font-mono">{flight.arrivalAirport}</span>
			</p>
			<p class="tl-carrier">
				<AirlineLogo iataCode={flight.carrier.iataCode} name={flight.carrier.name} />
				<span class="tl-carrier-name"
					>{flight.carrier.name}
					<span class="font-mono">{flight.flightNumber}</span
					>{#if flight.aircraft}&nbsp;&middot; {flight.aircraft}{/if}</span
				>
			</p>
		</div>
		<div class="tl-meta">
			<span class="tl-duration font-mono tabular-nums">{formatDuration(flight.duration)}</span>
			<span class="tl-price font-mono tabular-nums">{formatMoney(flight.price)}</span>
		</div>
	</li>
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<ol
	class={['itinerary-timeline', className]}
	aria-label={routeDescription}
	role="list"
	onkeydown={handleListKeydown}
>
	{#if shown.originLocation}
		{@render locationRow(shown.originLocation, 'Start', 'origin-location')}
		{@render transferRow(
			shown.transferToOriginAirport,
			'To the airport',
			'transfer-to-origin-airport',
			'to-origin-airport'
		)}
	{/if}

	{@render waitingRow(
		`${shown.originAirport.name} (${shown.originAirport.iataCode})`,
		shown.originWaitingTime,
		'origin-waiting',
		adjustOriginWaitingTime,
		handleOriginWaitingTimeInput,
		ORIGIN_WAITING_TIME_INPUT_MAX_MINUTES
	)}

	{@render flightRow(
		shown.outboundFlight,
		`Flight to ${shown.outboundFlight.arrivalAirport}`,
		'outbound-flight',
		timeReferences.outboundDeparture,
		timeReferences.outboundArrival
	)}

	{@render transferRow(
		shown.transferToHotel,
		shown.stay ? `To ${shown.stay.property.name}` : 'To the stopover',
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
		onclick={() => selectSegment('free-time')}
		onkeydown={(event) => handleRowKeydown(event, 'free-time')}
	>
		<span class="tl-when tl-when-pair">
			<TimeCell value={shown.freeTime.start} reference={timeReferences.freeStart} align="end" />
			<TimeCell value={shown.freeTime.end} reference={timeReferences.freeEnd} align="end" />
		</span>
		<span class="tl-rail">{@render dot('stopover')}</span>
		<div class="tl-content tl-stopover">
			<p class="tl-stopover-nights">
				<!-- Issue #140: the night count comes off the flight schedule alone (build.ts's
				     `nightsBetween`, issue #105), never off whether a bed was priced, so it
				     leads here whether or not a stay provider is configured. Zero nights is a
				     same-day connection, a fact about the schedule, not a missing purchase. -->
				{#if shown.nightsInConnection > 0}
					<strong class="font-mono tabular-nums">{shown.nightsInConnection}</strong>
					{shown.nightsInConnection === 1 ? 'night' : 'nights'} in {connectionLabel}
				{:else}
					Day stopover in {connectionLabel}
				{/if}
			</p>
			<p class="tl-stopover-stay">
				{#if shown.stay}
					{shown.stay.property.name} &middot; {shown.stay.roomKind}{#if shown.stay.property.rating}
						&middot; rated {shown.stay.property.rating}/5{/if}
				{:else if shown.nightsInConnection > 0}
					No bed priced yet. Add an Agoda or Booking.com key, or widen the search.
				{:else}
					No night spent here, so there is no bed to price.
				{/if}
			</p>
		</div>
		<div class="tl-meta">
			<span class="tl-duration tl-duration-free font-mono tabular-nums"
				>{formatLongDuration(shown.freeTime.duration)} free</span
			>
			{#if staySubtotal && shown.nightsInConnection > 0}
				<span class="tl-price font-mono tabular-nums">{formatMoney(staySubtotal)}</span>
			{/if}
		</div>
	</li>

	{@render transferRow(
		shown.transferToConnectionAirport,
		'To the connection airport',
		'transfer-to-connection-airport',
		'from-hotel'
	)}

	{@render waitingRow(
		// Itinerary never stores a full Airport record for the connection, only the two
		// flights that touch it (see domain/itinerary.ts), so this shows the one fact we
		// actually have (the IATA code) rather than fabricating a name, city or country.
		`the connection airport (${shown.outboundFlight.arrivalAirport})`,
		shown.connectionWaitingTime,
		'connection-waiting',
		adjustConnectionWaitingTime,
		handleConnectionWaitingTimeInput,
		maxConnectionWaitingTime
	)}

	{@render flightRow(
		shown.onwardFlight,
		`Flight to ${shown.destinationAirport.iataCode}`,
		'onward-flight',
		timeReferences.onwardDeparture,
		timeReferences.onwardArrival
	)}

	{#if shown.destinationLocation}
		{@render transferRow(
			shown.transferToDestinationLocation,
			'To the destination',
			'transfer-to-destination-location',
			'to-destination-location'
		)}
		{@render locationRow(shown.destinationLocation, 'Arrive', 'destination-location')}
	{/if}
</ol>

<MetricRail itinerary={shown} ids={ALL_METRIC_IDS} class="itinerary-timeline-totals" />

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
		/* 5rem holds "Wed, 10 Mar" on one line at this column's own type size, and a clock
		   with a "+2" day stamp beside it. Narrower and the date wrapped to two lines,
		   which made every flight row a third taller than it needed to be. */
		grid-template-columns: 5rem 0.875rem minmax(0, 1fr) auto;
		column-gap: var(--space-2);
		row-gap: 0;
	}

	.tl-row {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
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

	/* ---------------------------------------------------------------------
	 * WHAT.
	 * ------------------------------------------------------------------- */
	.tl-content {
		min-width: 0;
	}

	.tl-label {
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		line-height: 1.35;
		color: var(--color-text);
	}

	/* The detail rides on the label's own line and wraps under it only when it has to,
	   instead of claiming a paragraph of its own on every row. Two facts, one line. */
	.tl-detail-inline {
		margin-left: var(--space-2);
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
		margin-top: var(--space-1);
	}

	.tl-carrier-name {
		font-size: var(--font-size-xs);
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

	/* ---------------------------------------------------------------------
	 * Waiting-time editor (brief lines 39 & 69: editable inline).
	 * ------------------------------------------------------------------- */
	.tl-content-waiting {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
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
	 * as the good part rather than as one row among ten. Keeps the
	 * torn-ticket dashes, loses the padding that made it three times the
	 * height of everything around it.
	 * ------------------------------------------------------------------- */
	.tl-row-stopover {
		padding-block: var(--space-3);
	}

	.tl-stopover {
		padding: var(--space-2) var(--space-3);
		border: 1px dashed var(--color-stopover);
		border-radius: var(--radius-md);
		background: var(--color-stopover-bg);
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
	 * Totals. `MetricRail` draws them; this only places the block.
	 * ------------------------------------------------------------------- */
	:global(.itinerary-timeline-totals) {
		margin-top: var(--space-4);
		padding-top: var(--space-3);
		border-top: 2px dashed var(--color-border-strong);
	}

	/* ---------------------------------------------------------------------
	 * Narrow viewports: 3.5rem of clock column plus a rail plus a price
	 * column leaves too little for the label under about 24rem, so the
	 * clock column narrows and the meta column moves under the content.
	 * ------------------------------------------------------------------- */
	/* ---------------------------------------------------------------------
	 * Narrow: four columns stop being a timetable and start being four
	 * squeezed paragraphs. Below 34rem the row folds to rail plus content,
	 * with the clocks as a single line above the label and the duration and
	 * price as a single line below it. Same four children, same order, same
	 * `data-segment` contract, placed differently.
	 * ------------------------------------------------------------------- */
	@media (max-width: 34rem) {
		.itinerary-timeline {
			grid-template-columns: 0.875rem minmax(0, 1fr);
		}

		.tl-row {
			grid-template-rows: auto auto auto;
			row-gap: var(--space-1);
		}

		.tl-rail {
			grid-column: 1;
			grid-row: 1 / -1;
		}

		.tl-when,
		.tl-content,
		.tl-meta {
			grid-column: 2;
		}

		.tl-when {
			grid-row: 1;
			flex-direction: row;
			flex-wrap: wrap;
			align-items: baseline;
			justify-content: flex-start;
			gap: var(--space-1) var(--space-3);
			text-align: left;
		}

		/* `TimeCell` is told to hang off its right edge for the wide layout's right-aligned
		   clock column. Laid out in a row it has to hang off the left instead, or the clock
		   floats to the right of its own (wider) date line and reads as an indent. The
		   component's own class, hence :global. */
		.tl-when :global(.time-cell-end),
		.tl-when :global(.time-cell-end .time-cell-line),
		.tl-when :global(.time-cell-end .time-cell-meta) {
			align-items: flex-start;
			justify-content: flex-start;
			text-align: left;
		}

		/* Empty on the rows that carry no clock, and an empty flex box still takes its
		   row's gap. Collapsing it keeps a waiting row two lines tall, not three. */
		.tl-when:empty {
			display: none;
		}

		.tl-content {
			grid-row: 2;
		}

		.tl-meta {
			grid-row: 3;
			flex-direction: row;
			align-items: baseline;
			justify-content: flex-start;
			gap: var(--space-3);
		}

		.tl-meta:empty {
			display: none;
		}
	}
</style>
