<script lang="ts">
	/**
	 * The panel beside the map: what the connection you are pointing at is worth, over the
	 * list of every connection there is (issue #324).
	 *
	 * ## Detail on top, list below, both always present
	 *
	 * The list never disappears. That is the difference between this panel and issue #319's,
	 * where opening a property replaces the list with its detail, and the difference is the
	 * owner's requirement: he wants to sweep the pointer across close-together points and
	 * watch the answer change. A panel whose lower half rebuilt on every point he crossed
	 * would flicker, and he would lose the list he uses to reach the ones with no point near
	 * the pointer. So the top block changes and the bottom one holds still, and only the
	 * bottom one scrolls.
	 *
	 * ## Every row is a button, so the map is usable with no pointer
	 *
	 * Focusing a row previews it exactly as hovering a map point does. That is what makes
	 * this screen work for a keyboard: a map whose only affordance is hover has no keyboard
	 * story at all, and the list is a linear, ordered, focusable rendering of the same set.
	 *
	 * ## Nothing here recommends anything
	 *
	 * Every figure is copied off the model, which copies it off an itinerary a provider's
	 * data produced. A total that does not cover the whole trip says so in words rather than
	 * being quietly rounded up, and a connection nobody could pair says which rule refused it
	 * rather than "not available".
	 */
	import { AirlineLogo, TimeCell } from '$lib/components';
	import { formatKilometres } from '$lib/components/itinerary-timeline-format';
	import type { IataAirportCode } from '$lib/domain';
	import { formatDuration, formatMoney } from '$lib/format';
	import CalendarStrip from './CalendarStrip.svelte';
	import type { ConnectionCalendar } from './calendar';
	import { describeBlock, describeUnpriced, pointLabel, spokenSummary, STATE_LABEL } from './copy';
	import type { ConnectionOnMap, ConnectionsMapModel, ConnectionState } from './model';

	interface Props {
		model: ConnectionsMapModel;
		/** The connection the detail block is describing: whatever is being pointed at or
		 * focused, else whatever was pinned, else nothing. The dialog owns that resolution. */
		shown?: ConnectionOnMap;
		pinnedCode: IataAirportCode | null;
		/** Loaded lazily for the shown connection only, out of the cache, at zero requests.
		 * Absent while it is still being read, which is a few milliseconds of IndexedDB. */
		calendar?: ConnectionCalendar;
		/** One line counting the four states, from `summariseConnections`. */
		summary: string;
		onpreview: (code: IataAirportCode | null) => void;
		onpin: (code: IataAirportCode) => void;
		/** Opens the results card for this stopover and closes the dialog. The map answers
		 * "which stopovers exist"; picking one is still the list's job. */
		onopen: (code: IataAirportCode) => void;
		/** Airlines the traveller asked to avoid, upper-cased. Quiets their logo the same
		 * way the result card does, which is the only quieting AGENTS.md allows: a logo is a
		 * picture with no contrast ratio to protect, and the words beside it stay full
		 * strength. */
		avoidedCarriers?: ReadonlySet<string>;
	}

	let {
		model,
		shown,
		pinnedCode,
		calendar,
		summary,
		onpreview,
		onpin,
		onopen,
		avoidedCarriers = new Set<string>()
	}: Props = $props();

	/** What each state means, in the words the panel uses for it. Beside `STATE_LABEL` so a
	 * colour, a word and a sentence can never drift apart. */
	const KEY_NOTE: Record<ConnectionState, string> = {
		bookable: 'a flight pair, and every part of the total quoted',
		'part-priced': 'a flight pair, and something on the trip nobody priced',
		blocked: 'no pair of flights works. The row says which rule refused it',
		pending: 'nobody has finished looking at this one yet'
	};

	function priceOf(connection: ConnectionOnMap): string | undefined {
		if (connection.state !== 'bookable' && connection.state !== 'part-priced') return undefined;
		return formatMoney(connection.trip.best.score.itinerary.totalPrice);
	}

	/** Announced on every change of what the panel is showing, instead of the detail block
	 * being a live region. See `spokenSummary` for why the whole block is the wrong unit. */
	const spoken = $derived.by(() => {
		if (!shown) return '';
		const trip = shown.state === 'bookable' || shown.state === 'part-priced' ? shown.trip : undefined;
		return spokenSummary(shown, {
			price: trip ? formatMoney(trip.best.score.itinerary.totalPrice) : undefined,
			flightTime: trip ? formatDuration(trip.flightTime) : undefined,
			nights: trip?.best.score.itinerary.nightsInConnection
		});
	});
</script>

<p class="visually-hidden" role="status">{spoken}</p>

<div class="panel">
	<!-- Named, because Chromium puts a scrollable region with no focusable children into the
	     tab order on purpose, so a keyboard reader can scroll it. Measured: tabbing off the
	     close button lands here before the first stopover row. That stop is correct and worth
	     keeping; what it must not be is an unlabelled one. -->
	<div class="panel-detail" role="group" aria-label="What this connection is worth">
		{#if shown}
			{@const airport = shown.airport}
			<h3 class="panel-name">
				{airport.city.name}
				<span class="panel-code font-mono">{airport.iataCode}</span>
			</h3>
			<p class="panel-status">
				<span class={['panel-chip', `is-${shown.state}`]}>{STATE_LABEL[shown.state]}</span>
				<span class="panel-detour font-mono tabular-nums">
					{#if shown.extraKm < 1}
						As straight as a direct flight
					{:else}
						{formatKilometres(shown.extraKm)} further than a direct flight
					{/if}
				</span>
			</p>

			{#if shown.state === 'blocked'}
				{@const copy = describeBlock(shown.block)}
				<p class="panel-block-headline">{copy.headline}</p>
				{#if copy.detail}<p class="panel-note">{copy.detail}</p>{/if}
			{:else if shown.state === 'pending'}
				<p class="panel-note">Still looking at this one. Nothing is known about it yet.</p>
			{:else}
				{@const trip = shown.trip}
				{@const itinerary = trip.best.score.itinerary}
				{@const unpricedNote = describeUnpriced(trip.unpriced)}

				<p class="panel-price font-mono tabular-nums">
					{formatMoney(itinerary.totalPrice)}
					{#if unpricedNote}<span class="panel-price-floor">and up</span>{/if}
				</p>
				{#if unpricedNote}<p class="panel-note">{unpricedNote}</p>{/if}

				<dl class="panel-rail">
					<div class="panel-figure">
						<dt class="panel-figure-label font-mono">In the air</dt>
						<dd class="panel-figure-value font-mono tabular-nums">{formatDuration(trip.flightTime)}</dd>
					</div>
					<div class="panel-figure">
						<dt class="panel-figure-label font-mono">Layover</dt>
						<dd class="panel-figure-value font-mono tabular-nums">{formatDuration(trip.layover)}</dd>
					</div>
					<div class="panel-figure">
						<dt class="panel-figure-label font-mono">Nights</dt>
						<dd class="panel-figure-value font-mono tabular-nums">{itinerary.nightsInConnection}</dd>
					</div>
				</dl>
				<p class="panel-note">
					Your minimum layover is {formatDuration(model.minLayoverTime)}.
				</p>

				<ul class="panel-legs">
					{#each [itinerary.outboundFlight, itinerary.onwardFlight] as flight (flight.flightNumber + flight.departure.local)}
						<li class="panel-leg">
							<span class="panel-leg-route font-mono">
								{flight.departureAirport}&nbsp;&rarr;&nbsp;{flight.arrivalAirport}
							</span>
							<span class="panel-leg-times">
								<TimeCell value={flight.departure} />
								<TimeCell value={flight.arrival} reference={flight.departure} align="end" />
							</span>
							<span class="panel-leg-carrier">
								<AirlineLogo
									iataCode={flight.carrier.iataCode}
									name={flight.carrier.name}
									deprioritized={avoidedCarriers.has(flight.carrier.iataCode.toUpperCase())}
								/>
								{flight.carrier.name}
								<span class="font-mono">{flight.flightNumber}</span>
							</span>
							<span class="panel-leg-duration font-mono tabular-nums">{formatDuration(flight.duration)}</span>
						</li>
					{/each}
				</ul>

				{#if trip.best.score.avoidedAirlineFlightCount > 0}
					<p class="panel-warning">
						{trip.best.score.avoidedAirlineFlightCount === 2
							? 'Both flights are on an airline you asked to avoid.'
							: 'One flight is on an airline you asked to avoid.'}
					</p>
				{/if}

				{#if itinerary.nightsInConnection > 0}
					<p class="panel-note">
						{#if itinerary.stay}
							A bed here is priced at {formatMoney(itinerary.stay.pricePerNight)} a night.
						{:else}
							Nobody priced a bed in this city.
						{/if}
					</p>
				{/if}

				{#if trip.otherPairings > 0}
					<p class="panel-note">
						{trip.otherPairings}
						{trip.otherPairings === 1 ? 'other pairing' : 'other pairings'} through here, on the results card.
					</p>
				{/if}
			{/if}

			{#if calendar}
				<div class="panel-calendar">
					<CalendarStrip calendar={calendar.outbound} label="Out" />
					<CalendarStrip calendar={calendar.onward} label="On" />
					<p class="panel-note">Days already in this browser's cache. Nothing was fetched to draw them.</p>
				</div>
			{/if}

			{#if shown.state === 'bookable' || shown.state === 'part-priced'}
				<button type="button" class="panel-open" onclick={() => onopen(airport.iataCode)}>
					Open this stopover in the results
				</button>
			{/if}
		{:else}
			<p class="panel-lead">{summary}</p>
			<p class="panel-note">
				Point at a city on the map, or a row below, to see what stopping there is worth. Clicking one
				keeps it here while you look at the others.
			</p>
			<!-- The one thing the picture cannot say for itself. Every state is drawn in a
			     colour AND a shape, and this is where the words for both live. -->
			<ul class="panel-key">
				{#each ['bookable', 'part-priced', 'blocked', 'pending'] as const as state (state)}
					<li class="panel-key-row">
						<span class={['panel-key-dot', `is-${state}`]} aria-hidden="true"></span>
						<span class="panel-key-label">{STATE_LABEL[state]}</span>
						<span class="panel-key-note">{KEY_NOTE[state]}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	<ul class="panel-list">
		{#each model.connections as connection (connection.airport.iataCode)}
			{@const price = priceOf(connection)}
			<li>
				<button
					type="button"
					class={[
						'panel-row',
						`is-${connection.state}`,
						{ 'is-shown': connection.airport.iataCode === shown?.airport.iataCode },
						{ 'is-pinned': connection.airport.iataCode === pinnedCode }
					]}
					aria-pressed={connection.airport.iataCode === pinnedCode}
					aria-label={pointLabel(connection, price)}
					onpointerenter={() => onpreview(connection.airport.iataCode)}
					onpointerleave={() => onpreview(null)}
					onfocus={() => onpreview(connection.airport.iataCode)}
					onblur={() => onpreview(null)}
					onclick={() => onpin(connection.airport.iataCode)}
				>
					<span class="panel-row-name">{connection.airport.city.name}</span>
					<span class="panel-row-code font-mono">{connection.airport.iataCode}</span>
					{#if price}
						<span class="panel-row-price font-mono tabular-nums">{price}</span>
					{:else}
						<span class="panel-row-state">{STATE_LABEL[connection.state]}</span>
					{/if}
				</button>
			</li>
		{/each}
	</ul>
</div>

<style>
	/* Two rows in a FIXED proportion, each scrolling on its own. Not `auto` for the detail,
	   and that is the whole point.

	   With an auto row the detail grew the moment a row was pointed at, which pushed the
	   list down, which moved the row out from under the pointer, which cleared the preview,
	   which shrank the detail again. Playwright caught it as "the panel intercepts pointer
	   events" on a click that never landed; a person would have seen a row flickering away
	   from the cursor. A sweep across a dozen stopovers is the core interaction here, so
	   nothing in this panel may change size when the shown connection changes. */
	.panel {
		display: grid;
		grid-template-rows: minmax(0, 3fr) minmax(0, 2fr);
		gap: var(--space-3);
		min-height: 0;
		height: 100%;
	}

	/* The classic pure-CSS scroll shadow: two `local` gradients that scroll with the content
	   and two `scroll` ones that stay put, so a shadow appears at whichever end has more
	   below or above it and vanishes at the ends. It earns its lines here because a fixed
	   half of the panel cannot hold a whole stopover, so the calendar and the open button
	   genuinely are below the fold, and a hard cut with no cue reads as a rendering fault
	   rather than as "there is more". */
	.panel-detail {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding-right: var(--space-1);
		background:
			linear-gradient(var(--color-bg-elevated) 30%, transparent) top / 100% 1.5rem no-repeat local,
			linear-gradient(transparent, var(--color-bg-elevated) 70%) bottom / 100% 1.5rem no-repeat local,
			radial-gradient(farthest-side at 50% 0, rgb(3 5 14 / 35%), transparent) top / 100% 0.5rem no-repeat
				scroll,
			radial-gradient(farthest-side at 50% 100%, rgb(3 5 14 / 35%), transparent) bottom / 100% 0.5rem
				no-repeat scroll;
	}

	/* A column flex container with a bounded height shrinks its children, and a paragraph
	   that shrinks is a paragraph with its last line cut off rather than one that scrolls.
	   Measured at 1280: the opening sentence lost its third line. */
	.panel-detail > :global(*) {
		flex: none;
	}

	.panel-name {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-2);
		margin: 0;
		font-size: var(--font-size-base);
		font-weight: var(--font-weight-semibold);
		line-height: var(--line-height-sm);
	}

	.panel-code {
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
		letter-spacing: var(--tracking-wide);
	}

	.panel-status {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		margin: 0;
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}

	/* The chip repeats the point's colour and adds the word, so nothing on this screen is
	   told by hue alone (WCAG 1.4.1). */
	.panel-chip {
		padding: 2px var(--space-2);
		border: 1px solid currentcolor;
		border-radius: var(--radius-full);
		font-size: 0.625rem;
		font-weight: var(--font-weight-medium);
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
	}

	.panel-chip.is-bookable {
		color: var(--color-stopover);
	}

	.panel-chip.is-part-priced {
		color: var(--color-accent);
	}

	.panel-chip.is-blocked,
	.panel-chip.is-pending {
		color: var(--color-text-muted);
	}

	.panel-price {
		margin: 0;
		font-size: var(--font-size-lg);
		font-weight: var(--font-weight-semibold);
	}

	/* "and up", not a symbol. `Itinerary.totalPrice` is documented as a floor whenever a
	   part went unpriced, and a bare number would make the stopover nobody could price look
	   like the cheapest one on the map. */
	.panel-price-floor {
		margin-left: var(--space-1);
		font-family: var(--font-sans);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-regular);
		color: var(--color-text-muted);
	}

	.panel-block-headline {
		margin: 0;
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-medium);
		color: var(--color-text);
	}

	.panel-note {
		margin: 0;
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-muted);
	}

	.panel-warning {
		margin: 0;
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-warning);
	}

	.panel-lead {
		margin: 0;
		font-size: var(--font-size-sm);
		line-height: var(--line-height-sm);
		color: var(--color-text);
		text-wrap: balance;
	}

	.panel-key {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin: var(--space-1) 0 0;
		padding: 0;
		list-style: none;
	}

	.panel-key-row {
		display: grid;
		grid-template-columns: 0.75rem minmax(0, 1fr);
		gap: 0 var(--space-2);
		align-items: baseline;
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
	}

	/* The same fill-versus-hole distinction the map draws, so the key is the picture rather
	   than a second vocabulary for it. */
	.panel-key-dot {
		width: 0.625rem;
		height: 0.625rem;
		border-radius: var(--radius-full);
		translate: 0 1px;
	}

	.panel-key-dot.is-bookable {
		background: var(--color-stopover);
	}

	.panel-key-dot.is-part-priced {
		background: var(--color-accent);
	}

	.panel-key-dot.is-blocked,
	.panel-key-dot.is-pending {
		box-shadow: inset 0 0 0 2px var(--color-text-faint);
	}

	.panel-key-label {
		color: var(--color-text);
		font-weight: var(--font-weight-medium);
	}

	.panel-key-note {
		grid-column: 2;
		color: var(--color-text-muted);
	}

	.panel-rail {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(5rem, 1fr));
		gap: var(--space-2) var(--space-3);
		margin: 0;
	}

	.panel-figure {
		min-width: 0;
	}

	.panel-figure-label {
		font-size: 0.625rem;
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-muted);
	}

	.panel-figure-value {
		margin: 0;
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
	}

	.panel-legs {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.panel-leg {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: var(--space-1) var(--space-2);
		padding-top: var(--space-2);
		border-top: 1px solid var(--color-border);
	}

	.panel-leg-route {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-wide);
	}

	.panel-leg-times {
		display: flex;
		grid-column: 1 / -1;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.panel-leg-carrier {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		min-width: 0;
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
		overflow-wrap: anywhere;
	}

	.panel-leg-duration {
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
		text-align: right;
	}

	.panel-calendar {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding-top: var(--space-2);
		border-top: 1px solid var(--color-border);
	}

	.panel-open {
		align-self: flex-start;
		min-height: 2.75rem;
		padding: 0 var(--space-3);
		border: 1px solid var(--color-accent);
		border-radius: var(--radius-full);
		background: none;
		color: var(--color-accent);
		font: inherit;
		font-size: var(--font-size-xs);
		cursor: pointer;
		touch-action: manipulation;
	}

	.panel-open:hover {
		background: var(--color-surface-hover);
	}

	.panel-list {
		display: flex;
		flex-direction: column;
		gap: 1px;
		margin: 0;
		padding: 0 var(--space-1) 0 0;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		list-style: none;
		border-top: 1px solid var(--color-border);
	}

	.panel-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
		align-items: baseline;
		gap: var(--space-2);
		width: 100%;
		min-height: 44px;
		padding: var(--space-2);
		text-align: left;
		border: 1px solid transparent;
		border-radius: var(--radius-md);
		background: none;
		color: var(--color-text);
		font: inherit;
		cursor: pointer;
		touch-action: manipulation;
	}

	.panel-row:hover,
	.panel-row.is-shown {
		background: var(--color-surface-hover);
	}

	.panel-row.is-pinned {
		border-color: var(--color-text-faint);
	}

	.panel-row.is-blocked .panel-row-name,
	.panel-row.is-pending .panel-row-name {
		color: var(--color-text-muted);
	}

	.panel-row:focus-visible,
	.panel-open:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	.panel-row-name {
		font-size: var(--font-size-sm);
		overflow-wrap: anywhere;
	}

	.panel-row-code {
		font-size: 0.625rem;
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-faint);
	}

	.panel-row-price {
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-medium);
		white-space: nowrap;
	}

	.panel-row-state {
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
		white-space: nowrap;
	}
</style>
