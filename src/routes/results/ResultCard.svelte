<script lang="ts">
	/**
	 * One itinerary, ticket-shaped, built to be compared against the card above and below
	 * it rather than read on its own.
	 *
	 * ## What earns a place here, and what does not
	 *
	 * The card used to print one number, "Total time", and hide the rest of brief lines
	 * 55-60 behind an expander. Everything on it now is something a person actually weighs
	 * when choosing between two trips:
	 *
	 * - **Getting there** (`PriceLine`). The whole cost of this trip at the length on
	 *   screen, with the three payments that make it: flights, bed at its nightly rate,
	 *   ground with its ride count. "€273" alone is a number you have to open a panel to
	 *   trust.
	 * - **The trip strip** (`TripStrip`), roughly proportional to real time. The shape of
	 *   the trip is the fastest thing on the card to read, and it carries the two figures
	 *   that matter most (nights, and how long the stopover runs) in the place where they
	 *   mean something spatially. Nights ride here and nowhere else on the card: the
	 *   strip's caption already prints "2 nights in Vienna" in bold teal.
	 * - **Free time, in flight, airport wait, door to door** (`MetricRail`, the four in
	 *   `CARD_METRIC_IDS`). The figures that decide whether a cheap itinerary is actually
	 *   cheap. Airport waiting in particular is the cost nobody quotes. Free time is a day
	 *   count since issue #228, "2 full days" rather than the "2d 15h" the owner called
	 *   misleading; the edge times and the stay it buys are in the unfolded timeline,
	 *   because seven lines times four cards is not a results screen.
	 *
	 * ## Issue #278: the card stopped being a thing you open
	 *
	 * There was a "Show details" button under a dashed rule, and everything worth doing
	 * was behind it. The owner: **"the card does not need to be expandable like now. we now
	 * have a nice timeline preview already in the card, so the other timeline that is
	 * hidden barely adds any info. we can keep bot timelines, basically we make the preview
	 * expandable."**
	 *
	 * So the strip is the thing that opens, from its own caption, and the full timeline
	 * unfolds directly under the preview it belongs to. Two blocks left this file for the
	 * customise rail: `StopoverNights`, the "staying longer" ladder, which is now part of
	 * the stopover's own panel because how long you stay is a property of the stopover;
	 * and the control row itself. That is 76px and 54px of a 646px phone card, plus the
	 * gaps around them.
	 *
	 * `variantsLabel` went with them. "+2 more flight times through here" existed to
	 * advertise what the button hid, and nothing hides them now: the timeline marks the
	 * rows that have alternatives, and the flight picker in the rail lists them.
	 *
	 * The header's freshness badge renders only when its tone is not neutral. "Current
	 * price" and "Priced 3m ago" said the same thing as the footer's "fetched 3m ago" one
	 * line apart, and on a 375px screen the badge wrapped under the route and cost the
	 * card a row it could not spare: 635px of card against 620px of screen.
	 *
	 * What was cut, deliberately: per-flight prices and per-leg times (they are in the
	 * expanded panel, where a leg can also be swapped, and five prices on a card is a
	 * spreadsheet); the airline name chips, now carried by the logos on the strip and the
	 * names in the footer; the free-time start and end timestamps, since the strip already
	 * says how long it runs and the exact clock readings only matter once you are planning
	 * inside the stopover; and the one-line "why this is good" sentence, which restated in
	 * prose the two numbers now printed as numbers.
	 *
	 * Every derived string comes from `$lib/format`, `itinerary-metrics.ts` or
	 * `view-model.ts`, all pure and tested. This file arranges markup and picks classes; it
	 * never recomputes a duration or a price.
	 */
	import type { Snippet } from 'svelte';
	import { AirlineLogo, Card, Flag, FlightDetour, MetricRail, PriceLine, TripStrip } from '$lib/components';
	import { CARD_METRIC_IDS } from '$lib/components/itinerary-metrics';
	import { buildItineraryMapModel } from '$lib/itinerary-map/segments';
	import { buildFlightShape } from '$lib/itinerary-map/previews';
	import type { Airport, Itinerary } from '$lib/domain';
	import type { ItinerarySegmentId } from '$lib/itinerary-map/segment-id';
	import { formatAge } from '$lib/format';
	import { oneAdultFlightsTotal, placeInBand } from '$lib/results/price-band';
	import type { PriceHistory } from '$lib/results/price-band';
	import { connectionAirportCode } from '$lib/results/types';
	import type { ScoredResult } from '$lib/results/types';
	import { describePriceFreshness } from '$lib/results/view-model';
	import { technicalStopDetail, technicalStopLabel } from '$lib/components/technical-stop-note';
	import PriceBand from './PriceBand.svelte';

	interface Props {
		result: ScoredResult;
		/** Resolved lazily by the page (getAirport is async); undefined until then, in
		 * which case the card falls back to the bare IATA code rather than blocking. */
		connectionAirport?: Airport;
		/** Issue #232: the price history the whole search shares, when there is enough of it
		 * to draw. One band per results page rather than one per card, so every card is
		 * marked against the same distribution and the same denominator. Absent means the
		 * browser has not seen enough of this route to say anything, which is the default
		 * for a first-time visitor and is why nothing renders. */
		priceBand?: PriceHistory;
		/**
		 * Issue #278: the trip on screen. Usually `result.itinerary` straight from the
		 * stream, and the traveller's own edited copy once they have changed something in
		 * the customise rail. It arrives as a prop rather than being read off `result`
		 * because the rail is a sibling of this card, not a child of it, and the page is
		 * the one thing that can hold a trip both of them read. Two components deriving
		 * their own copy of one trip is what #243, #250, #264, #265 and #266 all were.
		 */
		itinerary: Itinerary;
		/** Which stretch of this trip the customise rail is showing, or `null` when the
		 * rail is showing another card or nothing. */
		selectedSegmentId?: ItinerarySegmentId | null;
		onSelectSegment?: (segment: ItinerarySegmentId) => void;
		/** Whether the full timeline is unfolded under the strip. */
		timelineOpen?: boolean;
		onToggleTimeline?: () => void;
		/** The full timeline, map and stopover block. Rendered by the page so this card does
		 * not have to know what any of them need. */
		timeline?: Snippet;
	}

	let {
		result,
		itinerary,
		connectionAirport,
		priceBand,
		selectedSegmentId = null,
		onSelectSegment,
		timelineOpen = false,
		onToggleTimeline,
		timeline
	}: Props = $props();

	const timelineId = $props.id();
	const connectionCode = $derived(connectionAirportCode(itinerary));

	/**
	 * Issue #278: on a phone the customise panel is a sheet at the foot of the screen, and a
	 * reader who taps a 3px transfer seam and gets a panel sitting on top of it has lost the
	 * context that made the tap mean anything.
	 *
	 * `scroll-margin-bottom` below inflates this block's box by the sheet's own height for
	 * scrolling purposes only, so `block: 'nearest'` lands the strip above the sheet rather
	 * than merely inside the viewport. On a wide screen the margin is zero and this call is a
	 * no-op for a strip already on screen.
	 *
	 * An effect rather than a handler because the selection arrives as a prop: it can be set
	 * from the timeline or the map as well as from the strip. It reads props and calls a DOM
	 * method, and writes no state, so it cannot retrigger itself (AGENTS.md, the `$effect`
	 * trap).
	 */
	let stripEl = $state<HTMLElement>();
	$effect(() => {
		if (!selectedSegmentId || !stripEl) return;
		// `scrollIntoView` takes no notice of `prefers-reduced-motion` on its own, unlike the
		// CSS transitions app.css already flattens for it. A reader who has asked for less
		// motion gets the same final position without the travel.
		const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		stripEl.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
	});

	/**
	 * Issue #280's flight ornament: the two arcs actually flown against the shortest line
	 * that exists between the same two airports.
	 *
	 * Built here rather than inside `FlightDetour` so the component takes plain data and
	 * stays testable without a dataset. Cheap enough to sit on a card: two great-circle
	 * arcs of 65 points each, no network, no WebGL. `tools/probe-map-cost.mjs` has the
	 * numbers for why this is an SVG and not a map.
	 */
	const flightShape = $derived(
		connectionAirport ? buildFlightShape(buildItineraryMapModel(itinerary, connectionAirport)) : undefined
	);
	const isDeprioritized = $derived(result.score.avoidedAirlineFlightCount > 0);
	const freshness = $derived(describePriceFreshness(result.price.freshness));
	// A neutral badge repeats the footer's "fetched 3m ago" one line down, so only a tone
	// with something to warn about earns the header row (see the file header).
	const showFreshness = $derived(freshness.tone !== 'neutral');

	/**
	 * Issue #232: the figure the band is drawn against, and where it lands.
	 *
	 * One adult and flights only, which is not the headline above it. The headline is the
	 * whole door-to-door cost for the party; the ledger holds one-adult fares and nothing
	 * else, so this is the only like-for-like comparison available and `PriceBand`'s own
	 * caption says which figure it is marking. `oneAdultFlightsTotal` returns nothing for a
	 * party-total fare or two currencies, and the band then does not render for this card
	 * while still rendering for its neighbours, which is correct: the fact is missing for
	 * this itinerary, not for the route.
	 */
	const comparableFlights = $derived(oneAdultFlightsTotal(itinerary));
	const bandPosition = $derived(
		priceBand && comparableFlights && comparableFlights.currency === priceBand.currency
			? placeInBand(priceBand, comparableFlights.minorUnits)
			: undefined
	);

	const connectionLabel = $derived(connectionAirport?.city.name ?? connectionCode);
	// The owner, on a trip connecting through Gatwick: "london has multiple airports so the
	// string LGW must be in there. and the other origin and end also should have city
	// name." Both halves of that were true and they pulled opposite ways: the stopover
	// named a city and dropped the code, on the one leg where the code decides whether the
	// trip is even feasible (Gatwick and Heathrow are 76km and an hour and a half apart),
	// while the endpoints printed a code with no place attached, unreadable to anyone who
	// does not already know BVC is Boa Vista. Every leg now carries both.
	const originCity = $derived(itinerary.originAirport.city.name);
	const destinationCity = $derived(itinerary.destinationAirport.city.name);
	// Only when it says something the city does not. "Pafos PFO" earns both; a city whose
	// name the code already repeats does not, and neither does an airport whose city we
	// could not resolve, where `connectionLabel` is already the bare code.
	const showConnectionCode = $derived(connectionLabel !== connectionCode);
	// The owner's report was one line reading "Velika Gorica ZAG": the wrong city name
	// (fixed in data/airport-city-names.ts) and no country at all. A stopover is a place
	// he has to decide about, and "Zagreb" alone still leaves him working out which
	// country he would be spending two nights in. Undefined until the airport record
	// resolves, which is the same reason `connectionLabel` falls back to the bare code.
	const connectionCountry = $derived(connectionAirport?.country.name);

	// Provenance: distinct provider labels behind this price, and the OLDEST of their
	// fetch times, the same "oldest part wins" reasoning `types.ts`'s freshness
	// derivation uses, so this footer's age never reads fresher than the badge above it.
	const providerLabels = $derived(Array.from(new Set(result.price.parts.map((part) => part.providerLabel))));
	const oldestFetchedAt = $derived(
		result.price.parts.length > 0
			? Math.min(...result.price.parts.map((part) => new Date(part.fetchedAt).getTime()))
			: undefined
	);
	const fetchedAgo = $derived(oldestFetchedAt !== undefined ? formatAge(Date.now() - oldestFetchedAt) : undefined);
	// One string for both the footer text and its `title`: the footer is a single line
	// and this end of it ellipsises on a phone, so the full sentence is one hover away.
	const sourceText = $derived(
		`via ${providerLabels.join(' & ')}${fetchedAgo ? `, fetched ${fetchedAgo}` : ''}`
	);

	// Both carriers, deduped: a single-airline itinerary should say the airline once. The
	// strip already shows each leg's mark, so this row is the names, in the footer where
	// provenance lives.
	const carriers = $derived(
		[itinerary.outboundFlight.carrier, itinerary.onwardFlight.carrier].filter(
			(carrier, index, all) => all.findIndex((other) => other.iataCode === carrier.iataCode) === index
		)
	);

	// One note per leg that has a technical stop, which for almost every itinerary is none
	// at all. Keyed by segment rather than by index so a picker swap that changes only the
	// onward leg does not re-key the outbound note.
	const technicalStopNotes = $derived(
		(
			[
				['outbound', itinerary.outboundFlight],
				['onward', itinerary.onwardFlight]
			] as const
		)
			.map(([key, flight]) => ({
				key,
				label: technicalStopLabel(flight),
				detail: technicalStopDetail(flight)
			}))
			.filter(
				(note): note is { key: 'outbound' | 'onward'; label: string; detail: string } =>
					note.label !== undefined
			)
	);

	// Card's `class` prop is a plain string (its own internal `class={[...]}` array
	// syntax only applies to the DOM element it renders, not to what a caller passes
	// in), so the conditional class is built here rather than handed through as an
	// array or object.
	const cardClassName = $derived(`result-card${isDeprioritized ? ' is-deprioritized' : ''}`);
</script>

<Card variant="ticket" elevated padded={false} class={cardClassName}>
	{#snippet header()}
		<div class="route">
			<span class="route-leg">
				<Flag country={itinerary.originAirport.country} />
				<span class="place"
					><span class="city">{originCity}</span><span class="iata font-mono tabular-nums"
						>{itinerary.originAirport.iataCode}</span
					></span
				>
			</span>
			<span class="route-arrow" aria-hidden="true">→</span>
			<span class="route-leg route-leg-stopover">
				<!-- Decorative here alone: this leg spells the country out beside the flag,
				     so announcing it twice only slows a screen reader down. -->
				<Flag country={connectionAirport?.country} decorative />
				<!-- City, code and country share one flex item on purpose: they are one
				     place name, and separate items would put the row's gap in front of the
				     comma. -->
				<span class="place"
					><span class="city">{connectionLabel}</span>{#if showConnectionCode}<span
							class="iata font-mono tabular-nums">{connectionCode}</span
						>{/if}{#if connectionCountry}<span class="country">, {connectionCountry}</span>{/if}</span
				>
			</span>
			<span class="route-arrow" aria-hidden="true">→</span>
			<span class="route-leg">
				<Flag country={itinerary.destinationAirport.country} />
				<span class="place"
					><span class="city">{destinationCity}</span><span class="iata font-mono tabular-nums"
						>{itinerary.destinationAirport.iataCode}</span
					></span
				>
			</span>
			{#if isDeprioritized || showFreshness}
				<span class="header-badges">
					{#if isDeprioritized}
						<!-- The one fact `describeWhyGood`'s sentence carried that no number on
						     this card does. It has to be a word, not the greyed-out treatment
						     alone: colour is the only other channel carrying it, and WCAG 1.4.1
						     is explicit that colour is never the sole means of conveying
						     information. -->
						<span class="avoid-badge">Airline you avoid</span>
					{/if}
					{#if showFreshness}
						<span class={['freshness-badge', `freshness-${freshness.tone}`]}>{freshness.label}</span>
					{/if}
				</span>
			{/if}
		</div>
	{/snippet}

	<div class="card-main">
		<PriceLine {itinerary} cityCentre={connectionAirport?.city.coordinates} />

		<!-- Issue #232: directly under the receipt, because the band is about the figure in
		     it and a comparison printed anywhere else is a rank with no anchor on screen.
		     Above "Staying longer" so the card reads in order: what this costs, whether that
		     is a good price, what a longer stay would cost. -->
		{#if priceBand && bandPosition && comparableFlights}
			<PriceBand
				band={priceBand}
				position={bandPosition}
				comparable={comparableFlights}
				route={{ origin: itinerary.originAirport.iataCode, destination: itinerary.destinationAirport.iataCode }}
				deprioritized={isDeprioritized}
			/>
		{/if}

		<!-- Issue #278: the preview is the expander. Its stopover caption carries the
		     control, so the affordance sits on the thing that opens and the card spends no
		     row on a button of its own. -->
		<div class="card-strip" bind:this={stripEl}>
			<TripStrip
				{itinerary}
				{connectionCode}
				{connectionLabel}
				{connectionAirport}
				deprioritized={isDeprioritized}
				{selectedSegmentId}
				{onSelectSegment}
				expanded={timelineOpen}
				onToggleExpanded={onToggleTimeline}
				controlsId={timelineId}
			/>
		</div>

		<!-- Issue #280. Beside the strip on purpose: the strip is the trip's shape in time,
		     this is its shape in space, and the two questions a person asks about a
		     connection ("how long does it cost me" and "how far out of the way is it") then
		     sit next to each other. Renders only once the page has resolved the connection
		     airport, since without it there is no second flight leg to compare. -->
		{#if flightShape}
			<FlightDetour shape={flightShape} />
		{/if}

		<!-- Under the two previews rather than below the totals, because the brief's own
		     words are that the preview opens into the full timeline. It sits after #280's
		     detour rather than between it and the strip: those two are one pair, the trip's
		     shape in time beside its shape in space, and unfolding a timeline between them
		     would separate a comparison somebody built on purpose. -->
		{#if timelineOpen && timeline}
			<div id={timelineId}>{@render timeline()}</div>
		{/if}

		<MetricRail {itinerary} ids={CARD_METRIC_IDS} />
	</div>

	{#snippet footer()}
		<p class="provenance">
			<span class="carriers">
				{#each carriers as carrier (carrier.iataCode)}
					<span class="carrier">
						<AirlineLogo iataCode={carrier.iataCode} name={carrier.name} deprioritized={isDeprioritized} />
						{carrier.name}
					</span>
				{/each}
				<!-- Issue #210. A leg that touches down on the way is a different product
				     from a nonstop, and nothing else on the collapsed card says so. Kept to
				     the honest claim and no more: "1 stop, no plane change", with the
				     airport and the ground time waiting in the title and in the expanded
				     timeline row. Deliberately NOT drawn into the trip strip, which issue
				     #209 is rebuilding — one honest sentence here beats two components
				     disagreeing about the same flight. -->
				{#each technicalStopNotes as note (note.key)}
					<span class="technical-stop" title={note.detail}>{note.label}</span>
				{/each}
			</span>
			<span class="provenance-source" title={sourceText}>{sourceText}</span>
		</p>
	{/snippet}
</Card>

<style>
	.result-card {
		/* Reserve-space: every card, real or skeleton, commits to this minimum height so
		   a card replacing a skeleton never reflows the cards below it. That is the
		   floor's only job, so it sits just under the shortest real card rather than
		   handing the phone card back the height this file just took off it. */
		min-height: 11rem;
	}

	.result-card.is-deprioritized {
		/* Colour only, never opacity (AGENTS.md, .is-deprioritized), the border also
		   drops to the quiet, non-"strong" tone so the whole card reads as background
		   noise without losing legibility. */
		border-color: var(--color-border);
	}

	.route {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	.route-leg {
		display: inline-flex;
		align-items: baseline;
		gap: var(--space-1);
		/* Three place names on one row is more than a 375px phone holds, so a leg wraps
		   whole rather than splitting a city from its code. */
		min-width: 0;
	}

	.place {
		display: inline-flex;
		align-items: baseline;
		min-width: 0;
	}

	/* Spaced by margin, not by the flex gap: a gap would also sit between the code and
	   the country's leading comma, printing "London LGW , United Kingdom". */
	.place .iata {
		margin-left: var(--space-1);
	}

	.place .city {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Three cities and three codes already wrap to three lines on a 375px phone, and the
	   flag beside the stopover says the country without spending one of them. Measured:
	   the route block is 89px tall with the country and 50px without, against a card
	   #197 had just brought down to 462px. The name comes back as soon as there is room
	   for it, and the flag carries it meanwhile. */
	.country {
		display: none;
	}

	@media (min-width: 30rem) {
		.country {
			display: inline;
		}
	}

	.route-leg-stopover .city {
		color: var(--color-stopover);
		font-weight: var(--font-weight-semibold);
	}

	/* `.is-deprioritized` lands on Card's own root element (it arrives there as a plain
	   string prop, see `cardClassName` above), which is outside this component's own
	   scoped markup, :global() is what tells Svelte that ancestor genuinely exists at
	   runtime instead of flagging the rule as dead. */
	:global(.is-deprioritized) .route-leg-stopover .city {
		color: var(--color-text-deprioritized);
	}

	.country {
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-regular);
		color: var(--color-text-muted);
	}

	.iata {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.route-arrow {
		color: var(--color-text-faint);
	}

	/* The badges ride in the header rather than beside the price: they are facts about the
	   whole card, and pinning them to the right of the route line keeps the price row free
	   for the price and its parts. */
	.header-badges {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: flex-end;
		gap: var(--space-2);
		margin-left: auto;
	}

	.avoid-badge {
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius-full);
		background: var(--color-bg-inset);
		color: var(--color-text-deprioritized);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
	}

	.freshness-badge {
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius-full);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
	}

	.freshness-info {
		color: var(--color-info);
		background: var(--color-info-bg);
	}

	.freshness-warning {
		color: var(--color-warning);
		background: var(--color-warning-bg);
	}

	/* A plain box around the strip, purely so there is something to scroll to and something
	   to hang a scroll margin on. It changes no geometry: the strip is a flex column and this
	   wrapper is a block of exactly its height. NOT `display: contents`, which would leave it
	   with no box and make `scrollIntoView` a no-op. */
	.card-strip {
		min-width: 0;
	}

	.card-main {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		padding: var(--space-4) var(--space-5);
	}

	/* One line, always. On a phone this footer spent three on "ZZ" and "via Ryanair (no
	   key required) & OSRM (walking & driving), fetched this minute"; the carriers keep
	   their full width and the source text gives way, its full sentence on `title`. */
	.provenance {
		display: flex;
		flex-wrap: nowrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2) var(--space-4);
		margin: 0;
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	.carriers {
		display: flex;
		flex-wrap: wrap;
		flex-shrink: 0;
		align-items: center;
		gap: var(--space-3);
	}

	.provenance-source {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.carrier {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		color: var(--color-text-muted);
	}

	:global(.is-deprioritized) .carrier {
		color: var(--color-text-deprioritized);
	}

	/* Issue #210. Reads as a stamped note on the ticket stub rather than a status badge:
	   this is a fact about the flight, not a warning about it, and the flight is often the
	   best option on the board. */
	.technical-stop {
		display: inline-flex;
		align-items: center;
		padding: 0 var(--space-2);
		border: 1px dashed var(--color-border-strong);
		border-radius: var(--radius-sm);
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	:global(.is-deprioritized) .technical-stop {
		color: var(--color-text-deprioritized);
		border-color: var(--color-border);
	}

	/* Desktop-sized padding and gaps were a third of what put the phone card over the
	   620px it has under the header and tab bar; one card per screen means no comparing. */
	@media (max-width: 34rem) {
		/* The customise sheet's own ceiling (`min(50dvh, 26rem)` on the results page) plus a
		   little air. `scrollIntoView({ block: 'nearest' })` treats this as part of the
		   strip's box, so a selected segment scrolls clear of the sheet instead of sitting
		   underneath it. */
		.card-strip {
			scroll-margin-bottom: calc(min(50dvh, 26rem) + var(--space-4));
		}

		.card-main {
			padding: var(--space-3) var(--space-4);
			gap: var(--space-3);
		}

		/* MetricRail's auto-fit grid seats three cells at this width, which leaves the
		   fourth figure alone on a second row: two by two reads as two pairs, three plus
		   one reads as a leftover. Scoped to this card because the timeline's totals
		   rail has six cells and three-up is right for it. */
		.result-card :global(.metric-rail-rail) {
			grid-template-columns: repeat(2, 1fr);
		}
	}
</style>
