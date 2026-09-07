<script lang="ts">
	/**
	 * The bed, in the half of the card's first row that was empty.
	 *
	 * Issue #435, the owner with a screenshot of that gap: **"on the card, there's a empty
	 * space on the right, it is a great spot to put info about the hotel, including image
	 * carrousel."** The row already held the flight detour and the receipt, and on a desktop
	 * card the space to their right was blank while the second-largest decision on the trip
	 * had no picture and no name anywhere the card could be scanned.
	 *
	 * ## What is here, and the one thing that is deliberately not
	 *
	 * The name, the rating on the provider's own scale, the room kind, the journey out of the
	 * airport, and the photographs.
	 *
	 * **Not the nightly rate**, which the issue asked for. `ResultCard`'s own header states
	 * the rule this card lives under, from the owner on issue #309: **"at the bottom info is
	 * duplicaded and messy."** Every summary figure has exactly one surface, and the rate
	 * already has one about six centimetres to the left, inside `PriceLine`'s hotel group as
	 * "2 nights x EUR 13.00 each". Printing it again in the same row is the defect #309 closed,
	 * visible at a glance because both copies are on screen together. What this panel adds is
	 * everything the receipt cannot say: which property, how good, what room, how far out.
	 *
	 * ## Nothing at all when there is no bed
	 *
	 * A grey frame reading "no picture" is worse than the space, which is `PhotoCarousel`'s own
	 * argument for rendering nothing on an empty list. `bedFacts` returning `undefined` is the
	 * trip having no bed, and the row then goes back to being the detour and the receipt.
	 *
	 * ## Why the layout is flex-basis arithmetic and one container query
	 *
	 * The card is the middle column of a three-column page, so its width does not track the
	 * viewport: at 1024px it is about 310px of content and at 1440px about 630px. A media
	 * query would be reading the wrong number. `.card-getting-there` wraps on flex bases
	 * instead, so this panel drops to its own line exactly when the row cannot seat three, and
	 * a container query on this element decides which shape it takes there. Measured heights
	 * for both are in `tests/e2e/card-size.spec.ts`.
	 */
	import type { Airport, Itinerary } from '$lib/domain';
	import { formatPropertyRating } from '$lib/format';
	import { PhotoCarousel, StayReachLine, bedFacts, propertyKey } from '$lib/stays';

	interface Props {
		itinerary: Itinerary;
		/** Resolved lazily by the page, and the only thing that can put a distance on the bed.
		 * Without it the reach line falls back to the journey, and with neither it says
		 * nothing rather than inventing a point (`bed-facts.ts`). */
		connectionAirport?: Airport;
	}

	let { itinerary, connectionAirport }: Props = $props();

	const bed = $derived(bedFacts(itinerary, connectionAirport?.coordinates));
	const rating = $derived(bed?.property.rating ? formatPropertyRating(bed.property.rating) : undefined);
	// A row that has neither a routed ride nor an airport position has nothing true to say
	// about how far out the bed is, and `StayReachLine`'s fallback would read "0 km from the
	// airport". Absent, not zero.
	const reachIsKnown = $derived(bed !== undefined && (bed.reach !== undefined || bed.distanceFromAirportKm !== undefined));
</script>

{#if bed}
	<!-- Keyed on the property, for `PickedBed`'s reason: the carousel counts which photograph
	     the reader has reached, and carrying that count to a different hostel would open the
	     new one on its second picture and fetch it unasked. -->
	{#key propertyKey(bed.property)}
		<section class="card-stay" aria-label="Where you sleep">
			<div class="card-stay-body">
				{#if bed.property.images.length > 0}
					<div class="card-stay-photo">
						<PhotoCarousel images={bed.property.images} name={bed.property.name} />
					</div>
				{/if}

				<div class="card-stay-facts">
					<p class="card-stay-name">
						{bed.property.name}
						{#if rating}
							<!-- Issue #258 made a rating a value and its scale, and
							     `formatPropertyRating` is the only place either becomes a string. The
							     scale is printed with the number, so 8.6/10 and 4.5/5 stay different
							     claims: this card does not decide what a rating means, and a second
							     conversion here is how the same property ends up scored two ways on
							     two surfaces. -->
							<span class="card-stay-rating font-mono tabular-nums">{rating}</span>
						{/if}
					</p>
					<p class="card-stay-room">{bed.roomKindLabel}</p>
					{#if reachIsKnown}
						<StayReachLine reach={bed.reach} distanceToAirportKm={bed.distanceFromAirportKm ?? 0} />
					{/if}
				</div>
			</div>
		</section>
	{/key}
{/if}

<style>
	.card-stay {
		/* Wide enough to seat a photograph and a name, and the number the row's wrap turns
		   on: the detour is 6.5rem and `PriceLine` asks for 11rem, so a card narrower than
		   about 34rem of content puts this on its own line. */
		flex: 1 1 15rem;
		min-width: 0;
		/* The shape below is decided by how much room this panel ended up with, not by the
		   viewport. A phone card and a 1440px card can both hand it 20rem, from opposite
		   directions. */
		container-type: inline-size;
	}

	.card-stay-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		min-width: 0;
	}

	.card-stay-photo {
		/* Shorter than the 16/10 the picker uses. This is a thumbnail beside a receipt, not
		   the subject of the screen, and every pixel here is card height on a phone. */
		--photo-aspect: 16 / 9;
		--photo-arrow-size: 1.75rem;
		min-width: 0;
	}

	.card-stay-facts {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
	}

	.card-stay-name {
		margin: 0;
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		line-height: var(--line-height-sm);
		color: var(--color-text);
		/* Property names are a provider's free text and some run long with nothing to break
		   on. The same treatment `PickedBed` gives its own. */
		overflow-wrap: anywhere;
	}

	/* The stopover colour, the one this app reserves for the free city, and the same pill
	   `PickedBed` prints. A reader moving between the card and the panel should meet one
	   rating, not two designs for it. */
	.card-stay-rating {
		margin-left: var(--space-2);
		padding: 1px var(--space-2);
		border-radius: var(--radius-full);
		background: var(--color-stopover-bg);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		color: var(--color-stopover);
		white-space: nowrap;
	}

	.card-stay-room {
		margin: 0;
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-muted);
	}

	/* Colour only, never opacity, and every line keeps its own contrast. `--color-text-muted`
	   already clears AA on this surface, so only the two loud things quiet down. */
	/* `.is-deprioritized` lands on `Card`'s own root, outside this component's scoped markup,
	   so `:global()` is what tells Svelte that ancestor exists at runtime. The same hook every
	   other block on this card hangs its quiet treatment on. */
	:global(.is-deprioritized) .card-stay-name,
	:global(.is-deprioritized) .card-stay-rating {
		color: var(--color-text-deprioritized);
	}

	:global(.is-deprioritized) .card-stay-rating {
		background: var(--color-bg-inset);
	}

	/* Wide enough for the picture to sit beside the words instead of above them, which is
	   what this panel gets when it has wrapped to a line of its own. Vertical is the narrow
	   case and the default, so a card that never reaches this width needs no override. */
	@container (min-width: 19rem) {
		.card-stay-body {
			flex-direction: row;
			align-items: flex-start;
			gap: var(--space-3);
		}

		.card-stay-photo {
			/* A third of the row, floored and capped: small enough that the name and the
			   journey keep the width they need on a 375px card, large enough to be a
			   photograph rather than a stamp on a 1440px one. */
			flex: 0 0 clamp(6.5rem, 32%, 11rem);
		}

		.card-stay-facts {
			flex: 1 1 0;
		}
	}
</style>
