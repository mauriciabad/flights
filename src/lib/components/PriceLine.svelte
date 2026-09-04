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
	 *
	 * Issue #204 adds the second thing it does not say, and the word "from" on the number
	 * itself. The owner's complaint was "the price of transport should be considered as
	 * well and you are not doing it or at least is not shown in the card", and a caveat
	 * chip beside an unqualified total is still a total: the loudest element on the card
	 * has to be the one that stops overstating. `from EUR 238.00` is a floor, which is
	 * what this number has always actually been whenever a part of the trip went unpriced.
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
	const missingGround = $derived(breakdown.unpricedTransferCount > 0);
	const isFloor = $derived(breakdown.missingStay || missingGround);
	// "2 rides" rather than a bare count, because the number on its own beside the word
	// "Ground" reads as an amount of money, which is the one thing it is not.
	const groundRides = $derived(
		`${breakdown.unpricedTransferCount} ${breakdown.unpricedTransferCount === 1 ? 'ride' : 'rides'}`
	);
</script>

<div class={['price-line', `price-line-${size}`]}>
	<p class="price-total font-mono tabular-nums">
		<!-- One word, inside the same paragraph so a screen reader reads "from 238 euros"
		     as one figure rather than announcing a total and a stray preposition. -->
		{#if isFloor}<span class="price-from">from</span>{/if}{formatMoney(breakdown.total)}
	</p>
	{#if showParts || breakdown.missingStay || missingGround}
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
			{#if missingGround}
				<!-- Issue #204, and deliberately the same chip as the bed above rather than a
				     second treatment: both say "the total is short by this much of the trip",
				     and two visual languages for one fact would read as two problems. The ride
				     count is the size of the hole. One leg of four is not the airport run in
				     both directions. Walked legs are never counted, because walking is free
				     and this app knows it (`domain/transfer.ts`). -->
				<li class="price-part price-part-missing">
					<span class="price-part-label">Ground, {groundRides}</span>
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

	/* Sized and weighted down so the figure keeps its place in the hierarchy: this
	   qualifies the number, it does not compete with it. Not tinted with
	   `--color-warning` either. The two chips below already carry that colour, and a
	   third warning-coloured element would make an incomplete price read as an error. */
	.price-from {
		margin-right: 0.3em;
		font-family: var(--font-sans);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-muted);
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
