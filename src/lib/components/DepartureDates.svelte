<script lang="ts">
	/**
	 * Issue #387's "Leaving on": every day this stopover's fares can be flown on, each
	 * priced against the trip on screen.
	 *
	 * The owner named the model himself:
	 *
	 * > I should be able to easily see and change the dates&times of the flights (and
	 * > recalculated hotel) shorted by best price. now I can easily change the duration of
	 * > the free time, that is well done. but changing the departure date is not easy
	 *
	 * So this is `StopoverNights` on the other axis, down to the stub shape, the punch mark
	 * on the current rung and the two-line stub that fits four across a 375px phone. A
	 * traveller who has learned one ladder has learned both, and the panel now says the same
	 * thing about both axes of a pairing instead of about one of them.
	 *
	 * ## Why the rungs are gold rather than teal
	 *
	 * `app.css` reserves `--color-stopover` for "the one thing this app is actually selling:
	 * the free city in the middle... and nothing else does, so it stays recognisable across
	 * screens". A departure date is a fact about the flight, so it takes the accent the
	 * flight picker's own selected row already uses. The two ladders being different colours
	 * is not decoration: it is which half of the trip you are moving.
	 *
	 * ## What is deliberately not here
	 *
	 * No month on a rung. A search window is days, so weekday plus day number identifies
	 * every rung on its own and a month would be the same word on all of them, in a control
	 * whose whole job is to fit several stubs across a phone.
	 *
	 * Every string comes from `results/departure-ladder.ts`, pure and tested. This file
	 * arranges markup and picks classes.
	 */
	import Icon from './Icon.svelte';
	import type { Itinerary } from '$lib/domain';
	import type { DepartureDateOption } from '$lib/results/departure-ladder';
	import { departureLadder, describeDepartureLadder } from '$lib/results/departure-ladder';

	interface Props {
		/** The itinerary currently on the card, on the date currently chosen. */
		itinerary: Itinerary;
		/** Every date this connection can leave on, in calendar order, with the trip on each,
		 * so a stub prices itself before anyone presses it. */
		options: readonly DepartureDateOption[];
		/** Colour-only quieting for an itinerary on an avoided airline, matching the rest of
		 * the card. */
		deprioritized?: boolean;
		onDateChange?: (date: string) => void;
	}

	let { itinerary, options, deprioritized = false, onDateChange }: Props = $props();

	const rungs = $derived(departureLadder(itinerary, options));
	const movesNote = $derived(describeDepartureLadder(itinerary, options));
	/** One rung is a stopover that can only be flown on one day, and a ladder saying so is a
	 * label repeating the flight row directly below it. */
	const hasLadder = $derived(rungs.length > 1);
</script>

{#if hasLadder}
	<div class={['leaving-on', { 'is-quiet': deprioritized }]}>
		<p class="ladder-head">
			<span class="ladder-title">Leaving on</span>
			{#if movesNote}
				<!-- Said before the press rather than announced after it. Which parts of the trip
				     a rung moves is the fact that decides whether its delta is worth trusting,
				     and it is derived from the rungs themselves rather than asserted. -->
				<span class="ladder-note">{movesNote}</span>
			{/if}
		</p>
		<!-- Buttons rather than radios, for `StopoverNights`' reason: this is not a form
		     field, and native radios would need a name unique per card to stop two cards
		     sharing one group. `aria-pressed` carries the chosen state and each stub says it
		     in words too, because colour is never the only channel (WCAG 1.4.1). -->
		<div class="ladder" role="group" aria-label="Departure date">
			{#each rungs as rung (rung.date)}
				<button
					type="button"
					class={['rung', { 'is-current': rung.isCurrent, 'is-cheapest': rung.isCheapest }]}
					aria-pressed={rung.isCurrent}
					aria-label={rung.description}
					data-testid="departure-rung"
					data-date={rung.date}
					onclick={() => !rung.isCurrent && onDateChange?.(rung.date)}
				>
					<span class="rung-date">
						{#if rung.isCurrent}
							<!-- A punched ticket, the same third channel the nights ladder uses after
							     the fill and the words. -->
							<Icon name="check" class="rung-punch" />
						{/if}{rung.label}
					</span>
					<span class="rung-price font-mono tabular-nums">{rung.delta ?? 'this trip'}</span>
				</button>
			{/each}
		</div>
	</div>
{/if}

<style>
	.leaving-on {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.ladder-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-1) var(--space-3);
		margin: 0;
	}

	/* The same eyebrow as "Staying longer", so the two ladders read as one receipt rather
	   than as two components that happen to be stacked in one rail. */
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

	/* A tear-off stub, identical in metrics to the nights ladder's: 44px tall, hairline
	   bordered, two lines so the date and its price both stay legible at 375px. */
	.rung {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		justify-content: center;
		gap: 1px;
		min-height: 2.75rem;
		max-width: 100%;
		padding: var(--space-1) var(--space-3);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-md);
		background: var(--color-bg-inset);
		touch-action: manipulation;
		transition:
			background-color var(--transition-fast),
			border-color var(--transition-fast),
			box-shadow var(--transition-fast),
			color var(--transition-fast);
	}

	.rung-date {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		line-height: 1.2;
		color: var(--color-accent);
		white-space: nowrap;
	}

	.rung-date :global(.rung-punch) {
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

	/* The owner asked for the days "shorted by best price". The row stays in calendar order
	   so a date still reads as a date, and the cheapest one is marked instead: a dashed
	   underline plus the word in its accessible name, which is a second channel rather than
	   a colour swap that would compete with the current rung's fill. */
	.rung.is-cheapest .rung-price {
		color: var(--color-success);
		text-decoration: underline dashed;
		text-underline-offset: 3px;
	}

	.rung:hover:not(.is-current) {
		background: var(--color-accent-muted);
		border-color: var(--color-accent);
	}

	/* Colour, not transform: these stubs sit in a wrapping row and a press that nudged one
	   would shift the whole line under the finger doing the pressing. */
	.rung:active:not(.is-current) {
		background: var(--color-accent-muted);
	}

	.rung:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	/* Marked three ways, as the nights ladder is: the fill, a doubled ring, and the punch
	   beside the words "this trip". The second ring is an inset shadow rather than a wider
	   border, because widening a border moves every neighbouring stub by a pixel on press. */
	.rung.is-current {
		background: var(--color-accent-muted);
		border-color: var(--color-accent);
		box-shadow: inset 0 0 0 1px var(--color-accent);
		cursor: default;
	}

	.rung.is-current .rung-price {
		color: var(--color-accent-muted-text);
	}

	.is-quiet .rung-date,
	.is-quiet .rung.is-current .rung-price,
	.is-quiet .rung.is-cheapest .rung-price {
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
</style>
