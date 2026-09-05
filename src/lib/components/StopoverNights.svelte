<script lang="ts">
	/**
	 * Issue #225's "Staying longer": every stopover length this city's fares actually
	 * support, each priced against the trip on screen.
	 *
	 * The owner's sketch, after being shown that London's second night costs minus three
	 * euros:
	 *
	 * ```
	 * STAYING LONGER
	 *   [+] 1 more night   -€3.00
	 *   [+] 2 more nights  +€24.00
	 *   (different onward flight each time)
	 * ```
	 *
	 * ## Why a row of stubs rather than the stepper this replaces
	 *
	 * #224 shipped a plus/minus stepper here because a row of night chips was unaffordable
	 * on a phone at 44px each. What changed is that the owner asked to see every length's
	 * price at once, and a stepper can only ever quote the next rung: the traveller had to
	 * press it to find out whether the rung after that was cheaper, and pressing it changed
	 * the trip. Two lines per stub, length above price, gets four rungs into the width of
	 * one row on a 375px card, so the whole ladder is usually one row and never more than
	 * two.
	 *
	 * It also removes the stepper's one real weakness. A stepper has no way to say "you are
	 * here"; this row marks the shown trip in words as well as in colour, and every other
	 * rung's delta is measured against it, so the headline above plus any stub is exactly
	 * what that stub costs.
	 *
	 * ## The badge a nightless trip gets instead
	 *
	 * A trip with no night in it is not a short stopover, and since issue #231 it is one of
	 * two things. A same-day connection lands and leaves before midnight. An overnight wait
	 * crosses a midnight it is too short to sleep through, and telling that traveller their
	 * connection is same-day would describe a different journey from the one they are on, so
	 * the badge reads "Overnight wait" and its title carries the hours.
	 *
	 * ## What is deliberately not here
	 *
	 * No "+EUR x per night". A pairing's nights are fixed by its two flights, so a longer
	 * stay is a different pairing on a different onward fare, and pricing a night off the
	 * bed's nightly rate would have quoted EUR 13 for the night that really costs minus
	 * three. Every figure on this row is two real totals subtracted.
	 *
	 * Every string comes from `results/stopover-nights.ts`, pure and tested. This file
	 * arranges markup and picks classes.
	 */
	import Icon from './Icon.svelte';
	import type { Itinerary } from '$lib/domain';
	import type { StopoverLengthOption } from '$lib/results/types';
	import {
		describeLadderFlights,
		overnightWaitNote,
		stopoverLadder,
		stopoverLengthLabelFor
	} from '$lib/results/stopover-nights';

	interface Props {
		/** The itinerary currently on the card, at the length currently chosen. */
		itinerary: Itinerary;
		/** Every length this connection offers, ascending, with the trip at each, so a stub
		 * prices itself before anyone presses it. */
		options: readonly StopoverLengthOption[];
		/** True when the shortest pairing spends no night here, which makes this a flight
		 * change rather than a stopover (issue #225). */
		isFlightChange: boolean;
		/** The stopover city's name, for the group's accessible name. Falls back to the
		 * IATA code upstream, never to a guess. */
		connectionLabel: string;
		/** Colour-only quieting for an itinerary on an avoided airline, matching the rest
		 * of the card. */
		deprioritized?: boolean;
		onNightsChange?: (nights: number) => void;
	}

	let {
		itinerary,
		options,
		isFlightChange,
		connectionLabel,
		deprioritized = false,
		onNightsChange
	}: Props = $props();

	const rungs = $derived(stopoverLadder(itinerary, options, connectionLabel));
	const flightsNote = $derived(describeLadderFlights(itinerary, options));
	/** A ladder with one rung is a label repeating the trip strip's own "2 nights in
	 * Vienna", so it renders nothing at all. The one single-length case that earns a slot
	 * is the flight change, because the strip has no way of saying "this is not a
	 * stopover". */
	const hasLadder = $derived(rungs.length > 1);
	// Issue #231: "no nights" is two different trips, and the badge below is the only place
	// that says which. `undefined` for a same-day connection, and for every real stopover.
	const waitNote = $derived(overnightWaitNote(itinerary));
</script>

{#if hasLadder}
	<div class={['staying-longer', { 'is-quiet': deprioritized }]}>
		<p class="ladder-head">
			<span class="ladder-title">Staying longer</span>
			{#if flightsNote}
				<!-- The owner's "(different onward flight each time)", derived from which
				     flights actually move rather than asserted: a city whose lengths all share
				     one outbound really does only move the onward leg. -->
				<span class="ladder-note">{flightsNote}</span>
			{/if}
		</p>
		<!-- Buttons rather than radios: this is not a form field, and native radios would
		     need a name unique per card to stop two cards sharing one group. `aria-pressed`
		     carries the chosen state, and each stub also says it in words, because colour is
		     never the only channel (WCAG 1.4.1). -->
		<div class="ladder" role="group" aria-label="Nights in {connectionLabel}">
			{#each rungs as rung (rung.nights)}
				<button
					type="button"
					class={['rung', { 'is-current': rung.isCurrent }]}
					aria-pressed={rung.isCurrent}
					aria-label={rung.description}
					onclick={() => !rung.isCurrent && onNightsChange?.(rung.nights)}
				>
					<span class="rung-length">
						{#if rung.isCurrent}
							<!-- A punched ticket. Third channel on the chosen stub after the fill and
							     the words, and the only one that survives being read at arm's length. -->
							<Icon name="check" class="rung-punch" />
						{/if}{rung.label}
					</span>
					<span class="rung-price font-mono tabular-nums">{rung.delta ?? 'this trip'}</span>
				</button>
			{/each}
		</div>
	</div>
{:else if isFlightChange}
	<!-- The one fact the trip strip cannot carry: this trip has no night in it, so it is an
	     ordinary connection and its total is the flights alone. Static, because this city
	     offers nothing longer to step to. -->
	<p
		class={['stopover-nights', 'is-connection', { 'is-quiet': deprioritized }]}
		title={waitNote
			? `${waitNote}, so the total is the flights alone.`
			: `Lands and leaves ${connectionLabel} on the same day, so there is no night to book.`}
	>
		{stopoverLengthLabelFor(itinerary)}
	</p>
{/if}

<style>
	.staying-longer {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	/* The eyebrow and its caveat share a line and wrap onto two when the phone is too
	   narrow for both, which is where the caveat belongs anyway: under the label it
	   qualifies, above the row it explains. */
	.ladder-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-1) var(--space-3);
		margin: 0;
	}

	/* Matches the price block's own eyebrow above it, so "Getting there" and "Staying
	   longer" read as the two halves of one receipt rather than as two components that
	   happen to be stacked. */
	.ladder-title {
		font-family: var(--font-mono);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-wide);
		text-transform: uppercase;
		color: var(--color-text-muted);
	}

	.ladder-note {
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	.ladder {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	/* A tear-off stub: 44px tall because #197 measured a 36px control here and rejected
	   it, hairline bordered, on the card's own radius. Two lines rather than one so the
	   length and its price both stay legible at 375, where a single-line stub reading
	   "2 nights +€24.00" is 140px and only two fit a row.

	   Filled rather than bare, so the unchosen stubs read as things you can press. A row
	   of hairline outlines on a phone, where there is no hover to discover them with,
	   looks like labels. */
	.rung {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		justify-content: center;
		gap: 1px;
		min-height: 2.75rem;
		/* The two lines inside never wrap, so a stub is as wide as its widest line. This
		   clamp is what stops an unusually long one (a currency whose formatted delta runs
		   past the card, say) pushing the row out of the card rather than taking a row of
		   its own. */
		max-width: 100%;
		padding: var(--space-1) var(--space-3);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-md);
		background: var(--color-bg-inset);
		/* No double-tap zoom delay on a control a traveller presses repeatedly. */
		touch-action: manipulation;
		transition:
			background-color var(--transition-fast),
			border-color var(--transition-fast),
			box-shadow var(--transition-fast),
			color var(--transition-fast);
	}

	.rung-length {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		line-height: 1.2;
		color: var(--color-stopover);
		white-space: nowrap;
	}

	.rung-length :global(.rung-punch) {
		width: 0.8rem;
		height: 0.8rem;
		flex-shrink: 0;
	}

	.rung-price {
		font-size: var(--font-size-xs);
		line-height: 1.2;
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.rung:hover:not(.is-current) {
		background: var(--color-stopover-bg);
		border-color: var(--color-stopover);
	}

	/* Colour, not transform: these stubs sit in a wrapping row and a press that nudged one
	   would shift the whole line under the finger doing the pressing. */
	.rung:active:not(.is-current) {
		background: var(--color-stopover-bg);
	}

	.rung:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	/* The trip the price above describes, marked three ways so returning to it is obvious
	   rather than merely possible: the teal fill, a doubled ring, and the punch mark with
	   the words "this trip". Colour is never the only channel (WCAG 1.4.1), and here it is
	   not even the loudest one.

	   The second ring is an inset shadow rather than a 2px border, because widening a
	   border would move the stub's neighbours by a pixel on every press. */
	.rung.is-current {
		background: var(--color-stopover-bg);
		border-color: var(--color-stopover);
		box-shadow: inset 0 0 0 1px var(--color-stopover);
		cursor: default;
	}

	.rung.is-current .rung-price {
		color: var(--color-stopover);
	}

	/* A trip with no night in it. Reads as a stamped note on the ticket, the same
	   treatment `.technical-stop` uses for the other honest fact about a flight, because
	   this is a fact about the trip rather than a warning about it. */
	.is-connection {
		align-self: flex-start;
		margin: 0;
		padding: 0 var(--space-2);
		border: 1px dashed var(--color-border-strong);
		border-radius: var(--radius-sm);
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.is-quiet .rung-length,
	.is-quiet .rung.is-current .rung-price {
		color: var(--color-text-deprioritized);
	}

	.is-quiet .rung,
	.is-quiet .rung.is-current {
		border-color: var(--color-border);
		background: var(--color-bg-inset);
		box-shadow: inset 0 0 0 1px var(--color-border-strong);
	}

	.is-quiet .rung:not(.is-current) {
		box-shadow: none;
	}

	.is-quiet.is-connection {
		color: var(--color-text-deprioritized);
		border-color: var(--color-border);
	}
</style>
