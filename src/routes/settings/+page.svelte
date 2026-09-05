<script lang="ts">
	/**
	 * Settings. The UI over the BYOK key store (issue #29): every provider row, the privacy
	 * statement AGENTS.md's "keys belong to the user" rule requires be visible (not just
	 * true), and export/import. Plus the currency every provider is asked to quote in.
	 *
	 * `keyStore.hydrated` gates the provider list rather than trusting an empty result:
	 * SvelteKit prerenders this route on the server, where there is no `localStorage`, and
	 * `KeyStore`'s own doc calls out exactly this ("a UI built on this store should gate on
	 * `hydrated`"). In practice `hydrated` flips to `true` synchronously once this module
	 * runs in the browser, so the skeleton below is a one-tick safety net, not a real
	 * loading state.
	 *
	 * The page grew things to set beyond the keys, so the heading it grew under stopped
	 * being true: the `h1` is "Settings" and the keys now sit in their own labelled section
	 * beneath it. The two display pickers go last on purpose. Issue #123 already
	 * established that the providers are what people come to this page for, and moved the
	 * export bar above the list so it would not push them below the fold on a phone; a card
	 * added at the top would undo that decision for a setting most people touch once. The
	 * clock (issue #229) sits below the currency because it changes nothing but the glyphs,
	 * where the currency changes what every provider is asked for.
	 */
	import { keyStore } from '$lib/keys';
	import { Skeleton } from '$lib/components';
	import { SETTINGS_PROVIDERS } from '$lib/settings/provider-catalog';
	import CurrencyPicker from './CurrencyPicker.svelte';
	import ProviderKeyCard from './ProviderKeyCard.svelte';
	import KeyExportImport from './KeyExportImport.svelte';
	import TimeFormatPicker from './TimeFormatPicker.svelte';
</script>

<svelte:head>
	<title>Settings — Layover</title>
	<meta
		name="description"
		content="Add your own API keys for Skyscanner, Booking, Agoda and more, and pick the currency every provider is asked to quote in."
	/>
</svelte:head>

<div class="settings-page">
	<header class="settings-header">
		<h1>Settings</h1>
		<p class="settings-lede">
			This app has no backend and no shared account: every search runs from your own browser
			straight to each provider, using a key you paste in below. Ryanair, Transitous and OSRM
			already work with no key at all, and the providers here unlock the rest.
		</p>
	</header>

	<section class="settings-section" aria-labelledby="api-keys">
		<h2 class="settings-section-heading" id="api-keys">API keys</h2>

		<div class="privacy-banner">
			<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
				<path
					d="M12 3l7 3v5c0 4.5-3 8.3-7 9.7-4-1.4-7-5.2-7-9.7V6l7-3z"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linejoin="round"
				/>
				<path d="M9 12.2l2 2 4-4.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
			</svg>
			<p>
				Every key you paste in below is stored only in this browser's <code>localStorage</code>. It is
				sent only in requests to the provider that issued it, over HTTPS, straight from your device
				— never to any server this app runs, because it doesn't run one. Clearing your browser data
				or using another device or browser means starting over, or importing an exported file.
			</p>
		</div>

		<KeyExportImport />

		{#if keyStore.hydrated}
			<div class="provider-list">
				{#each SETTINGS_PROVIDERS as provider (provider.id)}
					<ProviderKeyCard {provider} />
				{/each}
			</div>
		{:else}
			<div class="provider-list-skeleton" aria-hidden="true">
				<Skeleton height="12rem" />
				<Skeleton height="12rem" />
			</div>
		{/if}
	</section>

	<CurrencyPicker />
	<TimeFormatPicker />
</div>

<style>
	.settings-page {
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
		max-width: var(--layout-max-width);
		margin: 0 auto;
	}

	.settings-header h1 {
		margin: 0 0 var(--space-2);
	}

	/* The heading owns the block below it rather than floating between two page-level
	   gaps, which is what a bare <h2> in this flex column would do. */
	.settings-section {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.settings-section-heading {
		margin: 0;
		font-size: var(--font-size-lg);
	}

	.settings-lede {
		margin: 0;
		max-width: 60ch;
		color: var(--color-text-muted);
	}

	/* Info tokens, not --color-stopover: that colour is reserved app-wide for the free
	   stopover city itself (app.css), and this banner isn't that. */
	.privacy-banner {
		display: flex;
		gap: var(--space-3);
		padding: var(--space-4);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-info);
		background: var(--color-info-bg);
		color: var(--color-text);
	}

	.privacy-banner svg {
		flex-shrink: 0;
		width: 1.5rem;
		height: 1.5rem;
		color: var(--color-info);
	}

	.privacy-banner p {
		margin: 0;
		font-size: var(--font-size-sm);
	}

	.privacy-banner code {
		font-family: var(--font-mono);
		font-size: 0.9em;
	}

	.provider-list,
	.provider-list-skeleton {
		display: grid;
		grid-template-columns: 1fr;
		gap: var(--space-4);
	}

	@media (min-width: 48rem) {
		.provider-list,
		.provider-list-skeleton {
			grid-template-columns: repeat(2, 1fr);
			align-items: start;
		}
	}
</style>
