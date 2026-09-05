<script lang="ts">
	interface Option {
		value: string;
		label: string;
		disabled?: boolean;
	}

	interface Props {
		label: string;
		id?: string;
		options: Option[];
		value?: string;
		/** Shown as a disabled first option when no value is selected. */
		placeholder?: string;
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
		options,
		value = $bindable(''),
		placeholder,
		hint,
		error,
		required = false,
		disabled = false,
		class: className,
		...rest
	}: Props = $props();

	const uid = $props.id();
	const selectId = $derived(id ?? `select-${uid}`);
	const hintId = $derived(hint ? `${selectId}-hint` : undefined);
	const errorId = $derived(error ? `${selectId}-error` : undefined);
	const describedBy = $derived([hintId, errorId].filter(Boolean).join(' ') || undefined);
</script>

<div class={['field', className]}>
	<label for={selectId} class="field-label">
		{label}{#if required}<span aria-hidden="true"> *</span>{/if}
	</label>
	<div class="select-wrap">
		<select
			id={selectId}
			bind:value
			{required}
			{disabled}
			aria-invalid={error ? 'true' : undefined}
			aria-describedby={describedBy}
			class={['field-input', 'select-input', { 'has-error': !!error }]}
			{...rest}
		>
			{#if placeholder}
				<option value="" disabled>{placeholder}</option>
			{/if}
			{#each options as option (option.value)}
				<option value={option.value} disabled={option.disabled}>{option.label}</option>
			{/each}
		</select>
		<svg class="select-chevron" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
			<path
				d="M5 7l5 6 5-6"
				fill="none"
				stroke="currentColor"
				stroke-width="1.6"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
	</div>
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

	.select-wrap {
		position: relative;
	}

	.field-input {
		width: 100%;
		min-height: var(--control-height);
		padding: var(--control-padding-y) var(--space-3);
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

	.select-input {
		appearance: none;
		padding-right: var(--space-8);
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

	.select-chevron {
		position: absolute;
		top: 50%;
		right: var(--space-3);
		width: 1.25rem;
		height: 1.25rem;
		transform: translateY(-50%);
		color: var(--color-text-faint);
		pointer-events: none;
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
