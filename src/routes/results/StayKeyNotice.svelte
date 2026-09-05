<script lang="ts">
	/**
	 * Issue #117: the owner's own words, "'No bed priced for this stopover — total excludes
	 * a stay.' ... it is not acceptable that is not avilable." Both stay adapters of the day
	 * (Agoda, Booking.com) were `needsKey: true`, so with no key ever pasted in,
	 * `resources.ts`'s `fetchCheapestStay` filtered them out before a single request went
	 * out (`isProviderUsable`) and every stopover on this page was silently missing a bed
	 * price. Nothing before this notice said why, or what fixed it.
	 *
	 * **That gap is closed, so this notice is now dormant rather than dead.**
	 * `providers/stays/hostelworld.ts` is a keyless stay adapter registered as the baseline,
	 * so `hasUsableStayProvider` is true for a visitor who has configured nothing and this
	 * renders nothing — which is the outcome issue #117 asked for, reached by removing the
	 * cause rather than by explaining it better. It is deliberately kept, and kept keyed on
	 * the same one expression, because the condition it describes is still the true one: if
	 * the keyless baseline is ever unregistered or Hostelworld stops answering for good,
	 * "add a key" becomes the real fix again and this says so without anyone having to
	 * remember to put it back.
	 *
	 * Rendered once per page (`+page.svelte`), not per card: `ResultCard`'s
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
	 *
	 * Issue #185: `severity="info"`, not `"warning"`. This is a first-run setup hint, and
	 * drawn in warning yellow with a warning triangle it outranked the itineraries it sits
	 * under — the loudest thing on a page whose whole job is the list above it. Nothing has
	 * gone wrong when a keyless visitor has no key; something is simply not set up yet.
	 * `ErrorState`'s info treatment keeps the same layout, link and screen-reader politeness
	 * and stops the colour making a claim the words do not.
	 */
	import { ErrorState } from '$lib/components';
	import { keyStore } from '$lib/keys';
	import { hasUsableStayProvider } from '$lib/results/provider-setup';

	// Issue #140: the same expression the expanded card's stay picker uses, so the two can
	// never contradict each other about whether a bed was ever searched for.
	const hasStayProvider = $derived(hasUsableStayProvider(keyStore.availableKeys));
</script>

{#if !hasStayProvider}
	<ErrorState
		severity="info"
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
