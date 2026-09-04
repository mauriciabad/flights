<script lang="ts">
	/**
	 * Issue #27: card per property (name, images, rating, distance from the connection
	 * airport and the city centre), dorm/private prices side by side that update the
	 * itinerary total the instant you switch, and a cheapest-first alternatives list.
	 *
	 * One property is "open" (its full card + room-kind tiles are shown); the rest are
	 * the alternatives list below. Picking a tile within the open property, or a whole
	 * alternative, both flow through `choose` so `onchange` always fires with the same
	 * shape of delta regardless of which list the click came from.
	 */
	import type { Airport, Money, Stay } from '$lib/domain';
	import { Card, EmptyState } from '$lib/components';
	import RoomKindTile from './RoomKindTile.svelte';
	import StayAlternativeCard from './StayAlternativeCard.svelte';
	import { femaleDormFit, femaleDormFitMessage } from './female-dorm-fit';
	import { formatDistanceKm, haversineDistanceKm } from './distance';
	import { stayTotalDelta, stayTotalForNights } from './pricing';
	import { cheapestSelectableOption, isOptionSelectable, rankProperties } from './rank';
	import { propertyOf, type PropertyStayOptions } from './types';

	interface Props {
		/** Every candidate property for this connection, each with its priced room-kind
		 * options - typically a StayProvider search result grouped by property (issue
		 * #10's `StaySearchQuery`/`Stay[]`, wrapped in this module's `PropertyStayOptions`
		 * once that adapter is wired to a real results page). */
		properties: PropertyStayOptions[];
		/** Source of both proximity figures the card shows. */
		connectionAirport: Airport;
		/** Nights the itinerary spends in the connection city (domain/itinerary.ts
		 * `nightsInConnection`) - what a nightly price is multiplied by for "the stay". */
		nights: number;
		/** Mirrors domain/search-query.ts `SearchQuery.travellers`/`.females` exactly,
		 * defaults included - see female-dorm-fit.ts for how these decide female-only
		 * dorm eligibility. */
		travellers?: number;
		females?: number;
		/** Bindable: the Stay currently counted toward the itinerary. Unset picks the
		 * cheapest option this group can actually book, so there is always a real value
		 * to show and to hand a parent from the very first render. */
		selected?: Stay;
		/** Fires on every change with the Money delta the itinerary total should apply -
		 * already multiplied by `nights`, so a caller holding an `Itinerary.totalPrice`
		 * can add this directly instead of recomputing the whole total. */
		onchange?: (stay: Stay, deltaForStay: Money) => void;
	}

	let {
		properties,
		connectionAirport,
		nights,
		travellers,
		females,
		selected = $bindable(),
		onchange
	}: Props = $props();

	const ranked = $derived(rankProperties(properties, travellers, females));

	const fallbackStay = $derived(ranked[0] ? cheapestSelectableOption(ranked[0], travellers, females)?.stay : undefined);
	const effectiveSelected = $derived(selected ?? fallbackStay);

	const openGroup = $derived(
		ranked.find((group) => group.options.some((option) => option.stay === effectiveSelected)) ?? ranked[0]
	);
	const openProperty = $derived(openGroup ? propertyOf(openGroup) : undefined);
	const alternatives = $derived(ranked.filter((group) => group !== openGroup));

	/** Whether anything in the whole candidate list is bookable by this group at all -
	 * false only when every property's only rooms are a female-only dorm this group
	 * can't (fully) use, the one case with nothing safe to fall back to. */
	const nothingBookable = $derived(properties.length > 0 && ranked.every((g) => !cheapestSelectableOption(g, travellers, females)));

	const distanceToAirportKm = $derived(
		openProperty ? haversineDistanceKm(openProperty.coordinates, connectionAirport.coordinates) : 0
	);
	const distanceToCentreKm = $derived(
		openProperty ? haversineDistanceKm(openProperty.coordinates, connectionAirport.city.coordinates) : 0
	);

	// Whether the whole property list has anything that isn't a plain private room -
	// gates the one general data-quality note below rather than showing it on a
	// stopover with only private rooms on offer, where it would say nothing useful.
	const hasDormOptions = $derived(
		properties.some((group) => group.options.some((option) => option.stay.roomKind !== 'private'))
	);

	function choose(stay: Stay) {
		const previous = effectiveSelected;
		selected = stay;
		const delta =
			previous && previous.pricePerNight.currency === stay.pricePerNight.currency
				? stayTotalDelta(previous.pricePerNight, stay.pricePerNight, nights)
				: stayTotalForNights(stay.pricePerNight, nights);
		onchange?.(stay, delta);
	}
</script>

{#if properties.length === 0}
	<EmptyState
		title="No stays found yet"
		description="Nothing has come back for this connection so far - try again once the search finishes, or widen the search radius."
	/>
{:else if nothingBookable}
	<EmptyState
		title="No stay this group can book"
		description="Every property found here only offers a female-only dorm that doesn't fit this group's travellers. Try adding a stopover with more room types, or adjust who's travelling."
	/>
{:else if openGroup && openProperty}
	<div class="stay-picker">
		<Card variant="ticket" elevated>
			{#snippet header()}
				{openProperty.name}
			{/snippet}

			<div class="stay-open-body">
				<div class="stay-open-media" aria-hidden={openProperty.images.length === 0 ? true : undefined}>
					{#if openProperty.images[0]}
						<img src={openProperty.images[0]} alt={openProperty.name} loading="lazy" />
						{#if openProperty.images.length > 1}
							<span class="stay-open-media-count">1 / {openProperty.images.length}</span>
						{/if}
					{:else}
						<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
							<path d="M4 20V9l8-5 8 5v11" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
							<path d="M9 20v-6h6v6" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
						</svg>
					{/if}
				</div>

				<div class="stay-open-facts">
					{#if openProperty.rating !== undefined}
						<span class="stay-open-rating">
							{openProperty.rating.toFixed(1)} rating
							<span class="stay-open-rating-note">(scale as reported by the source)</span>
						</span>
					{/if}
					<span class="stay-open-distance">{formatDistanceKm(distanceToAirportKm)} from the airport</span>
					<span class="stay-open-distance">{formatDistanceKm(distanceToCentreKm)} from the city centre</span>
				</div>

				<div class="stay-room-kinds" role="group" aria-label="Room type for this stay">
					{#each openGroup.options as option (option.stay.roomKind)}
						{@const fit = option.stay.roomKind === 'female-dorm' ? femaleDormFit(travellers, females) : 'all'}
						{@const selectable = isOptionSelectable(option, travellers, females)}
						{@const caveat =
							option.stay.roomKind === 'female-dorm'
								? femaleDormFitMessage(fit, travellers, females)
								: option.notStated === 'female-only'
									? "Female-only status not confirmed for this room - it may not fit your whole group."
									: undefined}
						<RoomKindTile
							{option}
							{nights}
							selected={option.stay === effectiveSelected}
							{selectable}
							{caveat}
							onselect={() => choose(option.stay)}
						/>
					{/each}
				</div>

				{#if hasDormOptions}
					<p class="stay-data-note">
						Room type and female-only status come from the provider's own listing, which does not always confirm
						either - treat anything marked "not stated" as unconfirmed rather than settled.
					</p>
				{/if}
			</div>
		</Card>

		{#if alternatives.length > 0}
			<div class="stay-alternatives">
				<h3 class="stay-alternatives-heading">Other stays near this connection</h3>
				<ul class="stay-alternatives-list">
					{#each alternatives as group (propertyOf(group).name + propertyOf(group).coordinates.latitude + propertyOf(group).coordinates.longitude)}
						<li>
							<StayAlternativeCard
								{group}
								{connectionAirport}
								{nights}
								{travellers}
								{females}
								onselect={() => {
									const cheapest = cheapestSelectableOption(group, travellers, females);
									if (cheapest) choose(cheapest.stay);
								}}
							/>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	</div>
{/if}

<style>
	.stay-picker {
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
	}

	.stay-open-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.stay-open-media {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		aspect-ratio: 16 / 9;
		overflow: hidden;
		background: var(--color-bg-inset);
		border-radius: var(--radius-md);
		color: var(--color-text-faint);
	}

	.stay-open-media img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.stay-open-media svg {
		width: 3rem;
		height: 3rem;
	}

	.stay-open-media-count {
		position: absolute;
		right: var(--space-2);
		bottom: var(--space-2);
		padding: 0.125rem var(--space-2);
		background: var(--color-overlay);
		border-radius: var(--radius-full);
		color: var(--color-text);
		font-size: var(--font-size-xs);
	}

	.stay-open-facts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-4);
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.stay-open-rating {
		color: var(--color-text);
		font-weight: var(--font-weight-medium);
	}

	.stay-open-rating-note {
		font-weight: var(--font-weight-regular);
		color: var(--color-text-faint);
	}

	.stay-room-kinds {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
	}

	.stay-room-kinds > :global(*) {
		flex: 1 1 9.5rem;
	}

	.stay-data-note {
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	.stay-alternatives-heading {
		margin-bottom: var(--space-3);
		font-size: var(--font-size-base);
		font-weight: var(--font-weight-semibold);
	}

	.stay-alternatives-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
</style>
