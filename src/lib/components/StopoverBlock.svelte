<script lang="ts">
	/**
	 * The stopover, in the block the owner settled on in issue #228: three time lines in
	 * trip order, then the stay, always that order and always present.
	 *
	 * > Fri 9 from 9:10pm
	 * > 2 full days: Sat, Sun
	 * > Mon 12 until 9:05am
	 * >
	 * > Wombat's City Hostel
	 * > 6-bed mixed dorm
	 * > 2 nights, 52.82 EUR/night
	 * > [transport icon] 30 min from airport, 10 EUR/way
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
	 * - The rate is `stay.pricePerNight` through `formatMoney`, the app's one money edge.
	 * - The room kind is `ROOM_KIND_LABELS`, the same table the stay picker's tiles use.
	 * - The transfer's duration, mode and fare are `itinerary.transferToHotel` through
	 *   `formatDuration`, `transferModeLabel` and `unpricedTransferNote`, and when nothing
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
	 * ## Issue #227
	 *
	 * That issue is building a hover panel over the trip strip whose design carries this
	 * same content. This component is what it should render rather than writing a second
	 * one; it takes an `Itinerary` and nothing else, so a popover can call it unchanged.
	 */
	import type { Itinerary } from '$lib/domain';
	import { formatDuration, formatMoney } from '$lib/format';
	import { ROOM_KIND_LABELS } from '$lib/stays';
	import { freeTimeDays } from './free-time-days';
	import { transferModeLabel, unpricedTransferNote, unroutedLegNote } from './itinerary-timeline-format';

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
	const nights = $derived(itinerary.nightsInConnection);
	const stay = $derived(itinerary.stay);
	const toHotel = $derived(itinerary.transferToHotel);

	const nightsAndRate = $derived.by(() => {
		if (!stay || nights === 0) return undefined;
		return `${nights} ${nights === 1 ? 'night' : 'nights'}, ${formatMoney(stay.pricePerNight)}/night`;
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
			return unroutedLegNote('to-hotel', { hasStay: Boolean(stay), nightsInConnection: nights });
		}
		const fare = toHotel.price
			? `${formatMoney(toHotel.price)} each way`
			: unpricedTransferNote(toHotel.mode).toLocaleLowerCase();
		return `${transferModeLabel(toHotel.mode)}, ${formatDuration(toHotel.duration)} from the airport, ${fare}`;
	});

	// Issue #140 ruled out "yet" for a state nothing is about to change, and separates a
	// night with no bed priced from a same-day connection that has no bed to price.
	const noBedLine = $derived(
		nights > 0 ? 'No bed priced, so the total is a floor' : 'No night spent here, so there is no bed to price'
	);
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
		{#if stay}
			<p class="stopover-property">{stay.property.name}</p>
			<p class="stopover-room">{ROOM_KIND_LABELS[stay.roomKind]}</p>
			{#if nightsAndRate}
				<p class="stopover-rate font-mono tabular-nums">{nightsAndRate}</p>
			{/if}
		{:else}
			<p class="stopover-room">{noBedLine}</p>
		{/if}
		<p class="stopover-transfer">{transferLine}</p>
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

	.stopover-property {
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		color: var(--color-text);
	}

	.stopover-room,
	.stopover-rate,
	.stopover-transfer {
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-muted);
	}

	/* Colour swap rather than opacity, the treatment AGENTS.md names for an avoided
	   airline: every line here still has to be readable. */
	:global(.is-deprioritized) .stopover-days,
	:global(.is-deprioritized) .stopover-edge,
	:global(.is-deprioritized) .stopover-property {
		color: var(--color-text-deprioritized);
	}
</style>
