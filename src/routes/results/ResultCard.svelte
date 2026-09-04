<script lang="ts">
	/**
	 * One itinerary, boarding-pass shaped per AGENTS.md's design section. Every derived
	 * string comes from `$lib/results/format.ts` and `view-model.ts` (both pure and
	 * tested), this component only arranges markup and picks CSS classes, nothing here
	 * recomputes a duration or a price from scratch.
	 */
	import { Card, Chip } from '$lib/components';
	import { iconForAirport } from '$lib/data/airports';
	import type { Airport } from '$lib/domain';
	import { formatAge, formatClockTime, formatDayLabel, formatDuration, formatMoney } from '$lib/results/format';
	import { connectionAirportCode } from '$lib/results/types';
	import type { ScoredResult } from '$lib/results/types';
	import { describePriceFreshness, describeVariants, describeWhyGood } from '$lib/results/view-model';

	interface Props {
		result: ScoredResult;
		/** Resolved lazily by the page (getAirport is async); undefined until then, in
		 * which case the card falls back to the bare IATA code rather than blocking. */
		connectionAirport?: Airport;
	}

	let { result, connectionAirport }: Props = $props();

	const itinerary = $derived(result.itinerary);
	const connectionCode = $derived(connectionAirportCode(itinerary));
	const isDeprioritized = $derived(result.score.avoidedAirlineFlightCount > 0);
	const freshness = $derived(describePriceFreshness(result.price.freshness));
	const whyGood = $derived(describeWhyGood(result));

	const originIcon = $derived(iconForAirport(itinerary.originAirport));
	const destinationIcon = $derived(iconForAirport(itinerary.destinationAirport));
	const connectionIcon = $derived(iconForAirport(connectionAirport));
	const connectionLabel = $derived(connectionAirport?.city.name ?? connectionCode);
	const variantsLabel = $derived(describeVariants(result));

	// Provenance: distinct provider labels behind this price, and the OLDEST of their
	// fetch times, the same "oldest part wins" reasoning `types.ts`'s freshness
	// derivation uses, so this footer's age never reads fresher than the badge above it.
	const providerLabels = $derived(
		Array.from(new Set(result.price.parts.map((part) => part.providerLabel)))
	);
	const oldestFetchedAt = $derived(
		result.price.parts.length > 0
			? Math.min(...result.price.parts.map((part) => new Date(part.fetchedAt).getTime()))
			: undefined
	);
	const fetchedAgo = $derived(oldestFetchedAt !== undefined ? formatAge(Date.now() - oldestFetchedAt) : undefined);

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
				<span class="flag" aria-hidden="true">{originIcon.glyph}</span>
				<span class="iata font-mono tabular-nums">{itinerary.originAirport.iataCode}</span>
			</span>
			<span class="route-arrow" aria-hidden="true">→</span>
			<span class="route-leg route-leg-stopover">
				<span class="flag" aria-hidden="true">{connectionIcon.glyph}</span>
				<span class="city">{connectionLabel}</span>
				<span class="iata font-mono tabular-nums">{connectionCode}</span>
			</span>
			<span class="route-arrow" aria-hidden="true">→</span>
			<span class="route-leg">
				<span class="flag" aria-hidden="true">{destinationIcon.glyph}</span>
				<span class="iata font-mono tabular-nums">{itinerary.destinationAirport.iataCode}</span>
			</span>
		</div>
	{/snippet}

	<div class="card-main">
		<div class="price-row">
			<span class="price font-mono tabular-nums">{formatMoney(itinerary.totalPrice)}</span>
			<span class={['freshness-badge', `freshness-${freshness.tone}`]}>{freshness.label}</span>
		</div>
		{#if !itinerary.stay}
			<p class="no-stay-note">No bed priced for this stopover — total excludes a stay.</p>
		{/if}

		<dl class="stats">
			<div class="stat">
				<dt>Total time</dt>
				<dd class="font-mono tabular-nums">{formatDuration(itinerary.times.total)}</dd>
			</div>
			<div class="stat stat-stopover">
				<dt>Nights in {connectionLabel}</dt>
				<dd class="text-stopover">
					{#if !itinerary.stay}
						No stay priced
					{:else if itinerary.nightsInConnection === 0}
						Same-day connection
					{:else}
						{itinerary.nightsInConnection}
					{/if}
				</dd>
			</div>
		</dl>

		<p class="free-time">
			<span class="free-time-label">Free time</span>
			<span class="free-time-window font-mono tabular-nums">
				{formatDayLabel(itinerary.freeTime.start)} {formatClockTime(itinerary.freeTime.start)}
				<span aria-hidden="true">→</span>
				{formatDayLabel(itinerary.freeTime.end)} {formatClockTime(itinerary.freeTime.end)}
			</span>
		</p>

		<div class="airlines">
			<Chip label={itinerary.outboundFlight.carrier.name} deprioritized={isDeprioritized} />
			<Chip label={itinerary.onwardFlight.carrier.name} deprioritized={isDeprioritized} />
		</div>

		<p class="why-good">{whyGood}</p>
		{#if variantsLabel}
			<p class="variants">{variantsLabel}</p>
		{/if}
	</div>

	{#snippet footer()}
		<p class="provenance">
			via {providerLabels.join(' & ')}
			{#if fetchedAgo}
				<span aria-hidden="true">·</span>
				fetched {fetchedAgo}
			{/if}
		</p>
	{/snippet}
</Card>

<style>
	.result-card {
		/* Reserve-space: every card, real or skeleton, commits to this minimum height so
		   a card replacing a skeleton (or a price freshness badge changing width) never
		   reflows the cards below it. */
		min-height: 15rem;
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

	.flag {
		font-size: 1rem;
		line-height: 1;
	}

	.iata {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.route-arrow {
		color: var(--color-text-faint);
	}

	.card-main {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		padding: var(--space-5);
	}

	.price-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-3);
	}

	.price {
		font-size: var(--font-size-2xl);
		font-weight: var(--font-weight-bold);
		letter-spacing: var(--tracking-tight);
	}

	.freshness-badge {
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius-full);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
		white-space: normal;
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

	/* `--color-warning` directly on this card's own gradient background (`.card-ticket`'s
	   surface-hover-to-surface fade) clears 4.5:1 in the dark palette but not reliably in
	   light — 4.45:1 against the gradient's `--color-surface-hover` end, just under WCAG
	   AA. Giving it the same warning-tinted background `.freshness-warning` above already
	   uses fixes the pairing for real (that combination is picked together, not against
	   an arbitrary card background) instead of leaving it to whatever this card happens
	   to render on. */
	.no-stay-note {
		margin: 0;
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius-sm);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
		color: var(--color-warning);
		background: var(--color-warning-bg);
	}

	.stats {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-4);
		margin: 0;
	}

	.stat dt {
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}

	.stat dd {
		margin: 0;
		font-size: var(--font-size-lg);
		font-weight: var(--font-weight-semibold);
	}

	.free-time {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		margin: 0;
		padding: var(--space-3);
		background: var(--color-stopover-bg);
		border-radius: var(--radius-md);
	}

	:global(.is-deprioritized) .free-time {
		background: var(--color-bg-inset);
	}

	.free-time-label {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		color: var(--color-stopover);
	}

	:global(.is-deprioritized) .free-time-label {
		color: var(--color-text-deprioritized);
	}

	.free-time-window {
		font-size: var(--font-size-sm);
		color: var(--color-text);
	}

	.airlines {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.why-good {
		margin: 0;
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.variants {
		margin: 0;
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
		color: var(--color-accent);
	}

	.provenance {
		margin: 0;
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}
</style>
