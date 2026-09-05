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
		/**
		 * Whether this chip is on, owned by whoever passes it and never by the chip.
		 * Deliberately not `$bindable`: it was, and the chip flipped its own copy in its click
		 * handler on top of the flip the parent had already made from the same click, so it
		 * rendered the negation of the truth and then stayed stuck there, because a local
		 * write to an unbound bindable prop shadows every later value from the parent
		 * (issue #189, Chip.test.ts).
		 *
		 * A toggle whose pressed state is derived from application state cannot also keep a
		 * private copy of it. The parent reads the click through `onclick` and passes the
		 * answer back down.
		 */
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
		selected = false,
		removable = false,
		disabled = false,
		onRemove,
		onclick,
		class: className,
		children
	}: Props = $props();

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
		<button type="button" class="chip-toggle" aria-pressed={selected} {disabled} {onclick}>
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
		position: relative;
		height: 100%;
		border-radius: var(--radius-full);
		color: inherit;
		font: inherit;
		cursor: pointer;
	}

	/* The chip pill itself stays 1.75rem (28px) tall by design — growing every chip to
	   44px would visibly balloon every filter/tag list in the app, a redesign call, not
	   an accessibility fix. This invisible pseudo-element instead pads the real tap
	   target up to the 44px minimum (WCAG 2.5.5) without touching the chip's rendered
	   size: it's part of the button's own box for hit-testing even though nothing paints
	   there. Width stays at 100% (not wider) so it never reaches into a neighbouring
	   chip in the same wrapped row. */
	.chip-toggle::after {
		content: '';
		position: absolute;
		inset: 50% 0 auto 0;
		height: 2.75rem;
		transform: translateY(-50%);
	}

	.chip-toggle:hover:not(:disabled) {
		background: var(--color-surface-hover);
	}

	.chip-toggle:active:not(:disabled) {
		transform: scale(0.97);
	}

	/* The inset ring doubles the border's apparent weight without adding a pixel to the
	   chip's box, so choosing a facet never reflows the row it sits in. A real 2px border
	   would, and a row of chips jumping under the finger that just tapped one is the kind
	   of thing that makes a filter rail feel broken even when it is right. */
	.chip.is-selected {
		background: var(--color-accent-muted);
		border-color: var(--color-accent);
		color: var(--color-accent);
		box-shadow: inset 0 0 0 1px var(--color-accent);
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
		position: relative;
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

	/* Same invisible-hit-area trick as .chip-toggle::after above: the visible "x" glyph
	   stays a small 20px dot (shrinking it further would make it hard to see against a
	   chip's own edge), but the actual tappable region reaches the 44px minimum — the
	   one place on a chip someone one-handed on a phone actually needs to land
	   precisely, since missing it re-triggers the chip's own click instead. */
	.chip-remove::after {
		content: '';
		position: absolute;
		top: 50%;
		left: 50%;
		width: 2.75rem;
		height: 2.75rem;
		transform: translate(-50%, -50%);
	}

	.chip-remove:hover:not(:disabled) {
		background: var(--color-surface-hover);
	}

	.chip-remove svg {
		width: 0.75rem;
		height: 0.75rem;
	}
</style>
