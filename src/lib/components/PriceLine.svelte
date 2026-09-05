<script lang="ts">
	/**
	 * "Getting there": what this trip costs at the length on screen, and the real payments
	 * that make up the number.
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
	 * ## What the receipt is made of, and why none of it is a model
	 *
	 * Flights as one line, the bed as its own titled group, and one row per named ground
	 * leg. Each amount is money somebody really quoted or a range this app's own rate card
	 * describes. `priceBreakdown` (itinerary-metrics.ts) reuses the itinerary builder's own
	 * `scaleFareForParty`/`sumMoney`, so these lines always add up to the number above
	 * them, which matters more than it sounds: a flight fare scales to the party by that
	 * offer's own `priceScope` (#109), and "multiply both fares by travellers" would be
	 * right for Ryanair and wrong for Skyscanner.
	 *
	 * ## Issue #305 restructured the middle of it
	 *
	 * The bed used to be one line reading `Bed, 1 night × €52.85, 37.6 km from centre`,
	 * which wrapped to two lines at 375px and put a rate, a count and a distance in one
	 * string. The owner asked for "a group with `Hotel` as title and at right
	 * `€52.85/night` and inside it has `1 required night` and `1 extra night`". So the
	 * rate rides on the group header where a nightly rate belongs, and the nights split
	 * into the ones the flights force and the ones the traveller added from the ladder.
	 * That split is the one thing on the card that says which half of the bed bill is a
	 * choice.
	 *
	 * The ground used to be up to three aggregate rows counting rides ("Ground, 3 rides,
	 * not priced"). It is now one row per leg with the owner's own names: "Rides from and
	 * to hotel", "Ride to destination", "Ride from origin". A traveller who walks to their
	 * hotel and taxis to the airport was previously reading one line that averaged the two.
	 *
	 * The ESTIMATE tag went at the same time, at his request. The word is gone; the
	 * arithmetic behind it is untouched, which is the load-bearing half. See below.
	 *
	 * ## `from`, and the two things the total does not say
	 *
	 * Issue #204: "the price of transport should be considered as well and you are not
	 * doing it or at least is not shown in the card". A caveat chip beside an unqualified
	 * total is still a total, so the loudest element on the card is the one that has to
	 * stop overstating. `from €238.00` is a floor, which is what this number has always
	 * actually been whenever a part of the trip went unpriced.
	 *
	 * ## The estimated ground rows are still outside the number above them
	 *
	 * Issue #249, and issue #305 changed only how they read. The estimate is a range by
	 * construction, and collapsing it to a point to fit a `Money` invents the precision the
	 * range exists to refuse. And `totalPrice` is read by `results/sort.ts`'s cheapest-first
	 * and `results/filters.ts`'s max-price filter, so a guess in there quietly decides which
	 * trips a traveller never sees. Removing the ESTIMATE label is presentation; moving the
	 * number into the total would be none of those things and must not happen.
	 *
	 * ## Issue #339 changed the currency, and nothing else
	 *
	 * The owner read `Rides from and to hotel  £115.04-£182.84` under a euro total. The
	 * rate card is written in the ride's country's currency and there was no converter in
	 * the app, so those pounds were true and unusable: a figure that cannot be held against
	 * the number three lines above it.
	 *
	 * The estimate now arrives already in the traveller's currency, converted at the ECB
	 * reference rate vendored by `data/exchange-rates.ts`, the same way every other price
	 * on this card is in that currency because the search asked the provider for it. This
	 * component prints what it is given and adds one line: the range the rate card actually
	 * quoted, in the currency the driver actually charges. That line is the honesty half.
	 * A euro figure alone would read as a quote, and it is a rate card applied to a
	 * distance and then crossed at a rate of some age.
	 *
	 * What did NOT change: the estimate is still outside `totalPrice`, `costIsUnknown`
	 * still returns true for it, and a mixed-currency total is still impossible, because
	 * nothing converted here is a `Money` and none of it reaches `sumMoney` (issue #152).
	 */
	import type { Itinerary } from '$lib/domain';
	import { formatMoney, formatMoneyRange } from '$lib/format';
	import { priceBreakdown } from './itinerary-metrics';
	import type { GroundRowCost } from './itinerary-metrics';

	interface Props {
		itinerary: Itinerary;
		/** `lg` for the results card's headline, `md` anywhere the price is not the
		 * loudest thing in its own block. */
		size?: 'md' | 'lg';
		/** `ScoredResult.stopover.minimum`: the nights the card opened on, which is what tells
		 * a night the traveller did not choose from one they added. Absent, every night reads
		 * as required. */
		requiredNights?: number;
	}

	let { itinerary, size = 'lg', requiredNights }: Props = $props();

	const breakdown = $derived(priceBreakdown(itinerary, { requiredNights }));
	const groundRows = $derived(breakdown.groundRows);
	/** An estimated or unpriced ride keeps the headline a floor: neither is inside the
	 * total, so `€238.00` would still be understating the trip by whatever they cost. */
	const isFloor = $derived(
		breakdown.missingStay || groundRows.some((row) => row.cost.kind !== 'free' && row.cost.kind !== 'quoted')
	);
	/** A one-line breakdown is not shown: "Flights €229.00" directly under "€229.00" is a
	 * row that carries nothing. The hotel group counts as a second block, and the ground
	 * rows are independent of the test, because they are the one thing the total genuinely
	 * does not say. */
	const showParts = $derived(breakdown.parts.length + (breakdown.hotel ? 1 : 0) > 1);
	const hasRows = $derived(showParts || breakdown.missingStay || groundRows.length > 0);

	/** Whether this row admits a gap rather than stating an amount. The warning tint and
	 * the negative margin below both key off it. */
	function isUnpriced(cost: GroundRowCost): boolean {
		return cost.kind === 'unknown';
	}
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
	{#if hasRows}
		<ul class="price-parts">
			{#if showParts}
				{#each breakdown.parts as part (part.id)}
					<li class="price-part">
						<span class="price-part-label">{part.label}{#if part.detail}, {part.detail}{/if}</span>
						<span class="price-part-amount font-mono tabular-nums">{formatMoney(part.money)}</span>
					</li>
				{/each}
			{/if}

			{#if breakdown.hotel}
				<!-- Issue #305's group. A nested list rather than three sibling rows, so the
				     nights are inside the thing they are nights of: the rate on the header is
				     what they are each multiplied by, and a flat list would leave a reader
				     working out which rows the rate applies to. -->
				<li class="price-part price-group">
					<div class="price-group-head">
						<span class="price-part-label">Hotel</span>
						<span class="price-part-amount font-mono tabular-nums">{breakdown.hotel.rate}</span>
					</div>
					<ul class="price-group-rows">
						{#each breakdown.hotel.rows as row (row.id)}
							<li class="price-part">
								<span class="price-part-label">{row.label}</span>
								<span class="price-part-amount font-mono tabular-nums">{formatMoney(row.money)}</span>
							</li>
						{/each}
					</ul>
				</li>
			{/if}

			{#if breakdown.missingStay}
				<!-- Issue #117/#140: a plain fact about this itinerary, sitting in the
				     breakdown where the missing group would have been, rather than as a
				     separate banner repeated card after card. `StayKeyNotice` above the whole
				     list is the one place that names the cause and the fix. Gated on a night
				     actually being spent here: a same-day connection has no bed to miss. -->
				<li class="price-part price-part-missing">
					<span class="price-part-label">Hotel</span>
					<span class="price-part-amount">not priced</span>
				</li>
			{/if}

			{#each groundRows as row (row.id)}
				<!-- Issue #305. One row per leg the traveller actually takes, named as a
				     journey rather than counted as "rides". `domain/transfer.ts` reads an
				     absent transfer price two opposite ways: on a walk it is the fact that
				     walking is free, on a taxi it is a number nobody measured, and the row's
				     own `cost` is what carries which. Only the third case is tinted: the other
				     three state an amount, they do not admit a gap. -->
				<li class={['price-part', { 'price-part-missing': isUnpriced(row.cost) }]}>
					<span class="price-part-label">{row.label}</span>
					{#if row.cost.kind === 'quoted'}
						<span class="price-part-amount font-mono tabular-nums">{formatMoney(row.cost.money)}</span>
					{:else if row.cost.kind === 'estimated'}
						<!-- Issue #344: the range is what the party pays, the same footing as the
						     flights and the room above it, so the row says who that is, in the
						     same span and the same words the hotel rate two rows up already uses
						     ("EUR 30.00/night for 3"). The per-head share is deliberately not
						     here: every other line of this receipt is a party total, and one line
						     quietly switching to a per-person figure is the confusion this issue
						     was opened about. The picker does the splitting, beside the bus it is
						     being compared with. -->
						<span class="price-part-amount font-mono tabular-nums"
							>{formatMoneyRange(row.cost.lowMinorUnits, row.cost.highMinorUnits, row.cost.currency)}{row.cost
								.audience
								? ` ${row.cost.audience}`
								: ''}</span
						>
					{:else if row.cost.kind === 'free'}
						<span class="price-part-amount">free</span>
					{:else}
						<span class="price-part-amount">not priced</span>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.price-line {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		min-width: 0;
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
	   `--color-warning` either. The chips below already carry that colour, and a third
	   warning-coloured element would make an incomplete price read as an error. */
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

	/* Wraps, and the amount keeps the right edge when it does. The receipt shares its row
	   with the detour drawing since issue #305, so at 375px it has about 190px to print a
	   label and a figure in, and "Rides from and to hotel" beside a two-currency range is
	   wider than that. Without the wrap the amount, which cannot shrink, ran straight into
	   the label; `margin-left: auto` is what stops a wrapped amount landing on the left and
	   breaking the column of figures the stacked layout exists for. */
	.price-part {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0 var(--space-3);
	}

	.price-part-label {
		color: var(--color-text-muted);
		min-width: 0;
	}

	.price-part-amount {
		flex-shrink: 0;
		margin-left: auto;
		font-weight: var(--font-weight-medium);
		color: var(--color-text-muted);
	}


	/* Issue #305's hotel group. A column, not a row, because it holds a header row and its
	   own rows; the header keeps the receipt's two-edge shape so the rate lands in the same
	   right-hand column as every amount above and below it. */
	.price-group {
		flex-direction: column;
		align-items: stretch;
		gap: var(--space-1);
	}

	.price-group-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0 var(--space-3);
	}

	.price-group-head .price-part-label {
		color: var(--color-text);
		font-weight: var(--font-weight-semibold);
	}

	/* Indented from the group's title and no further: the amounts stay in the receipt's
	   one right-hand column, because a column you can add is the whole reason these rows
	   are stacked. */
	.price-group-rows {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		padding-left: var(--space-3);
	}

	/* Tinted for the same reason `MetricRail`'s caveat is: `--color-warning` measures
	   4.45:1 on this app's light card surfaces, under AA, and 4.51:1 against its own
	   tint.

	   The negative inline margin is issue #305's last piece, and the owner asked for it by
	   name: "when not priced, use negative x margin so texts are aligned despite being in
	   a bc with padding". The tint needs padding to be a chip rather than a stripe, and
	   that padding was pushing this row's label one step right of every other label, so a
	   receipt of four rows had one that did not line up. Pulling the box back out by
	   exactly what the padding puts in leaves the text on the same two edges as its
	   neighbours and the tint reading slightly wider than them, which is correct: it is a
	   highlight over the row, not an indent of it. */
	.price-part-missing {
		margin-inline: calc(var(--space-1) * -1);
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
