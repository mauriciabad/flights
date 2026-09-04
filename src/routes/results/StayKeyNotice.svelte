<script lang="ts">
	/**
	 * Issue #117: the owner's own words, "'No bed priced for this stopover — total excludes
	 * a stay.' ... it is not acceptable that is not avilable." Both stay adapters (Agoda,
	 * Booking.com) are `needsKey: true`, so with no key ever pasted in, `resources.ts`'s
	 * `fetchCheapestStay` filters them out before a single request goes out
	 * (`isProviderUsable`) and every stopover on this page is silently missing a bed price.
	 * Nothing before this notice said why, or what fixes it.
	 *
	 * Rendered once, above the results list (`+page.svelte`), not per card: `ResultCard`'s
	 * own "No bed priced" line stays a plain per-itinerary fact, this is the one place that
	 * names the cause and the fix, so a traveller reads it once instead of the same "add a
	 * key" advice repeated on every card, which is exactly what issue #117 flagged as
	 * reading like an error rather than a setup step.
	 *
	 * Agoda over Booking.com as the one named provider: its free tier is 500 requests a
	 * month against Booking's 50 (`$lib/settings/provider-catalog.ts`), generous enough to
	 * price every stopover a single search turns up, so it is the fix that actually removes
	 * the gap rather than one that just moves the limit lower.
	 *
	 * Renders nothing once a stay key already exists: this is about the gap, not a permanent
	 * banner competing with the results for attention once the fix is already in place.
	 */
	import { ErrorState } from '$lib/components';
	import { keyStore } from '$lib/keys';
	import { getProviderRegistry } from '$lib/results/provider-setup';

	const hasStayProvider = $derived(
		getProviderRegistry().usable('stay', keyStore.availableKeys).length > 0
	);
</script>

{#if !hasStayProvider}
	<ErrorState
		severity="warning"
		provider="Agoda"
		title="No stay provider configured"
		message="Stopovers below don't have a bed priced in. Agoda's free tier covers 500 requests a month, plenty for a search like this. Booking.com works too."
	>
		{#snippet action()}
			<a class="settings-link" href="/settings/#agoda">Add an Agoda key</a>
		{/snippet}
	</ErrorState>
{/if}

<style>
	.settings-link {
		font-weight: var(--font-weight-semibold);
	}
</style>
