<script lang="ts">
	/**
	 * One row in the "cheaper first" alternatives list (issue #27). Clicking a bookable
	 * row hands its cheapest eligible option to the parent as the new selected stay;
	 * a property with nothing this group can book (every room is a female-only dorm
	 * they can't use) still shows, per rank.ts's "sort last, don't drop", but as an
	 * inert row with the reason stated rather than a price.
	 */
	import type { Airport } from '$lib/domain';
	import { femaleDormFit, femaleDormFitMessage } from './female-dorm-fit';
	import { formatDistanceKm, haversineDistanceKm } from './distance';
	import { formatMoney, stayTotalForNights } from './pricing';
	import { cheapestSelectableOption } from './rank';
	import { propertyOf, type PropertyStayOptions } from './types';

	interface Props {
		group: PropertyStayOptions;
		connectionAirport: Airport;
		nights: number;
		travellers?: number;
		females?: number;
		onselect: () => void;
	}

	let { group, connectionAirport, nights, travellers, females, onselect }: Props = $props();

	const property = $derived(propertyOf(group));
	const cheapest = $derived(cheapestSelectableOption(group, travellers, females));
	const total = $derived(cheapest ? stayTotalForNights(cheapest.stay.pricePerNight, nights) : undefined);

	const distanceToAirportKm = $derived(haversineDistanceKm(property.coordinates, connectionAirport.coordinates));
	// Issue #162, same fix as StayPicker's own: no hand-checked city point, no second
	// figure. Both were measured against the airport before, so this row read
	// "6.0 km from airport · 6.0 km from centre" for every property in the list.
	const distanceToCentreKm = $derived.by(() => {
		const centre = connectionAirport.city.coordinates;
		return centre ? haversineDistanceKm(property.coordinates, centre) : undefined;
	});

	// Every ineligible option here is a female-only dorm this group can't (fully) use
	// (rank.ts's `isOptionSelectable`) - reusing that message rather than a generic "not
	// available" keeps the reason honest and specific, same copy the open property's own
	// tiles show for the identical situation.
	const unavailableReason = $derived(
		cheapest ? undefined : femaleDormFitMessage(femaleDormFit(travellers, females), travellers, females)
	);

	const image = $derived(property.images[0]);
</script>

<button
	type="button"
	class={['alt-card', { 'is-unavailable': !cheapest }]}
	disabled={!cheapest}
	onclick={onselect}
>
	<span class="alt-card-thumb" aria-hidden="true">
		{#if image}
			<img src={image} alt="" loading="lazy" />
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

	<span class="alt-card-body">
		<span class="alt-card-name">{property.name}</span>
		<span class="alt-card-meta">
			{#if property.rating !== undefined}
				<span class="alt-card-rating">{property.rating.toFixed(1)} rating</span>
			{/if}
			<span>{formatDistanceKm(distanceToAirportKm)} from airport</span>
			{#if distanceToCentreKm !== undefined}
				<span>{formatDistanceKm(distanceToCentreKm)} from centre</span>
			{/if}
		</span>
		{#if unavailableReason}
			<span class="alt-card-unavailable">{unavailableReason}</span>
		{/if}
	</span>

	{#if cheapest && total}
		<span class="alt-card-price">
			<span class="alt-card-price-from">from</span>
			<span class="font-mono tabular-nums">{formatMoney(cheapest.stay.pricePerNight)}<span class="alt-card-unit">/night</span></span>
			<span class="alt-card-price-total font-mono tabular-nums">{formatMoney(total)} total</span>
		</span>
	{/if}
</button>

<style>
	.alt-card {
		display: grid;
		grid-template-columns: 4.5rem 1fr auto;
		align-items: center;
		gap: var(--space-4);
		width: 100%;
		min-height: 44px;
		padding: var(--space-3);
		text-align: left;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		color: var(--color-text);
		cursor: pointer;
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

	.alt-card-thumb {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 4.5rem;
		height: 4.5rem;
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
		width: 1.75rem;
		height: 1.75rem;
	}

	.alt-card-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
	}

	.alt-card-name {
		font-weight: var(--font-weight-semibold);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.alt-card-meta {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-3);
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}

	.alt-card-rating {
		color: var(--color-text);
		font-weight: var(--font-weight-medium);
	}

	.alt-card-unavailable {
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	.alt-card-price {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.125rem;
		white-space: nowrap;
	}

	.alt-card-price-from {
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	.alt-card-unit {
		margin-left: 0.125rem;
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}

	.alt-card-price-total {
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
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
