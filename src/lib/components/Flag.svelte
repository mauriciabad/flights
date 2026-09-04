<script lang="ts">
	/**
	 * The one way this app draws a country flag.
	 *
	 * It replaces the regional-indicator emoji `iconForCity`/`iconForAirport` used to
	 * return, which the owner asked for by name: "dont use scrapy emojis for the flags,
	 * use flags svgs". Emoji flags are a platform lottery. Windows ships no flag glyphs
	 * at all and renders the pair of letter tiles instead ("HR"), and the platforms that
	 * do have them draw them at wildly different sizes and shapes next to the same run
	 * of text, so the one visual element that is supposed to be instantly recognisable
	 * is the one that changes per device.
	 *
	 * The SVGs are vendored under `static/flags/` by `scripts/prepare-flags.mjs` (see
	 * that file for the source, the licence and why only 234 of them are here). The
	 * `FLAG_ASSET_CODES` check below is what keeps the old emoji path's one real virtue:
	 * a code with no file never reaches an `<img src>`, so a broken image is not a state
	 * this component can be in, it just draws the placeholder instead.
	 */
	import { base } from '$app/paths';
	import type { Country } from '$lib/domain';
	import { FLAG_ASSET_CODES } from '$lib/data/flag-assets.generated';

	interface Props {
		/** Undefined for an airport whose record has not resolved yet, which draws the
		 *  placeholder rather than nothing: the row keeps its shape while it loads. */
		country?: Country | null;
		/** `sm` sits inline with a line of text; `md` sits beside two stacked lines, as
		 *  in the airport typeahead. */
		size?: 'sm' | 'md';
		/**
		 * True when the country is already written next to this flag, which makes the
		 * flag a repeat rather than information. Default false: on the result card's
		 * route strip the flag beside `BVC` is the only thing naming Cape Verde, so it
		 * has to be announced.
		 */
		decorative?: boolean;
		class?: string;
	}

	let { country, size = 'sm', decorative = false, class: className }: Props = $props();

	const code = $derived(country?.isoCode?.trim().toLowerCase() ?? '');
	const src = $derived(FLAG_ASSET_CODES.has(code) ? `${base}/flags/${code}.svg` : null);
	const name = $derived(country?.name ?? country?.isoCode ?? '');
	// An empty alt is the correct way to say "skip this", so the two cases genuinely
	// differ: decorative gets alt="", informative gets the country's own name.
	const alt = $derived(decorative ? '' : name ? `Flag of ${name}` : '');
</script>

{#if src}
	<img
		class={['flag', `flag-${size}`, className]}
		{src}
		{alt}
		title={decorative ? undefined : name || undefined}
		width="20"
		height="20"
		loading="lazy"
		decoding="async"
	/>
{:else}
	<!-- No country, or no flag file for it. A hollow disc the same size as a flag: it
	     holds the row's alignment without claiming to be a place. -->
	<span
		class={['flag', 'flag-empty', `flag-${size}`, className]}
		role={decorative ? undefined : 'img'}
		aria-hidden={decorative ? 'true' : undefined}
		aria-label={decorative ? undefined : 'Country unknown'}
	></span>
{/if}

<style>
	.flag {
		display: inline-block;
		flex-shrink: 0;
		border-radius: 50%;
		/* The source SVGs are already circular. The ring is what stops a flag whose
		   outer band matches the card behind it (Japan, Poland) from losing its edge. */
		box-shadow: 0 0 0 1px var(--color-border);
		vertical-align: -0.15em;
		object-fit: cover;
	}

	.flag-sm {
		width: 1.05em;
		height: 1.05em;
	}

	.flag-md {
		width: 1.5rem;
		height: 1.5rem;
	}

	.flag-empty {
		box-shadow: inset 0 0 0 1px var(--color-border);
		background: transparent;
	}
</style>
