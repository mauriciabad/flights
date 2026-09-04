<script lang="ts">
	/**
	 * Issue #23: "Some providers will be missing, out of quota, or down. That is the
	 * normal case, not an error page." One plate per provider this search actually
	 * touched (`SearchSnapshot.providers`), expanding to the full reason and a fix on
	 * click. A provider this search never called at all (every metered one, until the
	 * traveller widens) is `WidenOptionsPanel`'s concern, not this one's, showing it
	 * here as "unavailable" would misreport "never asked" as "asked and failed."
	 *
	 * Issue #130 split what used to be one state in two. Ryanair `404`s its routes endpoint
	 * for an airport it does not serve, which its adapter correctly treats as an ok, empty
	 * answer — so on BVC to PFO this strip had a provider that had answered twice and no way
	 * to say so, and rendered "Nothing has answered yet" instead. "Answered with nothing" and
	 * "never answered" are different facts about a search, and a traveller deciding whether
	 * to paste in a key needs to tell them apart. `providerAnswer` (`$lib/search`) is the
	 * one place that reading is derived; this component only renders it.
	 *
	 * Each plate is a split-flap cell from the departure board `app.css` describes, the same
	 * shape `NoResultsBoard.svelte` uses for the same information at full size: provider
	 * name, then its verdict on an inset flap, then what it cost. A row of identical grey
	 * pills could not carry the distinction this issue is about.
	 */
	import { ErrorState } from '$lib/components';
	import { providerAnswer } from '$lib/search';
	import type { ProviderAnswer } from '$lib/search';
	import { describeProviderError } from '$lib/results/types';
	import type { ProviderStatus } from '$lib/results/types';
	import { formatAge } from '$lib/results/format';

	interface Props {
		statuses: ProviderStatus[];
		/** True while any search stream is still running, so an empty strip can say which of
		 * "not yet" and "not at all" is true rather than always claiming the first. */
		searching?: boolean;
	}

	let { statuses, searching = false }: Props = $props();

	let expandedId = $state<string | undefined>(undefined);

	function toggle(providerId: string) {
		expandedId = expandedId === providerId ? undefined : providerId;
	}

	const FLAP_TEXT: Record<ProviderAnswer, string> = {
		answered: 'answered',
		'nothing-found': 'nothing found',
		failed: 'failed',
		'not-asked': 'not asked'
	};

	const rows = $derived(
		statuses.map((status) => ({
			status,
			answer: providerAnswer(status),
			error: status.lastError ? describeProviderError(status.lastError) : undefined
		}))
	);

	const expanded = $derived(rows.find((row) => row.status.providerId === expandedId));
</script>

<div class="provider-strip">
	<p class="provider-strip-label" id="provider-strip-label">Providers asked</p>
	<div class="scroll-x provider-row" role="group" aria-labelledby="provider-strip-label">
		{#each rows as row (row.status.providerId)}
			{#if row.answer === 'failed'}
				<button
					type="button"
					class="provider-plate is-interactive"
					data-testid="provider-status"
					data-provider={row.status.providerId}
					data-answer={row.answer}
					aria-expanded={expandedId === row.status.providerId}
					onclick={() => toggle(row.status.providerId)}
				>
					<span class="plate-name">{row.status.label}</span>
					<span class="plate-flap">{FLAP_TEXT[row.answer]}</span>
					<span class="plate-cost font-mono tabular-nums">
						{row.status.requestsUsed}<span class="plate-cost-unit"
							>&nbsp;{row.status.requestsUsed === 1 ? 'req' : 'reqs'}</span
						>
					</span>
				</button>
			{:else}
				<span
					class="provider-plate"
					data-testid="provider-status"
					data-provider={row.status.providerId}
					data-answer={row.answer}
				>
					<span class="plate-name">{row.status.label}</span>
					<span class="plate-flap">{FLAP_TEXT[row.answer]}</span>
					<span class="plate-cost font-mono tabular-nums">
						{row.status.requestsUsed}<span class="plate-cost-unit"
							>&nbsp;{row.status.requestsUsed === 1 ? 'req' : 'reqs'}</span
						>
					</span>
				</span>
			{/if}
		{/each}
		{#if rows.length === 0}
			<p class="provider-empty" data-testid="provider-strip-empty">
				{searching ? 'Waiting for the first answer.' : 'No provider was called for this search.'}
			</p>
		{/if}
	</div>

	{#if expanded?.error}
		<ErrorState
			title={`${expanded.status.label} is not contributing results`}
			message={expanded.error.message}
			reason={expanded.error.reason}
			provider={expanded.status.label}
			severity="warning"
		>
			{#snippet action()}
				<a class="settings-link" href="/settings/">Open settings to fix this</a>
			{/snippet}
		</ErrorState>
		{#if expanded.status.lastFetchedAt}
			<p class="last-success">
				Last answered {formatAge(Date.now() - new Date(expanded.status.lastFetchedAt).getTime())}.
			</p>
		{/if}
	{/if}
</div>

<style>
	.provider-strip {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.provider-strip-label {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-faint);
	}

	.provider-row {
		display: flex;
		align-items: stretch;
		gap: var(--space-2);
		padding-bottom: var(--space-1);
	}

	/* One departure-board cell: the provider's name, its verdict on a flap, and what it
	   spent. The left border is the only colour-coded part, and it is never the only signal
	   — the flap always spells the verdict out. */
	.provider-plate {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		flex-shrink: 0;
		/* 44px minimum touch target for the interactive variant, and the same height for the
		   static ones so the row does not step up and down. */
		min-height: 2.75rem;
		padding: var(--space-1) var(--space-3);
		border: 1px solid var(--color-border);
		border-left: 3px solid var(--color-text-faint);
		border-radius: var(--radius-md);
		background: var(--color-surface);
		color: var(--color-text);
		font-size: var(--font-size-sm);
		text-align: left;
	}

	.provider-plate.is-interactive {
		cursor: pointer;
		transition:
			background-color var(--transition-fast),
			border-color var(--transition-fast);
	}

	.provider-plate.is-interactive:hover {
		background: var(--color-surface-hover);
	}

	.provider-plate.is-interactive:active {
		transform: translateY(1px);
	}

	.provider-plate[data-answer='answered'] {
		border-left-color: var(--color-success);
	}

	.provider-plate[data-answer='nothing-found'] {
		border-left-color: var(--color-info);
	}

	.provider-plate[data-answer='failed'] {
		border-left-color: var(--color-warning);
	}

	.plate-name {
		max-width: 12rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: var(--font-weight-medium);
	}

	/* The split-flap plate, seam and all — see NoResultsBoard.svelte, which uses the same
	   treatment for the full-size version of this row. */
	.plate-flap {
		position: relative;
		padding: 0.1rem var(--space-2);
		border-radius: var(--radius-sm);
		background: var(--color-bg-inset);
		font-family: var(--font-mono);
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		white-space: nowrap;
		color: var(--color-text-muted);
	}

	.plate-flap::after {
		content: '';
		position: absolute;
		inset: 50% 0 auto 0;
		height: 1px;
		background: var(--color-border);
	}

	.provider-plate[data-answer='answered'] .plate-flap {
		color: var(--color-success);
	}

	.provider-plate[data-answer='nothing-found'] .plate-flap {
		color: var(--color-info);
	}

	.provider-plate[data-answer='failed'] .plate-flap {
		color: var(--color-warning);
	}

	.plate-cost {
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
		white-space: nowrap;
	}

	.plate-cost-unit {
		font-family: var(--font-sans);
	}

	.provider-empty {
		font-size: var(--font-size-sm);
		color: var(--color-text-faint);
	}

	.settings-link {
		font-weight: var(--font-weight-semibold);
	}

	.last-success {
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}
</style>
