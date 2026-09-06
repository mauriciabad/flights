<script lang="ts">
	/**
	 * One row in the alternatives list (issue #27). Clicking a bookable row hands its cheapest
	 * eligible option to the parent as the new selected stay; a property with nothing this
	 * group can book still shows, per rank.ts's "sort last, don't drop", but as an inert row
	 * with the reason stated rather than a price.
	 *
	 * ## Why the layout changed, twice, with the measurement that forced each
	 *
	 * Issue #319, the owner: **"the cards are cramped and not usable in that width."** This row
	 * used to be `grid-template-columns: 4.5rem 1fr auto`, and the `auto` price column carried
	 * three `white-space: nowrap` lines, so it claimed its full intrinsic width before the
	 * `1fr` body got anything. Measured in the 312px customise rail: the price column took
	 * 132px, the thumbnail 72px, and the property name was left a **50px** box holding a 144px
	 * string. Every name rendered as four characters and an ellipsis. So the price stopped
	 * competing with the name for a line, and it stays that way: the name and its facts take
	 * the full width beside the thumbnail, the money goes underneath, nothing is set smaller to
	 * make it fit, and the name wraps rather than truncating.
	 *
	 * Issue #404 is the next pass, and it is about weight rather than width. The owner:
	 * **"the information distribution, design and visual hierarchy is bad."** What he was
	 * looking at:
	 *
	 * ```
	 * Easy Host Porto
	 * rated 7.9/10 13.1 km from airport
	 * 1.1 km from centre
	 * from €30.40/night €30.40 total
	 * +€5.60/night +€5.60 over 1 night
	 * ```
	 *
	 * Three things are wrong with that and each has its own fix.
	 *
	 * **Five facts at one weight, so nothing leads.** The rating and both distances were one
	 * wrapped flex line of `--font-size-xs` muted text, which makes them read as a sentence
	 * rather than as three separate answers. They are now three tiers: the name, then the
	 * journey out (issue #405's per-mode times, which is what the airport distance was
	 * standing in for), then the rating and the centre distance as the quiet supporting line.
	 *
	 * **The same number, printed twice.** At one night the whole-stay figures ARE the nightly
	 * ones. `showsWholeStayFigures` in `choice.ts` decides that once, so the map's sidebar
	 * stops doing it too.
	 *
	 * **The wrong number was the biggest.** The rate was body size and the difference was
	 * `--font-size-sm`, so the eye landed on `€30.40` when the question the row exists to
	 * answer is `+€5.60`. That is inverted now: the difference is the largest figure on the
	 * row and the rate supports it.
	 *
	 * `€X total` is gone from the row entirely rather than shrunk. It is the one figure of the
	 * four a traveller cannot act on without also holding the current pick's whole-stay total,
	 * and the map dialog's figure rail prints both side by side for anyone comparing in
	 * earnest. The switch cost over the stay stays, because that is the thing being decided.
	 *
	 * One layout, no container query, unlike `PickedBed`: this list is only ever rendered
	 * inside `SegmentCustomiser`, which is a 312px rail on a desktop and a full-width sheet on
	 * a phone. Both are in one width band, and a second phase nobody reaches is a second phase
	 * nobody tests.
	 *
	 * ## No carousel here, deliberately
	 *
	 * Issue #319 asks for one and this row is not where it goes. Thirty rows would be thirty
	 * scrollers, thirty `aria-live` counters and sixty arrows in the tab order, and that
	 * settles it on its own. The carousel goes where a property has room and is looked at one
	 * at a time: the open card above this list, and the sidebar the stay map opens. Both are
	 * one click from here. This row keeps its single lazy thumbnail.
	 */
	import { describePriceComparison, type StayChoice } from './choice';
	import { Icon } from '$lib/components';
	import { formatPropertyRating } from '$lib/format';
	import { formatDistanceKm } from './distance';
	import { formatMoney } from './pricing';
	import { originalStayPhoto } from '$lib/providers/stays/original-photo';
	import StayReachLine from './StayReachLine.svelte';

	interface Props {
		choice: StayChoice;
		/** The stopover's nights, for the "over 3 nights" half of the difference. */
		nights: number;
		onselect: () => void;
	}

	let { choice, nights, onselect }: Props = $props();

	const property = $derived(choice.property);
	const delta = $derived(describePriceComparison(choice.comparison, nights));

	// Issue #281, the same one-retry shape the carousel uses: hold the STORED url that
	// failed, not the failing one, so a fallback that also fails settles instead of
	// alternating, and so a different property clears it on its own.
	let failedPhotoOf = $state<string | undefined>(undefined);
	const image = $derived.by(() => {
		const stored = property.images[0];
		if (!stored) return undefined;
		return stored === failedPhotoOf ? (originalStayPhoto(stored) ?? stored) : stored;
	});
</script>

<button
	type="button"
	class={['alt-card', { 'is-unavailable': !choice.cheapest }]}
	disabled={!choice.cheapest}
	onclick={onselect}
>
	<span class="alt-card-thumb" aria-hidden="true">
		{#if image}
			<img src={image} alt="" loading="lazy" onerror={() => (failedPhotoOf = property.images[0])} />
		{:else}
			<Icon name="home" />
		{/if}
	</span>

	<span class="alt-card-name">{property.name}</span>

	<!-- Issue #405. The journey, not the crow flight: a traveller cannot turn "13.1 km" into
	     "can I walk to this", and that was the question the distance was standing in for. -->
	<span class="alt-card-reach">
		<StayReachLine reach={choice.reach} distanceToAirportKm={choice.distanceToAirportKm} />
	</span>

	<span class="alt-card-meta">
		<!-- Issue #245: the scale, not just the number. Same wording as the row in the open
		     card below it and the stopover row in the timeline. -->
		{#if property.rating !== undefined}
			<span class="alt-card-rating">rated {formatPropertyRating(property.rating)}</span>
		{/if}
		<!-- The airport distance is not repeated here: the line above answers it better. This
		     is the other question, how central the bed is, and it is the one #406 sorts on. -->
		{#if choice.distanceToCentreKm !== undefined}
			<span>{formatDistanceKm(choice.distanceToCentreKm)} from centre</span>
		{/if}
	</span>

	{#if choice.unavailableReason}
		<span class="alt-card-unavailable">{choice.unavailableReason}</span>
	{:else if choice.cheapest}
		<span class="alt-card-money">
			<span class="alt-card-price">
				<!-- "from" stays: one property can offer a dorm and a private room, and this is
				     the cheapest of them rather than the price of staying here. -->
				<span class="alt-card-from">from</span><span class="font-mono tabular-nums"
					>{formatMoney(choice.cheapest.stay.pricePerNight)}<span class="alt-card-unit">/night</span></span
				>
			</span>

			{#if delta}
				<span class="alt-card-delta">
					<span class={['alt-card-delta-value', { 'is-cheaper': delta.cheaper }]}>{delta.headline}</span>
					{#if delta.overStay}
						<span class="alt-card-delta-stay">{delta.overStay}</span>
					{/if}
				</span>
			{/if}
		</span>
	{/if}
</button>

<style>
	/*
	   Four rows and two columns. The thumbnail spans the first three, so the name, the journey
	   out and the supporting facts all get the full width beside it; the money takes a
	   full-width row of its own, where it can carry both the rate and the difference without
	   either shortening the name.
	*/
	.alt-card {
		display: grid;
		grid-template-columns: 4rem minmax(0, 1fr);
		grid-template-areas:
			'thumb name'
			'thumb reach'
			'thumb meta'
			'money money';
		align-content: start;
		gap: var(--space-1) var(--space-3);
		width: 100%;
		min-height: 44px;
		padding: var(--space-3);
		text-align: left;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		color: var(--color-text);
		cursor: pointer;
		touch-action: manipulation;
		transition:
			background-color var(--transition-fast),
			border-color var(--transition-fast);
	}

	.alt-card:not(:disabled):hover {
		background: var(--color-surface-hover);
		border-color: var(--color-border-strong);
	}

	.alt-card:not(:disabled):active {
		transform: translateY(1px);
	}

	.alt-card:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	.alt-card-thumb {
		grid-area: thumb;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 4rem;
		height: 4rem;
		overflow: hidden;
		background: var(--color-bg-inset);
		border-radius: var(--radius-md);
		color: var(--color-text-faint);
	}

	.alt-card-thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.alt-card-thumb :global(svg) {
		width: 1.5rem;
		height: 1.5rem;
	}

	/* Wraps rather than truncating. The old row cut every name to four characters, and a
	   property name is the one string here a traveller has to be able to read. Providers
	   publish some very long ones with nothing to break on, which is what `anywhere` is
	   for - the same treatment `PickedBed` gives the same string. */
	.alt-card-name {
		grid-area: name;
		font-weight: var(--font-weight-semibold);
		line-height: var(--line-height-sm);
		overflow-wrap: anywhere;
	}

	.alt-card-reach {
		grid-area: reach;
		min-width: 0;
	}

	.alt-card-meta {
		grid-area: meta;
		display: flex;
		flex-wrap: wrap;
		align-content: start;
		gap: 0 var(--space-3);
		min-width: 0;
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-muted);
	}

	.alt-card-rating {
		color: var(--color-text);
		font-weight: var(--font-weight-medium);
	}

	.alt-card-unavailable {
		grid-area: money;
		margin-top: var(--space-1);
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-faint);
	}

	/* The rate on the left, what swapping costs on the right. Wraps to two lines rather
	   than squeezing either, on a narrow sheet or at a large text size. */
	.alt-card-money {
		grid-area: money;
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: baseline;
		gap: var(--space-1) var(--space-3);
		margin-top: var(--space-2);
		padding-top: var(--space-2);
		border-top: 1px solid var(--color-border);
	}

	/* Supporting, not leading (issue #404). The rate says what kind of bed this is; the
	   difference beside it says what changing to it costs, and that is the decision. */
	.alt-card-price {
		display: flex;
		align-items: baseline;
		gap: 0 var(--space-1);
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.alt-card-from {
		font-size: var(--font-size-xs);
	}

	.alt-card-delta {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0;
		white-space: nowrap;
	}

	.alt-card-unit {
		margin-left: 0.125rem;
		font-size: var(--font-size-xs);
	}

	.alt-card-delta-stay {
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-muted);
	}

	/* The figure this row exists for, and now the largest thing on it after the name. Same
	   treatment the alternative-flight rows give their own delta: plain text weight for
	   dearer, the success colour for cheaper, and never colour alone - the sign in front of
	   the number carries it too (WCAG 1.4.1). */
	.alt-card-delta-value {
		font-size: var(--font-size-base);
		font-weight: var(--font-weight-semibold);
		font-variant-numeric: tabular-nums;
		color: var(--color-text);
	}

	.alt-card-delta-value.is-cheaper {
		color: var(--color-success);
	}

	.alt-card.is-unavailable {
		background: var(--color-bg-inset);
		color: var(--color-text-deprioritized);
		cursor: not-allowed;
	}

	.alt-card.is-unavailable .alt-card-name {
		color: var(--color-text-deprioritized);
	}
</style>
