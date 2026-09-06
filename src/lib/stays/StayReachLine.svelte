<script lang="ts">
	/**
	 * How long the journey out from the connection airport takes, as a glyph and a time per
	 * mode. Issue #405.
	 *
	 * The owner wrote his request as `🚶🏻43min 🚌10min 🚘4min`, which is the shape and not the
	 * typeface: `ModeIcon` already draws these three and `mode-icon.ts` already argues how
	 * specific a transit glyph is allowed to be. Emoji would also be the one thing
	 * `ui-ux-pro-max` calls out on sight, since they are font-dependent and untintable.
	 *
	 * ## Why this is a component rather than markup in the row
	 *
	 * Two surfaces draw it: the alternatives row, and the map dialog's sidebar list. That is
	 * the same reason `choice.ts` exists one layer down, and the same failure it prevents. A
	 * second copy is how one surface starts saying "43m" while the other says "43 min".
	 *
	 * ## What it draws when there is nothing to draw
	 *
	 * A row must never read as "there is no bus to this hostel" when nobody asked. So an empty
	 * reach falls back to the straight-line distance it replaced, which is a true statement
	 * about the property, and `reach.ts` keeps the actual per-mode answers for the surface
	 * that has room to print them. While the lookup is in flight the row holds the space
	 * instead, so a time does not appear where an absence just was.
	 */
	import { ModeIcon } from '$lib/components';
	import Skeleton from '$lib/components/Skeleton.svelte';
	import { formatDistanceKm } from './distance';
	import { reachIsPending, stayReachPoints, type StayReach } from './reach';

	interface Props {
		reach: StayReach | undefined;
		/** The straight line this replaces, printed only where no mode has a time. */
		distanceToAirportKm: number;
	}

	let { reach, distanceToAirportKm }: Props = $props();

	const points = $derived(stayReachPoints(reach));
	const pending = $derived(points.length === 0 && reachIsPending(reach));
</script>

<span class="reach">
	{#if points.length > 0}
		{#each points as point (point.mode)}
			<span class="reach-point">
				<ModeIcon kind={point.mode} />
				<span class="visually-hidden">{point.word}&nbsp;</span>
				<span class="reach-time font-mono tabular-nums">{point.time}</span>
			</span>
		{/each}
	{:else if pending}
		<Skeleton width="7.5rem" height="1rem" />
		<span class="visually-hidden">Working out how long it takes to get there</span>
	{:else}
		<span class="reach-fallback">{formatDistanceKm(distanceToAirportKm)} from the airport</span>
	{/if}
</span>

<style>
	.reach {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		/* Wider between modes than inside one, so "walk 43m" reads as one fact rather than
		   four things in a row. */
		gap: var(--space-1) var(--space-4);
		min-width: 0;
		font-size: var(--font-size-sm);
		line-height: var(--line-height-sm);
	}

	.reach-point {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		white-space: nowrap;
		/* The glyph is the quieter half of the pair. It says which mode; the number is what
		   the eye is scanning down the column for, so the number keeps full contrast and the
		   icon sits at muted. Both clear WCAG AA against every surface this row uses. */
		color: var(--color-text-muted);
	}

	.reach-time {
		color: var(--color-text);
		font-weight: var(--font-weight-medium);
	}

	.reach-point :global(svg) {
		width: 1rem;
		height: 1rem;
	}

	.reach-fallback {
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}
</style>
