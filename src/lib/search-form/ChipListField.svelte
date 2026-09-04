<script lang="ts">
	/**
	 * A free-text "add one at a time" list, backing every code list in the brief that
	 * has no curated dataset to autocomplete against: forbidden connection countries
	 * (line 35), forbidden connection airports (line 35), airlines to avoid (line 36)
	 * and the allowed-connections list (line 38). Airport codes get `AirportField`'s
	 * typeahead instead - this is for the codes that don't have one.
	 */
	import { Chip } from '$lib/components';

	interface Props {
		label: string;
		id?: string;
		values?: string[];
		placeholder?: string;
		hint?: string;
		error?: string;
		disabled?: boolean;
		class?: string;
		/** Normalises and validates a token before it's added (e.g. uppercasing an IATA
		 * code and checking its length). Returns `null` to reject the token. */
		transform?: (raw: string) => string | null;
	}

	let {
		label,
		id,
		values = $bindable([]),
		placeholder,
		hint,
		error,
		disabled = false,
		class: className,
		transform = (raw) => raw.trim().toUpperCase() || null
	}: Props = $props();

	const uid = $props.id();
	const inputId = $derived(id ?? `chiplist-${uid}`);
	const hintId = $derived(hint ? `${inputId}-hint` : undefined);
	const errorId = $derived(error ? `${inputId}-error` : undefined);
	const describedBy = $derived([hintId, errorId].filter(Boolean).join(' ') || undefined);

	let draft = $state('');

	function commitDraft() {
		const token = transform(draft);
		draft = '';
		if (!token || values.includes(token)) return;
		values = [...values, token];
	}

	function removeAt(index: number) {
		values = values.filter((_, i) => i !== index);
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' || event.key === ',') {
			event.preventDefault();
			commitDraft();
			return;
		}
		// Backspace on an empty draft edits the list itself, like a browser's own tag
		// inputs (Gmail's "To" field, e.g.) - only when there's nothing left to erase in
		// the text box, so it never eats a keystroke the user meant for `draft`.
		if (event.key === 'Backspace' && draft === '' && values.length > 0) {
			removeAt(values.length - 1);
		}
	}
</script>

<div class={['field', className]}>
	<span id={`${inputId}-label`} class="field-label">{label}</span>
	{#if values.length}
		<ul class="chip-list" aria-labelledby={`${inputId}-label`}>
			{#each values as chipValue, i (chipValue)}
				<li>
					<Chip label={chipValue} removable onRemove={() => removeAt(i)} {disabled} />
				</li>
			{/each}
		</ul>
	{/if}
	<input
		id={inputId}
		type="text"
		value={draft}
		{placeholder}
		{disabled}
		aria-invalid={error ? 'true' : undefined}
		aria-describedby={describedBy}
		class={['field-input', { 'has-error': !!error }]}
		oninput={(event) => (draft = (event.currentTarget as HTMLInputElement).value)}
		onkeydown={onKeydown}
		onblur={commitDraft}
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

	.chip-list {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
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
