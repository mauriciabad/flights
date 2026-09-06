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
	import { base } from '$app/paths';
	import type { Airport, Money, Stay } from '$lib/domain';
	import { formatPropertyRating } from '$lib/format';
	import { Button, Card, EmptyState, RoutePreview } from '$lib/components';
	import RoomKindTile from './RoomKindTile.svelte';
	import StayAlternativeCard from './StayAlternativeCard.svelte';
	import PhotoCarousel from './PhotoCarousel.svelte';
	import StaysMapDialog from './StaysMapDialog.svelte';
	import { stayGenderFitMessage } from './gendered-room-fit';
	import { describeStayChoices } from './choice';
	import { formatDistanceKm, haversineDistanceKm } from './distance';
	import { stayTotalDelta, stayTotalForNights } from './pricing';
	import { cheapestSelectableOption, isOptionSelectable, rankProperties } from './rank';
	import { firstBookableStay } from './recommended-bed';
	import { describeStayCatalogue, type StayProviderOutcome } from './no-stays-reason';
	import { isSameBed, isSameProperty, propertyOf, type PropertyStayOptions } from './types';

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
		/** Days the traveller can actually use the city (`components/free-time-days.ts`
		 * `fullDayCount + usablePartDayCount`). */
		visitDays?: number;
		/** Mirrors domain/search-query.ts `SearchQuery.travellers`/`.females` exactly,
		 * defaults included - see gendered-room-fit.ts for how these decide women-only and
		 * men-only room eligibility. */
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
		/** Issue #203: what each stay provider did in this search. Empty means nothing has
		 * been recorded, which `describeNoStays` reports as such rather than as "they had
		 * nothing here" — the false claim this prop exists to stop. */
		stayProviders?: readonly StayProviderOutcome[];
		/** Issue #374: the registry labels of the stay providers still waiting on a key, so
		 * both notices can name whoever is actually missing instead of a hardcoded pair, and
		 * "add a key" is offered only where it could change the answer. */
		unconfiguredStayProviders?: readonly string[];
		/**
		 * Issue #367: whether the bed on screen is one the traveller picked rather than this
		 * app's own answer. The card says which, because those two are the same object and
		 * behave differently: only the recommendation moves when the stopover gets longer.
		 */
		chosen?: boolean;
		/**
		 * Hands the bed back to the app, so it follows the recommendation again. Offered only
		 * where it would change something: the traveller has chosen a bed AND the ranking now
		 * puts a different property first.
		 */
		onuseRecommended?: () => void;
	}

	let {
		properties,
		connectionAirport,
		nights,
		visitDays = 0,
		travellers,
		females,
		selected = $bindable(),
		onchange,
		stayProviders = [],
		unconfiguredStayProviders = [],
		chosen = false,
		onuseRecommended
	}: Props = $props();

	// Issue #374: the same question asked of a list that is NOT empty. 54 Hostelworld
	// hostels look like the market until something says they are one provider's catalogue,
	// and the bed the traveller wanted can be sitting behind a key he never saved.
	const catalogueNote = $derived(
		describeStayCatalogue({ propertyCount: properties.length, stayProviders, unconfiguredStayProviders })
	);

	// Issue #219: the ordering weighs each property's distance from the terminal against
	// the nights on screen, so extending the stopover reorders this list under the
	// traveller. That is the point: a dorm across town is the wrong bed for one night and
	// the right one for four, and the list should say so rather than hold still.
	// The centre is the other half of that argument. Getting to the terminal happens twice
	// whatever the length, while going into town happens once per day there is a day to
	// spend there, so days in the city pull this list toward the centre rather than only
	// toward the cheap bed across town.
	const ranked = $derived(
		rankProperties(properties, {
			travellers,
			females,
			connectionAirport: connectionAirport.coordinates,
			cityCentre: connectionAirport.city.coordinates,
			nights,
			visitDays
		})
	);

	const fallbackStay = $derived(firstBookableStay(ranked, travellers, females));
	const effectiveSelected = $derived(selected ?? fallbackStay);

	// Structurally, not by reference. `stayCandidatesByConnection` is replaced wholesale on
	// every snapshot while a draft holds its own frozen itinerary, so the bed this trip
	// books and the identical bed in this list stop being one object the moment a
	// background refresh lands. On reference equality the card then opened on whatever the
	// ranking happened to put first, which since issue #366 is often not the booked bed at
	// all, and issue #367's mark on that card would have named the wrong property.
	const openGroup = $derived(
		ranked.find((group) => group.options.some((option) => isSameBed(option.stay, effectiveSelected))) ??
			ranked[0]
	);
	const openProperty = $derived(openGroup ? propertyOf(openGroup) : undefined);

	// The head of the list the traveller is looking at, which is also what the results page
	// would put on this trip if they had not chosen. Offering the swap only when those two
	// differ keeps the action off a card that is already the recommendation.
	const recommendationMoved = $derived(
		chosen && openProperty !== undefined && !isSameProperty(fallbackStay?.property, openProperty)
	);

	/**
	 * Every candidate as a row, with what swapping to it would cost measured from the stay
	 * on screen. Issue #319; `choice.ts` owns the arithmetic and the wording. Derived once
	 * here rather than per surface, because the list, the map's points and the map's sidebar
	 * are three renderings of one answer and a second derivation grows a second answer.
	 */
	const choices = $derived(
		describeStayChoices(ranked, {
			picked: effectiveSelected,
			connectionAirport: connectionAirport.coordinates,
			cityCentre: connectionAirport.city.coordinates,
			nights,
			travellers,
			females
		})
	);
	const alternatives = $derived(choices.filter((choice) => choice.group !== openGroup));

	/** The map exists while this is true and not one moment longer, which is issue #280's
	 * rule about where MapLibre may live. Mounting the dialog creates the only instance on
	 * the page; unmounting it runs `map.remove()`. */
	let mapOpen = $state(false);

	/** Whether anything in the whole candidate list is bookable by this group at all -
	 * false only when every property's only rooms are a women-only or men-only dorm this
	 * group can't (fully) use, the one case with nothing safe to fall back to. */
	const nothingBookable = $derived(properties.length > 0 && ranked.every((g) => !cheapestSelectableOption(g, travellers, females)));

	const distanceToAirportKm = $derived(
		openProperty ? haversineDistanceKm(openProperty.coordinates, connectionAirport.coordinates) : 0
	);
	// Issue #162: `undefined`, and the line below it goes away, unless this airport has a
	// hand-checked city point (`data/airport-city-names.ts`). It used to measure against
	// `connectionAirport.city.coordinates` when that was the airport's own position, so
	// this card printed one number under two labels — "6.0 km from the airport" above
	// "6.0 km from the city centre" — and the second one read as a promise about a real
	// old town.
	const distanceToCentreKm = $derived.by(() => {
		const centre = connectionAirport.city.coordinates;
		if (!openProperty || !centre) return undefined;
		return haversineDistanceKm(openProperty.coordinates, centre);
	});

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

<!-- Issue #389: there is no empty-list arm here. `SegmentCustomiser` is this component's
     only caller and it asks `stayProperties.length === 0` before it reaches for
     `StayPicker`, so an empty state written here could never render. It had one, and the two
     copies had already drifted apart over how they build the key link's href, which is what
     a second unreachable derivation of one answer buys you. `describeNoStays` now has one
     caller and one place on screen. -->
{#if nothingBookable}
	<EmptyState
		title="No stay this group can book"
		description="Every property found here only offers a women-only or men-only dorm that doesn't fit this group's travellers. Try adding a stopover with more room types, or adjust who's travelling."
	/>
{:else if openGroup && openProperty}
	<div class="stay-picker">
		<Card variant="ticket" elevated>
			{#snippet header()}
				{openProperty.name}
			{/snippet}

			<div class="stay-open-body">
				<!-- Issue #367. Which of the two this bed is, said on the card rather than set
				     there: a bed follows the recommendation until somebody picks one, the way
				     an HTML input keeps its default until it is typed into. -->
				<div class="stay-mark-row">
					<span class="stay-mark" class:is-chosen={chosen} data-testid="stay-mark">
						{chosen ? 'Your pick' : 'Recommended'}
					</span>
					{#if recommendationMoved}
						<Button
							size="md"
							variant="ghost"
							class="stay-mark-action"
							data-testid="use-recommended-bed"
							onclick={() => onuseRecommended?.()}>Use the recommended bed</Button
						>
					{/if}
				</div>
				<!-- Issue #307, "the carrousel for hotel should be used in more places". This box
				     used to draw the first photograph with a "1 / 2" counter under it and no way
				     to reach the second: a label promising a picture the page would not show.
				     Keyed on the property so a swap starts a different hostel at its first
				     photograph rather than at whichever one the last reader had reached. -->
				{#key openProperty.name + openProperty.coordinates.latitude}
					<PhotoCarousel images={openProperty.images} name={openProperty.name} />
				{/key}

				<div class="stay-open-facts">
					<!-- Issue #245: "(scale as reported by the source)" is gone with the doubt
					     that needed it. The scale arrives on the rating now, so this can name
					     it, and the timeline row a few centimetres away names the same one. -->
					{#if openProperty.rating !== undefined}
						<span class="stay-open-rating">rated {formatPropertyRating(openProperty.rating)}</span>
					{/if}
					<span class="stay-open-distance">{formatDistanceKm(distanceToAirportKm)} from the airport</span>
					{#if distanceToCentreKm !== undefined}
						<span class="stay-open-distance">
							{formatDistanceKm(distanceToCentreKm)} from the centre of {connectionAirport.city.name}
						</span>
					{/if}
				</div>

				<div class="stay-room-kinds" role="group" aria-label="Room type for this stay">
					{#each openGroup.options as option (option.stay.roomKind)}
						{@const selectable = isOptionSelectable(option, travellers, females)}
						{@const caveat = stayGenderFitMessage(option.stay, travellers, females)}
						<RoomKindTile
							{option}
							{nights}
							selected={isSameBed(option.stay, effectiveSelected)}
							{selectable}
							{caveat}
							onselect={() => choose(option.stay)}
						/>
					{/each}
				</div>

				{#if hasDormOptions}
					<!-- Issue #288: this used to point at a "not stated" marker no adapter could ever
					     set, so it described a distinction the page never drew. Issue #300 deleted the
					     marker itself. What this says now is checkable on the tiles above it. -->
					<p class="stay-data-note">
						A dorm is shown as women-only or men-only when the provider's own room listing says so, and as a
						plain dorm bed only when that listing holds a mixed room. It is the listing's word, not a guess
						from the property's name.
					</p>
				{/if}
			</div>
		</Card>

		{#if alternatives.length > 0}
			<div class="stay-alternatives">
				<h3 class="stay-alternatives-heading">Other stays near this connection</h3>
				<!-- The list is ordered by what the whole stopover costs rather than by the rate
				     alone (issue #219), so a cheaper bed can sit below a dearer one. Saying so is
				     cheaper than letting the differences below read as a broken sort. -->
				<p class="stay-alternatives-note">
					Cheapest first for this stopover's length, counting the journey out to each. Prices compare
					against the stay this trip books now.
				</p>

				<!--
					Issue #280's architecture, applied to a second map. This picture is an inline
					`<svg>` with no basemap, no controls and no WebGL: `tools/probe-map-cost.mjs`
					measured four live MapLibre instances per card settling in 4.5s on a throttled
					phone and twenty never settling at all, because Chromium evicts the oldest of
					more than sixteen live contexts. So the list carries a drawing and the dialog
					carries the map.
				-->
				<button type="button" class="stay-map-open" onclick={() => (mapOpen = true)}>
					<RoutePreview
						lines={[]}
						points={[
							{ coordinates: connectionAirport.coordinates, tone: 'neutral' },
							...choices.map((choice) => ({ coordinates: choice.property.coordinates, tone: 'stopover' as const }))
						]}
						width={320}
						height={120}
					/>
					<span class="stay-map-open-label">
						Open the map of all {choices.length} stays
						<span class="stay-map-open-hint">Pick a point to compare it against this one</span>
					</span>
				</button>

				<ul class="stay-alternatives-list">
					{#each alternatives as choice (choice.key)}
						<li>
							<StayAlternativeCard
								{choice}
								{nights}
								onselect={() => {
									if (choice.cheapest) choose(choice.cheapest.stay);
								}}
							/>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		<!-- Issue #374: the footnote sits after the alternatives, not inside them, because a
		     single-property list came from one provider too. The line break belongs OUTSIDE
		     the block: Svelte trims whitespace at the start of a block's content, so a
		     newline after `{#if}` is not a space and the sentence runs on as "...missing from
		     this list.Add an Agoda key". -->
		{#if catalogueNote}
			<!-- One flex child, not four: the failure lines are the evidence for the sentence
			     above them and have to sit with it rather than at the picker's own 1.5rem. -->
			<div class="stay-catalogue-footnote">
				<p class="stay-catalogue-note" data-testid="stay-catalogue-note">
					{catalogueNote.description}
					{#if catalogueNote.action}<a href="{base}{catalogueNote.action.href}">{catalogueNote.action.label}</a>{/if}
				</p>
				{#each catalogueNote.providerFailures as failure (failure)}
					<p class="stay-failure font-mono" data-testid="stay-provider-failure">{failure}</p>
				{/each}
			</div>
		{/if}
	</div>

	{#if mapOpen}
		<StaysMapDialog {choices} {connectionAirport} {nights} onchoose={choose} onclose={() => (mapOpen = false)} />
	{/if}
{/if}

<style>
	.stay-picker {
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
	}

	/* Muted rather than faint, for the reason `ResultDetail`'s copy of this note gives:
	   the provider's own words are the evidence, and they have to be readable. */
	.stay-failure {
		margin: 0;
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
		overflow-wrap: anywhere;
	}

	.stay-open-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	/* Mobile first: in the 300px rail the label and the action stack, and they sit on one
	   line as soon as there is room for both. */
	.stay-mark-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
	}

	/* A stub, in the ticket language the panel around this already speaks: small caps, wide
	   tracking, a full-radius outline. Colour is never the only signal here, because the two
	   states say different words. */
	.stay-mark {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-full);
		padding: var(--space-1) var(--space-3);
		background: var(--color-bg-inset);
		color: var(--color-text-muted);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-wide);
	}

	.stay-mark.is-chosen {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}

	/* `Button` sets `white-space: nowrap`, which this label cannot honour in the 300px
	   desktop rail. Wrapping to two lines inside the button is the honest answer there;
	   shortening the words would make the action vaguer everywhere else. */
	.stay-mark-row :global(.stay-mark-action) {
		white-space: normal;
		text-align: center;
	}

	/* 16/9 rather than the carousel's own 16/10, because the open card's photograph is the
	   widest thing on this panel and the ratio it reserves is what stops an image shoving
	   the room tiles down when it lands. That image was 2.8 MB when this was written and is
	   about 65 KB since `hostelworld-photo.ts`. That changes the wait and not the shove.
	   Any picture arriving after layout moves what is under it. */
	.stay-open-body :global(.photo-carousel) {
		--photo-aspect: 16 / 9;
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

	.stay-catalogue-footnote {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	/* A footnote about what the list is missing, not an alarm about it: the beds above are
	   real and bookable, so this reads at the weight of the dorm note rather than louder. */
	.stay-catalogue-note {
		margin: 0;
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	.stay-alternatives-heading {
		font-size: var(--font-size-base);
		font-weight: var(--font-weight-semibold);
	}

	.stay-alternatives-note {
		margin: var(--space-1) 0 var(--space-3);
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-muted);
	}

	/* The drawing and its caption side by side, so the picture reads as a control rather
	   than as a decoration with a button under it. */
	.stay-map-open {
		display: grid;
		grid-template-columns: 8rem minmax(0, 1fr);
		align-items: center;
		gap: var(--space-3);
		width: 100%;
		min-height: 44px;
		margin-bottom: var(--space-3);
		padding: var(--space-2);
		text-align: left;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		color: var(--color-text);
		font: inherit;
		cursor: pointer;
		touch-action: manipulation;
		transition: border-color var(--transition-fast);
	}

	.stay-map-open:hover {
		border-color: var(--color-border-strong);
	}

	.stay-map-open:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	.stay-map-open-label {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-medium);
	}

	.stay-map-open-hint {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-regular);
		color: var(--color-text-muted);
	}

	.stay-alternatives-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
</style>
