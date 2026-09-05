<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		description?: string;
		icon?: Snippet;
		/** Usually a Button — "broaden your dates", "add an airport". */
		action?: Snippet;
		/** Issue #203: what a provider actually said, verbatim, below our own sentence and
		 * the fix for it rather than instead of them. `ErrorState` keeps the same order and
		 * the same dashed rule for the same reason: our classification is an addition on top
		 * of the evidence, never a replacement for it (AGENTS.md). */
		evidence?: Snippet;
		class?: string;
	}

	let { title, description, icon, action, evidence, class: className }: Props = $props();
</script>

<!-- role="status": announces once when a filtered list becomes empty,
     without the assertive interruption ErrorState uses for hard failures. -->
<div class={['empty-state', className]} role="status">
	<div class="empty-state-icon" aria-hidden="true">
		{#if icon}
			{@render icon()}
		{:else}
			<!-- A boarding-pass stub: nothing has been issued yet. -->
			<svg viewBox="0 0 24 24" fill="none">
				<path
					d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linejoin="round"
				/>
				<path
					d="M13 5v2M13 17v2M13 11v2"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linecap="round"
				/>
			</svg>
		{/if}
	</div>
	<p class="empty-state-title">{title}</p>
	{#if description}
		<p class="empty-state-description">{description}</p>
	{/if}
	{#if action}
		<div class="empty-state-action">{@render action()}</div>
	{/if}
	{#if evidence}
		<div class="empty-state-evidence">{@render evidence()}</div>
	{/if}
</div>

<style>
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		gap: var(--space-2);
		padding: var(--space-8) var(--space-5);
		color: var(--color-text-muted);
	}

	.empty-state-icon {
		width: 3rem;
		height: 3rem;
		margin-bottom: var(--space-2);
		color: var(--color-text-faint);
	}

	.empty-state-icon svg {
		width: 100%;
		height: 100%;
	}

	.empty-state-title {
		font-size: var(--font-size-lg);
		font-weight: var(--font-weight-semibold);
		color: var(--color-text);
	}

	.empty-state-description {
		max-width: 32rem;
		font-size: var(--font-size-sm);
	}

	.empty-state-action {
		margin-top: var(--space-3);
	}

	.empty-state-evidence {
		max-width: 32rem;
		margin-top: var(--space-3);
		padding-top: var(--space-3);
		border-top: 1px dashed var(--color-border);
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
		overflow-wrap: anywhere;
	}
</style>
