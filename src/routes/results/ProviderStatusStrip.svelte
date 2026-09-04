<script lang="ts">
	/**
	 * Issue #23: "Some providers will be missing, out of quota, or down. That is the
	 * normal case, not an error page." One pill per provider this search actually
	 * touched (`SearchSnapshot.providers`), expanding to the full reason and a fix on
	 * click. A provider this search never called at all (every metered one, until the
	 * traveller widens) is `WidenOptionsPanel`'s concern, not this one's, showing it
	 * here as "unavailable" would misreport "never asked" as "asked and failed."
	 *
	 * Chip's own `interactive`/`selected` toggle is deliberately NOT used here: clicking
	 * one pill has to collapse whichever other pill was open, and Chip only knows about
	 * its own click, not a sibling's, so this component owns `expandedId` itself and
	 * wraps a plain (non-interactive) Chip in its own button for the pill's look without
	 * inheriting a self-managed state that could desync across pills.
	 */
	import { Chip, ErrorState } from '$lib/components';
	import { describeProviderError } from '$lib/results/types';
	import type { ProviderStatus } from '$lib/results/types';
	import { formatAge } from '$lib/results/format';

	interface Props {
		statuses: ProviderStatus[];
	}

	let { statuses }: Props = $props();

	let expandedId = $state<string | undefined>(undefined);

	function toggle(providerId: string) {
		expandedId = expandedId === providerId ? undefined : providerId;
	}

	function variantFor(status: ProviderStatus): 'success' | 'warning' {
		return status.lastError ? 'warning' : 'success';
	}

	function summaryFor(status: ProviderStatus): string {
		if (status.lastError) return `${status.label}: unavailable`;
		const requests = status.requestsUsed;
		return `${status.label}: answered${requests > 0 ? ` (${requests} request${requests === 1 ? '' : 's'})` : ''}`;
	}

	const expanded = $derived(statuses.find((status) => status.providerId === expandedId));
	const expandedError = $derived(expanded?.lastError ? describeProviderError(expanded.lastError) : undefined);
</script>

<div class="provider-strip">
	<p class="provider-strip-label" id="provider-strip-label">Providers that answered</p>
	<div class="scroll-x provider-row" role="group" aria-labelledby="provider-strip-label">
		{#each statuses as status (status.providerId)}
			{#if status.lastError}
				<button
					type="button"
					class="provider-button"
					aria-expanded={expandedId === status.providerId}
					onclick={() => toggle(status.providerId)}
				>
					<Chip variant={variantFor(status)} label={summaryFor(status)} />
				</button>
			{:else}
				<Chip variant={variantFor(status)} label={summaryFor(status)} />
			{/if}
		{/each}
		{#if statuses.length === 0}
			<p class="provider-empty">Nothing has answered yet.</p>
		{/if}
	</div>

	{#if expanded?.lastError && expandedError}
		<ErrorState
			title={`${expanded.label} is not contributing results`}
			message={expandedError.message}
			reason={expandedError.reason}
			provider={expanded.label}
			severity="warning"
		>
			{#snippet action()}
				<a class="settings-link" href="/settings/">Open settings to fix this</a>
			{/snippet}
		</ErrorState>
		{#if expanded.lastFetchedAt}
			<p class="last-success">
				Last answered {formatAge(Date.now() - new Date(expanded.lastFetchedAt).getTime())}.
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
		align-items: center;
		gap: var(--space-2);
		padding-bottom: var(--space-1);
	}

	.provider-button {
		flex-shrink: 0;
		border-radius: var(--radius-full);
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
