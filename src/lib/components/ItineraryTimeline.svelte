<script lang="ts">
	/**
	 * Issue #24: the itinerary timeline, the app's centrepiece. Renders exactly the
	 * schedule from docs/prompts/001-initial-brief.md lines 44-53 (also quoted in the
	 * issue): origin location, transfer to origin airport, waiting time, outbound flight,
	 * transfer to hotel, free time, transfer to connection airport, waiting time, onward
	 * flight, transfer to destination location.
	 *
	 * DOM contract for issue #25 (the comparator): this component's root is the `<ol>`
	 * itself, with no wrapping `<div>` around it, followed by a sibling `<dl>` of totals, so
	 * a parent never has to reach past an extra layer to grid-align either one. Each
	 * schedule step is one `<li class="tl-row">`, always in the same order, so the Nth row
	 * of one itinerary is always the same *kind* of step as the Nth row of any other
	 * itinerary built from the same SearchQuery. The two rows that can be entirely absent,
	 * origin and destination location, are a property of the query, not of one itinerary,
	 * so their presence is identical across every itinerary being compared side by side.
	 * That positional guarantee is what makes plain CSS subgrid work with no per-row naming
	 * scheme: pass `subgrid` and this `<ol>` becomes `grid-template-rows: subgrid`, so a
	 * parent grid's row tracks size to the tallest sibling at each position. See this
	 * file's PR description for the exact contract issue #25 can build on.
	 *
	 * Issue #73 makes each `<li>` clickable (to drive `ItineraryMap`'s selection, issue
	 * #26), but only by adding attributes and handlers directly to that same `<li>` — no
	 * wrapping element, so the contract above still holds.
	 */
	import type { Airport, Duration, FlightOffer, Itinerary, LocalDateTime, Location, Transfer } from '../domain';
	import { recomputeItineraryWaitingTimes } from '../algorithm/build';
	import type { ItinerarySegmentId } from '../itinerary-map/segment-id';
	import {
		formatCalendarDate,
		formatClockTime,
		formatDuration,
		formatMoney,
		formatUtcOffset,
		isDifferentCalendarDate,
		transferModeLabel,
		unroutedLegNote
	} from './itinerary-timeline-format';
	import type { UnroutedLeg } from './itinerary-timeline-format';

	interface Props {
		itinerary: Itinerary;
		/** Opts the root `<ol>` into a shared row grid from an ancestor grid instead of
		 * sizing its own rows. See the DOM contract note above. Off by default so the
		 * component still lays out correctly on its own, e.g. in a results list. */
		subgrid?: boolean;
		/** The totals `<dl>` after the row list. Off when a parent (the comparator) is
		 * building one shared totals bar across every column instead of one per column. */
		showTotals?: boolean;
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
		subgrid = false,
		showTotals = true,
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
	const connectionLabel = $derived(
		connectionAirport?.city.name ?? shown.outboundFlight.arrivalAirport
	);

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
	// element, since the comparator (issue #25) depends on each step being exactly one
	// flat `<li class="tl-row">`.
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
	// `<ol>` itself. Each is silenced with a `<!-- svelte-ignore -->` at its own spot,
	// the same pattern the comparator's own scrollable region already uses in
	// Comparator.svelte for an identical reason — a linter heuristic, not an ARIA rule,
	// axe itself is clean against a real build (verified per issue #19).
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
			? { minorUnits: shown.stay.pricePerNight.minorUnits * shown.nightsInConnection, currency: shown.stay.pricePerNight.currency }
			: undefined
	);

	const uid = $props.id();

	const routeDescription = $derived(
		`Itinerary from ${shown.originAirport.iataCode} to ${shown.destinationAirport.iataCode} via ${shown.outboundFlight.arrivalAirport}`
	);
</script>

{#snippet timeBadge(dateTime: LocalDateTime)}
	<span class="tl-time">
		<span class="tl-time-clock font-mono tabular-nums">{formatClockTime(dateTime)}</span>
		<span class="tl-time-date">{formatCalendarDate(dateTime)}</span>
		<span class="tl-time-offset font-mono" title={dateTime.timeZone}>
			{formatUtcOffset(dateTime.utcOffsetMinutes)}
		</span>
	</span>
{/snippet}

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
		<span class="tl-rail">{@render dot('point')}</span>
		<div class="tl-content">
			<p class="tl-label">{label}</p>
			<p class="tl-detail">{location.label}</p>
		</div>
	</li>
{/snippet}

{#snippet transferRow(
	transfer: Transfer | undefined,
	label: string,
	segment: ItinerarySegmentId,
	leg: UnroutedLeg
)}
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
		<span class="tl-rail">{@render dot('point')}</span>
		<div class="tl-content tl-content-row">
			<div class="tl-transfer-info">
				<p class="tl-label">{label}</p>
				{#if transfer}
					<p class="tl-detail">
						{transferModeLabel(transfer.mode)}
						{#if transfer.legs.some((leg) => leg.description)}
							&middot; {transfer.legs
								.map((leg) => leg.description)
								.filter(Boolean)
								.join(', ')}
						{/if}
					</p>
					{#if transfer.mode === 'transit' && transfer.transitSchedule}
						{#if transfer.transitSchedule.following.length === 0}
							<p class="tl-note tl-note-warning">
								No later service found. The {formatClockTime(transfer.transitSchedule.intended)} connection is the
								last one.
							</p>
						{:else}
							<p class="tl-note">
								Next after this one: {transfer.transitSchedule.following.map((t) => formatClockTime(t)).join(', ')}
							</p>
						{/if}
					{/if}
				{:else}
					<!-- Issue #140: why this leg has no route, never "not available yet".
					     See unroutedLegNote for what each case actually observed. -->
					<p class="tl-note">
						{unroutedLegNote(leg, {
							hasStay: shown.stay !== undefined,
							nightsInConnection: shown.nightsInConnection
						})}
					</p>
				{/if}
			</div>
			{#if transfer}
				<div class="tl-meta">
					<span class="tl-duration font-mono tabular-nums">{formatDuration(transfer.duration)}</span>
					{#if transfer.price}
						<span class="tl-price font-mono tabular-nums">{formatMoney(transfer.price)}</span>
					{:else}
						<span class="tl-price tl-price-unknown">price n/a</span>
					{/if}
				</div>
			{/if}
		</div>
	</li>
{/snippet}

{#snippet waitingRow(
	airportLabel: string,
	minutes: Duration,
	flight: FlightOffer,
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
		<span class="tl-rail">{@render dot('event')}</span>
		<div class="tl-content">
			<p class="tl-label">Waiting at {airportLabel}</p>
			<p class="tl-detail">Buffer before {flight.carrier.name} {flight.flightNumber} boards</p>
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
				<span class="tl-stepper-unit">min</span>
				<button
					type="button"
					class="tl-stepper-btn"
					onclick={() => onAdjust(15)}
					disabled={minutes >= maxMinutes}
					aria-label="Increase waiting time by 15 minutes"
				>
					&plus;
				</button>
				<span class="tl-waiting-formatted font-mono tabular-nums">{formatDuration(minutes)}</span>
			</div>
		</div>
	</li>
{/snippet}

{#snippet flightRow(flight: FlightOffer, label: string, segment: ItinerarySegmentId)}
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
		<span class="tl-rail">{@render dot('event')}</span>
		<div class="tl-content tl-content-row">
			<div class="tl-flight-info">
				<p class="tl-label">{label}</p>
				<p class="tl-detail">
					{flight.carrier.name} {flight.flightNumber}
					{#if flight.aircraft}&middot; {flight.aircraft}{/if}
				</p>
				<div class="tl-flight-times">
					<span class="tl-flight-endpoint">
						<span class="tl-flight-code font-mono">{flight.departureAirport}</span>
						{@render timeBadge(flight.departure)}
					</span>
					<span class="tl-flight-arrow" aria-hidden="true">&rarr;</span>
					<span class="tl-flight-endpoint">
						<span class="tl-flight-code font-mono">{flight.arrivalAirport}</span>
						{@render timeBadge(flight.arrival)}
						{#if isDifferentCalendarDate(flight.departure, flight.arrival)}
							<span class="tl-note tl-note-plusday">next day</span>
						{/if}
					</span>
				</div>
			</div>
			<div class="tl-meta">
				<span class="tl-duration font-mono tabular-nums">{formatDuration(flight.duration)}</span>
				<span class="tl-price font-mono tabular-nums">{formatMoney(flight.price)}</span>
			</div>
		</div>
	</li>
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<ol
	class={['itinerary-timeline', className]}
	class:itinerary-timeline--subgrid={subgrid}
	aria-label={routeDescription}
	role="list"
	onkeydown={handleListKeydown}
>
	{#if shown.originLocation}
		{@render locationRow(shown.originLocation, 'Starting point', 'origin-location')}
		{@render transferRow(
			shown.transferToOriginAirport,
			'Travel to the airport',
			'transfer-to-origin-airport',
			'to-origin-airport'
		)}
	{/if}

	{@render waitingRow(
		`${shown.originAirport.name} (${shown.originAirport.iataCode})`,
		shown.originWaitingTime,
		shown.outboundFlight,
		'origin-waiting',
		adjustOriginWaitingTime,
		handleOriginWaitingTimeInput,
		ORIGIN_WAITING_TIME_INPUT_MAX_MINUTES
	)}

	{@render flightRow(shown.outboundFlight, `Flight to ${shown.outboundFlight.arrivalAirport}`, 'outbound-flight')}

	{@render transferRow(
		shown.transferToHotel,
		shown.stay ? `Travel to ${shown.stay.property.name}` : 'Travel to the stopover',
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
		<span class="tl-rail">{@render dot('stopover')}</span>
		<div class="tl-content tl-stopover">
			<p class="tl-stopover-eyebrow">The stopover</p>
			<p class="tl-stopover-nights">
				<!-- Issue #140: the night count comes off the flight schedule alone (build.ts's
				     `nightsBetween`, issue #105), never off whether a bed was priced, so it leads
				     here whether or not a stay provider is configured. Branching on the stay
				     first used to hide a real six-night stopover behind a bare "Stopover in
				     BGY". Zero nights is a same-day connection, a fact about the schedule, not
				     a missing purchase. -->
				{#if shown.nightsInConnection > 0}
					{shown.nightsInConnection}
					{shown.nightsInConnection === 1 ? 'night' : 'nights'} in {connectionLabel}
				{:else}
					<span class="tl-stopover-sameday">Day stopover in {connectionLabel}, no overnight stay</span>
				{/if}
			</p>
			<p class="tl-detail">
				{#if shown.stay}
					{shown.stay.property.name} &middot; {shown.stay.roomKind}
					{#if shown.stay.property.rating}&middot; rated {shown.stay.property.rating}/5{/if}
				{:else if shown.nightsInConnection > 0}
					No bed priced yet. Add an Agoda or Booking.com key, or widen the search, to price one here.
				{:else}
					No night spent here, so there is no bed to price.
				{/if}
			</p>
			<div class="tl-free-window">
				<span class="tl-free-endpoint">
					<span class="tl-free-caption">Free from</span>
					{@render timeBadge(shown.freeTime.start)}
				</span>
				<span class="tl-free-endpoint">
					<span class="tl-free-caption">Until</span>
					{@render timeBadge(shown.freeTime.end)}
				</span>
			</div>
			<div class="tl-meta">
				<span class="tl-duration font-mono tabular-nums">{formatDuration(shown.freeTime.duration)} free</span>
				{#if staySubtotal && shown.nightsInConnection > 0}
					<span class="tl-price font-mono tabular-nums">{formatMoney(staySubtotal)}</span>
				{/if}
			</div>
		</div>
	</li>

	{@render transferRow(
		shown.transferToConnectionAirport,
		'Travel to the connection airport',
		'transfer-to-connection-airport',
		'from-hotel'
	)}

	{@render waitingRow(
		// Itinerary never stores a full Airport record for the connection, only the two
		// flights that touch it (see domain/itinerary.ts), so this shows the one fact we
		// actually have (the IATA code) rather than fabricating a name, city or country.
		`the connection airport (${shown.outboundFlight.arrivalAirport})`,
		shown.connectionWaitingTime,
		shown.onwardFlight,
		'connection-waiting',
		adjustConnectionWaitingTime,
		handleConnectionWaitingTimeInput,
		maxConnectionWaitingTime
	)}

	{@render flightRow(shown.onwardFlight, `Flight to ${shown.destinationAirport.iataCode}`, 'onward-flight')}

	{#if shown.destinationLocation}
		{@render transferRow(
			shown.transferToDestinationLocation,
			'Travel to the destination',
			'transfer-to-destination-location',
			'to-destination-location'
		)}
		{@render locationRow(shown.destinationLocation, 'Final destination', 'destination-location')}
	{/if}
</ol>

{#if showTotals}
	<dl class="itinerary-timeline-totals">
		<div class="tl-total">
			<dt>In-flight</dt>
			<dd class="font-mono tabular-nums">{formatDuration(shown.times.inFlight)}</dd>
		</div>
		<div class="tl-total">
			<dt>Airport waiting</dt>
			<dd class="font-mono tabular-nums">{formatDuration(shown.times.airportWaiting)}</dd>
		</div>
		<div class="tl-total">
			<dt>Free time</dt>
			<dd class="font-mono tabular-nums">{formatDuration(shown.times.free)}</dd>
		</div>
		<div class="tl-total tl-total-nights">
			<dt>Nights in connection</dt>
			<dd class="font-mono tabular-nums">{shown.nightsInConnection}</dd>
		</div>
		<div class="tl-total tl-total-primary">
			<dt>Total time</dt>
			<dd class="font-mono tabular-nums">{formatDuration(shown.times.total)}</dd>
		</div>
		<div class="tl-total tl-total-primary">
			<dt>Total price</dt>
			<dd class="font-mono tabular-nums">{formatMoney(shown.totalPrice)}</dd>
			<!-- Issue #140: only a stopover that actually spends a night is missing
			     anything. On a same-day connection this total is complete, and warning that
			     it excludes a stay would invent a cost the trip never had. -->
			{#if !shown.stay && shown.nightsInConnection > 0}
				<p class="tl-note tl-note-warning">Excludes an unpriced stopover stay</p>
			{/if}
		</div>
	</dl>
{/if}

<style>
	/* ---------------------------------------------------------------------
	 * Row list. Two columns exposed to every row (a narrow rail, a flexible
	 * content column) so each <li> can subgrid them and every dot / line
	 * lands in the same place regardless of how tall that row's own content
	 * is. This is a different axis from the `subgrid` prop below: this one
	 * is always on, for this component's own internal alignment; that one
	 * opts the whole row list into a *parent's* row tracks.
	 * ------------------------------------------------------------------- */
	.itinerary-timeline {
		position: relative;
		display: grid;
		grid-template-columns: 1.5rem minmax(0, 1fr);
		column-gap: var(--space-3);
		row-gap: var(--space-5);
	}

	/* Issue #25's hook: place this component inside a grid ancestor that defines the shared
	   row tracks, then pass `subgrid` so this list's own rows size to match its siblings'
	   at each position instead of sizing independently. */
	.itinerary-timeline--subgrid {
		grid-row: 1 / -1;
		grid-template-rows: subgrid;
		row-gap: 0;
	}

	.tl-row {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
		align-items: start;
		border-radius: var(--radius-md);
		/* The interactive role (issue #73, the map selection contract) lives on the `<li>`
		   itself, not a wrapper: a wrapper would need its own `grid-template-columns:
		   subgrid`, breaking the two-column contract every row here relies on and the
		   comparator (#25) reads from. */
		cursor: pointer;
		transition: background-color var(--transition-fast);
	}

	.tl-row:hover {
		background: var(--color-surface-hover);
	}

	/* A box-shadow, not `outline`: `outline` is reserved for the global `:focus-visible` ring
	   below, so a row that is both selected and keyboard-focused still shows both, rather than
	   one replacing the other under the same CSS property. */
	.tl-row.is-selected {
		background: var(--color-accent-muted);
		box-shadow: 0 0 0 2px var(--color-accent);
	}

	/* ---------------------------------------------------------------------
	 * The rail: a continuous line down the left edge with a marker per row.
	 * Built from one pseudo-element per row rather than a single absolutely
	 * positioned line for the whole list, so the rail still lines up
	 * correctly under `subgrid` even though row heights then come from a
	 * shared track rather than this component's own content.
	 * ------------------------------------------------------------------- */
	.tl-rail {
		position: relative;
		display: flex;
		justify-content: center;
		height: 100%;
		min-height: 1.5rem;
	}

	.tl-rail::before {
		content: '';
		position: absolute;
		top: 0;
		bottom: calc(-1 * var(--space-5));
		left: 50%;
		width: 2px;
		background: var(--color-border-strong);
		transform: translateX(-50%);
	}

	.tl-row:last-child .tl-rail::before {
		display: none;
	}

	/* Under `subgrid`, the list's own row-gap is 0 (the parent's row tracks decide spacing
	   instead), so the line has nothing to bridge past this row's own bottom edge. */
	.itinerary-timeline--subgrid .tl-rail::before {
		bottom: 0;
	}

	.tl-dot {
		position: relative;
		z-index: 1;
		width: 0.5rem;
		height: 0.5rem;
		margin-top: 0.4rem;
		border-radius: var(--radius-full);
		background: var(--color-border-strong);
	}

	.tl-dot-event {
		width: 0.85rem;
		height: 0.85rem;
		margin-top: 0.3rem;
		background: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.tl-dot-stopover {
		width: 1.1rem;
		height: 1.1rem;
		margin-top: 0.2rem;
		background: var(--color-stopover);
		box-shadow: 0 0 0 4px var(--color-stopover-bg);
	}

	/* ---------------------------------------------------------------------
	 * Row content
	 * ------------------------------------------------------------------- */
	.tl-content {
		min-width: 0;
		padding-bottom: var(--space-1);
	}

	.tl-content-row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.tl-transfer-info,
	.tl-flight-info {
		min-width: 0;
		flex: 1 1 14rem;
	}

	.tl-label {
		font-weight: var(--font-weight-semibold);
		color: var(--color-text);
	}

	.tl-detail {
		margin-top: var(--space-1);
		font-size: var(--font-size-sm);
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

	.tl-note-plusday {
		display: inline-block;
		margin-top: var(--space-1);
		padding: 0 var(--space-2);
		border-radius: var(--radius-sm);
		background: var(--color-warning-bg);
		color: var(--color-warning);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.tl-meta {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: var(--space-1);
		flex: 0 0 auto;
		text-align: right;
	}

	.tl-duration {
		font-size: var(--font-size-sm);
		color: var(--color-text);
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
	 * Local time badges. The clock time is the headline; the calendar date
	 * and UTC offset are always shown alongside it, never only on request,
	 * because AGENTS.md is explicit that a 00:30 arrival must never render
	 * as the previous day. Showing the date every time is what makes that
	 * failure mode impossible to reintroduce later by accident.
	 * ------------------------------------------------------------------- */
	.tl-time {
		display: flex;
		flex-direction: column;
		line-height: 1.3;
	}

	.tl-time-clock {
		font-size: var(--font-size-lg);
		font-weight: var(--font-weight-semibold);
		color: var(--color-text);
	}

	.tl-time-date {
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}

	.tl-time-offset {
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	.tl-flight-times {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		margin-top: var(--space-2);
	}

	.tl-flight-endpoint {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.tl-flight-code {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-faint);
	}

	.tl-flight-arrow {
		color: var(--color-text-faint);
	}

	/* ---------------------------------------------------------------------
	 * Waiting-time editor (brief lines 39 & 69: editable inline).
	 * ------------------------------------------------------------------- */
	.tl-waiting-editor {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}

	.tl-stepper-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		/* 44px minimum touch target, matching Button.svelte's own md size: WCAG 2.5.5, and
		   this app is meant to be used one-handed. */
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
		width: 4rem;
		height: 2.75rem;
		padding: 0 var(--space-2);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-md);
		background: var(--color-surface);
		color: var(--color-text);
		font-size: var(--font-size-base);
		text-align: center;
	}

	.tl-stepper-input:focus-visible {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.tl-stepper-unit {
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	.tl-waiting-formatted {
		margin-left: var(--space-2);
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-medium);
		color: var(--color-text-muted);
	}

	/* ---------------------------------------------------------------------
	 * The stopover row: the emotional payload of the product, so it reads
	 * as the good part rather than as one row among ten. Reuses the
	 * ticket-stub dashed border and warm-accent header treatment from
	 * Card's "ticket" variant, applied directly (rather than wrapping in
	 * <Card>) so this row stays a plain <li> in the flat row list issue #25
	 * depends on.
	 * ------------------------------------------------------------------- */
	.tl-row-stopover {
		margin-block: var(--space-2);
	}

	.tl-stopover {
		padding: var(--space-4);
		border: 2px dashed var(--color-stopover);
		border-radius: var(--radius-lg);
		background: var(--color-stopover-bg);
	}

	.tl-stopover-eyebrow {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		color: var(--color-stopover);
	}

	.tl-stopover-nights {
		margin-top: var(--space-1);
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		font-size: var(--font-size-xl);
		font-weight: var(--font-weight-bold);
		color: var(--color-text);
	}

	/* The night count is a number, so it earns the big mono departure-board treatment.
	   "Day stopover in Bergamo, no overnight stay" is a sentence, and set at the same
	   size it wraps to three lines on a 390px screen and reads as shouting. Same slot,
	   same weight, sentence size. */
	.tl-stopover-sameday {
		font-family: var(--font-sans);
		font-size: var(--font-size-base);
	}

	.tl-free-window {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-5);
		margin-top: var(--space-3);
	}

	.tl-free-caption {
		display: block;
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	/* `--color-text-faint` was only ever checked against `--color-bg`/`--color-surface`
	   (app.css's own comment on the token), not against `--color-stopover-bg` — the one
	   background it also sits on here (the caption above each free-time clock, and the
	   UTC-offset badge inside `timeBadge`). In the dark palette that pairing is 3.55:1,
	   under WCAG AA's 4.5:1 (axe caught it as a real contrast failure, not a false
	   positive). `--color-text-muted` clears 4.5:1 against every background this app
	   uses, stopover included, so this scopes the swap to inside the stopover box rather
	   than touching either token's own definition or every other place they're used. */
	.tl-stopover .tl-free-caption,
	.tl-stopover .tl-time-offset {
		color: var(--color-text-muted);
	}

	.tl-stopover .tl-meta {
		flex-direction: row;
		align-items: center;
		justify-content: flex-start;
		margin-top: var(--space-3);
		gap: var(--space-4);
	}

	/* ---------------------------------------------------------------------
	 * Totals summary: a separate top-level sibling of the row list on
	 * purpose (see this file's header comment): the comparator's own
	 * bottom bar is separate chrome per the brief, not part of the aligned
	 * rows, so a parent that wants to build its own can set showTotals to
	 * false and skip this block entirely.
	 * ------------------------------------------------------------------- */
	.itinerary-timeline-totals {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-5);
		margin-top: var(--space-6);
		padding-top: var(--space-4);
		border-top: 2px dashed var(--color-border-strong);
	}

	.tl-total {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.tl-total dt {
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	.tl-total dd {
		margin: 0;
		font-size: var(--font-size-base);
		color: var(--color-text);
	}

	.tl-total-nights dd {
		color: var(--color-stopover);
	}

	.tl-total-primary dd {
		font-size: var(--font-size-lg);
		font-weight: var(--font-weight-bold);
	}

	/* ---------------------------------------------------------------------
	 * Wider viewports: give flight/transfer rows a dedicated time+price
	 * column instead of letting them wrap under the label.
	 * ------------------------------------------------------------------- */
	@media (min-width: 40rem) {
		.tl-content-row {
			flex-wrap: nowrap;
		}
	}
</style>
