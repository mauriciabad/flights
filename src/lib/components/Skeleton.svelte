<script lang="ts">
	interface Props {
		width?: string;
		height?: string;
		radius?: string;
		circle?: boolean;
		/** Renders this many stacked text-line bars instead of one block;
		    the last line is shorter so it reads as the end of a sentence. */
		lines?: number;
		class?: string;
	}

	let {
		width = '100%',
		height = '1rem',
		radius,
		circle = false,
		lines = 1,
		class: className
	}: Props = $props();
</script>

<!--
	Purely decorative — aria-hidden throughout. The component streaming
	these in is responsible for announcing loading state once, e.g. with
	a `role="status"` region, rather than having every shimmering block
	talk over each other.
-->
{#if lines > 1}
	<span class={['skeleton-lines', className]} aria-hidden="true">
		{#each Array.from({ length: lines }) as _, i (i)}
			<span
				class="skeleton"
				style:width={i === lines - 1 ? '60%' : width}
				style:height
				style:border-radius={radius ?? 'var(--radius-sm)'}
			></span>
		{/each}
	</span>
{:else}
	<span
		class={['skeleton', { 'skeleton-circle': circle }, className]}
		style:width
		style:height
		style:border-radius={circle ? '50%' : (radius ?? 'var(--radius-sm)')}
		aria-hidden="true"
	></span>
{/if}

<style>
	.skeleton-lines {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.skeleton {
		display: block;
		background: linear-gradient(
			90deg,
			var(--color-surface) 25%,
			var(--color-surface-hover) 50%,
			var(--color-surface) 75%
		);
		background-size: 200% 100%;
		animation: skeleton-shimmer 1.6s ease-in-out infinite;
	}

	.skeleton-circle {
		border-radius: var(--radius-full);
	}

	@keyframes skeleton-shimmer {
		0% {
			background-position: 200% 0;
		}
		100% {
			background-position: -200% 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.skeleton {
			animation: none;
			background: var(--color-surface-hover);
		}
	}
</style>
