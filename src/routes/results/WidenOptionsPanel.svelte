<script lang="ts">
	/**
	 * "The caller can ask what widening would cost, in requests, and choose" (issue #56's
	 * own brief, echoed for this list). `SearchSnapshot.widenOptions` is computed with NO
	 * network call, so this panel can always be shown, even before any key is configured.
	 *
	 * Calendar and confirm are genuinely different actions, not two strengths of the same
	 * "search harder" button. A calendar widen answers "which dates are cheap" across a whole
	 * year; a confirm widen prices the exact dates already on screen. Since issue #244 they
	 * often cost the same, so the copy on each group has to say what it buys rather than
	 * leaning on the price to tell them apart.
	 *
	 * Issue #96: `SearchSnapshot.widenOptions` carries one entry per connection candidate,
	 * so a search considering five stopovers listed the same provider five times, with
	 * nothing on screen saying which city each row belonged to. `groupWidenOptions`
	 * (`$lib/results/types`) folds those into one row per provider, summing the cost across
	 * every candidate it covers, since a traveller decides on a provider and a tier, not on
	 * an unlabelled city they can't tell apart.
	 *
	 * Issue #244: that fold used to be all-or-nothing. Five stopovers summed to 55 requests
	 * against Sky Scrapper's 15-request cap, the row rendered permanently disabled, and no
	 * reachable action in the app ever spent a Skyscanner request. A row is now offered at
	 * whatever size the month can pay for, and only disappears when it cannot pay for one
	 * stopover.
	 */
	import { Button } from '$lib/components';
	import { getProviderQuotaSnapshot } from '$lib/providers/budget';
	import { affordableWidenOptions, groupWidenOptions, widenOptionGroupKey } from '$lib/results/types';
	import type { AffordableWiden, WidenOption, WidenOptionGroup } from '$lib/results/types';

	interface Props {
		options: WidenOption[];
		/** Fires when the traveller commits to spending one group's combined cost, across
		 * every candidate it covers — or, when the month cannot pay for all of them, across
		 * the `affordable.options` prefix the row offered instead. */
		onWiden: (option: WidenOptionGroup, affordable: AffordableWiden) => void;
		/** The group currently in flight, if any, disables just that one button rather than
		 * the whole panel, so widening one provider doesn't block reading another's cost
		 * while it runs. */
		pendingKey?: string;
	}

	let { options, onWiden, pendingKey }: Props = $props();

	function requestsLabel(group: WidenOptionGroup, affordable: AffordableWiden): string {
		const count = affordable.options.length;
		const base = `~${affordable.requests} request${affordable.requests === 1 ? '' : 's'}`;
		// Honest about the number being a sum, not one candidate's cost (issue #96: "if the
		// number is an aggregate across candidates while the label reads as one action,
		// make the label honest"). Only said out loud when there is more than one
		// candidate behind it, since for exactly one it already reads as a single action.
		if (count <= 1) return base;
		// Issue #244: when the month cannot pay for every stopover the row still runs, on
		// as many as it can, so the count has to name what is really being bought.
		if (affordable.skipped > 0) return `${base} across ${count} of ${group.options.length} stopovers`;
		return `${base} across ${count} stopovers`;
	}

	/**
	 * How much of one row this month can pay for. Never more (issue #96: a widen priced
	 * above the remaining allowance cannot complete, so offering it at that price means
	 * failing partway through), and never all-or-nothing either (issue #244: a row covering
	 * five stopovers used to vanish entirely because the five together were over the cap,
	 * which is how a configured Sky Scrapper key ended up unreachable from every search).
	 * Reads `getProviderQuotaSnapshot` fresh on every call rather than caching it, since the
	 * real remaining budget changes the moment any widen actually spends, in this panel or
	 * another tab open on the same search.
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
	function affordable(group: WidenOptionGroup): AffordableWiden {
		// `requiresKey` rows quote what widening WOULD cost once a key exists, so they are
		// priced against the whole group rather than against a quota nothing is spending
		// yet — "Add a key to use this" below is what they render instead of a button.
		if (group.requiresKey) return { options: group.options, requests: group.requests, skipped: 0 };
		return affordableWidenOptions(group, getProviderQuotaSnapshot(group.providerId).remaining);
	}

	/** Said only when the month cannot buy even one stopover in the row. Anything above that
	 * is offered at its real, smaller size instead of being taken away. Quotes the first
	 * stopover's cost rather than the row's total, since the total is no longer what pressing
	 * the row would spend. */
	function nothingAffordableReason(group: WidenOptionGroup): string {
		const { remaining } = getProviderQuotaSnapshot(group.providerId);
		const one = group.options[0]?.requests ?? group.requests;
		return `Only ${remaining} request${remaining === 1 ? '' : 's'} left this month for ${group.label}. One stopover needs ${one}.`;
	}

	const calendarOptions = $derived(
		groupWidenOptions(options.filter((option) => option.tier === 'calendar'))
	);
	const confirmOptions = $derived(
		groupWidenOptions(options.filter((option) => option.tier === 'confirm'))
	);
</script>

{#snippet widenRow(group: WidenOptionGroup, pendingLabel: string, actionLabel: string)}
	{@const key = widenOptionGroupKey(group)}
	{@const fits = affordable(group)}
	<div class="widen-row">
		<span class="widen-row-label">{group.label}</span>
		<span class="widen-row-cost font-mono tabular-nums">{requestsLabel(group, fits)}</span>
		{#if group.requiresKey}
			<a class="widen-row-fix" href="/settings/">Add a key to use this</a>
		{:else if fits.options.length === 0}
			<span class="widen-row-unavailable">{nothingAffordableReason(group)}</span>
		{:else}
			<Button
				size="sm"
				variant="secondary"
				disabled={pendingKey === key}
				onclick={() => onWiden(group, fits)}
			>
				{pendingKey === key ? pendingLabel : actionLabel}
			</Button>
			{#if fits.skipped > 0}
				<span class="widen-row-partial">
					{fits.skipped} more {fits.skipped === 1 ? 'stopover needs' : 'stopovers need'} requests this
					month has not got.
				</span>
			{/if}
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
						Narrow and exact: spends one request per leg to price the dates already shown.
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

	/* Quieter than `.widen-row-unavailable`: the action next to it still runs, and this only
	   says how far the month's allowance reaches. It takes the whole width so the sentence
	   sits under its own row rather than wrapping between the cost and the button. */
	.widen-row-partial {
		flex: 1 0 100%;
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}
</style>
