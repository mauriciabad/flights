<script lang="ts">
	import type { Snippet } from 'svelte';

	type Variant = 'default' | 'accent' | 'success' | 'warning' | 'danger';

	interface Props {
		label?: string;
		variant?: Variant;
		/** The greyed-out treatment for e.g. an avoided airline. Colour
		    only — never opacity — so it stays legible. */
		deprioritized?: boolean;
		/** Renders the chip body as a toggle button instead of a static tag. */
		interactive?: boolean;
		selected?: boolean;
		removable?: boolean;
		disabled?: boolean;
		onRemove?: () => void;
		onclick?: (event: MouseEvent) => void;
		class?: string;
		children?: Snippet;
	}

	let {
		label,
		variant = 'default',
		deprioritized = false,
		interactive = false,
		selected = $bindable(false),
		removable = false,
		disabled = false,
		onRemove,
		onclick,
		class: className,
		children
	}: Props = $props();

	function handleToggle(event: MouseEvent) {
		if (disabled) return;
		onclick?.(event);
		selected = !selected;
	}

	function handleRemove(event: MouseEvent) {
		event.stopPropagation();
		if (disabled) return;
		onRemove?.();
	}
</script>

<span
	class={[
		'chip',
		`chip-${variant}`,
		{
			'is-selected': interactive && selected,
			'is-deprioritized': deprioritized,
			'is-disabled': disabled
		},
		className
	]}
>
	{#if interactive}
		<button type="button" class="chip-toggle" aria-pressed={selected} {disabled} onclick={handleToggle}>
			{#if children}
				{@render children()}
			{:else}
				{label}
			{/if}
		</button>
	{:else}
		<span class="chip-label">
			{#if children}
				{@render children()}
			{:else}
				{label}
			{/if}
		</span>
	{/if}
	{#if removable}
		<button
			type="button"
			class="chip-remove"
			{disabled}
			aria-label={`Remove ${label ?? 'item'}`}
			onclick={handleRemove}
		>
			<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
				<path
					d="M4 4l8 8M12 4l-8 8"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linecap="round"
				/>
			</svg>
		</button>
	{/if}
</span>

<style>
	.chip {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		height: 1.75rem;
		padding-inline: var(--space-1);
		border-radius: var(--radius-full);
		border: 1px solid var(--color-border-strong);
		background: var(--color-surface);
		color: var(--color-text);
		font-size: var(--font-size-sm);
		line-height: 1;
		max-width: 100%;
		transition:
			background-color var(--transition-fast),
			border-color var(--transition-fast),
			color var(--transition-fast);
	}

	.chip-toggle,
	.chip-label {
		display: inline-block;
		max-width: 16rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		padding-inline: var(--space-2);
	}

	.chip-toggle {
		height: 100%;
		border-radius: var(--radius-full);
		color: inherit;
		font: inherit;
		cursor: pointer;
	}

	.chip-toggle:hover:not(:disabled) {
		background: var(--color-surface-hover);
	}

	.chip-toggle:active:not(:disabled) {
		transform: scale(0.97);
	}

	.chip.is-selected {
		background: var(--color-accent-muted);
		border-color: var(--color-accent);
		color: var(--color-accent);
	}

	.chip-accent {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}

	.chip-success {
		background: var(--color-success-bg);
		border-color: var(--color-success);
		color: var(--color-success);
	}

	.chip-warning {
		background: var(--color-warning-bg);
		border-color: var(--color-warning);
		color: var(--color-warning);
	}

	.chip-danger {
		background: var(--color-danger-bg);
		border-color: var(--color-danger);
		color: var(--color-danger);
	}

	.chip.is-deprioritized {
		color: var(--color-text-deprioritized);
		border-color: var(--color-border);
		background: var(--color-bg-inset);
	}

	.chip.is-disabled {
		opacity: 0.55;
	}

	.chip-remove {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.25rem;
		height: 1.25rem;
		margin-right: var(--space-1);
		border-radius: var(--radius-full);
		color: inherit;
		cursor: pointer;
	}

	.chip-remove:hover:not(:disabled) {
		background: var(--color-surface-hover);
	}

	.chip-remove svg {
		width: 0.75rem;
		height: 0.75rem;
	}
</style>
