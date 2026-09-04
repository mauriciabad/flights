<script lang="ts">
	import type { Snippet } from 'svelte';

	type InputType = 'text' | 'email' | 'tel' | 'number' | 'search' | 'password' | 'url';

	interface Props {
		label: string;
		id?: string;
		type?: InputType;
		value?: string;
		placeholder?: string;
		hint?: string;
		error?: string;
		required?: boolean;
		disabled?: boolean;
		class?: string;
		/** Rendered next to the label, e.g. "(optional)" or a unit. */
		labelSuffix?: Snippet;
		[key: string]: unknown;
	}

	let {
		label,
		id,
		type = 'text',
		value = $bindable(''),
		placeholder,
		hint,
		error,
		required = false,
		disabled = false,
		class: className,
		labelSuffix,
		...rest
	}: Props = $props();

	// $props.id() is stable across server and client render, unlike
	// Math.random() or a module-level counter, so labels stay linked to
	// their input after hydration.
	const uid = $props.id();
	const inputId = $derived(id ?? `field-${uid}`);
	const hintId = $derived(hint ? `${inputId}-hint` : undefined);
	const errorId = $derived(error ? `${inputId}-error` : undefined);
	const describedBy = $derived([hintId, errorId].filter(Boolean).join(' ') || undefined);
</script>

<div class={['field', className]}>
	<label for={inputId} class="field-label">
		<span>{label}{#if required}<span aria-hidden="true"> *</span>{/if}</span>
		{#if labelSuffix}<span class="field-label-suffix">{@render labelSuffix()}</span>{/if}
	</label>
	<input
		id={inputId}
		{type}
		bind:value
		{placeholder}
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
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-2);
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-medium);
		color: var(--color-text-muted);
	}

	.field-label-suffix {
		font-weight: var(--font-weight-regular);
		color: var(--color-text-faint);
	}

	.field-input {
		width: 100%;
		min-height: 2.75rem;
		padding: var(--space-3) var(--space-4);
		background: var(--color-surface);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-md);
		color: var(--color-text);
		font-size: var(--font-size-base);
		transition:
			border-color var(--transition-fast),
			background-color var(--transition-fast),
			box-shadow var(--transition-fast);
	}

	.field-input::placeholder {
		color: var(--color-text-faint);
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
