<script lang="ts">
	interface Props {
		label: string;
		id?: string;
		/** ISO date string, `YYYY-MM-DD`. This is a calendar date with no
		    time or offset attached — see AGENTS.md on why flight times
		    always carry their own offset instead of being normalised. */
		value?: string;
		min?: string;
		max?: string;
		hint?: string;
		error?: string;
		required?: boolean;
		disabled?: boolean;
		class?: string;
		[key: string]: unknown;
	}

	let {
		label,
		id,
		value = $bindable(''),
		min,
		max,
		hint,
		error,
		required = false,
		disabled = false,
		class: className,
		...rest
	}: Props = $props();

	const uid = $props.id();
	const inputId = $derived(id ?? `date-${uid}`);
	const hintId = $derived(hint ? `${inputId}-hint` : undefined);
	const errorId = $derived(error ? `${inputId}-error` : undefined);
	const describedBy = $derived([hintId, errorId].filter(Boolean).join(' ') || undefined);
</script>

<div class={['field', className]}>
	<label for={inputId} class="field-label">
		{label}{#if required}<span aria-hidden="true"> *</span>{/if}
	</label>
	<input
		id={inputId}
		type="date"
		bind:value
		{min}
		{max}
		{required}
		{disabled}
		aria-invalid={error ? 'true' : undefined}
		aria-describedby={describedBy}
		class={['field-input', { 'has-error': !!error }]}
		{...rest}
	/>
	{#if hint && !error}
		<p id={hintId} class="field-hint">{hint}</p>
	{/if}
	{#if error}
		<p id={errorId} class="field-error" role="alert">{error}</p>
	{/if}
</div>

<style>
	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		width: 100%;
	}

	.field-label {
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-medium);
		color: var(--color-text-muted);
	}

	.field-input {
		width: 100%;
		min-height: 2.75rem;
		padding: var(--space-3) var(--space-4);
		background: var(--color-surface);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-md);
		color: var(--color-text);
		/* A date is a departure-board number before it's anything else. */
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		font-size: var(--font-size-base);
		transition:
			border-color var(--transition-fast),
			background-color var(--transition-fast),
			box-shadow var(--transition-fast);
	}

	.field-input:hover:not(:disabled) {
		background: var(--color-surface-hover);
	}

	.field-input:focus-visible {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.field-input:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.field-input.has-error {
		border-color: var(--color-danger);
	}

	.field-hint {
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	.field-error {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
		color: var(--color-danger);
	}
</style>
