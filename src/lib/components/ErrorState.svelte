<script module lang="ts">
	/**
	 * Shared vocabulary for "why a provider failed", so a RapidAPI 403 reads
	 * the same way in the results list and settings instead of every feature
	 * writing its own copy. Provider adapters (#2) can
	 * import `ProviderIssueReason` and hand a value straight to this
	 * component's `reason` prop.
	 */
	export type ProviderIssueReason =
		| 'missing-key'
		| 'invalid-key'
		| 'quota-exceeded'
		| 'not-subscribed'
		| 'rate-limited'
		| 'down'
		| 'unknown';

	export const PROVIDER_ISSUE_COPY: Record<ProviderIssueReason, string> = {
		'missing-key': 'No API key saved for this provider yet.',
		'invalid-key': 'The saved API key was rejected.',
		'quota-exceeded': "This provider's free-tier quota is used up for now.",
		'not-subscribed': 'The key exists but is not subscribed to this API on RapidAPI.',
		'rate-limited': 'Too many requests right now — it will retry shortly.',
		down: 'The provider is not responding.',
		unknown: "Something went wrong and we don't know why yet."
	};
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';

	type Severity = 'error' | 'warning' | 'info';

	interface Props {
		title: string;
		message?: string;
		/** Fills in standard copy for `message` when one isn't given
		    explicitly, so the same failure reads identically everywhere. */
		reason?: ProviderIssueReason;
		severity?: Severity;
		/** The provider this concerns, e.g. "Skyscanner". */
		provider?: string;
		icon?: Snippet;
		/** A retry button, an "Add API key" link — whatever the owning
		    feature can actually do about it. */
		action?: Snippet;
		/** The exact status and message text a real response carried, shown verbatim below
		    `message`/`action` rather than instead of them (issue #122: a classification like
		    "not subscribed" must sit alongside the evidence for it, never replace it — the
		    one thing that let a working key get misdiagnosed was substituting our own
		    sentence for what the provider actually said). Omit when no response exists to
		    show, e.g. a network failure or a local pre-flight refusal. */
		providerResponse?: { status: number; message: string };
		class?: string;
	}

	let {
		title,
		message,
		reason,
		severity = 'error',
		provider,
		icon,
		action,
		providerResponse,
		class: className
	}: Props = $props();

	const resolvedMessage = $derived(message ?? (reason ? PROVIDER_ISSUE_COPY[reason] : undefined));
	// A dozen providers can degrade at once. Only a hard error interrupts a
	// screen reader (role="alert"); a warning or info note is announced
	// politely so several of them don't talk over each other.
	const role = $derived(severity === 'error' ? 'alert' : 'status');
</script>

<div class={['error-state', `error-state-${severity}`, className]} {role}>
	<div class="error-state-icon" aria-hidden="true">
		{#if icon}
			{@render icon()}
		{:else if severity === 'warning'}
			<svg viewBox="0 0 24 24" fill="none">
				<path
					d="M12 3l10 18H2L12 3z"
					stroke="currentColor"
					stroke-width="2"
					stroke-linejoin="round"
				/>
				<line x1="12" y1="10" x2="12" y2="14" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
				<circle cx="12" cy="17.3" r="1" fill="currentColor" />
			</svg>
		{:else if severity === 'info'}
			<svg viewBox="0 0 24 24" fill="none">
				<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" />
				<line x1="12" y1="11" x2="12" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
				<circle cx="12" cy="7.7" r="1" fill="currentColor" />
			</svg>
		{:else}
			<svg viewBox="0 0 24 24" fill="none">
				<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" />
				<line x1="9" y1="9" x2="15" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
				<line x1="15" y1="9" x2="9" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
			</svg>
		{/if}
	</div>
	<div class="error-state-body">
		{#if provider}
			<p class="error-state-provider">{provider}</p>
		{/if}
		<p class="error-state-title">{title}</p>
		{#if resolvedMessage}
			<p class="error-state-message">{resolvedMessage}</p>
		{/if}
		{#if action}
			<div class="error-state-action">{@render action()}</div>
		{/if}
		{#if providerResponse}
			<p class="error-state-evidence font-mono">
				{provider ?? 'Provider'} responded HTTP {providerResponse.status}: {providerResponse.message}
			</p>
		{/if}
	</div>
</div>

<style>
	.error-state {
		display: flex;
		gap: var(--space-3);
		padding: var(--space-4);
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: var(--color-surface);
	}

	.error-state-icon {
		flex-shrink: 0;
		width: 1.5rem;
		height: 1.5rem;
	}

	.error-state-icon svg {
		width: 100%;
		height: 100%;
	}

	.error-state-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
	}

	.error-state-provider {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-text-faint);
	}

	.error-state-title {
		font-weight: var(--font-weight-semibold);
		color: var(--color-text);
	}

	.error-state-message {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.error-state-action {
		margin-top: var(--space-2);
	}

	/* Deliberately below the action button, not above it: our own headline and the fix
	   for it come first, this is the receipt for anyone who wants to check our work. */
	.error-state-evidence {
		margin: var(--space-2) 0 0;
		padding-top: var(--space-2);
		border-top: 1px dashed var(--color-border);
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
		word-break: break-word;
	}

	.error-state-error {
		border-color: var(--color-danger);
		background: var(--color-danger-bg);
	}

	.error-state-error .error-state-icon {
		color: var(--color-danger);
	}

	.error-state-warning {
		border-color: var(--color-warning);
		background: var(--color-warning-bg);
	}

	.error-state-warning .error-state-icon {
		color: var(--color-warning);
	}

	.error-state-info {
		border-color: var(--color-info);
		background: var(--color-info-bg);
	}

	.error-state-info .error-state-icon {
		color: var(--color-info);
	}
</style>
