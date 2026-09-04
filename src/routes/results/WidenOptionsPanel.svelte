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
	 */
	import { Button } from '$lib/components';
	import { widenOptionKey as keyFor } from '$lib/results/types';
	import type { WidenOption } from '$lib/results/types';

	interface Props {
		options: WidenOption[];
		/** Fires when the traveller commits to spending one option's estimated requests. */
		onWiden: (option: WidenOption) => void;
		/** The option currently in flight, if any, disables just that one button rather
		 * than the whole panel, so widening one candidate doesn't block reading another's
		 * cost while it runs. */
		pendingKey?: string;
	}

	let { options, onWiden, pendingKey }: Props = $props();

	function requestsLabel(option: WidenOption): string {
		return `~${option.requests} request${option.requests === 1 ? '' : 's'}`;
	}

	const calendarOptions = $derived(options.filter((option) => option.tier === 'calendar'));
	const confirmOptions = $derived(options.filter((option) => option.tier === 'confirm'));
</script>

{#if options.length > 0}
	<div class="widen-panel">
		<p class="widen-panel-label" id="widen-panel-label">Widen this search</p>
		<div class="widen-groups" role="group" aria-labelledby="widen-panel-label">
			{#if calendarOptions.length > 0}
				<div class="widen-group">
					<p class="widen-group-title">See a month of prices</p>
					<p class="widen-group-hint">Cheap and broad: which dates are worth confirming.</p>
					{#each calendarOptions as option (keyFor(option))}
						<div class="widen-row">
							<span class="widen-row-label">{option.label}</span>
							<span class="widen-row-cost font-mono tabular-nums">{requestsLabel(option)}</span>
							{#if option.requiresKey}
								<a class="widen-row-fix" href="/settings/">Add a key to use this</a>
							{:else}
								<Button
									size="sm"
									variant="secondary"
									disabled={pendingKey === keyFor(option)}
									onclick={() => onWiden(option)}
								>
									{pendingKey === keyFor(option) ? 'Checking…' : 'Check calendar'}
								</Button>
							{/if}
						</div>
					{/each}
				</div>
			{/if}

			{#if confirmOptions.length > 0}
				<div class="widen-group">
					<p class="widen-group-title">Confirm an exact price</p>
					<p class="widen-group-hint">
						Expensive and narrow: spends a real request to price the date already shown.
					</p>
					{#each confirmOptions as option (keyFor(option))}
						<div class="widen-row">
							<span class="widen-row-label">{option.label}</span>
							<span class="widen-row-cost font-mono tabular-nums">{requestsLabel(option)}</span>
							{#if option.requiresKey}
								<a class="widen-row-fix" href="/settings/">Add a key to use this</a>
							{:else}
								<Button
									size="sm"
									variant="secondary"
									disabled={pendingKey === keyFor(option)}
									onclick={() => onWiden(option)}
								>
									{pendingKey === keyFor(option) ? 'Confirming…' : 'Confirm price'}
								</Button>
							{/if}
						</div>
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
</style>
