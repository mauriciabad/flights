<script lang="ts">
	/**
	 * Issue #224: how long the stopover is, and the traveller's own control over it.
	 *
	 * The card opens on the shortest stopover the flight pairing allows, and this is what
	 * makes it longer. The owner, on a card that had chosen six nights beside Gatwick for
	 * him:
	 *
	 * > the nights should be kept to a minimum by default
	 *
	 * > and i can decide to add more nights if the city is interesting and the hotel in the
	 * > center
	 *
	 * ## Why it rides in the card's existing control row
	 *
	 * A card that fits two to a phone screen is the whole job of a results list, and this
	 * one is already 489 to 521px at 375 wide against the 462px #197 fought it down to. So
	 * this control adds no row: it sits at the left of the ticket's tear-line row, whose
	 * height is already set by the 44px "Show details" button beside it. Nothing on the card
	 * moves until the traveller presses a button.
	 *
	 * ## Why a stepper rather than a row of night chips
	 *
	 * Chips would show every length at once, which is the better affordance on a wide
	 * screen and unaffordable on a narrow one: six 44px targets plus the details toggle is
	 * two rows on a phone, and 44px is not negotiable (#197 measured a 36px alternative and
	 * rejected it). A stepper is two targets whatever the ladder's length, and stepping is
	 * the shape of the decision anyway: "one more night", not "jump to five".
	 *
	 * ## What the buttons say before they are pressed
	 *
	 * Each one names the trip it would produce and what it costs, both in its accessible
	 * name and in its tooltip, because a longer stay usually means a different onward
	 * flight at a different fare. Issue #224: "the card must say the price moved and why,
	 * never silently." The `note` below is the after: what actually changed, once the
	 * traveller is standing somewhere other than the default.
	 *
	 * ## The two things this renders, and the third it does not
	 *
	 * A trip with no night in it is not a short stopover, it is a flight change (issue
	 * #225), so the value reads that rather than "0 nights" and the price line beside it
	 * carries no bed. The ladder is still there whenever the city has one: hiding it would
	 * delete the stopover from every well-connected city, which is the product.
	 *
	 * A connection with exactly one possible length and a night in it renders NOTHING. The
	 * trip strip above already prints "2 nights in Vienna" in bold teal, and a control with
	 * one position is a label repeating it. The only single-length case that earns a slot is
	 * the flight change, because the strip has no way of saying "this one is not a stopover".
	 *
	 * Every string comes from `results/stopover-nights.ts`, pure and tested. This file
	 * arranges markup and picks classes.
	 */
	import type { Itinerary } from '$lib/domain';
	import { describeLengthStep, describeStopoverChange, neighbouringLengths, stopoverLengthLabel } from '$lib/results/stopover-nights';

	interface Props {
		/** The itinerary currently on the card, at the length currently chosen. */
		itinerary: Itinerary;
		/** The shortest pairing through this connection, the baseline every price move is
		 * measured against. The same object as `itinerary` while nothing is extended. */
		minimumItinerary: Itinerary;
		/** Every night count this connection offers, ascending (the `nights` of each
		 * `StopoverLengths.options` entry). */
		available: readonly number[];
		/** The itinerary at each available length, so a button can price its own step
		 * before it is pressed. Keyed by night count. */
		itineraryAtLength: (nights: number) => Itinerary | undefined;
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
		minimumItinerary,
		available,
		itineraryAtLength,
		isFlightChange,
		connectionLabel,
		deprioritized = false,
		onNightsChange
	}: Props = $props();

	const nights = $derived(itinerary.nightsInConnection);
	const label = $derived(stopoverLengthLabel(nights));
	const neighbours = $derived(neighbouringLengths(available, nights));
	const change = $derived(describeStopoverChange(itinerary, minimumItinerary));

	/** What one step in either direction would produce: the trip, and what it costs
	 * against the trip on screen. `undefined` at that end of the ladder, which is what
	 * disables the button. A missing button would move the other one under the traveller's
	 * finger between presses. */
	function step(nights: number | undefined) {
		if (nights === undefined) return undefined;
		const target = itineraryAtLength(nights);
		if (!target) return undefined;
		return { nights, label: stopoverLengthLabel(nights), cost: describeLengthStep(itinerary, target) };
	}

	const longer = $derived(step(neighbours.longer));
	const shorter = $derived(step(neighbours.shorter));
	/** Two buttons with nowhere to go are two buttons nobody can press. */
	const canChooseLength = $derived(longer !== undefined || shorter !== undefined);

	// "2 nights in London, one more night, +EUR 41.00". The outcome, not the verb:
	// "increase" tells a screen-reader user which way the button points and nothing about
	// where it lands, and where it lands is a different flight at a different price.
	function stepDescription(target: { label: string; cost?: string } | undefined, verb: string): string {
		if (!target) return verb;
		const trip = `${target.label} in ${connectionLabel}`;
		return target.cost ? `${trip}, ${target.cost}` : trip;
	}
</script>

{#if !canChooseLength}
	{#if isFlightChange}
		<!-- The one fact the trip strip cannot carry: this trip has no night in it, so it
		     is an ordinary connection and its total is the flights alone. Static, because
		     this city offers nothing longer to step to. -->
		<p
			class={['stopover-nights', 'is-connection', { 'is-quiet': deprioritized }]}
			title="Lands and leaves {connectionLabel} on the same day, so there is no night to book."
		>
			{label}
		</p>
	{/if}
{:else}
	<div class={['stopover-nights', { 'is-quiet': deprioritized }]} role="group" aria-label="Nights in {connectionLabel}">
		<button
			type="button"
			class="nights-step"
			disabled={!shorter}
			aria-label={stepDescription(shorter, 'One night fewer')}
			title={shorter?.cost ? `${shorter.label}, ${shorter.cost}` : undefined}
			onclick={() => shorter && onNightsChange?.(shorter.nights)}
		>
			<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
				<path d="M4 8h8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
			</svg>
		</button>
		<!-- Announced on change so a screen-reader user hears the trip they just chose,
		     not only the button they pressed. Polite: the price and the strip beside it
		     are updating in the same frame and none of it is urgent. -->
		<span class="nights-value font-mono tabular-nums" aria-live="polite">{label}</span>
		<button
			type="button"
			class="nights-step"
			disabled={!longer}
			aria-label={stepDescription(longer, 'One night more')}
			title={longer?.cost ? `${longer.label}, ${longer.cost}` : undefined}
			onclick={() => longer && onNightsChange?.(longer.nights)}
		>
			<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
				<path d="M8 4v8M4 8h8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
			</svg>
		</button>
		{#if change.note}
			<!-- Issue #224: "Do not silently cap it either. If the traveller extends beyond
			     what the flight pairing supports, the onward flight has to change, and the
			     card must say the price moved and why." Only ever rendered once the
			     traveller has moved off the default, so no ordinary card pays for it. -->
			<span class="nights-note">{change.note}</span>
		{/if}
	</div>
{/if}

<style>
	/* Tight on the column axis, because this row has to hold the control and the
	   "Show details" button on one line at 375. Measured: the row has 309px there, the
	   toggle takes 124, and the control has to come in under 173. */
	.stopover-nights {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1);
		margin: 0;
	}

	/* The stopover teal, the same reserved colour the strip's free-time cells and its
	   "2 nights in Vienna" caption already carry, so the number here and the shape above
	   read as one fact rather than two.

	   3.5rem holds "1 night" and lets "2 nights" grow past it. It is a floor rather than a
	   width so the wording is never clipped; the cost is that a card reading "Flight
	   change" wraps this row on a phone, which is the rarer card and the one whose words
	   carry the most. */
	.nights-value {
		min-width: 3.5rem;
		text-align: center;
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		color: var(--color-stopover);
	}

	/* A ticket stub: square-ish, hairline, the same radius the rest of the card uses. 44px
	   because #197 measured a 36px stepper in the timeline and rejected it, and this row's
	   own "Show details" button is already 2.75rem. */
	.nights-step {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.75rem;
		height: 2.75rem;
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-md);
		color: var(--color-stopover);
		/* No double-tap zoom delay on the one control a traveller presses repeatedly. */
		touch-action: manipulation;
		transition:
			color var(--transition-fast),
			border-color var(--transition-fast),
			background-color var(--transition-fast);
	}

	.nights-step svg {
		width: 1rem;
		height: 1rem;
	}

	.nights-step:hover:not(:disabled) {
		background: var(--color-stopover-bg);
		border-color: var(--color-stopover);
	}

	.nights-step:active:not(:disabled) {
		/* Colour, not transform: a control sitting in a row with a fixed height must not
		   nudge its neighbours on press. */
		background: var(--color-stopover-bg);
	}

	.nights-step:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	/* The end of the ladder, kept in place rather than removed: a vanishing button moves
	   the other one under a finger already on its way down. The cursor and the `disabled`
	   attribute carry it as well as the colour does. */
	.nights-step:disabled {
		color: var(--color-text-faint);
		border-color: var(--color-border);
		cursor: not-allowed;
	}

	.nights-note {
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}

	/* A trip with no night in it. Reads as a stamped note on the ticket, the same
	   treatment `.technical-stop` uses for the other honest fact about a flight, because
	   this is a fact about the trip rather than a warning about it. */
	.is-connection {
		padding: 0 var(--space-2);
		border: 1px dashed var(--color-border-strong);
		border-radius: var(--radius-sm);
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.is-quiet .nights-value,
	.is-quiet .nights-step {
		color: var(--color-text-deprioritized);
	}

	.is-quiet.is-connection {
		color: var(--color-text-deprioritized);
		border-color: var(--color-border);
	}
</style>
