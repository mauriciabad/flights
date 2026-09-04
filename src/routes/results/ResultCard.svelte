<script lang="ts">
	/**
	 * One itinerary, ticket-shaped, built to be compared against the card above and below
	 * it rather than read on its own.
	 *
	 * ## What earns a place here, and what does not
	 *
	 * The card used to print one number, "Total time", and hide the rest of brief lines
	 * 55-60 behind an expander. Everything on it now is something a person actually weighs
	 * when choosing between two trips:
	 *
	 * - **The total, with its parts** (`PriceLine`). "€273 = €229 flights + €44 bed" is the
	 *   comparison; "€273" alone is a number you have to open a panel to trust.
	 * - **The trip strip** (`TripStrip`), roughly proportional to real time. The shape of
	 *   the trip is the fastest thing on the card to read, and it carries the two figures
	 *   that matter most (nights, and how long the stopover runs) in the place where they
	 *   mean something spatially.
	 * - **In flight, airport wait, door to door** (`MetricRail`). The three that decide
	 *   whether a cheap itinerary is actually cheap. Airport waiting in particular is the
	 *   cost nobody quotes.
	 *
	 * What was cut, deliberately: per-flight prices and per-leg times (they are in the
	 * expanded panel, where a leg can also be swapped, and five prices on a card is a
	 * spreadsheet); the airline name chips, now carried by the logos on the strip and the
	 * names in the footer; the free-time start and end timestamps, since the strip already
	 * says how long it runs and the exact clock readings only matter once you are planning
	 * inside the stopover; and the one-line "why this is good" sentence, which restated in
	 * prose the two numbers now printed as numbers.
	 *
	 * Every derived string comes from `$lib/format`, `itinerary-metrics.ts` or
	 * `view-model.ts`, all pure and tested. This file arranges markup and picks classes; it
	 * never recomputes a duration or a price.
	 */
	import { AirlineLogo, Card, Flag, MetricRail, PriceLine, TripStrip } from '$lib/components';
	import { CARD_METRIC_IDS } from '$lib/components/itinerary-metrics';
	import type { Airport } from '$lib/domain';
	import { formatAge } from '$lib/format';
	import { connectionAirportCode } from '$lib/results/types';
	import type { ScoredResult } from '$lib/results/types';
	import { describePriceFreshness, describeVariants } from '$lib/results/view-model';

	interface Props {
		result: ScoredResult;
		/** Resolved lazily by the page (getAirport is async); undefined until then, in
		 * which case the card falls back to the bare IATA code rather than blocking. */
		connectionAirport?: Airport;
		/** Issue #104: whether the full timeline/map/pickers are open below this card. */
		expanded?: boolean;
		onToggleExpand?: () => void;
	}

	let { result, connectionAirport, expanded = false, onToggleExpand }: Props = $props();

	const itinerary = $derived(result.itinerary);
	const connectionCode = $derived(connectionAirportCode(itinerary));
	const isDeprioritized = $derived(result.score.avoidedAirlineFlightCount > 0);
	const freshness = $derived(describePriceFreshness(result.price.freshness));

	const connectionLabel = $derived(connectionAirport?.city.name ?? connectionCode);
	// The owner's report was one line reading "Velika Gorica ZAG": the wrong city name
	// (fixed in data/airport-city-names.ts) and no country at all. A stopover is a place
	// he has to decide about, and "Zagreb" alone still leaves him working out which
	// country he would be spending two nights in. Undefined until the airport record
	// resolves, which is the same reason `connectionLabel` falls back to the bare code.
	const connectionCountry = $derived(connectionAirport?.country.name);
	const variantsLabel = $derived(describeVariants(result));

	// Provenance: distinct provider labels behind this price, and the OLDEST of their
	// fetch times, the same "oldest part wins" reasoning `types.ts`'s freshness
	// derivation uses, so this footer's age never reads fresher than the badge above it.
	const providerLabels = $derived(Array.from(new Set(result.price.parts.map((part) => part.providerLabel))));
	const oldestFetchedAt = $derived(
		result.price.parts.length > 0
			? Math.min(...result.price.parts.map((part) => new Date(part.fetchedAt).getTime()))
			: undefined
	);
	const fetchedAgo = $derived(oldestFetchedAt !== undefined ? formatAge(Date.now() - oldestFetchedAt) : undefined);

	// Both carriers, deduped: a single-airline itinerary should say the airline once. The
	// strip already shows each leg's mark, so this row is the names, in the footer where
	// provenance lives.
	const carriers = $derived(
		[itinerary.outboundFlight.carrier, itinerary.onwardFlight.carrier].filter(
			(carrier, index, all) => all.findIndex((other) => other.iataCode === carrier.iataCode) === index
		)
	);

	// Card's `class` prop is a plain string (its own internal `class={[...]}` array
	// syntax only applies to the DOM element it renders, not to what a caller passes
	// in), so the conditional class is built here rather than handed through as an
	// array or object.
	const cardClassName = $derived(`result-card${isDeprioritized ? ' is-deprioritized' : ''}`);
</script>

<Card variant="ticket" elevated padded={false} class={cardClassName}>
	{#snippet header()}
		<div class="route">
			<span class="route-leg">
				<Flag country={itinerary.originAirport.country} />
				<span class="iata font-mono tabular-nums">{itinerary.originAirport.iataCode}</span>
			</span>
			<span class="route-arrow" aria-hidden="true">→</span>
			<span class="route-leg route-leg-stopover">
				<!-- Decorative here alone: this leg spells the country out beside the flag,
				     so announcing it twice only slows a screen reader down. -->
				<Flag country={connectionAirport?.country} decorative />
				<!-- City and country share one flex item on purpose: they are one place
				     name, and separate items would put the row's gap in front of the
				     comma. The stopover's IATA code is not repeated here: the trip strip
				     right below prints it on the boundary it actually names. -->
				<span class="place"
					><span class="city">{connectionLabel}</span>{#if connectionCountry}<span class="country"
							>, {connectionCountry}</span
						>{/if}</span
				>
			</span>
			<span class="route-arrow" aria-hidden="true">→</span>
			<span class="route-leg">
				<Flag country={itinerary.destinationAirport.country} />
				<span class="iata font-mono tabular-nums">{itinerary.destinationAirport.iataCode}</span>
			</span>
			<span class="header-badges">
				{#if isDeprioritized}
					<!-- The one fact `describeWhyGood`'s sentence carried that no number on this
					     card does. It has to be a word, not the greyed-out treatment alone:
					     colour is the only other channel carrying it, and WCAG 1.4.1 is
					     explicit that colour is never the sole means of conveying
					     information. -->
					<span class="avoid-badge">Airline you avoid</span>
				{/if}
				<span class={['freshness-badge', `freshness-${freshness.tone}`]}>{freshness.label}</span>
			</span>
		</div>
	{/snippet}

	<div class="card-main">
		<PriceLine {itinerary} />

		<TripStrip {itinerary} {connectionCode} {connectionLabel} deprioritized={isDeprioritized} />

		<MetricRail {itinerary} ids={CARD_METRIC_IDS} />

		<!-- Issue #104: "open the full trip." A plain controlled button. `aria-expanded`
		     comes straight from a prop, never a locally-owned copy, so an external change
		     is never stuck out of sync with what this card renders. That is the exact bug
		     FilterPanel.svelte's own Chip usage documents as the failure mode of a
		     `$bindable` prop nobody binds. -->
		<div class="card-controls">
			{#if variantsLabel}
				<!-- Brief line 67's "+2 more flight times through here". Beside the button
				     that opens the picker able to swap them, not inside it: a button's label
				     is its accessible name, and "Show details +2 more flight times through
				     here" is not a name. -->
				<span class="variants">{variantsLabel}</span>
			{/if}
			<button type="button" class="details-toggle" aria-expanded={expanded} onclick={() => onToggleExpand?.()}>
				<span class="details-toggle-label">{expanded ? 'Hide details' : 'Show details'}</span>
				<svg
					class={['details-chevron', { 'is-open': expanded }]}
					viewBox="0 0 16 16"
					aria-hidden="true"
					focusable="false"
				>
					<path
						d="M4 6l4 4 4-4"
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
			</button>
		</div>
	</div>

	{#snippet footer()}
		<p class="provenance">
			<span class="carriers">
				{#each carriers as carrier (carrier.iataCode)}
					<span class="carrier">
						<AirlineLogo iataCode={carrier.iataCode} name={carrier.name} deprioritized={isDeprioritized} />
						{carrier.name}
					</span>
				{/each}
			</span>
			<span class="provenance-source"
				>via {providerLabels.join(' & ')}{#if fetchedAgo}, fetched {fetchedAgo}{/if}</span
			>
		</p>
	{/snippet}
</Card>

<style>
	.result-card {
		/* Reserve-space: every card, real or skeleton, commits to this minimum height so
		   a card replacing a skeleton (or a price freshness badge changing width) never
		   reflows the cards below it. Lower than it was: the card itself is now denser
		   than the one it replaces, and an over-generous floor would put the difference
		   straight back as empty space. */
		min-height: 13rem;
	}

	.result-card.is-deprioritized {
		/* Colour only, never opacity (AGENTS.md, .is-deprioritized), the border also
		   drops to the quiet, non-"strong" tone so the whole card reads as background
		   noise without losing legibility. */
		border-color: var(--color-border);
	}

	.route {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	.route-leg {
		display: inline-flex;
		align-items: baseline;
		gap: var(--space-1);
	}

	.route-leg-stopover .city {
		color: var(--color-stopover);
		font-weight: var(--font-weight-semibold);
	}

	/* `.is-deprioritized` lands on Card's own root element (it arrives there as a plain
	   string prop, see `cardClassName` above), which is outside this component's own
	   scoped markup, :global() is what tells Svelte that ancestor genuinely exists at
	   runtime instead of flagging the rule as dead. */
	:global(.is-deprioritized) .route-leg-stopover .city {
		color: var(--color-text-deprioritized);
	}

	.country {
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-regular);
		color: var(--color-text-muted);
	}

	.iata {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.route-arrow {
		color: var(--color-text-faint);
	}

	/* The badges ride in the header rather than beside the price: they are facts about the
	   whole card, and pinning them to the right of the route line keeps the price row free
	   for the price and its parts. */
	.header-badges {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: flex-end;
		gap: var(--space-2);
		margin-left: auto;
	}

	.avoid-badge {
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius-full);
		background: var(--color-bg-inset);
		color: var(--color-text-deprioritized);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
	}

	.freshness-badge {
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius-full);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
	}

	.freshness-neutral {
		color: var(--color-text-faint);
	}

	.freshness-info {
		color: var(--color-info);
		background: var(--color-info-bg);
	}

	.freshness-warning {
		color: var(--color-warning);
		background: var(--color-warning-bg);
	}

	.card-main {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		padding: var(--space-4) var(--space-5);
	}

	/* The ticket's tear line, reused for the row of controls below the boarding-pass
	   content rather than inventing a new divider treatment. */
	.card-controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-2) var(--space-3);
		padding-top: var(--space-3);
		border-top: 2px dashed var(--color-border-strong);
	}

	.details-toggle {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 2.75rem;
		padding: 0 var(--space-2);
		border-radius: var(--radius-md);
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-medium);
		color: var(--color-accent);
		transition: color var(--transition-fast);
	}

	.details-toggle:hover {
		color: var(--color-accent-hover);
	}

	.details-toggle:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	/* An auto right margin rather than `justify-content: space-between` on the row: with
	   `space-between`, a control that wraps to a second line is the only item on it and
	   gets pushed to the LEFT, which put "Show details" under the label on a 375px card.
	   This way whatever wraps stays hard against the right edge. */
	.variants {
		margin-right: auto;
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	.details-toggle-label {
		white-space: nowrap;
	}

	.details-chevron {
		width: 0.9rem;
		height: 0.9rem;
		transition: transform var(--transition-fast);
	}

	.details-chevron.is-open {
		transform: rotate(180deg);
	}

	.provenance {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2) var(--space-4);
		margin: 0;
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	.carriers {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-3);
	}

	.carrier {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		color: var(--color-text-muted);
	}

	:global(.is-deprioritized) .carrier {
		color: var(--color-text-deprioritized);
	}
</style>
