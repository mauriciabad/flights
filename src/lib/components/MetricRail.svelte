<script lang="ts">
	/**
	 * A row of labelled figures about one itinerary: the totals bar under the timeline,
	 * the secondary numbers on a results card. One component, one vocabulary, one set of
	 * labels, driven by `itinerary-metrics.ts` so no caller can invent a third spelling of
	 * "airport waiting time".
	 *
	 * Boarding-pass field treatment: an uppercase caption in the app's mono face over the
	 * number itself, under a hairline, never boxed. That is what the printed field labels
	 * on a real ticket look like, and it is what stops five numbers reading as five cards.
	 *
	 * The hairline sits on top of each cell rather than down its left side, which looks
	 * like a smaller decision than it is: the rail wraps, and a left-hand divider draws
	 * itself down the left margin of whichever cell happens to start the second row. A top
	 * rule is correct at any column count, so a three-up on a phone and a six-up on a
	 * desktop are the same markup with nothing to special-case.
	 */
	import type { Itinerary } from '$lib/domain';
	import { ALL_METRIC_IDS, itineraryMetrics, type ItineraryMetricId } from './itinerary-metrics';

	interface Props {
		itinerary: Itinerary;
		/** Which figures, in which order. Defaults to all of them. */
		ids?: readonly ItineraryMetricId[];
		/** `rail` lays the cells out side by side and wraps; `stack` puts each on its own
		 * line with the value flush right, for a column too narrow to sit them abreast. */
		layout?: 'rail' | 'stack';
		class?: string;
	}

	let { itinerary, ids = ALL_METRIC_IDS, layout = 'rail', class: className }: Props = $props();

	const metrics = $derived(itineraryMetrics(itinerary, ids));
</script>

<dl class={['metric-rail', `metric-rail-${layout}`, className]}>
	{#each metrics as metric (metric.id)}
		<div class={['metric', `metric-${metric.tone}`]}>
			<dt class="metric-label font-mono">{metric.label}</dt>
			<dd class="metric-value font-mono tabular-nums">
				{metric.value}
				{#if metric.note}
					<span class="metric-note">{metric.note}</span>
				{/if}
			</dd>
		</div>
	{/each}
</dl>

<style>
	.metric-rail {
		margin: 0;
	}

	.metric-rail-rail {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(5.5rem, 1fr));
		gap: var(--space-3);
	}

	.metric-rail-rail .metric {
		padding-top: var(--space-2);
		border-top: 1px solid var(--color-border);
	}

	.metric-rail-stack {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.metric-rail-stack .metric {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-3);
	}

	/* `--color-text-muted`, not `--color-text-faint`: app.css records the faint token as
	   checked against `--color-bg` and `--color-surface`, and re-measuring it here put it
	   at 4.19:1 on the dark palette's card surface, under WCAG AA. This is a field label,
	   not decoration, and the totals bar it used to be (`.stat dt`) was muted too. */
	.metric-label {
		font-size: 0.625rem;
		font-weight: var(--font-weight-medium);
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.metric-value {
		margin: 0;
		font-size: var(--font-size-base);
		font-weight: var(--font-weight-semibold);
		line-height: 1.3;
		color: var(--color-text);
	}

	.metric-stopover .metric-value {
		color: var(--color-stopover);
	}

	.metric-primary .metric-value {
		font-size: var(--font-size-lg);
		font-weight: var(--font-weight-bold);
	}

	/* A caveat that is true at the same time as the number, never instead of it (issue
	   #108). Its own line, small and warning-toned, so the figure stays the thing a glance
	   reads while the qualifier is still there for anyone reading closer.

	   The warning-tinted background is not decoration: `--color-warning` on this app's
	   light card surfaces measures 4.45:1, just under WCAG AA, which is the same finding
	   the note this replaces recorded. Against its own tint it is 4.51:1 light and 8.31:1
	   dark, and that pairing holds whatever surface the rail lands on. */
	.metric-note {
		display: inline-block;
		margin-top: 2px;
		padding: 0 var(--space-1);
		border-radius: var(--radius-sm);
		background: var(--color-warning-bg);
		font-family: var(--font-sans);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
		color: var(--color-warning);
	}

	/* `--color-text-deprioritized` is the token AGENTS.md names for an avoided airline, and
	   it is a colour swap rather than an opacity trick for exactly this reason: these
	   numbers still have to be readable. */
	:global(.is-deprioritized) .metric-value {
		color: var(--color-text-deprioritized);
	}
</style>
