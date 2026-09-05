<script lang="ts">
	/**
	 * The one way this app draws an icon. Issue #321.
	 *
	 * Before this there was no icon set at all: fifteen components each drew their own
	 * inline `<svg>`, on three different grids (16, 20 and 24), at five stroke widths
	 * between 1.4 and 2. Nobody notices that until two of them sit side by side, and then
	 * it is the only thing you can see. Tabler Icons is one grid at one weight, and this
	 * component is where that weight is stated once instead of per caller.
	 *
	 * The paths come from `data/tabler-icons.generated.ts`, which holds the icons this app
	 * names and nothing else. See `scripts/prepare-icons.mjs` for why they are vendored
	 * rather than imported: an icon package in `dependencies` puts a tree-shaker between
	 * what the source imports and what a visitor downloads, and this app has no backend, so
	 * every byte it ships is a byte somebody waits for.
	 *
	 * ## Sizing, and why this sets none
	 *
	 * `1em`, so an icon dropped beside a line of text is that text's size and needs no rule
	 * at all. Every caller that wants a different one sets `width` and `height` on it from
	 * its own stylesheet, which is what they all did before this existed. Those rules need
	 * `:global(...)` now, because the `<svg>` lives in this component rather than in theirs.
	 *
	 * ## `aria-hidden` by default, on purpose
	 *
	 * Almost every icon in this app sits next to its own word — "Close", "Settings", "Edit
	 * search" — or inside a button that already carries an `aria-label`. Issue #287 settled
	 * that deliberately: a screen reader announcing "close, close" is the only thing a
	 * second label could add. So hidden is the default and `label` is the opt-out, rather
	 * than the other way round, which would make the wrong choice the quiet one.
	 */
	import type { ClassValue } from 'svelte/elements';
	import { TABLER_ICON_PATHS, type IconName } from '$lib/data/tabler-icons.generated';

	interface Props {
		name: IconName;
		/**
		 * What this icon says out loud, for the rare icon that is the only thing saying it.
		 * Absent means decorative, which is the common case: the meaning is already printed
		 * beside it or on the control around it.
		 */
		label?: string;
		class?: ClassValue;
	}

	let { name, label, class: className }: Props = $props();
</script>

<svg
	class={['icon', className]}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="2"
	stroke-linecap="round"
	stroke-linejoin="round"
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
	focusable="false"
>
	{#each TABLER_ICON_PATHS[name] as d (d)}
		<path {d} />
	{/each}
</svg>

<style>
	.icon {
		width: 1em;
		height: 1em;
		flex-shrink: 0;
	}
</style>
