<script lang="ts">
	/**
	 * Test-only wrapper for issue #189, in the exact shape `results/FilterPanel.svelte` uses:
	 * a parent that owns the set of chosen facets and derives every chip's `selected` from
	 * it, plus an `onclick` that rewrites that set.
	 *
	 * A `.ts` test cannot author this. The defect only appears when the parent's write and
	 * the chip's own re-render happen inside one click, so both halves have to live in a
	 * compiled component, the same reason `ItineraryTimelineSelectionHarness.svelte` exists.
	 */
	import Chip from './Chip.svelte';

	interface Props {
		values: string[];
	}

	let { values }: Props = $props();

	let chosen = $state<ReadonlySet<string>>(new Set());

	/** What the parent believes, so a test can tell "the filter applied but the chip stayed
	 * mute" apart from "nothing happened at all". Those two look identical from the DOM. */
	export function currentChosen(): ReadonlySet<string> {
		return chosen;
	}

	function toggle(value: string) {
		const next = new Set(chosen);
		if (next.has(value)) next.delete(value);
		else next.add(value);
		chosen = next;
	}
</script>

{#each values as value (value)}
	<Chip interactive selected={chosen.has(value)} onclick={() => toggle(value)}>{value}</Chip>
{/each}
