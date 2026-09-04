<script lang="ts">
	import type { Snippet } from 'svelte';

	type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
	type Size = 'sm' | 'md' | 'lg';

	interface Props {
		variant?: Variant;
		size?: Size;
		type?: 'button' | 'submit' | 'reset';
		disabled?: boolean;
		/** Shows a spinner and blocks interaction, without changing layout. */
		loading?: boolean;
		fullWidth?: boolean;
		/** Renders an `<a>` instead of a `<button>` when set. */
		href?: string;
		class?: string;
		children: Snippet;
		[key: string]: unknown;
	}

	let {
		variant = 'primary',
		size = 'md',
		type = 'button',
		disabled = false,
		loading = false,
		fullWidth = false,
		href,
		class: className,
		children,
		...rest
	}: Props = $props();

	const classes = $derived([
		'btn',
		`btn-${variant}`,
		`btn-${size}`,
		{ 'btn-full': fullWidth, 'is-loading': loading },
		className
	]);
</script>

{#if href}
	<a {href} class={classes} aria-disabled={disabled || loading} {...rest}>
		{#if loading}
			<span class="btn-spinner" aria-hidden="true"></span>
		{/if}
		{@render children()}
	</a>
{:else}
	<button {type} disabled={disabled || loading} class={classes} {...rest}>
		{#if loading}
			<span class="btn-spinner" aria-hidden="true"></span>
		{/if}
		{@render children()}
	</button>
{/if}

<style>
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		border-radius: var(--radius-md);
		border: 1px solid transparent;
		font-family: inherit;
		font-weight: var(--font-weight-semibold);
		letter-spacing: 0.01em;
		text-decoration: none;
		white-space: nowrap;
		cursor: pointer;
		transition:
			background-color var(--transition-fast),
			border-color var(--transition-fast),
			color var(--transition-fast),
			opacity var(--transition-fast),
			transform var(--transition-fast),
			box-shadow var(--transition-fast);
	}

	.btn:disabled,
	.btn[aria-disabled='true'] {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.btn-full {
		width: 100%;
	}

	/* Sizes. Minimum 44px tap target on the two touch-oriented sizes, per
	   WCAG 2.5.5 and because this app is meant to be used one-handed. */
	.btn-sm {
		min-height: 2.25rem;
		padding: var(--space-2) var(--space-3);
		font-size: var(--font-size-sm);
	}

	.btn-md {
		min-height: 2.75rem;
		padding: var(--space-3) var(--space-5);
		font-size: var(--font-size-base);
	}

	.btn-lg {
		min-height: 3.25rem;
		padding: var(--space-4) var(--space-6);
		font-size: var(--font-size-lg);
	}

	/* Tactile press feedback: every variant nudges down 1px on activation,
	   like a real switch rather than a flat image of one. Reduced-motion
	   users still get the instant state change, just without the tween
	   (handled globally in app.css). */
	.btn:not(:disabled):not([aria-disabled='true']):active {
		transform: translateY(1px);
	}

	/* Variants */
	.btn-primary {
		background: linear-gradient(180deg, var(--color-accent-hover), var(--color-accent));
		color: var(--color-accent-text);
		box-shadow: var(--shadow-accent);
	}

	.btn-primary:not(:disabled):not([aria-disabled='true']):hover {
		background: var(--color-accent-hover);
	}

	.btn-secondary {
		background: var(--color-surface);
		border-color: var(--color-border-strong);
		color: var(--color-text);
	}

	.btn-secondary:not(:disabled):not([aria-disabled='true']):hover {
		background: var(--color-surface-hover);
		border-color: var(--color-accent);
	}

	.btn-ghost {
		background: transparent;
		color: var(--color-text);
	}

	.btn-ghost:not(:disabled):not([aria-disabled='true']):hover {
		background: var(--color-surface-hover);
	}

	.btn-danger {
		background: var(--color-danger-bg);
		border-color: var(--color-danger);
		color: var(--color-danger);
	}

	.btn-danger:not(:disabled):not([aria-disabled='true']):hover {
		background: var(--color-danger);
		color: var(--color-accent-text);
	}

	.btn-spinner {
		width: 1em;
		height: 1em;
		border: 2px solid currentColor;
		border-right-color: transparent;
		border-radius: var(--radius-full);
		animation: btn-spin 0.6s linear infinite;
	}

	@media (prefers-reduced-motion: reduce) {
		.btn-spinner {
			animation-duration: 1.5s;
		}
	}

	@keyframes btn-spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
