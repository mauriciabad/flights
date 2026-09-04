<script lang="ts">
	/**
	 * "The caller can ask what widening would cost, in requests, and choose" (issue #56's
	 * own brief, echoed for this list). `SearchSnapshot.widenOptions` is computed with NO
	 * network call, so this panel can always be shown, even before any key is configured.
	 *
	 * Calendar and confirm are genuinely different actions, not two strengths of the same
	 * "search harder" button: a calendar widen answers "which dates are cheap" for close to
	 * free, a confirm widen spends a real, metered request to price one exact date. Grouping
	 * them separately, with their own copy, is what keeps a traveller from reaching for the
	 * expensive one out of habit when the cheap one already answers their question.
	 *
	 * Issue #96: `SearchSnapshot.widenOptions` carries one entry per connection candidate,
	 * so a search considering five stopovers listed the same provider five times, with
	 * nothing on screen saying which city each row belonged to. `groupWidenOptions`
	 * (`$lib/results/types`) folds those into one row per provider, summing the cost across
	 * every candidate it covers, since a traveller decides on a provider and a tier, not on
	 * an unlabelled city they can't tell apart.
	 */
	import { Button } from '$lib/components';
	import { getProviderQuotaSnapshot } from '$lib/providers/budget';
	import { groupWidenOptions, widenOptionGroupKey } from '$lib/results/types';
	import type { WidenOption, WidenOptionGroup } from '$lib/results/types';

	interface Props {
		options: WidenOption[];
		/** Fires when the traveller commits to spending one group's combined cost, across
		 * every candidate it covers. */
		onWiden: (option: WidenOptionGroup) => void;
		/** The group currently in flight, if any, disables just that one button rather than
		 * the whole panel, so widening one provider doesn't block reading another's cost
		 * while it runs. */
		pendingKey?: string;
	}

	let { options, onWiden, pendingKey }: Props = $props();

	function requestsLabel(option: WidenOptionGroup): string {
		const base = `~${option.requests} request${option.requests === 1 ? '' : 's'}`;
		// Honest about the number being a sum, not one candidate's cost (issue #96: "if the
		// number is an aggregate across candidates while the label reads as one action,
		// make the label honest"). Only said out loud when there is more than one
		// candidate behind it, since for exactly one it already reads as a single action.
		return option.options.length > 1 ? `${base} across ${option.options.length} stopovers` : base;
	}

	/**
	 * Never offer a widen priced above what is actually left this month (issue #96): a row
	 * quoting 40 requests against a 15-request cap cannot complete, so it renders disabled
	 * with the reason instead of failing partway through, the same treatment `requiresKey`
	 * already gets below. Reads `getProviderQuotaSnapshot` fresh on every call rather than
	 * caching it, since the real remaining budget changes the moment any widen actually
	 * spends, in this panel or another tab open on the same search.
	 *
	 * Deliberately not `isQuotaGenerous` (`$lib/providers/budget`, issue #94): that answers
	 * "is this provider's cap generous enough, relative to a typical cost, to spend the
	 * moment a key exists with no further opt-in", which is how `resources.ts` decides a
	 * stay provider can run inside the free tier without ever becoming a `WidenOption` at
	 * all. Every row this panel renders is the opposite case by construction, a metered
	 * FLIGHT cost `pipeline.ts` already decided needs an explicit ask (`estimateSearchOffersCost`/
	 * `estimatePriceCalendarWidenCost` are non-zero, or `confirmWidenOptions`/
	 * `calendarWidenOptions` would not have produced an option here at all). So the only
	 * question left is the literal one the issue asks: does the quoted cost fit what is
	 * actually left this month. Verified against a live search: Flights Sky's calendar row
	 * (10 requests against its 40-request cap) scores `isQuotaGenerous` false (40 / 10 = 4,
	 * under the 20 the function requires) yet plainly fits its own cap and must stay
	 * offered, exactly what `remaining` alone gets right and a generosity ratio would have
	 * wrongly blocked.
	 */
	function overBudgetReason(option: WidenOptionGroup): string | undefined {
		if (option.requiresKey) return undefined; // "Add a key" below already covers this case.
		const { remaining } = getProviderQuotaSnapshot(option.providerId);
		if (option.requests <= remaining) return undefined;
		return `Only ${remaining} request${remaining === 1 ? '' : 's'} left this month for ${option.label}. This needs ${option.requests}.`;
	}

	const calendarOptions = $derived(
		groupWidenOptions(options.filter((option) => option.tier === 'calendar'))
	);
	const confirmOptions = $derived(
		groupWidenOptions(options.filter((option) => option.tier === 'confirm'))
	);
</script>

{#snippet widenRow(option: WidenOptionGroup, pendingLabel: string, actionLabel: string)}
	{@const key = widenOptionGroupKey(option)}
	{@const reason = overBudgetReason(option)}
	<div class="widen-row">
		<span class="widen-row-label">{option.label}</span>
		<span class="widen-row-cost font-mono tabular-nums">{requestsLabel(option)}</span>
		{#if option.requiresKey}
			<a class="widen-row-fix" href="/settings/">Add a key to use this</a>
		{:else if reason}
			<span class="widen-row-unavailable">{reason}</span>
		{:else}
			<Button
				size="sm"
				variant="secondary"
				disabled={pendingKey === key}
				onclick={() => onWiden(option)}
			>
				{pendingKey === key ? pendingLabel : actionLabel}
			</Button>
		{/if}
	</div>
{/snippet}

{#if options.length > 0}
	<div class="widen-panel">
		<p class="widen-panel-label" id="widen-panel-label">Widen this search</p>
		<div class="widen-groups" role="group" aria-labelledby="widen-panel-label">
			{#if calendarOptions.length > 0}
				<div class="widen-group">
					<p class="widen-group-title">See a month of prices</p>
					<p class="widen-group-hint">Cheap and broad: which dates are worth confirming.</p>
					{#each calendarOptions as option (widenOptionGroupKey(option))}
						{@render widenRow(option, 'Checking…', 'Check calendar')}
					{/each}
				</div>
			{/if}

			{#if confirmOptions.length > 0}
				<div class="widen-group">
					<p class="widen-group-title">Confirm an exact price</p>
					<p class="widen-group-hint">
						Expensive and narrow: spends a real request to price the date already shown.
					</p>
					{#each confirmOptions as option (widenOptionGroupKey(option))}
						{@render widenRow(option, 'Confirming…', 'Confirm price')}
					{/each}
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.widen-panel {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: var(--space-4);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-bg-inset);
	}

	.widen-panel-label {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-faint);
	}

	.widen-groups {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.widen-group-title {
		font-weight: var(--font-weight-semibold);
	}

	.widen-group-hint {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
		margin-bottom: var(--space-2);
	}

	.widen-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-3);
		padding: var(--space-2) 0;
	}

	.widen-row-label {
		flex: 1 1 auto;
		min-width: 8rem;
	}

	.widen-row-cost {
		color: var(--color-text-muted);
		font-size: var(--font-size-sm);
	}

	.widen-row-fix {
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
	}

	.widen-row-unavailable {
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		color: var(--color-warning);
	}
</style>
