<script lang="ts">
	/**
	 * "Getting there": what this trip costs at the length on screen, and the three real
	 * payments that make up the number.
	 *
	 * ## The name
	 *
	 * The owner asked for one, having flagged his own word for it as confusing: "i call it
	 * flight price but maybe it is confusing and you come with a better term, it is the
	 * mandatory money to pay to do that itinerary." It is confusing, because it includes
	 * beds and buses. After #230 the headline already IS the whole cost of the trip at its
	 * shortest length; issue #225 is the label it never had. Not "base fare", not
	 * "ancillaries": the test he set is whether a traveller reads it once and knows which
	 * number they cannot avoid.
	 *
	 * ## The three lines, and why none of them is a model
	 *
	 * Flights, bed with its nightly rate, ground with its ride count. Each is money
	 * somebody really quoted. `priceBreakdown` (itinerary-metrics.ts) reuses the itinerary
	 * builder's own `scaleFareForParty`/`sumMoney`, so these lines always add up to the
	 * number above them — which matters more than it sounds, because a flight fare scales
	 * to the party by that offer's own `priceScope` (#109), and "multiply both fares by
	 * travellers" would be right for Ryanair and wrong for Skyscanner.
	 *
	 * The bed line carries #206's per-night figure, and who the rate covers. That is not
	 * cosmetic: a dorm bed is quoted per person and a private room per party, measured
	 * rather than assumed (docs/PROVIDERS.md), and the difference is a factor of the party
	 * size in what a stopover costs.
	 *
	 * The walk line below them is the one row carrying no money, because it is the one cost
	 * this app knows without anybody quoting it (#249). It reads `free` rather than
	 * `€0.00`, since a currency figure in the amounts column is a measured quote and #212
	 * removed the last fabricated zero from this app.
	 *
	 * ## `from`, and the two things the total does not say
	 *
	 * Issue #204: "the price of transport should be considered as well and you are not
	 * doing it or at least is not shown in the card". A caveat chip beside an unqualified
	 * total is still a total, so the loudest element on the card is the one that has to
	 * stop overstating. `from €238.00` is a floor, which is what this number has always
	 * actually been whenever a part of the trip went unpriced.
	 *
	 * ## The estimated ground line, and why it is outside the number above it
	 *
	 * Issue #249. The app has held a rate-card range for a short taxi since issue #9 and
	 * showed it only inside `TransportPicker`, so this receipt said "not priced" about a
	 * ride the same screen priced one tap deeper. That line now carries the range.
	 *
	 * It is a receipt line and not a part of the total, and the three reasons are worth
	 * stating here because this is the file where somebody will be tempted to add it in.
	 * The estimate is a range by construction, and collapsing it to a point to fit a
	 * `Money` invents the precision the range exists to refuse. Its currency is the ride's
	 * country's, not the search's, so a GBP taxi against a EUR trip is the mix `sumMoney`
	 * throws on and issue #152 was about. And `totalPrice` is read by
	 * `results/sort.ts`'s cheapest-first and `results/filters.ts`'s max-price filter, so a
	 * guess in there quietly decides which trips a traveller never sees.
	 *
	 * So the line reads as its own row with an ESTIMATE tag, in the same words and the same
	 * type as the picker's, and `from` stays on the headline. The traveller gets the size of
	 * the gap without the total pretending to have closed it.
	 */
	import type { Coordinates, Itinerary } from '$lib/domain';
	import { formatMoney, formatMoneyRange } from '$lib/format';
	import { priceBreakdown, rideCount, walkCount } from './itinerary-metrics';

	interface Props {
		itinerary: Itinerary;
		/** `lg` for the results card's headline, `md` anywhere the price is not the
		 * loudest thing in its own block. */
		size?: 'md' | 'lg';
		/** Issue #224: the stopover city's centre point, when the caller has resolved the
		 * airport record and the dataset knows one. The bed line then says how far out the
		 * bed is, which is one of the two facts the owner named as his reason to spend
		 * another night somewhere. Absent, the line simply omits it. */
		cityCentre?: Coordinates;
	}

	let { itinerary, size = 'lg', cityCentre }: Props = $props();

	const breakdown = $derived(priceBreakdown(itinerary, { cityCentre }));
	const missingGround = $derived(breakdown.unpricedTransferCount > 0);
	const walkedGround = $derived(breakdown.walkedTransferCount > 0);
	const estimatedGround = $derived(breakdown.estimatedGround);
	/** An estimated ride keeps the headline a floor. The estimate is not inside the total,
	 * so `€238.00` would still be understating the trip by whatever the taxi costs. */
	const isFloor = $derived(breakdown.missingStay || missingGround || estimatedGround.length > 0);
	/** A one-part breakdown is not shown: "Flights €229.00" directly under "€229.00" is a
	 * row that carries nothing. The ground chips are independent of that, because they are
	 * the one thing the total genuinely does not say. */
	const showParts = $derived(breakdown.parts.length > 1);
	const showGroundRows = $derived(walkedGround || estimatedGround.length > 0 || missingGround);
</script>

<div class={['price-line', `price-line-${size}`]}>
	<p class="price-headline">
		<span class="price-label">Getting there</span>
		<span class="price-total font-mono tabular-nums">
			<!-- One word, inside the same element so a screen reader reads "from 238 euros"
			     as one figure rather than announcing a total and a stray preposition. -->
			{#if isFloor}<span class="price-from">from</span>{/if}{formatMoney(breakdown.total)}
		</span>
	</p>
	{#if showParts || breakdown.missingStay || showGroundRows}
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
			{#if walkedGround}
				<!-- Issue #249. `domain/transfer.ts` reads an absent transfer price two opposite
				     ways: on a walk it is the fact that walking is free, on a taxi it is a number
				     nobody measured. The receipt named only the second, so the one leg whose cost
				     this app knows exactly was the leg missing from where the trip is added up.
				     Untinted for that reason: this row states an amount, it does not admit a gap. -->
				<li class="price-part">
					<span class="price-part-label">Ground, {walkCount(breakdown.walkedTransferCount)}</span>
					<span class="price-part-amount">free</span>
				</li>
			{/if}
			{#each estimatedGround as estimate (estimate.currency)}
				<!-- Issue #249. One row per currency, because a trip with an origin location in
				     Spain and a stopover in Britain has one leg rated in EUR and another in GBP,
				     and there is no converter in this app by design. Untinted like the walked
				     row: this states an amount rather than admitting a gap. The tag is the same
				     word and the same treatment `TransportPicker` uses for the same range, so a
				     traveller who opens the picker meets a figure they have already seen. -->
				<li class="price-part">
					<span class="price-part-label">Ground, {rideCount(estimate.rides)}</span>
					<span class="price-part-amount font-mono tabular-nums">
						{formatMoneyRange(estimate.lowMinorUnits, estimate.highMinorUnits, estimate.currency)}
						<span class="estimate-tag">estimate</span>
					</span>
				</li>
			{/each}
			{#if missingGround}
				<!-- Issue #204, and deliberately the same chip as the bed above rather than a
				     second treatment: both say "the total is short by this much of the trip",
				     and two visual languages for one fact would read as two problems. The ride
				     count is the size of the hole. One leg of four is not the airport run in
				     both directions. Walked and estimated legs are never counted here: walking
				     is free and this app knows it, and a rated ride has its own row above
				     (`domain/transfer.ts`'s `groundFare`). -->
				<li class="price-part price-part-missing">
					<span class="price-part-label">Ground, {rideCount(breakdown.unpricedTransferCount)}</span>
					<span class="price-part-amount">not priced</span>
				</li>
			{/if}
		</ul>
	{/if}
</div>

<style>
	.price-line {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	/* Label and total on one line, hard to the two edges. It buys back the row the label
	   would otherwise cost, and it puts the number where the amounts below it are, so the
	   receipt reads down a single right edge. */
	.price-headline {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-1) var(--space-3);
		margin: 0;
	}

	/* Mono caps, the departure-board voice this app already uses for the small print. It
	   is quiet on purpose: it names the number rather than competing with it. */
	.price-label {
		font-family: var(--font-mono);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-wide);
		text-transform: uppercase;
		color: var(--color-text-muted);
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

	/* A receipt: one payment per line, what it was on the left and what it cost on the
	   right. This used to be an inline wrapping row, which fitted a phone by putting three
	   labels and three amounts in an order that depended on the width. The owner asked for
	   the parts under the number, and stacked is also the only layout where the amounts
	   line up as a column you can add. */
	.price-parts {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
	}

	.price-part {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-2) var(--space-3);
	}

	.price-part-label {
		color: var(--color-text-muted);
		/* The bed line carries a rate, a night count and a distance, so it is the one that
		   runs long. It wraps rather than truncating: every part of it is a fact the
		   traveller is deciding on. */
		min-width: 0;
	}

	.price-part-amount {
		flex-shrink: 0;
		font-weight: var(--font-weight-medium);
		color: var(--color-text-muted);
	}

	/* Quiet, small caps, sitting under its own amount: the word qualifies the figure
	   without competing with the two real ones above it. Deliberately the same treatment
	   `TransportPicker` gives the identical range, so the two screens read as one claim
	   rather than two. Not warning-tinted. An estimate is a number this app has, not a hole
	   it is confessing to, and the chip below is the one that means the second thing. */
	.estimate-tag {
		display: block;
		font-family: var(--font-sans);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-regular);
		letter-spacing: var(--tracking-wide);
		line-height: 1.2;
		text-transform: uppercase;
		color: var(--color-text-faint);
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
