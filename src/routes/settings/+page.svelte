<script lang="ts">
	/**
	 * Settings: API keys (issue #29). The UI over the BYOK key store — every provider row,
	 * the privacy statement AGENTS.md's "keys belong to the user" rule requires be visible
	 * (not just true), and export/import.
	 *
	 * `keyStore.hydrated` gates the provider list rather than trusting an empty result:
	 * SvelteKit prerenders this route on the server, where there is no `localStorage`, and
	 * `KeyStore`'s own doc calls out exactly this ("a UI built on this store should gate on
	 * `hydrated`"). In practice `hydrated` flips to `true` synchronously once this module
	 * runs in the browser, so the skeleton below is a one-tick safety net, not a real
	 * loading state.
	 */
	import { keyStore } from '$lib/keys';
	import { Skeleton } from '$lib/components';
	import { SETTINGS_PROVIDERS } from '$lib/settings/provider-catalog';
	import ProviderKeyCard from './ProviderKeyCard.svelte';
	import KeyExportImport from './KeyExportImport.svelte';
</script>

<svelte:head>
	<title>Settings — Layover</title>
	<meta name="description" content="Add your own API keys for Skyscanner, Booking, Agoda and more." />
</svelte:head>

<div class="settings-page">
	<header class="settings-header">
		<h1>API keys</h1>
		<p class="settings-lede">
			This app has no backend and no shared account: every search runs from your own browser
			straight to each provider, using a key you paste in below. Ryanair, Transitous and OSRM
			already work with no key at all — the providers here unlock the rest.
		</p>
	</header>

	<section class="privacy-banner" aria-label="Privacy">
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
	</section>

	<KeyExportImport />

	{#if keyStore.hydrated}
		<section class="provider-list" aria-label="Providers">
			{#each SETTINGS_PROVIDERS as provider (provider.id)}
				<ProviderKeyCard {provider} />
			{/each}
		</section>
	{:else}
		<div class="provider-list-skeleton" aria-hidden="true">
			<Skeleton height="12rem" />
			<Skeleton height="12rem" />
		</div>
	{/if}
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
