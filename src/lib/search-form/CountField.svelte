<script lang="ts">
	/**
	 * A small whole number with a minus and a plus either side, for party sizes. Issue #277,
	 * the owner: "the way info is iputes is not tought to the use case". A number spinner
	 * whose arrows are four pixels tall is the browser's answer to "how many people", not
	 * this app's: the real answer is almost always one or two, and both should be one tap.
	 *
	 * The text box stays a real `<input type="number">` with the field's own id, so it is
	 * still typed into, still autofilled, and still the thing validation points focus at.
	 *
	 * The buttons never clamp what is already typed. `validation.ts` refuses a party of zero
	 * with a sentence, and silently correcting it here is exactly the behaviour the owner
	 * asked to stop: "a field that can be wrong should say so rather than quietly correct
	 * itself".
	 */
	interface Props {
		label: string;
		id: string;
		/** Raw text, not a number: a cleared box has to stay distinct from "0". */
		value?: string;
		/** What one press of plus starts counting from while the box is empty. */
		fallback: number;
		min: number;
		placeholder?: string;
		hint?: string;
		error?: string;
		onblur?: () => void;
	}

	let {
		label,
		id,
		value = $bindable(''),
		fallback,
		min,
		placeholder,
		hint,
		error,
		onblur
	}: Props = $props();

	const hintId = $derived(hint ? `${id}-hint` : undefined);
	const errorId = $derived(error ? `${id}-error` : undefined);
	const describedBy = $derived([hintId, errorId].filter(Boolean).join(' ') || undefined);

	const current = $derived(Number.parseInt(value, 10));

	function step(by: number) {
		const from = Number.isFinite(current) ? current : fallback;
		value = String(Math.max(min, from + by));
	}
</script>

<div class="field">
	<label for={id}>{label}</label>
	<div class="stepper">
		<button type="button" class="step" onclick={() => step(-1)}>
			<span class="visually-hidden">One fewer, {label}</span>
			<span aria-hidden="true">&minus;</span>
		</button>
		<input
			{id}
			type="number"
			inputmode="numeric"
			{min}
			{placeholder}
			bind:value
			aria-invalid={error ? 'true' : undefined}
			aria-describedby={describedBy}
			class={['count', { 'has-error': !!error }]}
			{onblur}
		/>
		<button type="button" class="step" onclick={() => step(1)}>
			<span class="visually-hidden">One more, {label}</span>
			<span aria-hidden="true">+</span>
		</button>
	</div>
	{#if hint && !error}
		<p id={hintId} class="hint">{hint}</p>
	{/if}
	{#if error}
		<p id={errorId} class="error" role="alert">{error}</p>
	{/if}
</div>

<style>
	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
	}

	label {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
		color: var(--color-text-muted);
	}

	/* One control with two ends, not three boxes: the border belongs to the group and the
	   dividers are the buttons' own edges. */
	.stepper {
		display: grid;
		grid-template-columns: var(--control-height) minmax(0, 1fr) var(--control-height);
		background: var(--color-surface);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-md);
	}

	.step {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: var(--control-height);
		color: var(--color-text-muted);
		font-size: var(--font-size-lg);
		line-height: 1;
		cursor: pointer;
		/* Held down or tapped twice to get to 3, so it must not wait for a double-tap zoom. */
		touch-action: manipulation;
		transition:
			color var(--transition-fast),
			background-color var(--transition-fast);
	}

	.step:first-of-type {
		border-right: 1px solid var(--color-border);
		border-start-start-radius: var(--radius-md);
		border-end-start-radius: var(--radius-md);
	}

	.step:last-of-type {
		border-left: 1px solid var(--color-border);
		border-start-end-radius: var(--radius-md);
		border-end-end-radius: var(--radius-md);
	}

	.step:hover {
		color: var(--color-text);
		background: var(--color-surface-hover);
	}

	.count {
		min-width: 0;
		min-height: var(--control-height);
		padding-inline: var(--space-2);
		background: transparent;
		border: 0;
		color: var(--color-text);
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		font-size: var(--font-size-sm);
		text-align: center;
	}

	/* Chrome's own spinner duplicates the two buttons either side of it. */
	.count::-webkit-inner-spin-button,
	.count::-webkit-outer-spin-button {
		appearance: none;
		margin: 0;
	}

	.count {
		appearance: textfield;
	}

	.count::placeholder {
		color: var(--color-text-faint);
	}

	.stepper:has(.count:focus-visible) {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.count:focus-visible {
		outline: none;
	}

	.stepper:has(.has-error) {
		border-color: var(--color-danger);
	}

	.hint {
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-faint);
	}

	.error {
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		font-weight: var(--font-weight-medium);
		color: var(--color-danger);
	}

	@media (prefers-reduced-motion: reduce) {
		.step {
			transition: none;
		}
	}
</style>
