<script lang="ts">
	/**
	 * What the stopover is actually worth, in the three lines the owner wrote on issue
	 * #228: when you reach the city, which whole days are yours, and when you leave for
	 * the airport again.
	 *
	 * It replaces a `FREE TIME 2d 15h` cell in the rail below. His objection to that cell
	 * is the whole issue: `2d 15h` reads as two and a half usable days when it may be two
	 * evenings and a morning. Nobody plans a trip in durations.
	 *
	 * Every string here comes from `free-time-days.ts`, which is pure and pins all four of
	 * his worked blocks character for character. This file arranges them and picks classes;
	 * it never decides what a day is worth or how a clock reads.
	 *
	 * The middle line is the answer, so it is the one in the stopover teal at full size.
	 * The two edges are the qualifiers, quiet and mono beside it. No line explains the
	 * other two: he rejected "still counts" and "too late to count", and a day that appears
	 * both in an edge line and in the middle one is simply true.
	 */
	import type { Itinerary } from '$lib/domain';
	import { freeTimeDays } from './free-time-days';

	interface Props {
		itinerary: Itinerary;
	}

	let { itinerary }: Props = $props();

	// `undefined` for a connection whose free-time window has no length: a same-day change
	// with the whole gap eaten by the waiting rule and the transfers. Three lines about
	// nothing is worse than no block.
	const days = $derived(freeTimeDays(itinerary.freeTime.start, itinerary.freeTime.end));
</script>

{#if days}
	<div class="free-time">
		<p class="free-time-label font-mono">Free time</p>
		<p class="free-time-edge font-mono tabular-nums">{days.from}</p>
		<p class="free-time-days">{days.fullDays}</p>
		<p class="free-time-edge font-mono tabular-nums">{days.until}</p>
	</div>
{/if}

<style>
	/* The same hairline-over-field treatment MetricRail uses, so this reads as one more
	   printed field on the ticket rather than as a panel that wandered in. */
	.free-time {
		padding-top: var(--space-2);
		border-top: 1px solid var(--color-border);
	}

	.free-time p {
		margin: 0;
	}

	/* `--color-text-muted`, not `--color-text-faint`, for the reason MetricRail records:
	   the faint token measures 4.19:1 on the dark palette's card surface, under WCAG AA,
	   and this is a field label rather than decoration. */
	.free-time-label {
		font-size: 0.625rem;
		font-weight: var(--font-weight-medium);
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-muted);
	}

	.free-time-days {
		font-size: var(--font-size-base);
		font-weight: var(--font-weight-semibold);
		line-height: 1.3;
		color: var(--color-stopover);
	}

	/* Ordered so the three lines read in trip order while the middle one still carries the
	   weight: the edges are a size down and quiet, not hidden. */
	.free-time-edge {
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-muted);
	}

	/* Colour swap rather than opacity, the treatment AGENTS.md names for an avoided
	   airline: these lines still have to be readable. */
	:global(.is-deprioritized) .free-time-days,
	:global(.is-deprioritized) .free-time-edge {
		color: var(--color-text-deprioritized);
	}
</style>
