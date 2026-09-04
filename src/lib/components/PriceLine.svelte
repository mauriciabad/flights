<script lang="ts">
	/**
	 * The trip's price: the total, large, with the parts that made it underneath.
	 *
	 * Brief line 54 asks for "price of each part and in total", and until now the card
	 * showed only the total while the parts sat behind an expander. The split between what
	 * the flights cost and what the bed costs is the whole argument of this app, so it
	 * belongs next to the number it explains.
	 *
	 * `priceBreakdown` (itinerary-metrics.ts) reuses the itinerary builder's own
	 * `scaleFareForParty`/`sumMoney`, so these lines always add up to the total beside them.
	 * A one-part breakdown is not shown at all: "Flights €229.00" next to "€229.00" is a
	 * row that carries nothing. The unpriced-bed line is independent of that, because it is
	 * the one thing the total genuinely does not say.
	 */
	import type { Itinerary } from '$lib/domain';
	import { formatMoney } from '$lib/format';
	import { priceBreakdown } from './itinerary-metrics';

	interface Props {
		itinerary: Itinerary;
		/** `lg` for the results card's headline, `md` anywhere the price is not the
		 * loudest thing in its own block. */
		size?: 'md' | 'lg';
	}

	let { itinerary, size = 'lg' }: Props = $props();

	const breakdown = $derived(priceBreakdown(itinerary));
	const showParts = $derived(breakdown.parts.length > 1);
</script>

<div class={['price-line', `price-line-${size}`]}>
	<p class="price-total font-mono tabular-nums">{formatMoney(breakdown.total)}</p>
	{#if showParts || breakdown.missingStay}
		<ul class="price-parts">
			{#if showParts}
				{#each breakdown.parts as part (part.id)}
					<li class="price-part">
						<span class="price-part-label">{part.label}{#if part.detail}, {part.detail}{/if}</span>
						<span class="price-part-amount font-mono tabular-nums">{formatMoney(part.money)}</span>
					</li>
				{/each}
			{/if}
			{#if breakdown.missingStay}
				<!-- Issue #117/#140: a plain fact about this itinerary, sitting in the
				     breakdown where the missing line would have been, rather than as a
				     separate banner repeated card after card. `StayKeyNotice` above the whole
				     list is the one place that names the cause and the fix. Gated on a night
				     actually being spent here: a same-day connection has no bed to miss. -->
				<li class="price-part price-part-missing">
					<span class="price-part-label">Bed</span>
					<span class="price-part-amount">not priced</span>
				</li>
			{/if}
		</ul>
	{/if}
</div>

<style>
	.price-line {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-1) var(--space-4);
	}

	.price-total {
		font-weight: var(--font-weight-bold);
		letter-spacing: var(--tracking-tight);
	}

	.price-line-lg .price-total {
		font-size: var(--font-size-2xl);
	}

	.price-line-md .price-total {
		font-size: var(--font-size-xl);
	}

	/* The parts read as a receipt tail beside the total, not as a table: one line each,
	   label then amount, hairline-separated only where they wrap onto their own row. */
	.price-parts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-3);
		font-size: var(--font-size-xs);
	}

	.price-part {
		display: flex;
		align-items: baseline;
		gap: var(--space-1);
		white-space: nowrap;
	}

	.price-part-label {
		color: var(--color-text-muted);
	}

	.price-part-amount {
		font-weight: var(--font-weight-medium);
		color: var(--color-text-muted);
	}

	/* Tinted for the same reason `MetricRail`'s caveat is: `--color-warning` measures
	   4.45:1 on this app's light card surfaces, under AA, and 4.51:1 against its own
	   tint. */
	.price-part-missing {
		padding: 0 var(--space-1);
		border-radius: var(--radius-sm);
		background: var(--color-warning-bg);
	}

	.price-part-missing .price-part-label,
	.price-part-missing .price-part-amount {
		color: var(--color-warning);
	}

	:global(.is-deprioritized) .price-total {
		color: var(--color-text-deprioritized);
	}
</style>
