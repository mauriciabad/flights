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
	 * - The room kind is `ROOM_KIND_LABELS`, the same table the stay picker's tiles use, and
	 *   the distance beside it is `stays/distance.ts`, the same straight line and the same
	 *   formatter every row of that picker prints (issue #219).
	 * - The transfer's duration, mode and fare are `itinerary.transferToHotel` through
	 *   `formatDuration`, `transferModeLabel` and `transferFareNote`, and when nothing
	 *   routed to the bed at all, `unroutedLegNote`.
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
	 * **The transport line names its mode instead of drawing an icon.** He asked for an
	 * icon; the app has no transfer-mode icon set, and every other transfer surface spells
	 * the mode out through `transferModeLabel`. Inventing four glyphs here would be a second
	 * vocabulary for the same four modes.
	 *
	 * ## The stay half has three states, not two
	 *
	 * A bed, no bed priced for a real night, and — since issue #231 — a stopover that
	 * crosses a midnight it is too short to sleep through. The third one prints the wait
	 * and its length instead of a property, because the two time lines above it plainly
	 * show a date change and "no night spent here" beside them would read as a bug rather
	 * than as the answer.
	 *
	 * ## Issue #227
	 *
	 * That issue is building a hover panel over the trip strip whose design carries this
	 * same content. This component is what it should render rather than writing a second
	 * one; it takes an `Itinerary` and nothing else, so a popover can call it unchanged.
	 */
	import type { Coordinates, Itinerary } from '$lib/domain';
	import { transferRideDuration } from '$lib/domain';
	import { formatDuration, formatMoney } from '$lib/format';
	import { overnightWaitNote } from '$lib/results/stopover-nights';
	import {
		bedNightlyRate,
		formatDistanceKm,
		haversineDistanceKm,
		PickedBed,
		propertyKey,
		ROOM_KIND_LABELS
	} from '$lib/stays';
	import { freeTimeDays } from './free-time-days';
	import {
		landingBufferNote,
		transferFareNote,
		transferModeLabel,
		unroutedLegNote
	} from './itinerary-timeline-format';

	interface Props {
		itinerary: Itinerary;
		/** The stopover city's name, resolved by the page from the airport record. The
		 * itinerary carries only the IATA code (domain/itinerary.ts), so a component that
		 * derived this itself would print a code where the rest of the card prints a city. */
		connectionLabel: string;
		/** Issue #219: the connection airport's position, so the block can say how far out
		 * the bed is. Optional, and the line degrades to the room kind alone without it: the
		 * itinerary carries no connection `Airport` (domain/itinerary.ts holds the IATA code
		 * and nothing else), and a caller that has not resolved one must not be forced to
		 * invent a point. */
		connectionCoordinates?: Coordinates;
	}

	let { itinerary, connectionLabel, connectionCoordinates }: Props = $props();

	// `undefined` for a window with no length: a same-day change whose whole gap is eaten
	// by the waiting rule and the transfers. Three lines about nothing is worse than none.
	const days = $derived(freeTimeDays(itinerary.freeTime.start, itinerary.freeTime.end));
	const nights = $derived(itinerary.nightsInConnection);
	const stay = $derived(itinerary.stay);
	const toHotel = $derived(itinerary.transferToHotel);
	// Issue #231: set only when the stopover crosses a midnight it is too short to sleep
	// through. Both lines below need it, so it is derived once rather than asked twice.
	const waitNote = $derived(overnightWaitNote(itinerary));

	/**
	 * How far out the bed is. Issue #219: the app picked a bed 48.3 km from the airport and
	 * the card said nothing about it, so the one number that made the pick look absurd was
	 * the one number missing from the screen.
	 *
	 * Straight-line, the same figure and the same formatter the stay picker's rows use
	 * (`stays/distance.ts`), never a second measurement that could disagree with the list
	 * a tap away. The transfer line below is the other half of the answer: how long the
	 * journey actually takes, which is a route rather than a line.
	 *
	 * `undefined` when no airport position was resolved. The itinerary carries only an IATA
	 * code (domain/itinerary.ts), and a block that invented a point would print a distance
	 * to nowhere; the figure is simply absent instead.
	 */
	const distanceFromAirport = $derived.by(() => {
		if (!stay || !connectionCoordinates) return undefined;
		const km = haversineDistanceKm(stay.property.coordinates, connectionCoordinates);
		return formatDistanceKm(km);
	});

	// Issue #206: the rate, and who it covers. `bedNightlyRate` owns that decision so this
	// figure and the card's own "Bed, 2 nights × €13.00 each" can never quote two different
	// numbers for one bed. A dorm bed for three carries "each"; a private room carries "for
	// 3", because a room is one unit whatever the party size and splitting it between heads
	// would be a number nobody quoted.
	//
	// Handed on as the number and its audience rather than as one sentence: since issue
	// #279 the block prints them on two lines, and re-splitting a string it had just joined
	// would be the second derivation this file exists to avoid.
	const bedRate = $derived.by(() => {
		if (!stay) return undefined;
		const rate = bedNightlyRate(stay, itinerary.travellers);
		return { amount: formatMoney(rate.money), audience: rate.audience };
	});

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
		const ride = `${transferModeLabel(toHotel.mode)}, ${formatDuration(transferRideDuration(toHotel))} from the airport, ${fare}`;
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

	{#if days}
		<p class="stopover-edge font-mono tabular-nums">{days.from}</p>
		<p class="stopover-days">{days.fullDays}</p>
		<p class="stopover-edge font-mono tabular-nums">{days.until}</p>
	{:else}
		<p class="stopover-days">No full days</p>
	{/if}

	<div class="stopover-stay">
		<!-- `nights > 0` as well as `stay`, since issue #231: a stopover can carry a priced
		     bed it does not need. Naming the property under a trip that books nothing would
		     put a hostel and no rate on the card and leave the reader to work out which of
		     the two they are being told. -->
		{#if stay && bedRate && nights > 0}
			<!-- Keyed on the property so a swap rebuilds the block rather than reusing it.
			     `PickedBed` counts which photograph the reader has reached, and carrying
			     that count over to a different hostel would open the new one on its second
			     picture and fetch it unasked. -->
			{#key propertyKey(stay.property)}
				<PickedBed
					property={stay.property}
					roomKindLabel={ROOM_KIND_LABELS[stay.roomKind]}
					{nights}
					rate={bedRate}
					{distanceFromAirport}
					transfer={{ note: transferLine, mode: toHotel?.mode }}
				/>
			{/key}
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
