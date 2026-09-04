import type { ComparedItinerary } from '../components/comparator-types';

/**
 * Issue #103: carries "which itineraries the traveller chose to compare" from the results
 * list (`routes/results/+page.svelte`) to the comparator route
 * (`routes/comparator/+page.svelte`) across a client-side navigation, which unmounts the
 * results page's whole component tree. A plain component-local `$state` cannot survive
 * that, which is exactly the case AGENTS.md's "reach for a store only when state genuinely
 * has to outlive a component tree" carve-out is for — same reasoning as `$lib/keys`'
 * `KeyStore`, mirrored here as a class-singleton rather than a bare module-level `$state`
 * so a test can construct a second instance without fighting the shared singleton.
 *
 * Deliberately a snapshot, not a live reference: leaving `/results/` cancels that page's
 * own search (`+page.svelte`'s effect cleanup aborts its `AbortController`), so there is
 * nothing live left to mirror anyway. Reloading `/comparator/` directly loses this the same
 * way every other in-memory search result in this app is lost on reload — `?demo=1` stays
 * the one reload-stable path (`tests/e2e/comparator.spec.ts`).
 */
export class ComparisonSelectionStore {
	#items = $state<ComparedItinerary[]>([]);

	get items(): ComparedItinerary[] {
		return this.#items;
	}

	set(items: ComparedItinerary[]): void {
		this.#items = items;
	}

	clear(): void {
		this.#items = [];
	}
}

export const comparisonSelection = new ComparisonSelectionStore();
