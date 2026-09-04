<script lang="ts">
	/**
	 * One cheap week, as a ticket stub, issue #71.
	 *
	 * The stub shape is not decoration for its own sake: the perforated edge separates the
	 * two things this card carries, which are a claim ("leave this week and the flights
	 * cost this") and the evidence for it (which days it was chosen from, which sources
	 * priced it, how old those prices are). Every travel product buries the second half.
	 * Here it is the whole reason the card is allowed to exist, because a ranking built
	 * from two lucky days is not the same answer as one built from six.
	 *
	 * The action is a real search. Pressing it navigates to `/results/` with the exact date
	 * pair pinned and the stopover named, which is #182's rule applied here: picking a week
	 * IS running that search, not a detour to a screen that then asks you to run one.
	 */
	import { Button } from '$lib/components';
	import type { IsoCurrencyCode } from '$lib/domain';
	import { dayLabel } from '$lib/flexible-dates';
	import type { RankedWeek } from '$lib/flexible-dates';
	import { formatAge, formatMoney } from '$lib/format';

	interface Props {
		week: RankedWeek;
		/** Airport codes, so a stub reads as a route without needing the page's header. */
		originAirport: string;
		stopoverAirport: string;
		destinationAirport: string;
		/** The stopover's city name when the dataset has resolved it, the bare code
		 * otherwise. Never a placeholder. */
		stopoverName: string;
		currency: IsoCurrencyCode;
		/** Adapter id to human label, so a stub says "Ryanair" rather than "ryanair". */
		providerLabels: Record<string, string>;
		/** `Date.now()` at render, passed in rather than read here so the whole page agrees
		 * on one clock and a test can pin it. */
		now: number;
		/** Marks the single cheapest week on the page. */
		leading?: boolean;
		onsearch: (week: RankedWeek) => void;
	}

	let {
		week,
		originAirport,
		stopoverAirport,
		destinationAirport,
		stopoverName,
		currency,
		providerLabels,
		now,
		leading = false,
		onsearch
	}: Props = $props();

	const label = (providerId: string): string => providerLabels[providerId] ?? providerId;

	const total = $derived(formatMoney({ minorUnits: week.best.totalMinorUnits, currency }));
	const nightWord = $derived(week.best.nights === 1 ? 'night' : 'nights');
</script>

<article class={['stub', { 'is-leading': leading }]}>
	<header class="stub-head">
		<p class="stub-week font-mono">
			{dayLabel(week.weekStart)} to {dayLabel(week.weekEnd)}
		</p>
		<p class="stub-total font-mono tabular-nums">{total}</p>
	</header>

	<p class="stub-stay">
		<span class="nights font-mono">{week.best.nights}</span>
		{nightWord} in {stopoverName}
	</p>

	<div class="perforation" aria-hidden="true"></div>

	<dl class="legs">
		<div class="leg">
			<dt class="font-mono">{originAirport} to {stopoverAirport}</dt>
			<dd>
				<span class="font-mono">{dayLabel(week.best.outbound.departureDate)}</span>
				<span class="font-mono tabular-nums leg-price"
					>{formatMoney({ minorUnits: week.best.outbound.minorUnits, currency })}</span
				>
				<span class="leg-source"
					>{label(week.best.outbound.providerId)}, {formatAge(now - week.best.outbound.observedAt)}</span
				>
			</dd>
		</div>
		<div class="leg">
			<dt class="font-mono">{stopoverAirport} to {destinationAirport}</dt>
			<dd>
				<span class="font-mono">{dayLabel(week.best.onward.departureDate)}</span>
				<span class="font-mono tabular-nums leg-price"
					>{formatMoney({ minorUnits: week.best.onward.minorUnits, currency })}</span
				>
				<span class="leg-source"
					>{label(week.best.onward.providerId)}, {formatAge(now - week.best.onward.observedAt)}</span
				>
			</dd>
		</div>
	</dl>

	<p class="evidence">
		Cheapest of {week.pricedDepartures}
		{week.pricedDepartures === 1 ? 'priced departure' : 'priced departures'} this week. One adult, flights
		only.
	</p>

	<Button variant={leading ? 'primary' : 'secondary'} fullWidth onclick={() => onsearch(week)}>
		Search these dates
	</Button>
</article>

<style>
	.stub {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: var(--space-4);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-surface);
	}

	.stub.is-leading {
		border-color: var(--color-accent);
		box-shadow: var(--shadow-accent);
	}

	.stub-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.stub-week {
		margin: 0;
		font-size: var(--font-size-sm);
		line-height: var(--line-height-sm);
		color: var(--color-text-muted);
	}

	.stub-total {
		margin: 0;
		font-size: var(--font-size-2xl);
		line-height: var(--line-height-2xl);
		font-weight: var(--font-weight-bold);
		letter-spacing: var(--tracking-tight);
	}

	.stub-stay {
		margin: 0;
		font-size: var(--font-size-sm);
		line-height: var(--line-height-sm);
		color: var(--color-stopover);
	}

	/* The one colour reserved for the free city in the middle, per app.css. */
	.nights {
		padding: 0 var(--space-2);
		border-radius: var(--radius-full);
		background: var(--color-stopover-bg);
		font-weight: var(--font-weight-bold);
	}

	/* The tear line of a ticket stub: the claim is above it, the evidence below. */
	.perforation {
		height: 1px;
		background: repeating-linear-gradient(
			90deg,
			var(--color-border-strong) 0 4px,
			transparent 4px 9px
		);
	}

	.legs {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin: 0;
	}

	.leg dt {
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-faint);
	}

	.leg dd {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-1) var(--space-3);
		margin: 0;
		font-size: var(--font-size-sm);
		line-height: var(--line-height-sm);
	}

	.leg-price {
		font-weight: var(--font-weight-semibold);
	}

	.leg-source {
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-muted);
	}

	.evidence {
		margin: 0;
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-muted);
		text-wrap: pretty;
	}
</style>
