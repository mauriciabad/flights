<script lang="ts">
	/**
	 * Issue #119: a carrier mark, not a text chip. `airline-logos.ts` documents the source
	 * and its licence. `failedFor` records which `iataCode` the last `onerror` fired for,
	 * so `failed` derives straight from comparing it to the current prop rather than
	 * needing an `$effect` to reset a plain boolean when the carrier changes — a new
	 * carrier (a different card, or this same card's flight swapped by a picker) always
	 * gets its own fresh attempt, never stuck showing a previous logo's failure.
	 */
	import { airlineLogoUrl, airlineMonogram } from '$lib/data/airline-logos';

	interface Props {
		iataCode: string;
		name: string;
	}

	let { iataCode, name }: Props = $props();

	let failedFor = $state<string | undefined>(undefined);
	const failed = $derived(failedFor === iataCode);
</script>

{#if failed}
	<span class="airline-monogram" aria-hidden="true">{airlineMonogram(name)}</span>
{:else}
	<img
		class="airline-logo"
		src={airlineLogoUrl(iataCode)}
		alt=""
		width="22"
		height="22"
		loading="lazy"
		decoding="async"
		onerror={() => (failedFor = iataCode)}
	/>
{/if}

<style>
	/* pics.avs.io always delivers a square canvas, even for a wordmark-shaped mark like
	   Ryanair's — checked directly by fetching FR.png and reading it: the actual harp+text
	   art fills only the middle band of the square, the rest is transparent padding. At the
	   16px an ordinary chip icon uses, that padding wins and the wordmark reads as a blurred
	   line, not a logo — this size is the smallest at which it stays legible, since there is
	   no way to crop the padding from CSS alone (the file itself is square, not the box). */
	.airline-logo {
		width: 1.375rem;
		height: 1.375rem;
		flex-shrink: 0;
		border-radius: var(--radius-sm);
		/* Most carrier marks ship on a transparent or white background; a faint plate
		   keeps a white logo from vanishing into this app's own dark surfaces without
		   drawing a hard box around every mark. */
		background: var(--color-bg-elevated);
		object-fit: contain;
	}

	.airline-monogram {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.375rem;
		height: 1.375rem;
		flex-shrink: 0;
		border-radius: var(--radius-sm);
		background: var(--color-accent-muted);
		color: var(--color-accent);
		font-family: var(--font-mono);
		font-size: 0.625rem;
		font-weight: var(--font-weight-bold);
		letter-spacing: 0;
		line-height: 1;
	}
</style>
