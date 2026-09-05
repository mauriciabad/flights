<script lang="ts">
	/**
	 * One row in the "cheaper first" alternatives list (issue #27). Clicking a bookable row
	 * hands its cheapest eligible option to the parent as the new selected stay; a property
	 * with nothing this group can book still shows, per rank.ts's "sort last, don't drop",
	 * but as an inert row with the reason stated rather than a price.
	 *
	 * ## Why the layout changed, with the measurement that forced it
	 *
	 * Issue #319, the owner: **"the cards are cramped and not usable in that width."** He is
	 * describing something specific and it is worse than cramped. This row used to be
	 * `grid-template-columns: 4.5rem 1fr auto`, and the `auto` price column carried three
	 * `white-space: nowrap` lines, so it claimed its full intrinsic width before the `1fr`
	 * body got anything. Measured on this branch in the 312px customise rail, before the
	 * change: the price column took 132px, the thumbnail 72px, and the property name was
	 * left a **50px** box holding a 144px string. Every name in the list rendered as four
	 * characters and an ellipsis, and the three-phrase meta line wrapped down that same 50px
	 * column into 200px of height. A 312px row 254px tall, saying almost nothing.
	 *
	 * So the price stops competing with the name for one line. The name and its facts take
	 * the full width beside the thumbnail, and the money goes on its own row underneath.
	 * Nothing is set smaller to make it fit, which is the other half of what he asked for,
	 * and the name wraps rather than truncating: a hostel name is the one string on this row
	 * a traveller has to be able to read.
	 *
	 * One layout, no container query, unlike `PickedBed`: this list is only ever rendered
	 * inside `SegmentCustomiser`, which is a 312px rail on a desktop and a full-width sheet
	 * on a phone. Both are in one width band, and a second phase nobody reaches is a second
	 * phase nobody tests.
	 *
	 * ## The price difference is the point of the row now
	 *
	 * `choice.ts` decides it, and its doc comment argues both halves: per night rather than
	 * per stay, because a stopover can book zero nights; and the room only, never the
	 * assumed fare `rank.ts` orders on, because AGENTS.md forbids presenting an estimate as
	 * a fact.
	 *
	 * ## No carousel here, deliberately
	 *
	 * Issue #319 asks for one and this row is not where it goes. Thirty rows would be thirty
	 * scrollers, thirty `aria-live` counters and sixty arrows in the tab order, and on the
	 * keyless Hostelworld path every one of those photographs is a 2.8 MB original (issue
	 * #284). The carousel goes where a property has room and is looked at one at a time: the
	 * open card above this list, and the sidebar the stay map opens. Both are one click from
	 * here. This row keeps its single lazy thumbnail.
	 */
	import { describePriceComparison, stayDistances, type StayChoice } from './choice';
	import { formatPropertyRating } from '$lib/format';
	import { formatMoney } from './pricing';
	import { originalStayPhoto } from '$lib/providers/stays/original-photo';

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
			<svg viewBox="0 0 24 24" fill="none">
				<path
					d="M4 20V9l8-5 8 5v11"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linejoin="round"
				/>
				<path d="M9 20v-6h6v6" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
			</svg>
		{/if}
	</span>

	<span class="alt-card-name">{property.name}</span>

	<span class="alt-card-meta">
		<!-- Issue #245: the scale, not just the number. Same wording as the row in the open
		     card below it and the stopover row in the timeline. -->
		{#if property.rating !== undefined}
			<span class="alt-card-rating">rated {formatPropertyRating(property.rating)}</span>
		{/if}
		{#each stayDistances(choice) as line (line.from)}
			<span>{line.distance} from {line.from}</span>
		{/each}
	</span>

	{#if choice.unavailableReason}
		<span class="alt-card-unavailable">{choice.unavailableReason}</span>
	{:else if choice.cheapest && choice.total}
		<span class="alt-card-money">
			<span class="alt-card-price">
				<span class="alt-card-from">from</span>
				<span class="font-mono tabular-nums"
					>{formatMoney(choice.cheapest.stay.pricePerNight)}<span class="alt-card-unit">/night</span
					></span
				>
				<!-- Only where there is a night to multiply. On a day stopover this would be
				     "€0.00 total" under every row, which is arithmetic rather than information. -->
				{#if nights > 0}
					<span class="alt-card-total font-mono tabular-nums">{formatMoney(choice.total)} total</span>
				{/if}
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
	   Three rows and two columns. The thumbnail spans the first two, so the name and its
	   facts get everything beside it; the money takes a full-width row of its own, where it
	   can carry both the rate and the difference without either shortening the name.
	*/
	.alt-card {
		display: grid;
		grid-template-columns: 4rem minmax(0, 1fr);
		grid-template-areas:
			'thumb name'
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

	.alt-card-thumb svg {
		width: 1.5rem;
		height: 1.5rem;
	}

	/* Wraps rather than truncating. The old row cut every name to four characters, and a
	   property name is the one string here a traveller has to be able to read. Providers
	   publish some very long ones with nothing to break on, which is what `anywhere` is
	   for - the same treatment `PickedBed` gives the same string. */
	.alt-card-name {
		grid-area: name;
		align-self: end;
		font-weight: var(--font-weight-semibold);
		line-height: var(--line-height-sm);
		overflow-wrap: anywhere;
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

	.alt-card-price,
	.alt-card-delta {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 0 var(--space-2);
		white-space: nowrap;
	}

	.alt-card-delta {
		justify-content: flex-end;
	}

	.alt-card-from,
	.alt-card-unit {
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}

	.alt-card-unit {
		margin-left: 0.125rem;
	}

	.alt-card-total,
	.alt-card-delta-stay {
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}

	/* The figure issue #319 exists for. Same treatment the alternative-flight rows give
	   their own delta: plain text weight for dearer, the success colour for cheaper, and
	   never colour alone - the sign in front of the number carries it too (WCAG 1.4.1). */
	.alt-card-delta-value {
		font-size: var(--font-size-sm);
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
