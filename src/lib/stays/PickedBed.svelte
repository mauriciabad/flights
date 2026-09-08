<script lang="ts">
	/**
	 * The bed the traveller picked, shown as a thing with a picture rather than as a
	 * paragraph about a thing.
	 *
	 * Issue #279, the owner's own words: **"the picked hotel should also be shown in the
	 * card permanently, with more details and images (carrousel so i can see more images),
	 * and not inside the tooltip. and also with a better layout and design, not it is a
	 * blob of text."**
	 *
	 * The blob was four consecutive `<p>` elements in `StopoverBlock.svelte`: property,
	 * room kind and distance, nights and rate, then the ride. Four lines of the same size
	 * in the same colour, which is a paragraph with line breaks in it. This is the same
	 * four facts given a shape, plus the three the app already had and never showed: the
	 * photographs, the guest rating, and whether the property admits women only. Two of those
	 * three have since gone to the surface that owns them, and the sections below say why.
	 *
	 * ## Nothing here is computed here
	 *
	 * Every value arrives already derived, for the reason `StopoverBlock` gives at length:
	 * a fact with two derivations grows two answers. `bedNightlyRate` (issue #238) still
	 * owns the rate and who it covers, and the ride's sentence is still the one
	 * `itinerary-timeline-format.ts` spells for the timeline. This file arranges them.
	 *
	 * ## This block draws no photographs, and the reason moved twice
	 *
	 * It drew them from #279 until issue #458. The strip itself moved out first, to
	 * `PhotoCarousel.svelte` for #307, so the picker's open card and the stay map's sidebar
	 * could show the same thing rather than each growing one.
	 *
	 * Then #440 put this block at the top of the trip inspector, directly above that picker,
	 * and the picker's open card is by construction the property this block is about.
	 * `StayPicker` opens the group holding the selected bed, and choosing an alternative is
	 * what makes it selected. So the panel photographed one building twice, the upper one
	 * reading `1 / 2` and the lower `1 / 5`, and the one a reader's eye lands on first was
	 * the one with less in it. The upper set was `Property.images` merged with the picked
	 * room's; the lower adds what the provider answered on demand about that property's
	 * rooms (`fetch-room-photos.ts`), which is a lookup keyed to the open card rather than
	 * to a bed. Measured at 1440x900 before the change, 235px of this block's 523px was a
	 * photograph of a building photographed again 550px below it.
	 *
	 * A picture belongs where somebody is choosing, so the picker's open card keeps it and
	 * this block says which bed is booked in words. The panel loses nothing, since those are
	 * the same property's photographs with its rooms in them. The result card carries a
	 * thumbnail carousel of the same bed through `CardStay`, which is where issue #279's ask
	 * for the picked hotel "in the card permanently, with images" is answered now.
	 *
	 * The hover panel wanted this first and for its own reason. Issue #307, the owner:
	 * **"dont show the images inside the toooltip, it is too large."** It stood 542px tall
	 * on a 900px viewport with 189px of that a media box. That is true by construction now
	 * rather than by a prop nobody sets.
	 *
	 * ## What this block says, and what it leaves to the picker (issue #465)
	 *
	 * Removing the photograph left the words saying the same thing twice. In the trip
	 * inspector this block sits about 550px above the stay picker's open card, and that card
	 * is the same property for the reason above, so the panel printed the name, the rating,
	 * the distance from the airport, the room kind and the nightly rate in both places inside
	 * a column 20rem to 24rem wide.
	 *
	 * The rule is the one `ResultCard`'s header carries from issue #309, the owner: **"at the
	 * bottom info is duplicaded and messy. all info should be already in the card, so
	 * expanding shouldn change."** Every summary figure has one surface. `CardStay` already
	 * applies it by refusing the nightly rate, which `PriceLine` owns on that card.
	 *
	 * So the two surfaces answer two questions. This block answers "which bed am I booked
	 * into and what does it cost": the property, the room, the rate and who it covers, the
	 * nights, and the ride out to it. The picker's open card answers "is this the property I
	 * want": the photographs, the rating, both distances, and every room kind with its price.
	 *
	 * The rating and the distance from the connection airport went with that split. Neither
	 * is a fact about the booking, and both read better on the card that is offering the
	 * property. The distance costs the hover stub nothing, because `SegmentStub` passes no
	 * connection coordinates and the stub prints "From VIE, 2.8 km straight line" as a fact
	 * of its own; the rating leaves the stub, where the card underneath it prints the same
	 * number through `CardStay`.
	 *
	 * The room kind rides in the name's own paragraph now rather than in a row below it. It
	 * is half the answer to which bed, so it belongs beside the property rather than under
	 * it, and the row it used to hold is 28px of a panel this issue is about the height of.
	 */
	import { ModeIcon } from '$lib/components';
	import type { Property, TransferMode } from '$lib/domain';

	interface Props {
		/** Name and the women-only restriction, read straight off the domain record. Neither
		 * `Property.images` nor `Property.rating` is drawn here; the two sections above say
		 * which surface owns each. */
		property: Property;
		/** `ROOM_KIND_LABELS[stay.roomKind]`, the same table the picker's tiles print. */
		roomKindLabel: string;
		/** How many nights this stopover books, for the figure beside the rate. */
		nights: number;
		/** `bedNightlyRate` through `formatMoney`, already split into the number and who it
		 * covers, so this block and the card's price breakdown cannot quote two different
		 * figures for one bed (issue #206). `audience` is absent when the party is one. */
		rate: { amount: string; audience?: string };
		/** The ride to the bed. `note` is always a full sentence, including when nothing
		 * routed at all, because issue #228 asked for a line that never vanishes. `mode` is
		 * absent in exactly that unrouted case, and the pictogram goes with it. */
		transfer: { note: string; mode?: TransferMode };
	}

	let { property, roomKindLabel, nights, rate, transfer }: Props = $props();
</script>

<div class="bed">
	<p class="bed-name">
		{property.name}
		<span class="bed-tag">{roomKindLabel}</span>
		{#if property.womenOnly}
			<!-- The whole property admits women only, which `domain/stay.ts` is careful to separate
			     from one room being a female dorm. It has been on the record since a women-only
			     hostel was recommended to a party with no female travellers, and this is the only
			     surface that prints it. -->
			<span class="bed-tag bed-tag-restricted">Women only</span>
		{/if}
	</p>

	<dl class="bed-rail">
		<div class="bed-figure">
			<dt class="bed-figure-label font-mono">Per night</dt>
			<dd class="bed-figure-value font-mono tabular-nums">
				{rate.amount}
				<!-- The space before this matters and is not formatting. The note is a block, so it
				     drops to its own line either way, but with the markup closed up the two run
				     together in `textContent` and a screen reader says "twenty euros for three" as
				     one word: "€20.00for 3". -->
				{#if rate.audience}<span class="bed-figure-note">{rate.audience}</span>{/if}
			</dd>
		</div>
		<div class="bed-figure">
			<dt class="bed-figure-label font-mono">Nights</dt>
			<dd class="bed-figure-value font-mono tabular-nums">{nights}</dd>
		</div>
	</dl>

	<p class="bed-transfer">
		{#if transfer.mode}
			<ModeIcon kind={transfer.mode} />
		{/if}
		<span>{transfer.note}</span>
	</p>
</div>

<style>
	/* One column at every width. This was two once there was room for two, and the second
	   track held the photograph; with the photograph on the picker's own card (issue #458)
	   the query container, the container query and the wrapper that carried it are all gone
	   with it. Three short rows have nothing to gain from a second column. */
	.bed {
		display: grid;
		gap: var(--space-2);
		align-content: start;
	}

	.bed-name {
		margin: 0;
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		line-height: var(--line-height-sm);
		color: var(--color-text);
		/* Property names are a provider's free text and some of them are very long with no
		   spaces to break on. Same treatment `EmptyState` and `SegmentStub` give theirs. */
		overflow-wrap: anywhere;
	}

	/* Riding inside the name's own paragraph rather than in a row of its own (issue #465), so
	   a long property name and the room it books reflow together instead of leaving a chip
	   stranded on a line by itself. The rating pill used to hold this slot; the picker's open
	   card scores the property now. */
	.bed-tag {
		display: inline-block;
		margin-left: var(--space-2);
		padding: 1px var(--space-2);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-full);
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	/* Not a warning tone. A women-only property is a fact about the inventory, and colouring
	   it as a problem would editorialise a restriction that suits some travellers fine. */
	.bed-tag-restricted {
		border-color: var(--color-border-strong);
		color: var(--color-text);
	}

	/*
	   The boarding-pass field treatment `MetricRail` established: a small uppercase mono
	   caption over the figure, under a hairline, never boxed. Same vocabulary rather than
	   the same component, because `MetricRail` reads `itinerary-metrics.ts`, a fixed
	   registry of itinerary-level figures, and these two are facts about a booking.
	   Bending that registry to hold them would put a bed's rate behind an itinerary's API.

	   A top rule rather than a left one for the reason that file records: the rail wraps,
	   and a left divider draws itself down the margin of whichever cell starts row two.
	*/
	.bed-rail {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(4.5rem, 1fr));
		gap: var(--space-3);
		margin: var(--space-1) 0 0;
	}

	.bed-figure {
		padding-top: var(--space-2);
		border-top: 1px solid var(--color-border);
	}

	/* Muted rather than faint, the measurement `MetricRail` records: the faint token comes
	   out at 4.19:1 on the dark palette's card surface, under WCAG AA, and this is a field
	   label rather than decoration. */
	.bed-figure-label {
		font-size: 0.625rem;
		font-weight: var(--font-weight-medium);
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.bed-figure-value {
		margin: 0;
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		line-height: 1.3;
		color: var(--color-text);
	}

	/* "each" or "for 3" sits under the number rather than beside it: who a rate covers is a
	   qualifier on the figure, and running it inline turns a two-character cell into a
	   nine-character one that wraps the rail at 375px. */
	.bed-figure-note {
		display: block;
		font-family: var(--font-sans);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-regular);
		color: var(--color-text-muted);
	}

	.bed-transfer {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		margin: var(--space-1) 0 0;
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-muted);
	}

	/* A flex item will not shrink below its longest word without this, and the sentence
	   beside the pictogram carries place names nobody here chose the length of. */
	.bed-transfer span {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	/* Colour swap rather than opacity, matching the rest of the card's deprioritised
	   treatment: every line here still has to be readable. */
	:global(.is-deprioritized) .bed-name,
	:global(.is-deprioritized) .bed-figure-value {
		color: var(--color-text-deprioritized);
	}
</style>
