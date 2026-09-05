<script lang="ts">
	/**
	 * One leg's days over the search window: which fly, which do not, and which nobody has
	 * looked at (issue #324).
	 *
	 * The owner asked for "calendar with days that have flights and days that dont". The
	 * third state is the one that keeps this honest. Every square here is a read of
	 * `$lib/flexible-dates`'s cache at zero requests, and most of a year is usually unknown,
	 * so drawing unknown the same as "no flight" would turn "we have not asked" into "nothing
	 * flies". `/results/when/` holds the same line about the same data.
	 *
	 * ## Not a chart
	 *
	 * A row of squares, one per day, in date order, under two lines of text. The squares are
	 * decoration for readers who can see them, which is why the row is `aria-hidden` and each
	 * square carries only a `title`. A grid of thirty focusable cells inside a dialog that
	 * already has a list of stopovers to tab through would bury the useful controls.
	 *
	 * Nothing lives in a `title` alone. A `title` does not open on touch at all, so a phone
	 * would lose whatever only lived there. The counts and the cheapest day both appear as
	 * text, and the per-day `title` is a pointer convenience on top of that, never the only
	 * copy of a fact.
	 */
	import { formatMoney } from '$lib/format';
	import type { LegCalendar } from './calendar';

	interface Props {
		calendar: LegCalendar;
		/** "Out" or "On", so two strips under one heading say which leg each is. */
		label: string;
	}

	let { calendar, label }: Props = $props();

	const summary = $derived(summarise(calendar));

	/** The cheapest day anybody has seen on this leg, as text. Everything else the squares
	 * carry is a count, which the summary states; this is the one per-day fact worth
	 * reaching on a phone, where a `title` never opens. */
	const cheapest = $derived.by(() => {
		let best: { date: string; minorUnits: number } | undefined;
		for (const day of calendar.days) {
			if (day.state !== 'priced' || day.minorUnits === undefined) continue;
			if (!best || day.minorUnits < best.minorUnits) best = { date: day.date, minorUnits: day.minorUnits };
		}
		return best;
	});

	function summarise(leg: LegCalendar): string {
		const parts: string[] = [];
		if (leg.priced > 0) parts.push(`${leg.priced} with a fare`);
		if (leg.blank > 0) parts.push(`${leg.blank} with none`);
		if (leg.unknown > 0) parts.push(`${leg.unknown} not looked at`);
		if (parts.length === 0) return 'No days in this window.';
		return parts.join(', ');
	}

	function dayTitle(day: LegCalendar['days'][number]): string {
		if (day.state === 'priced') {
			const price =
				day.minorUnits === undefined
					? ''
					: `, from ${formatMoney({ minorUnits: day.minorUnits, currency: calendar.currency })}`;
			return `${day.date}: a fare was seen${price}`;
		}
		if (day.state === 'blank') {
			return day.reason === 'sold-out'
				? `${day.date}: a source reported it sold out`
				: `${day.date}: a source reported no service`;
		}
		return `${day.date}: nobody has looked`;
	}
</script>

<div class="strip">
	<p class="strip-head">
		<span class="strip-label font-mono">{label}</span>
		<span class="strip-route font-mono">{calendar.origin}&nbsp;&rarr;&nbsp;{calendar.destination}</span>
		<span class="strip-summary">{summary}</span>
	</p>
	{#if cheapest}
		<p class="strip-cheapest">
			Cheapest seen
			<span class="font-mono tabular-nums"
				>{formatMoney({ minorUnits: cheapest.minorUnits, currency: calendar.currency })}</span
			>
			on <span class="font-mono tabular-nums">{cheapest.date}</span>
		</p>
	{/if}
	<div class="strip-days" aria-hidden="true">
		{#each calendar.days as day (day.date)}
			<span class={['strip-day', `is-${day.state}`]} title={dayTitle(day)}></span>
		{/each}
	</div>
</div>

<style>
	.strip {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.strip-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0 var(--space-2);
		margin: 0;
		font-size: var(--font-size-xs);
		line-height: 1.4;
		color: var(--color-text-muted);
	}

	.strip-label {
		font-size: 0.625rem;
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-faint);
	}

	.strip-route {
		color: var(--color-text);
		font-weight: var(--font-weight-medium);
	}

	.strip-summary {
		font-variant-numeric: tabular-nums;
	}

	.strip-cheapest {
		margin: 0;
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-muted);
	}

	/* Squares shrink to fit rather than wrapping. A window is a few weeks to a few months,
	   and a strip that wrapped to three rows would read as three legs. */
	.strip-days {
		display: flex;
		gap: 1px;
	}

	.strip-day {
		flex: 1 1 0;
		min-width: 2px;
		height: 0.75rem;
		border-radius: 1px;
	}

	.strip-day.is-priced {
		background: var(--color-stopover);
	}

	/* A day a source called empty is drawn, not left out: it is a fact somebody reported.
	   Darker than the unknown hatch, and both are distinguishable in greyscale. */
	.strip-day.is-blank {
		background: var(--color-border-strong);
	}

	/* Nobody looked. Faintest of the three, and hatched rather than flat, so a reader can
	   tell "no answer" from "answered, nothing" without reading the tooltip. */
	.strip-day.is-unknown {
		background: repeating-linear-gradient(
			45deg,
			var(--color-bg-inset),
			var(--color-bg-inset) 2px,
			var(--color-border) 2px,
			var(--color-border) 3px
		);
	}
</style>
