<script lang="ts">
	/**
	 * A blank ticket, standing in for a result card that has not arrived yet.
	 *
	 * Issue #314. What stood here was four grey bars in a 15rem box, against real cards that
	 * measure 552px plain and 828px at their worst (`tests/e2e/card-size.spec.ts`), and only
	 * ever one of them. So the list grew from nothing as results streamed in, and the
	 * provider strip and the widen panel under it were pushed down the page once per card.
	 * On a phone that was 1.42 of Cumulative Layout Shift against Google's 0.10.
	 *
	 * It mirrors `ResultCard`'s blocks rather than approximating its height with a number:
	 * the same `Card variant="ticket"`, the same header, the same `card-main` padding and
	 * gaps, a stand-in for each of the four blocks the card prints. A skeleton built from
	 * the real component's grid tracks the real card at any width, which one fixed
	 * `min-height` cannot. The route block alone is 89px on a 375px phone and 50px once
	 * there is room for the country names.
	 *
	 * It does not have to match exactly, and it will not. A card carrying a price band is
	 * 140px taller than one without. What has to be right is the reserved stack as a whole
	 * being taller than the viewport, which is `RESERVED_RESULT_SLOTS`' job on the results
	 * page: everything under the list then starts below the fold, and a slot filling at the
	 * wrong height moves only what is already off screen.
	 *
	 * `aria-hidden` throughout, per `Skeleton`'s own contract: the results subhead already
	 * says "still searching" in a live region, and seven shimmering blocks announcing
	 * themselves would talk over it.
	 */
	import { Card, Skeleton } from '$lib/components';
</script>

<Card variant="ticket" elevated padded={false} class="result-card-skeleton">
	{#snippet header()}
		<div class="route-shape" aria-hidden="true">
			<span class="leg-shape">
				<Skeleton circle width="1.25rem" height="1.25rem" />
				<Skeleton width="4.5rem" height="1.125rem" />
			</span>
			<span class="arrow-shape">→</span>
			<span class="leg-shape">
				<Skeleton circle width="1.25rem" height="1.25rem" />
				<Skeleton width="5.5rem" height="1.125rem" />
			</span>
			<span class="arrow-shape">→</span>
			<span class="leg-shape">
				<Skeleton circle width="1.25rem" height="1.25rem" />
				<Skeleton width="4rem" height="1.125rem" />
			</span>
		</div>
	{/snippet}

	<div class="main-shape" aria-hidden="true">
		<!-- The detour drawing and the receipt beside it, the row `card-getting-there` lays
		     out the same way. -->
		<div class="getting-there-shape">
			<Skeleton width="5rem" height="5rem" radius="var(--radius-md)" />
			<div class="receipt-shape">
				<Skeleton width="7rem" height="1.75rem" />
				<Skeleton lines={2} height="0.875rem" />
			</div>
		</div>

		<!-- The trip strip: one bar the height of the real one, and its caption under it. -->
		<div class="strip-shape">
			<Skeleton height="3.5rem" radius="var(--radius-md)" />
			<Skeleton width="55%" height="0.875rem" />
		</div>

		<!-- Free time, in flight, airport wait, door to door: four cells, as `MetricRail`
		     prints them. -->
		<div class="rail-shape">
			{#each [0, 1, 2, 3] as cell (cell)}
				<div class="rail-cell-shape">
					<Skeleton width="70%" height="0.75rem" />
					<Skeleton width="50%" height="1.25rem" />
				</div>
			{/each}
		</div>
	</div>

	{#snippet footer()}
		<div class="provenance-shape" aria-hidden="true">
			<Skeleton width="8rem" height="0.875rem" />
			<Skeleton width="3.5rem" height="0.875rem" />
		</div>
	{/snippet}
</Card>

<style>
	/* The floor, and the number that makes the reservation work.
	 *
	 * 480px is what a 375x812 phone has between the top of the list and the bottom of the
	 * screen (measured: the list starts at y=335). At or above it, the second reserved slot
	 * starts off screen and stays off screen whether the card that lands in the first one is
	 * the 453px this route builds or the 828px worst case, so a slot filling at the wrong
	 * height moves nothing anybody can see. Below it, every arrival drags the next slot
	 * across the fold.
	 *
	 * It also sits inside the range of real cards rather than above it: 453px on the owner's
	 * BCN to PFO search, 552px plain and 828px worst case on the fixtures
	 * `tests/e2e/card-size.spec.ts` measures. So the shape above fills it rather than
	 * leaving a hole under a short skeleton. */
	:global(.result-card-skeleton) {
		min-height: 30rem;
	}

	.route-shape {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.leg-shape {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
	}

	/* The one glyph that is not a shimmering block. The real header prints these arrows
	   between the three places, and keeping them makes the blank ticket read as a route
	   rather than as a row of bars. */
	.arrow-shape {
		color: var(--color-border-strong);
	}

	.main-shape {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		padding: var(--space-4) var(--space-5);
	}

	.getting-there-shape {
		display: flex;
		align-items: flex-start;
		gap: var(--space-4);
	}

	.receipt-shape {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		flex: 1;
		min-width: 0;
	}

	.strip-shape {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.rail-shape {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-3) var(--space-4);
	}

	.rail-cell-shape {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.provenance-shape {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
	}

	@media (min-width: 40rem) {
		.rail-shape {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}
</style>
