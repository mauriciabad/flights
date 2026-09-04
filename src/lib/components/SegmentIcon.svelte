<script module lang="ts">
	/**
	 * Issue #119: "Flight, train, bus, walk, taxi and hotel are all text today. This is a
	 * timeline of a journey and should read at a glance." One glyph per kind of step, so a
	 * traveller scanning the timeline recognises the shape of their trip before reading a
	 * single word.
	 *
	 * Built from plain SVG primitives (line/circle/rect/polygon), matching the nav icons
	 * already hand-drawn in `+layout.svelte` — no icon library, no licence to track, no
	 * external request that could 404. `TransferMode` has no separate "train" vs "bus"
	 * literal (`TransferLeg.description` is free text, e.g. "Bus 100 to City Airport
	 * Station" — not a machine-readable field), so `transit` gets one glyph for public
	 * transport in general rather than a guess at which vehicle a provider's free text
	 * happens to name. `taxi` and `drive` share the same car silhouette; the taxi's roof
	 * light is the one thing that tells them apart, same as it would on a real street.
	 */
	import type { TransferMode } from '../domain';

	export type SegmentKind = TransferMode | 'flight' | 'hotel';
</script>

<script lang="ts">
	interface Props {
		kind: SegmentKind;
		class?: string;
	}

	let { kind, class: className }: Props = $props();
</script>

<svg
	class={className}
	viewBox="0 0 24 24"
	fill="none"
	aria-hidden="true"
	focusable="false"
>
	{#if kind === 'flight'}
		<!-- A paper-plane dart: the one glyph every departure board already uses for
		     "flight", so it needs no learning curve. -->
		<polygon
			points="3,11 21,3 14,21 11,13 3,11"
			stroke="currentColor"
			stroke-width="2"
			stroke-linejoin="round"
		/>
		<line x1="11" y1="13" x2="21" y2="3" stroke="currentColor" stroke-width="2" />
	{:else if kind === 'walk'}
		<circle cx="12" cy="4.5" r="1.75" fill="currentColor" />
		<line x1="12" y1="7.5" x2="11" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
		<line x1="11" y1="13" x2="8" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
		<line x1="11" y1="13" x2="15" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
		<line x1="12" y1="9" x2="16" y2="10.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
		<line x1="12" y1="9" x2="9" y2="7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
	{:else if kind === 'transit'}
		<rect x="4" y="6" width="16" height="10" rx="2" stroke="currentColor" stroke-width="2" />
		<line x1="4" y1="11" x2="20" y2="11" stroke="currentColor" stroke-width="2" />
		<line x1="9" y1="6" x2="9" y2="11" stroke="currentColor" stroke-width="2" />
		<line x1="15" y1="6" x2="15" y2="11" stroke="currentColor" stroke-width="2" />
		<circle cx="8" cy="18" r="1.5" fill="currentColor" />
		<circle cx="16" cy="18" r="1.5" fill="currentColor" />
	{:else if kind === 'taxi' || kind === 'drive'}
		<polyline
			points="3,17 5,11 8,8 16,8 19,11 21,17"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
		<line x1="3" y1="17" x2="21" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
		<circle cx="7.5" cy="17" r="1.6" fill="currentColor" />
		<circle cx="16.5" cy="17" r="1.6" fill="currentColor" />
		{#if kind === 'taxi'}
			<!-- The roof light is the only thing distinguishing a taxi from an ordinary
			     drive: same car, one added mark, same as on a real street. -->
			<rect x="10.5" y="5.5" width="3" height="2" rx="0.5" fill="currentColor" />
		{/if}
	{:else if kind === 'hotel'}
		<rect x="3" y="14" width="18" height="5" rx="1" stroke="currentColor" stroke-width="2" />
		<rect x="5" y="10" width="6" height="4" rx="1" fill="currentColor" />
		<line x1="3" y1="10" x2="3" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
		<line x1="3" y1="21" x2="3" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
		<line x1="21" y1="21" x2="21" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
	{/if}
</svg>
