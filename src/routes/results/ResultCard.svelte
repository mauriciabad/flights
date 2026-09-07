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
	 * - **Free time, in flight, airport wait, changes, door to door** (`MetricRail`, the
	 *   five in `CARD_METRIC_IDS`). The figures that decide whether a cheap itinerary is
	 *   actually cheap. Airport waiting in particular is the cost nobody quotes, and since
	 *   issue #424 so is the number of times the trip makes you change vehicle: the owner's
	 *   own reason for asking is that "it is way better a hotel with no transfers and a bit
	 *   more expensive than one with changes", which is a judgement he can only make if both
	 *   cards say it. Free time is a day count since issue #228, "2 full days" rather than
	 *   the "2d 15h" the owner called misleading; the edge times are in the trip inspector,
	 *   because seven lines times four cards is not a results screen.
	 * - **The bed** (`CardStay`), in the half of the first row that was blank. Issue #435,
	 *   the owner: "on the card, there's a empty space on the right, it is a great spot to
	 *   put info about the hotel, including image carrousel." Which property, how it is
	 *   rated on its provider's own scale, what room, how far out, and its photographs.
	 *   Deliberately not the nightly rate, which the receipt beside it already prints, and
	 *   nothing at all when the trip books no bed.
	 *
	 * ## Issue #309: this card owns every summary figure, and nothing repeats it
	 *
	 * The owner, on the expanded card: **"at the bottom info is duplicaded and messy. all
	 * info should be already in the card, so expanding shouldn change."** Four of the six
	 * figures were printed twice, once by the rail at the foot of this file and again by an
	 * identical rail the timeline rendered a few centimetres lower, which is what #278's
	 * restructure left behind when the expanded panel moved inside the card instead of
	 * replacing it.
	 *
	 * So the rule is now a rule and not an accident. Every summary figure has exactly one
	 * surface: the four above are this rail's, the night count is the trip strip's caption,
	 * the nightly rate is the receipt's, and the total is the headline with that receipt
	 * under it. Anything printed twice on this card is the same defect coming back, which is
	 * why the bed panel names the property and says nothing about what it costs.
	 *
	 * ## Issue #440: the card stopped being a thing you open, for the second and last time
	 *
	 * #278 took away a "Show details" button and made the trip strip's own caption the
	 * expander. #440 took the fold away entirely. The owner: **"Delete the expandible part
	 * of the card. Make sure all info is already in other places, and no funcionality is
	 * lost."**
	 *
	 * So the caption is a caption again, `timelineOpen`, `onToggleTimeline` and the
	 * `timeline` snippet are gone with it, and `ResultDetail.svelte` is deleted. What that
	 * fold held now lives in the trip inspector beside the list: the full timeline with its
	 * option marks, the stopover block, and the map for whichever leg is selected. Picking
	 * any part of any card fills it, which is one gesture where there used to be two.
	 *
	 * `variantsLabel` went in #278. "+2 more flight times through here" existed to advertise
	 * what a button hid, and nothing hides them now: the timeline marks the rows that have
	 * alternatives, and the flight picker in the inspector lists them.
	 *
	 * The header's freshness badge renders only when its tone is not neutral. "Current
	 * price" and "Priced 3m ago" said the same thing as the footer's "fetched 3m ago" one
	 * line apart, and on a 375px screen the badge wrapped under the route and cost the
	 * card a row it could not spare: 635px of card against 620px of screen.
	 *
	 * What was cut, deliberately: per-flight prices and per-leg times (they are in the
	 * inspector, where a leg can also be swapped, and five prices on a card is a
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
	import {
		AirlineLogo,
		Card,
		Flag,
		FlightDetour,
		Icon,
		MetricRail,
		PriceLine,
		SourceNote,
		TripStrip
	} from '$lib/components';
	import { CARD_METRIC_IDS } from '$lib/components/itinerary-metrics';
	import { formatWeekdayAndDay } from '$lib/format';
	import { buildItineraryMapModel } from '$lib/itinerary-map/segments';
	import { buildFlightShape } from '$lib/itinerary-map/previews';
	import type { Airport, Itinerary } from '$lib/domain';
	import type { ItinerarySegmentId } from '$lib/itinerary-map/segment-id';
	import { oneAdultFlightsTotal, placeInBand } from '$lib/results/price-band';
	import type { PriceHistory } from '$lib/results/price-band';
	import { savedPriceNote, saveTripLabel } from '$lib/results/saved-trip';
	import type { SavedItinerary } from '$lib/saved';
	import { connectionAirportCode } from '$lib/results/types';
	import type { ScoredResult } from '$lib/results/types';
	import { revealMinimally } from '$lib/results/reveal-scroll';
	import {
		describePriceFreshness,
		describeSourceGroups,
		describeSources,
		describeStaleSources
	} from '$lib/results/view-model';
	import { technicalStopDetail, technicalStopLabel } from '$lib/components/technical-stop-note';
	import CardStay from './CardStay.svelte';
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
		/**
		 * Issue #434: this trip's saved record, when the traveller has kept it. It fills the
		 * heart, and its price log is what the note under the route compares against.
		 *
		 * A prop rather than a lookup here, because the id needs the normalised query and
		 * that belongs to the page. The card holds a record, not a boolean, so the two facts
		 * it needs ("is this kept" and "what did it cost then") come from one object that
		 * cannot disagree with itself.
		 */
		savedTrip?: SavedItinerary;
		/** Pressing the heart. The page owns the store call, because it is the page that
		 * mints the visit token the first price observation is filed under. Absent leaves
		 * the heart off the card entirely. */
		onToggleSave?: () => void;
	}

	let {
		result,
		itinerary,
		connectionAirport,
		priceBand,
		selectedSegmentId = null,
		onSelectSegment,
		savedTrip,
		onToggleSave
	}: Props = $props();

	const connectionCode = $derived(connectionAirportCode(itinerary));

	/**
	 * Issue #278: on a phone the customise panel is a sheet at the foot of the screen, and a
	 * reader who taps a 3px transfer seam and gets a panel sitting on top of it has lost the
	 * context that made the tap mean anything. So a covered strip is scrolled clear.
	 *
	 * Issue #308 is what that cost. It was `scroll-margin-bottom` plus
	 * `scrollIntoView({ block: 'nearest' })`, and the margin inflated this block's box by the
	 * sheet's whole height for scrolling purposes, so an entirely visible strip read as one
	 * that did not fit and every tap moved the page. The owner: "it updates my scroll and is
	 * anoying." `revealMinimally` states the same intent as arithmetic instead: it measures
	 * what a bottom sheet is actually covering right now and scrolls by the smallest amount
	 * that clears it, which on a wide screen, where the panel is a sidebar covering nothing,
	 * is exactly zero.
	 *
	 * An effect rather than a handler because the selection arrives as a prop: it can be set
	 * from the timeline or the map as well as from the strip. It reads props and calls a DOM
	 * method, and writes no state, so it cannot retrigger itself (AGENTS.md, the `$effect`
	 * trap).
	 */
	let stripEl = $state<HTMLElement>();
	$effect(() => {
		if (!selectedSegmentId || !stripEl) return;
		revealMinimally(stripEl);
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

	// Issue #434. The route in the heart's own name, because six hearts called "Save this
	// trip" are one control a voice user cannot aim at, and `saveTripLabel` says what
	// changes between the two states.
	const saveLabel = $derived(
		saveTripLabel(savedTrip !== undefined, {
			origin: originCity,
			connection: connectionLabel,
			destination: destinationCity
		})
	);
	// One line, and only once there are two prices to compare. `savedPriceNote` owns that
	// floor; the card owns the height it costs, which is why the note is a line in the
	// header band rather than a block in the card body.
	const priceNote = $derived(savedPriceNote(savedTrip));

	// Provenance, issue #289: every source behind this price, each at its own age. They do
	// not share a TTL, so one "fetched N ago" over all of them printed the age of whatever
	// had the longest one. `view-model.ts` owns the wording and is tested against it.
	//
	// Issue #312 took this off the footer as prose. It was one ellipsised line showing about
	// a tenth of its text at 375px, and `title` was carrying the rest, which is no fallback
	// at all on a touch screen. `SourceNote` is the control that reveals it; `staleNote` is
	// what stays on the card, because the brief asks for stale results to be marked visibly
	// and a fact behind a deliberate tap is not marked.
	//
	// `Date.now()` is read on every re-render rather than snapshotted. Since #293 a card
	// follows the refetch it started, and these ages move while the traveller watches:
	// measured, "fetched 1 hour ago" becomes "fetched this minute" inside 1.5 seconds. A
	// cached reading here would put that defect straight back.
	const sourceGroups = $derived(describeSourceGroups(result.price.parts, Date.now()));
	const sourceText = $derived(describeSources(result.price.parts, Date.now()));
	const staleNote = $derived(describeStaleSources(result.price.parts, Date.now()));

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
		<div class="card-head">
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
				<!-- The owner: "the result card should show the departure and arrival dates. now
				     it doesn't show it anywhere when collapsed". It did not. The strip stamps a
				     weekday on a free day and the timeline carries full dates, but both of those
				     are inside the fold, so a collapsed card said which cities and what price
				     and never which days.


				     A `.route` item rather than a row of its own, because `.route` already wraps
				     and this costs no card height on a desktop card and one wrap on a phone.
				     Issue #437 kept that. The owner wanted the dates at the right end and heavier
				     ("now it is too bland"), and both are true of an item that stays in the flow:
				     `margin-left: auto` sends it to the end of whatever line it lands on, which
				     is the far right at 1440px and the end of the second line at 375px, beside
				     the third airport rather than alone under it.

				     Each end reads in its own place's local time, per the owner's rule that every
				     time on this page belongs to the place it names, so a red-eye landing after
				     midnight says the day the traveller actually arrives. -->
				<span class="route-dates font-mono tabular-nums"
					><!--
					Non-breaking spaces inside the hidden words on purpose. A trailing space at the
					end of an element's text is collapsed away, and the accessible name came out
					"DepartsWed 16" and "arrivesThu 17" when it was an ordinary one. #318 is the
					same seam read the other way: there, indentation between two elements put a
					space in front of a comma.
					--><span class="visually-hidden">Departs&nbsp;</span>{formatWeekdayAndDay(
						itinerary.outboundFlight.departure
					)}<span class="route-dates-arrow" aria-hidden="true">→</span><span class="visually-hidden"
						>,&nbsp;arrives&nbsp;</span
					>{formatWeekdayAndDay(itinerary.onwardFlight.arrival)}</span
				>
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
				{#if onToggleSave}
					<!-- Issue #434, the owner: "we can use the heart icon for saved itineraries".
					     Last, so it is beside the stamp: the two are the row's right-hand cluster
					     and they wrap together or not at all, which is what keeps the dates from
					     ending up alone on a line of their own. -->
					<button
						type="button"
						class={['save-trip', { 'is-saved': savedTrip !== undefined }]}
						aria-label={saveLabel}
						onclick={onToggleSave}
					>
						<Icon name="heart" />
					</button>
				{/if}
			</div>
			{#if priceNote}
				<!-- Only on a trip the traveller kept, and only once it has been priced twice.
				     One line, under the stamp it is about, in the words `$lib/saved` already
				     uses on the search screen and on `/saved/`. -->
				<p class={['price-note', `is-${priceNote.direction}`]}>{priceNote.short}</p>
			{/if}
		</div>
	{/snippet}

	<div class="card-main">
		<!-- Issue #305, the owner: the flight map "is placed to the left of the Getting
		     there price breakdown, so space is better used". The two answer the pair of
		     questions a person asks about a connection, what it costs and how far out of
		     the way it goes, and side by side they cost one block of card height instead of
		     two. The detour renders only once the page has resolved the connection airport,
		     since without it there is no second flight leg to compare, and the receipt then
		     takes the whole row on its own. -->
		<div class="card-getting-there">
			{#if flightShape}
				<FlightDetour shape={flightShape} />
			{/if}
			<PriceLine {itinerary} requiredNights={result.stopover.minimum} />
			<!-- Issue #435: the bed, in the half of this row that used to be blank. It renders
			     nothing at all for a trip with no bed, so the row goes back to the pair #305
			     arranged. -->
			<CardStay {itinerary} {connectionAirport} />
		</div>

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

		<!-- Issue #440 took the fold off this card, and the caption went back to being a
		     caption. Picking any part of the strip fills the trip inspector beside the list,
		     which is where the full timeline, the selected leg's map and every picker now
		     live. -->
		<div class="card-strip" bind:this={stripEl}>
			<TripStrip
				{itinerary}
				{connectionCode}
				{connectionLabel}
				{connectionAirport}
				deprioritized={isDeprioritized}
				{selectedSegmentId}
				{onSelectSegment}
			/>
		</div>

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
			<!-- Issue #312. Absent, not empty, when no part of this itinerary carries a tracked
			     source: the row used to render a bare "via" with nothing after it, and now it
			     renders no control at all rather than one that opens onto nothing.

			     The age beside the icon is the staleness signal, and it is deliberately not
			     inside the panel. The brief asks that stale cached results be marked visibly,
			     and hiding the last trace of it behind a tap would trade an unreadable row for
			     a worse defect. It says "oldest" because that is what it is: #289 exists
			     because one age printed over sources whose TTLs range from 5 minutes to 30 days
			     read as a claim about all of them. -->
			{#if sourceText}
				<span class="provenance-source">
					{#if staleNote}
						<span class="provenance-stale">{staleNote}</span>
					{/if}
					<SourceNote groups={sourceGroups} summary={sourceText} />
				</span>
			{/if}
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

	.card-head {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	/* Issue #437, the owner: "items are not vertically well centered". They were on a
	   shared baseline, which is right for text and wrong for everything else in this row.
	   A flag is a picture and it sat on the baseline with the descenders hanging below it;
	   the date stamp is a box and a box has no baseline worth sharing. So the row centres
	   its items, and `.place` below keeps the baseline where the run of text needs it. */
	.route {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	.route-leg {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		/* Three place names on one row is more than a 375px phone holds, so a leg wraps
		   whole rather than splitting a city from its code. */
		min-width: 0;
	}

	/* The one place a baseline is still the right answer: city, code and country are one
	   run of text at three sizes, and centring them would leave the small ones floating. */
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

	/*
	 * Issue #437: a date stamped on the stub, rather than two more words trailing the third
	 * airport in the weight of everything around them.
	 *
	 * The card is a ticket (Card's own `variant="ticket"`, a warm band over a dashed tear
	 * line) and a departure board is what a traveller reads a date off, so the stamp is that
	 * board: amber on the app's darkest inset, mono and tabular, the only element in the
	 * header carrying its own surface. That is where the hierarchy comes from. Not weight,
	 * which would have put it in competition with the city names, and not size, which is
	 * what the row has least of.
	 *
	 * The padding is 2px rather than `--space-1`, and that is a measurement, not a taste.
	 * The row's line box is 24px and the stamp has to fit inside it: 2px + 17.5px of
	 * 14px/1.25 text + 2px + a 1px border at each end is 24px exactly, so the stamp costs
	 * the header nothing. At `--space-1` it is 28px, and every line it lands on grows 4px.
	 *
	 * Contrast, measured on the painted colours the way `design-seams.spec.ts` does it:
	 * 9.2:1 in dark and 5.4:1 in light. #318 is why that is checked against this element's
	 * own background rather than the page's.
	 */
	.route-dates {
		display: inline-flex;
		align-items: center;
		margin-left: auto;
		padding: 2px var(--space-1);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background: var(--color-bg-inset);
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		line-height: 1.25;
		color: var(--color-accent);
		white-space: nowrap;
	}

	.route-dates-arrow {
		margin: 0 0.1875rem;
		color: var(--color-text-muted);
	}

	/* Pulled in to a 4px gap from the row's own 8px. An arrow is a connector and belongs
	   nearer the two things it connects than the legs are to each other, and this row needs
	   the 16px: measured at 1440px, "Barcelona BCN to Budapest BUD, Hungary to Paphos PFO"
	   plus the stamp and the heart is 641px of content in a 630px card, and 625px once the
	   two arrows stop taking a full gap each. */
	.route-arrow {
		margin-inline: calc(var(--space-1) - var(--space-2));
		color: var(--color-accent-muted-text);
	}

	/* The badges ride in the header rather than beside the price: they are facts about the
	   whole card, and pinning them to the right of the route line keeps the price row free
	   for the price and its parts.

	   Their `margin-left: auto` moved to `.route-dates` in #437. Two auto margins on one
	   flex line share the free space between them, which would have parked the badges in
	   the middle of the row; one is what pins a cluster to the end. */
	.header-badges {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-2);
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

	/*
	 * Issue #434's heart, as a control and not an ornament.
	 *
	 * 44px square, per WCAG 2.5.5, taken out of the header's own padding rather than added
	 * to the row: the box is centred on the first line of the route and the padding above
	 * and below the row absorbs the rest, so the header measures what it measured before.
	 * `.saved-all` on the search screen buys its target the same way.
	 *
	 * Absolute, because a target this size in a row that wraps at 375px is a wrap. Pinned to
	 * the top right so it reads as the card's own corner action, which is also the one place
	 * on this card nothing else claims.
	 */
	.save-trip {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		/* WCAG 2.2 SC 2.5.8's 24px, as a real box, because that is what
		   `trip-strip-geometry.spec.ts` measures and it is right to: an overlay is a
		   promise a bounding box can check. The 4px it costs the row comes back below. */
		width: 1.5rem;
		height: 1.5rem;
		margin: 0;
		/* Half the row's gap, so the heart and the stamp read as the one right-hand cluster
		   they wrap as, and so a 24px control costs the row exactly what a 20px one did. */
		margin-inline-start: calc(var(--space-1) - var(--space-2));
		padding: 0;
		border-radius: var(--radius-full);
		color: var(--color-accent-muted-text);
		/* No 300ms wait for a double tap that will never come, which on a control this
		   small is the difference between a press that feels heard and one that does not. */
		touch-action: manipulation;
		/* Named properties, never `all`. The heart filling is the whole confirmation that
		   the trip was kept, and a snap reads as a redraw rather than an answer. `app.css`
		   turns both off under `prefers-reduced-motion`. */
		transition:
			color 150ms ease-out,
			transform 120ms ease-out;
		--icon-size: 1.25rem;
	}

	/* SC 2.5.5's 44px on top of the 24px above, as an overlay rather than as a box. The row
	   is a boarding-pass header that already wraps twice on a 375px phone, and a 44px flex
	   item in it costs a third line and 32px of a card that has none to give. */
	.save-trip::before {
		content: '';
		position: absolute;
		inset: -0.625rem;
		border-radius: var(--radius-full);
	}

	/* Colour alone, no disc behind it. The header band IS `--color-accent-muted` on this
	   card, so the tinted circle a control like this usually gets would be invisible. */
	.save-trip:hover {
		color: var(--color-accent-hover);
	}

	.save-trip:active {
		transform: scale(0.95);
	}

	/* Filled, not merely tinted. Icon's `<svg fill="none">` is a presentation attribute, so
	   a rule here beats it and the paths inherit the fill. The colour is the accent the
	   saved list and `/saved/` already draw their hearts in, so one heart means one thing
	   in all three places. */
	.save-trip.is-saved {
		color: var(--color-accent);
	}

	.save-trip.is-saved :global(.icon) {
		fill: currentColor;
	}

	/*
	 * Issue #434: where today's price sits against the price this trip was saved at.
	 *
	 * A line in the header band rather than a block in the card, because the card body is
	 * budgeted to the block (`card-size.spec.ts`) and this is not a block. It costs one
	 * line, on saved cards only, which is a card the traveller asked for.
	 *
	 * The word carries the meaning and the colour repeats it, the same rule and the same
	 * two tokens `SavedItineraries.svelte` uses, so "€4.00 cheaper" says the same thing to a
	 * reader who cannot tell green from red.
	 */
	.price-note {
		margin: 0;
		text-align: end;
		font-size: var(--font-size-xs);
		/* Its own, tight, rather than the page's 1.6 for body text. Measured: this line costs
		   the header 28px at the inherited height and 20px here, and the difference is a
		   twentieth of what a phone leaves for a whole card. */
		line-height: 1.3;
		font-weight: var(--font-weight-medium);
		color: var(--color-accent-muted-text);
	}

	.price-note.is-cheaper {
		color: var(--color-success);
	}

	.price-note.is-dearer {
		color: var(--color-danger);
	}

	/* A plain box around the strip, purely so there is something to scroll to and something
	   to hang a scroll margin on. It changes no geometry: the strip is a flex column and
	   this wrapper is a block of exactly its height. NOT `display: contents`, which would
	   leave it with no box and make `scrollIntoView` a no-op. */
	.card-strip {
		min-width: 0;
	}

	.card-main {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		padding: var(--space-4) var(--space-5);
	}

	/* Issue #305: the detour drawing and the receipt share one row. The drawing is a fixed
	   6.5rem (`FlightDetour` owns that, and owns why it must not resize per route), so the
	   receipt takes what is left and `min-width: 0` is what lets its long labels wrap
	   inside the column instead of widening it. Top-aligned rather than centred: the
	   headline is the thing a reader lands on, and it has to sit on the card's own first
	   line whatever height the receipt below it turns out to be.

	   Issue #435 made it three, and `flex-wrap` plus the two bases below are the whole
	   responsive rule. This card is the middle column of a three-column page, so its width
	   does not track the viewport: about 310px of content at a 1024px viewport and about
	   630px at 1440px, which is why no media query could get this right. 6.5rem of drawing
	   plus 11rem of receipt plus 15rem of bed plus two gaps needs roughly 34rem, and under
	   that the bed drops to its own line while the pair #305 arranged stays together. */
	.card-getting-there {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: var(--space-4);
	}

	/* The receipt's own file has no opinion about how much of a row it should take, because
	   it is also drawn in places that are not this row. 11rem is its floor here: below that
	   "2 nights x EUR 13.00 each" wraps to three lines and the row costs more height than the
	   bed beside it saves. */
	.card-getting-there :global(.price-line) {
		flex: 1 1 11rem;
	}

	/* One line, always, and since issue #312 a short one. The provenance used to be a
	   sentence competing with the carriers for the row and losing, ellipsised to about a
	   tenth of itself at 375px. What sits here now is an age when there is one worth showing
	   and a 24px control, so the carriers get the width they need without anything having to
	   give way. */
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
		display: inline-flex;
		align-items: center;
		flex-shrink: 0;
		gap: var(--space-2);
	}

	/* Visible, and quiet. An hour-old card is not an error, so this is not warning-tinted:
	   the tone that means "the total is short by something nobody has measured" belongs to
	   the receipt's own chips, and wearing it here would make a cached road route read as a
	   missing price. */
	.provenance-stale {
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
		/* Three-up, which is what MetricRail's own auto-fit grid seats at this width. It was
		   forced to two while the rail held four cells, because two by two reads as two
		   pairs and three plus one reads as a leftover. Issue #424's CHANGES cell makes it
		   five, and five at two-up is three rows and a dangling cell, a whole row of card
		   height on the screen that has the least of it. At three-up five cells sit in the
		   same two rows the four did, so the phone card is exactly as tall as it was.
		   Scoped to this card because the timeline's totals rail has its own cell count. */
		.result-card :global(.metric-rail-rail) {
			grid-template-columns: repeat(3, 1fr);
		}
	}
</style>
