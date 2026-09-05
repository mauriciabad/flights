<script lang="ts">
	/**
	 * A duration as the four or five answers people actually give, with the box still there
	 * for the sixth. Issue #277: "the way info is iputes is not tought to the use case".
	 * Nobody types 90 into a minutes box because they wanted 90 minutes; they wanted an hour
	 * and a half, and the number was the tax on saying so.
	 *
	 * The presets are a fast path, not the whole control. The box keeps the field's own id
	 * and any minute value at all remains typeable, so this narrows nothing.
	 */
	import { formatDuration } from '$lib/format';

	interface Props {
		label: string;
		id: string;
		/** Raw text, not a number: a cleared box has to stay distinct from "0". */
		value?: string;
		presets: number[];
		/** What the field falls back to when it is left empty, shown on the matching preset
		 * so the default is visible rather than buried in a sentence. */
		fallback: number;
		hint?: string;
		error?: string;
		onblur?: () => void;
	}

	let { label, id, value = $bindable(''), presets, fallback, hint, error, onblur }: Props =
		$props();

	const hintId = $derived(hint ? `${id}-hint` : undefined);
	const errorId = $derived(error ? `${id}-error` : undefined);
	const describedBy = $derived([hintId, errorId].filter(Boolean).join(' ') || undefined);

	const effective = $derived(value.trim() === '' ? fallback : Number.parseInt(value, 10));
</script>

<div class="field">
	<label for={id}>{label}</label>
	<div class="row">
		<ul class="presets">
			{#each presets as preset (preset)}
				<li>
					<button
						type="button"
						class={['preset', { 'is-on': effective === preset }]}
						aria-pressed={effective === preset}
						onclick={() => (value = String(preset))}
					>
						{formatDuration(preset)}
					</button>
				</li>
			{/each}
		</ul>
		<div class="custom">
			<input
				{id}
				type="number"
				inputmode="numeric"
				min="0"
				step="5"
				placeholder={String(fallback)}
				bind:value
				aria-invalid={error ? 'true' : undefined}
				aria-describedby={describedBy}
				class={['minutes', { 'has-error': !!error }]}
				{onblur}
			/>
			<span class="unit">min</span>
		</div>
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
		gap: var(--space-2);
		min-width: 0;
	}

	label {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
		color: var(--color-text-muted);
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.presets {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
		margin: 0;
	}

	.preset {
		min-height: var(--control-height);
		padding-inline: var(--space-3);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-full);
		color: var(--color-text-muted);
		font-family: var(--font-mono);
		font-size: var(--font-size-xs);
		cursor: pointer;
		transition:
			color var(--transition-fast),
			border-color var(--transition-fast),
			background-color var(--transition-fast);
	}

	.preset:hover {
		color: var(--color-text);
		border-color: var(--color-border-strong);
	}

	.preset.is-on {
		background: var(--color-accent-muted);
		border-color: var(--color-accent);
		color: var(--color-accent);
	}

	.custom {
		display: flex;
		align-items: center;
		gap: var(--space-1);
	}

	.minutes {
		width: 4.5rem;
		min-height: var(--control-height);
		padding-inline: var(--space-2);
		background: var(--color-surface);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-md);
		color: var(--color-text);
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		font-size: var(--font-size-sm);
		text-align: right;
	}

	.minutes:focus-visible {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.minutes.has-error {
		border-color: var(--color-danger);
	}

	.minutes::placeholder {
		color: var(--color-text-faint);
	}

	.unit {
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
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
		.preset {
			transition: none;
		}
	}
</style>
