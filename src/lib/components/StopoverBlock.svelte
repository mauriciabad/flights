<script lang="ts">
	/**
	 * The stopover, in the block the owner settled on in issue #228: three time lines in
	 * trip order, then the stay, always that order and always present.
	 *
	 * > Fri 9 from 9:10pm
	 * > 2 full days: Sat, Sun
	 * > Mon 12 until 9:05am
	 *
	 * The stay half is no longer written here. Issue #279: the owner called four more lines
	 * under those three "a blob of text" and asked for the bed to be a thing with pictures,
	 * so `PickedBed` renders it and this file's job shrank to gathering the facts and
	 * handing them over. The three time lines above are untouched, and so is every rule
	 * about when a bed is named at all.
	 *
	 * ## Not one number here is computed here
	 *
	 * Every line reads a value something else already owns, which is the whole reason this
	 * component is thin. A fact with two derivations grows two answers, and the one on this
	 * block would be the one nobody notices has gone stale.
	 *
	 * - The three time lines come from `free-time-days.ts`, whose edges are
	 *   `itinerary.freeTime`, which `build.ts` already folds the flight times, the waiting
	 *   rule and the ground transfer into. So "until" is when you leave for the airport,
	 *   not when the plane leaves, which is exactly what #228 asks these lines to name.
	 * - The night count is `itinerary.nightsInConnection`, off the flight schedule alone
	 *   (issue #105), never off whether a bed was priced.
	 * - The rate, and who it covers, is `bedNightlyRate` through `formatMoney`, the app's one
	 *   money edge. The card's price breakdown composes the same two pieces into its own
	 *   "Bed, 2 nights × €13.00 each", so the panel and the card cannot quote two different
	 *   figures for one bed (issue #206).
	 * - The room kind is `ROOM_KIND_LABELS`, the same table the stay picker's tiles use.
	 * - The transfer's duration, shape and fare are `itinerary.transferToHotel` through
	 *   `formatDuration`, `transferDetailLine` and `transferFareNote`, and when nothing
	 *   routed to the bed at all, `unroutedLegNote`.
	 *
	 * The rate and the room kind arrive together, from `stays/bed-facts.ts`. Issue #435 put the
	 * same property on the result card, and three derivations copied onto a second surface is
	 * this section's own warning coming true.
	 *
	 * ## How far out the bed is left this block with issue #465
	 *
	 * Issue #219 put a straight line to the connection airport here, and #465 found it printed
	 * again a few centimetres below, in the stay picker's open card, which is by construction
	 * the same property. Every summary figure has one surface (issue #309), so the distance is
	 * the picker's now and this block stopped asking for a point to measure from. That is why
	 * there is no `connectionCoordinates` prop any more. Nothing here needs one.
	 *
	 * ## The two format decisions worth naming
	 *
	 * **Money keeps the app's convention, not the one in his comment.** He wrote `52.82
	 * EUR/night` and `10 EUR/way`, and flagged in the same breath that changing the symbol's
	 * side is a repo-wide change to confirm before touching. He then set the convention the
	 * other way in AGENTS.md: symbol first, and "each way" rather than "/way", which he had
	 * called probably wrong and is. The later ruling wins, so this reads `€52.82/night` and
	 * `€10.00 each way` through the existing formatter, and no money formatting changes.
	 *
	 * **The transport line is words, not a glyph.** He asked for an icon; the app had no
	 * transfer-mode icon set when this was written, and inventing four glyphs here would
	 * have been a second vocabulary for the same four modes.
	 *
	 * What those words are changed with issue #373. This used to read the bare mode through
	 * `transferModeLabel`, on the reasoning that every other transfer surface did. That had
	 * stopped being true: `ItineraryTimeline` and `segment-stub.ts` both moved to
	 * `transferDetailLine`, and this block was left printing "Public transport" beside a
	 * timeline row reading "Bus, then metro (1 change)" about the same journey.
	 *
	 * ## The stay half has three states, not two
	 *
	 * A bed, no bed priced for a real night, and — since issue #426 — a connection the
	 * traveller never leaves the airport for. That third one prints when the wait starts,
	 * how long it is and when it ends, then the reason nothing is booked; it has no bed and
	 * no journey to one to describe, because the itinerary carries neither.
	 *
	 * ## Issue #227
	 *
	 * That issue is building a hover panel over the trip strip whose design carries this
	 * same content. This component is what it should render rather than writing a second
	 * one; it takes an `Itinerary` and nothing else, so a popover can call it unchanged.
	 */
	import type { Itinerary } from '$lib/domain';
	import { transferRideDuration } from '$lib/domain';
	import { formatClockTime, formatDuration, formatMoney, formatWeekdayAndDay } from '$lib/format';
	import { overnightWaitNote } from '$lib/results/stopover-nights';
	import { bedFacts, PickedBed } from '$lib/stays';
	import { freeTimeDays } from './free-time-days';
	import {
		landingBufferNote,
		transferDetailLine,
		transferFareNote,
		unroutedLegNote
	} from './itinerary-timeline-format';

	interface Props {
		itinerary: Itinerary;
		/** The stopover city's name, resolved by the page from the airport record. The
		 * itinerary carries only the IATA code (domain/itinerary.ts), so a component that
		 * derived this itself would print a code where the rest of the card prints a city. */
		connectionLabel: string;
	}

	let { itinerary, connectionLabel }: Props = $props();

	// `undefined` for a window with no length: a same-day change whose whole gap is eaten
	// by the waiting rule and the transfers. Three lines about nothing is worse than none.
	const days = $derived(freeTimeDays(itinerary.freeTime.start, itinerary.freeTime.end));
	// Issue #426: set when the traveller never leaves the terminal, and the whole block then
	// describes that wait instead of days in a city. Reading it here rather than testing the
	// night count is what stops this block and the timeline drawing two different trips.
	const airsideWait = $derived(itinerary.airsideWait);
	const nights = $derived(itinerary.nightsInConnection);
	const stay = $derived(itinerary.stay);
	const toHotel = $derived(itinerary.transferToHotel);
	// Issue #231: set only when the stopover crosses a midnight it is too short to sleep
	// through. Both lines below need it, so it is derived once rather than asked twice.
	const waitNote = $derived(overnightWaitNote(itinerary));

	/**
	 * The bed, gathered by `stays/bed-facts.ts`.
	 *
	 * That module exists because issue #435 put the same property on the result card, and a
	 * rate derived on both surfaces is the "one fact, two answers" failure this file's header
	 * spends a paragraph warning about. What it hands back is unformatted, the rate as
	 * `Money`, because each surface prints money its own way.
	 *
	 * Called with no coordinates on purpose. `bedFacts` will measure the straight line to the
	 * connection airport for a caller that has one, and since issue #465 no surface this
	 * block draws wants it.
	 */
	const bed = $derived(bedFacts(itinerary));

	// Issue #206: the rate, and who it covers, split into the number and its audience rather
	// than joined into a sentence. Since issue #279 the block prints them on two lines, and
	// re-splitting a string it had just joined would be the second derivation this file
	// exists to avoid.
	const bedRate = $derived(
		bed ? { amount: formatMoney(bed.rate.money), audience: bed.rate.audience } : undefined
	);

	/**
	 * "each way" only because this leg is travelled twice, out to the bed and back to the
	 * airport. AGENTS.md records the owner rejecting "/way" for it, which is not English.
	 *
	 * Never absent, because he asked for a block that is "always present in the same
	 * format". A line that vanishes when nobody could route to the bed would let the block
	 * quietly change shape at exactly the moment it has something to say, so the unrouted
	 * case reads `unroutedLegNote`, which is the same sentence the timeline's own transfer
	 * row prints and already separates "no bed to reach" from "a bed nobody could route to"
	 * (issues #140 and #211).
	 */
	const transferLine = $derived.by(() => {
		if (!toHotel) {
			return unroutedLegNote('to-hotel', {
				hasStay: Boolean(stay),
				nightsInConnection: nights,
				overnightWait: waitNote !== undefined,
				transferAnchor: itinerary.transferAnchor
			});
		}
		// Issue #249: "about £35.85-£55.58 each way" where the rate card reaches, because
		// this sentence used to read "price not available" a few centimetres under a receipt
		// line carrying that very range for that very ride.
		const note = transferFareNote(toHotel);
		// "each way" only attaches to a figure. A walk's "No fare" is a fact about walking,
		// not an amount, and "No fare each way" is not a sentence.
		const fare = note.amount
			? `${note.estimated ? 'about ' : ''}${note.text} each way`
			: note.text.toLocaleLowerCase();
		// Issue #290: `duration` is landing to doorstep and this sentence puts a mode label in
		// front of it, so it has to quote the ride. The walk-out follows as its own sentence
		// rather than being dropped: the two time lines at the top of this same block are
		// built off the full duration, and "from 12:48am" beside a bare 38m would look like an
		// arithmetic mistake.
		//
		// Issue #373: `transferDetailLine`, not `transferModeLabel`. The owner's criterion for
		// a bed is "no transport hoping to change bus or metro line", and "Public transport"
		// cannot answer it while "Bus, then metro (1 change)" can. The timeline row four
		// centimetres below already printed the second sentence for this very transfer, so
		// the block was the one surface still discarding a count the app had. Falls back to
		// the plain mode label for a taxi, a walk, or a journey whose legs nobody itemised,
		// which is what `summariseTransferLegs` returning `undefined` means.
		const ride = `${transferDetailLine(toHotel)}, ${formatDuration(transferRideDuration(toHotel))} from the airport, ${fare}`;
		const walkOut = landingBufferNote(toHotel);
		return walkOut ? `${ride}. ${walkOut}` : ride;
	});

	/**
	 * Issue #140 ruled out "yet" for a state nothing is about to change, and separates a
	 * night with no bed priced from a same-day connection that has no bed to price.
	 *
	 * Issue #231 added the third state, and it is the one the traveller most needs spelled
	 * out: the clock crossed midnight, the app charged nothing for it, and the reason is
	 * that six hours between 11pm and 5am buys nobody a room. Saying only "no night spent
	 * here" beside two clock readings that plainly show a date change would read as a bug.
	 */
	const noBedLine = $derived.by(() => {
		if (nights > 0) return 'No bed priced, so the total is a floor';
		return waitNote ?? 'No night spent here, so there is no bed to price';
	});
</script>

<section class="stopover" aria-label={`Your stopover in ${connectionLabel}`}>
	<!-- A field label, not a heading. The results page runs from the app shell's `h1`
	     straight to the cards with no `h2` between, so an `h3` here would be an orphan in
	     the outline. The `aria-label` above is what names this block. -->
	<p class="stopover-label font-mono">{connectionLabel}</p>

	{#if airsideWait}
		<!-- Issue #426. The same three-line shape #228 settled, saying the one thing that is
		     true of this trip: when the traveller lands, that they are in the terminal until
		     they board, and when that is. It used to print the two edges of a "free time"
		     window that is a departures hall, over a heading naming a city nobody reaches. -->
		<p class="stopover-edge font-mono tabular-nums">
			{formatWeekdayAndDay(airsideWait.start)} from {formatClockTime(airsideWait.start)}
		</p>
		<p class="stopover-days">
			Waiting at {itinerary.outboundFlight.arrivalAirport}, {formatDuration(airsideWait.duration)}
		</p>
		<p class="stopover-edge font-mono tabular-nums">
			{formatWeekdayAndDay(airsideWait.end)} until {formatClockTime(airsideWait.end)}
		</p>
	{:else if days}
		<p class="stopover-edge font-mono tabular-nums">{days.from}</p>
		<p class="stopover-days">{days.fullDays}</p>
		<p class="stopover-edge font-mono tabular-nums">{days.until}</p>
		{#if days.countMeaning}
			<!-- Issue #306. The card has room for "2+ days" and not for a sentence, so the
			     sentence lives here, where the stopover is described in full and the two
			     clock readings it is about are printed directly above and below it. Not the
			     explanatory text #228 rejected: that was "still counts" and "too late to
			     count" annotating the day list, which the list already says by naming the
			     days it names. This says what a suffix that did not exist then is claiming,
			     against readings a reader can check it with. -->
			<p class="stopover-part-day">{days.countMeaning}</p>
		{/if}
	{:else}
		<p class="stopover-days">No full days</p>
	{/if}

	<div class="stopover-stay">
		<!-- Issue #426: no bed and no journey to one, because there is neither. The sentence
		     that stays is the reason nothing is priced, which is the one thing the three lines
		     above do not say. "Overnight wait, so there is no hotel leg here" went with the
		     leg: a trip in a terminal has no hotel leg to be missing. -->
		{#if airsideWait}
			<p class="stopover-room">{noBedLine}</p>
		<!-- Since issue #426 a trip with no night carries no bed at all, so `stay` is the whole
		     question again: `nights > 0` was the guard that let this block hold a quote for a
		     room nobody was booking, and the model no longer offers it one. -->
		{:else if stay && bed && bedRate}
			<PickedBed
				property={stay.property}
				roomKindLabel={bed.roomKindLabel}
				{nights}
				rate={bedRate}
				transfer={{ note: transferLine, mode: toHotel?.mode }}
			/>
		{:else}
			<p class="stopover-room">{noBedLine}</p>
			<p class="stopover-transfer">{transferLine}</p>
		{/if}
	</div>
</section>

<style>
	/* The boarding-pass field treatment the rest of the ticket uses: a hairline, a small
	   uppercase mono caption, then the content. Not a boxed panel, which would read as a
	   different kind of object from every other block on the card. */
	.stopover {
		padding-top: var(--space-2);
		border-top: 1px solid var(--color-border);
	}

	.stopover p {
		margin: 0;
	}

	/* `--color-text-muted`, not `--color-text-faint`, for the reason MetricRail records:
	   the faint token measures 4.19:1 on the dark palette's card surface, under WCAG AA,
	   and this is a field label rather than decoration. */
	/* Qualified by `.stopover` so it outranks the `.stopover p` reset above, which is one
	   specificity point higher than a bare class and would otherwise eat this margin. */
	.stopover .stopover-label {
		margin: 0 0 var(--space-1);
		font-size: 0.625rem;
		font-weight: var(--font-weight-medium);
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-muted);
	}

	/* The middle line is the answer, so it carries the weight and the teal reserved for
	   the free city. The edges are the qualifiers: a size down and quiet, never hidden. */
	.stopover-days {
		font-size: var(--font-size-base);
		font-weight: var(--font-weight-semibold);
		line-height: 1.3;
		color: var(--color-stopover);
	}

	.stopover-edge {
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-muted);
	}

	/* A footnote to the three lines above it, quieter than the edges: it explains a mark on
	   another surface rather than stating a fact about this trip that nothing else carries. */
	.stopover-part-day {
		margin-top: var(--space-1);
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-faint);
	}

	/* The blank line the owner drew between the times and the stay, as space rather than
	   as a second rule: one block, two halves, not two blocks. */
	.stopover-stay {
		margin-top: var(--space-3);
	}

	/* The two sentences left in this file, for the stopover that books no bed at all.
	   Everything the bed case prints moved into `PickedBed` with issue #279, and its
	   deprioritised treatment moved with it. */
	.stopover-room,
	.stopover-transfer {
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-muted);
	}

	/* Colour swap rather than opacity, the treatment AGENTS.md names for an avoided
	   airline: every line here still has to be readable. */
	:global(.is-deprioritized) .stopover-days,
	:global(.is-deprioritized) .stopover-edge {
		color: var(--color-text-deprioritized);
	}
</style>
