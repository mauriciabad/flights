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
	import { Button, Card, Chip, EmptyState, RoutePreview, Select } from '$lib/components';
	import RoomKindTile from './RoomKindTile.svelte';
	import StayAlternativeCard from './StayAlternativeCard.svelte';
	import PhotoCarousel from './PhotoCarousel.svelte';
	import StaysMapDialog from './StaysMapDialog.svelte';
	import { stayGenderFitMessage } from './gendered-room-fit';
	import { describeStayChoices } from './choice';
	import { stayReachNote, type StayReach } from './reach';
	import { STAY_SORT_LABELS, availableStaySortKeys, sortStayChoices, type StaySortKey } from './sort';
	import { formatDistanceKm, haversineDistanceKm } from './distance';
	import { stayTotalDelta, stayTotalForNights } from './pricing';
	import {
		cheapestSelectableOption,
		countPropertiesByBedKind,
		isOptionSelectable,
		isPropertyOnOffer,
		rankProperties
	} from './rank';
	import { BED_KINDS, BED_KIND_LABELS, NO_BED_KIND_FILTER, type BedKind } from './room-kind';
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
		/**
		 * Bindable: which bed kinds the alternatives list and the map are narrowed to (issue
		 * #423), empty meaning both. The owner asked for "a filter for the bed kind (dorm or
		 * provate room)... same on the map".
		 *
		 * Bound rather than owned here because `SegmentCustomiser` answers the same question
		 * from outside this component: its `recommendedForNow` ranks `stayCandidates` itself,
		 * so a filter kept private to the picker would let "Use the recommended bed" hand back
		 * a dorm to somebody looking at private rooms.
		 */
		bedKinds?: ReadonlySet<BedKind>;
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
		 * Issue #405: how long the journey out from the connection airport takes, per property
		 * and per mode. Fetched by whoever owns provider access (`SegmentCustomiser`) rather
		 * than here, so this component stays a pure function of its props and testable without
		 * a network. Empty means nobody has looked, which every surface renders as the straight
		 * line it replaced.
		 */
		reachByProperty?: ReadonlyMap<string, StayReach>;
		/** Whatever the reach lookup failed with, in the provider's own words. */
		reachFailures?: readonly string[];
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
		bedKinds = $bindable(NO_BED_KIND_FILTER),
		onchange,
		stayProviders = [],
		unconfiguredStayProviders = [],
		chosen = false,
		onuseRecommended,
		reachByProperty,
		reachFailures = []
	}: Props = $props();

	const uid = $props.id();

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
			visitDays,
			bedKinds
		})
	);

	const fallbackStay = $derived(firstBookableStay(ranked, travellers, females, bedKinds));
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
	// `fallbackStay` has to exist for this to mean anything: under a bed-kind filter that
	// nothing matches there is no recommendation to hand back, and the button would have run
	// `useRecommendedBed` against an `undefined` and done nothing at all.
	const recommendationMoved = $derived(
		chosen &&
			fallbackStay !== undefined &&
			openProperty !== undefined &&
			!isSameProperty(fallbackStay.property, openProperty)
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
			females,
			bedKinds,
			reachByProperty
		})
	);

	/**
	 * Issue #423's filter, applied here and nowhere else.
	 *
	 * The alternatives list, the map's points and the map's sidebar are all renderings of
	 * `sortedChoices`, so narrowing upstream of it is what makes the owner's "same on the map"
	 * true without the map knowing a filter exists.
	 *
	 * A property nobody in the group can book stays on the list carrying its reason, because
	 * no click of theirs changes that; one the traveller hid goes, because showing it is
	 * showing them what they asked to hide. `isPropertyOnOffer` is where those two part.
	 *
	 * The property the trip books never leaves. The map marks it as the current pick and every
	 * delta on this screen is measured from its price.
	 */
	const onOffer = $derived(
		choices.filter((choice) => choice.isPicked || isPropertyOnOffer(choice.group, travellers, females, bedKinds))
	);

	/** Inventory per kind, for the two chips. Read off `properties` rather than off the
	 * filtered list, so the count on the chip the traveller has NOT chosen is the count of what
	 * choosing it would show them rather than a count of their own current answer. */
	const bedKindCounts = $derived(countPropertiesByBedKind(properties, travellers, females));

	/** The one kind the traveller narrowed to, or `undefined` when they have not narrowed at
	 * all. Neither chip and both chips are one request, which is why this is not a size. */
	const onlyBedKind = $derived(bedKinds.size === 1 ? [...bedKinds][0] : undefined);

	/**
	 * Issue #406, and the reason it lives up here rather than in the row: the list, the map's
	 * points and the map's sidebar are three renderings of one answer, and a sort inside
	 * `StayAlternativeCard` would leave the other two on the old order. `sortStayChoices` takes
	 * the ranked list and rearranges it; `rankProperties` still decides what "recommended"
	 * means and is still the default.
	 */
	let sortKey = $state<StaySortKey>('recommended');
	const sortCurrency = $derived(effectiveSelected?.pricePerNight.currency);
	// Filter first, then sort what is left: the two are orthogonal, and asking which keys are
	// worth offering of rows the reader cannot see would offer a bus-ride sort for a bus ride
	// to a property the filter has already taken away.
	const sortKeys = $derived(availableStaySortKeys(onOffer, sortCurrency));
	// A key can stop being offered under the traveller: a different stopover has no city
	// centre, its beds are quoted in another currency, or a bed-kind filter has just taken the
	// only routed row away. Falling back to the default beats holding a selection the control
	// no longer shows.
	const activeSortKey = $derived(sortKeys.includes(sortKey) ? sortKey : 'recommended');
	const sortedChoices = $derived(sortStayChoices(onOffer, activeSortKey, sortCurrency));

	/** What the order currently is, in the words of the key that produced it. The default's
	 * sentence is the one issue #219 needs, and every other key gets a plain statement rather
	 * than that sentence left standing over a list it no longer describes. */
	const sortNote = $derived(
		activeSortKey === 'recommended'
			? "Cheapest first for this stopover's length, counting the journey out to each."
			: `Sorted by ${STAY_SORT_LABELS[activeSortKey].toLowerCase()}, shortest first. Stays without that figure are at the end.`
	);

	/** Why no row has a bus time, said once rather than thirty times. `fetch-reach.ts` holds
	 * the measurement behind it. */
	const reachNote = $derived(
		stayReachNote(sortedChoices.flatMap((choice) => (choice.reach ? [choice.reach] : [])))
	);

	const alternatives = $derived(sortedChoices.filter((choice) => choice.group !== openGroup));

	/** Every other property this connection has, before any of it is filtered. What it decides
	 * is whether there is a second stay here at all, which is a different question from whether
	 * the filter left one standing, and the two need different words on screen. */
	const otherStays = $derived(choices.filter((choice) => choice.group !== openGroup));

	/**
	 * Said when the traveller's own filter is what emptied the list.
	 *
	 * Distinct from `nothingBookable` on purpose. That one is about a connection where nobody
	 * in this party can sleep anywhere, and there is no click that fixes it. This one is a
	 * choice they made a moment ago, so it names the kind that found nothing and the button
	 * beside it puts the other beds back.
	 */
	const filteredOutNote = $derived.by(() => {
		if (alternatives.length > 0 || onlyBedKind === undefined) return undefined;
		const kind = BED_KIND_LABELS[onlyBedKind].toLowerCase();
		const others =
			otherStays.length === 1
				? 'The one other stay found here does not offer'
				: `None of the other ${otherStays.length} stays found here offers`;
		return {
			title: `No other ${kind} near this connection`,
			description: `${others} a ${kind} this group can book. The stay above still shows every room it has.`
		};
	});

	/**
	 * Flips one chip, by rebuilding the set rather than mutating a copy of it.
	 *
	 * `bedKinds` is a `ReadonlySet` the parent holds in `$state` and this replaces wholesale,
	 * which is `ResultFilters`' convention (`results/filters.ts`) and is what makes the
	 * reassignment the reactive signal. Building the new value out of `BED_KINDS` keeps the
	 * result plain and immutable, so nothing here needs a reactive collection.
	 */
	function toggleBedKind(kind: BedKind) {
		const turningOn = !bedKinds.has(kind);
		bedKinds = new Set(
			BED_KINDS.filter((candidate) => (candidate === kind ? turningOn : bedKinds.has(candidate)))
		);
	}

	/** The map exists while this is true and not one moment longer, which is issue #280's
	 * rule about where MapLibre may live. Mounting the dialog creates the only instance on
	 * the page; unmounting it runs `map.remove()`. */
	let mapOpen = $state(false);

	/** Whether anything in the whole candidate list is bookable by this group at all -
	 * false only when every property's only rooms are a women-only or men-only dorm this
	 * group can't (fully) use, the one case with nothing safe to fall back to. */
	const nothingBookable = $derived(
		properties.length > 0 && ranked.every((g) => !cheapestSelectableOption(g, travellers, females))
	);

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

		{#if otherStays.length > 0}
			<div class="stay-alternatives">
				<h3 class="stay-alternatives-heading">Other stays near this connection</h3>
				<!-- The default order is what the whole stopover costs rather than the rate alone
				     (issue #219), so a cheaper bed can sit below a dearer one. Saying so is cheaper
				     than letting the differences below read as a broken sort. The sentence changes
				     with the key, because "cheapest first" is a lie once the traveller has asked
				     for the shortest walk. -->
				<p class="stay-alternatives-note">
					{sortNote}
					Prices compare against the stay this trip books now.
				</p>

				<!-- The two view controls together, because they answer one question between them:
				     which of these stays am I looking at, and in what order. They stack in the
				     300px rail and sit side by side the moment there is room for both. -->
				<div class="stay-view-controls">
					<!--
						Chips here and a `Select` beside them, which is not an inconsistency. Sorting
						picks one of five keys, and issue #406 chose the platform's own picker for
						that. This picks a subset of two, and a subset is what a chip rail is for:
						both counts are readable at once, which is the whole answer to "are there any
						private rooms here". The treatment is `FilterPanel`'s, down to the head with
						its right-hand readout, so the two filter rails in this app read as one idea.
					-->
					<div class="stay-filter">
						<div class="stay-filter-head">
							<span id="{uid}-bed-kind">Bed kind</span>
							<span class="stay-filter-value">{onlyBedKind ? BED_KIND_LABELS[onlyBedKind] : 'Any'}</span>
						</div>
						<div class="chip-row" role="group" aria-labelledby="{uid}-bed-kind">
							{#each BED_KINDS as kind (kind)}
								<Chip
									interactive
									selected={bedKinds.has(kind)}
									disabled={bedKindCounts[kind] === 0}
									onclick={() => toggleBedKind(kind)}
								>
									{BED_KIND_LABELS[kind]}
									<span class="tabular-nums">({bedKindCounts[kind]})</span>
								</Chip>
							{/each}
						</div>
					</div>

					<!--
						A native select rather than a row of chips (issue #406). Five keys as chips wrap
						to three lines in the 312px rail, and on a phone this hands the traveller the
						platform's own picker. It is keyboard-reachable with a real focus ring, and the
						active key is a word in the closed control rather than a colour on one chip.
						Offered only where there is more than one thing to choose between: a list nothing
						has routed yet has no second key, and a control with one option is furniture.
					-->
					{#if sortKeys.length > 1}
						<Select
							class="stay-sort"
							label="Sort these stays by"
							options={sortKeys.map((key) => ({ value: key, label: STAY_SORT_LABELS[key] }))}
							bind:value={() => activeSortKey, (next) => (sortKey = next as StaySortKey)}
						/>
					{/if}
				</div>

				<!-- The list the traveller asked for, or the reason it is empty. Both the map and
				     the rows below read `sortedChoices`, so with nothing matching there is no map
				     worth opening either: what belongs here is the way back. -->
				{#if filteredOutNote}
					<EmptyState title={filteredOutNote.title} description={filteredOutNote.description}>
						{#snippet action()}
							<Button size="md" variant="secondary" onclick={() => (bedKinds = NO_BED_KIND_FILTER)}>
								Show every bed kind
							</Button>
						{/snippet}
					</EmptyState>
				{:else}
					<!-- Issue #405. Absence of a bus time on thirty rows would read as "there is no bus
					     to any of these", which nobody checked. This is the true version of that claim,
					     said once. -->
					{#if reachNote}
						<p class="stay-alternatives-note" data-testid="stay-reach-note">{reachNote}</p>
					{/if}
					<!-- AGENTS.md, "show the error you got": the router's own sentence and status code,
					     not our paraphrase of them. -->
					{#each reachFailures as failure (failure)}
						<p class="stay-failure font-mono" data-testid="stay-reach-failure">{failure}</p>
					{/each}

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
								...sortedChoices.map((choice) => ({
									coordinates: choice.property.coordinates,
									tone: 'stopover' as const
								}))
							]}
							width={320}
							height={120}
						/>
						<span class="stay-map-open-label">
							<!-- "all" stops being true the moment the traveller narrows, and the map is
							     narrowed with the list (issue #423). Saying "matching" is what stops this
							     label promising a hostel the map will not draw. -->
							{onlyBedKind
								? `Open the map of ${sortedChoices.length} matching stays`
								: `Open the map of all ${sortedChoices.length} stays`}
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
				{/if}
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
					{#if catalogueNote.action}<a href="{base}{catalogueNote.action.href}"
							>{catalogueNote.action.label}</a
						>{/if}
				</p>
				{#each catalogueNote.providerFailures as failure (failure)}
					<p class="stay-failure font-mono" data-testid="stay-provider-failure">{failure}</p>
				{/each}
			</div>
		{/if}
	</div>

	{#if mapOpen}
		<StaysMapDialog
			choices={sortedChoices}
			{connectionAirport}
			{nights}
			onchoose={choose}
			onclose={() => (mapOpen = false)}
		/>
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

	/* Mobile first: one column in the 300px rail and on a phone, side by side as soon as
	   there is room for both. The chips are the wider of the two and take the spare space,
	   because a truncated "Private room (4)" costs the reader the count. */
	.stay-view-controls {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--space-3);
		margin-bottom: var(--space-3);
	}

	.stay-filter {
		display: flex;
		flex: 1 1 13rem;
		flex-direction: column;
		gap: var(--space-2);
	}

	/* `FilterPanel`'s head, kept to the pixel: the label on the left and what the group is
	   currently set to on the right, so a rail scrolled past its own chips still says what it
	   is doing. */
	.stay-filter-head {
		display: flex;
		justify-content: space-between;
		gap: var(--space-2);
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.stay-filter-value {
		color: var(--color-text);
		font-weight: var(--font-weight-medium);
	}

	.chip-row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.stay-view-controls :global(.stay-sort) {
		flex: 1 1 11rem;
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
