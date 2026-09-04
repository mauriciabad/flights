<script lang="ts">
	/**
	 * A carrier's mark, as an image. `$lib/data/airline-logos.ts` documents the source and
	 * the privacy check behind it.
	 *
	 * `failedFor` records which `iataCode` the last `onerror` fired for, so `failed`
	 * derives from comparing it to the current prop rather than needing an `$effect` to
	 * reset a plain boolean when the carrier changes. A new carrier, whether that is a
	 * different card or this same row's flight swapped by a picker, always gets a fresh
	 * attempt and is never stuck showing a previous logo's failure.
	 *
	 * Never shifts layout. The `<img>` carries explicit `width`/`height` attributes and a
	 * matching fixed CSS box, so its space is reserved the instant this component mounts,
	 * before a byte of the image arrives, and the monogram fallback is sized to the same
	 * box so a failure swaps content without moving anything. A slow or hanging request
	 * changes nothing either: image loads are asynchronous, this one is also
	 * `loading="lazy"`, and the box already has its final size regardless.
	 */
	import { airlineLogoUrl, airlineMonogram } from '$lib/data/airline-logos';

	interface Props {
		iataCode: string;
		name: string;
		/** `sm` for a dense timeline row, `md` where the carrier is the row's subject.
		 * Both are square; only the box changes. */
		size?: 'sm' | 'md';
		/** Colour-only quieting for an airline the traveller asked to avoid. AGENTS.md is
		 * explicit that this is never an opacity trick for text, but a logo is a picture,
		 * not text: it carries no contrast ratio to protect, and desaturating it is the
		 * only way to quiet a mark whose colours this app does not control. */
		deprioritized?: boolean;
	}

	let { iataCode, name, size = 'sm', deprioritized = false }: Props = $props();

	let failedFor = $state<string | undefined>(undefined);
	const failed = $derived(failedFor === iataCode);
	const pixels = $derived(size === 'md' ? 28 : 20);
</script>

{#if failed}
	<span
		class={['airline-mark', 'airline-monogram', `airline-mark-${size}`, { 'is-quiet': deprioritized }]}
		aria-hidden="true">{airlineMonogram(name)}</span
	>
{:else}
	<img
		class={['airline-mark', 'airline-logo', `airline-mark-${size}`, { 'is-quiet': deprioritized }]}
		src={airlineLogoUrl(iataCode)}
		alt=""
		width={pixels}
		height={pixels}
		loading="lazy"
		decoding="async"
		referrerpolicy="no-referrer"
		onerror={() => (failedFor = iataCode)}
	/>
{/if}

<style>
	.airline-mark {
		flex-shrink: 0;
		border-radius: var(--radius-sm);
	}

	.airline-mark-sm {
		width: 1.25rem;
		height: 1.25rem;
	}

	.airline-mark-md {
		width: 1.75rem;
		height: 1.75rem;
	}

	.airline-logo {
		/* Most carrier marks ship on a transparent or white ground. A faint plate keeps a
		   white logo from vanishing into this app's dark surfaces without drawing a hard
		   box around every mark. */
		background: var(--color-bg-elevated);
		object-fit: contain;
	}

	.airline-monogram {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--color-accent-muted);
		color: var(--color-accent);
		font-family: var(--font-mono);
		font-size: 0.5625rem;
		font-weight: var(--font-weight-bold);
		line-height: 1;
	}

	.airline-mark-md.airline-monogram {
		font-size: var(--font-size-xs);
	}

	.airline-logo.is-quiet {
		filter: grayscale(1);
	}

	.airline-monogram.is-quiet {
		background: var(--color-bg-inset);
		color: var(--color-text-deprioritized);
	}
</style>
