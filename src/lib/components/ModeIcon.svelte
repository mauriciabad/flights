<script lang="ts">
	/**
	 * The one way this app draws "what kind of thing is this step".
	 *
	 * Issue #119, the owner's own words: **"every segment is a coloured dot on a vertical
	 * line. Flight, transfer, waiting and stopover look the same at a glance; only the
	 * heading text tells them apart"** and **"the transport picker is text only for Walk,
	 * Public transport, Drive and Taxi"**. Both are the same missing thing, so both read
	 * from this one file rather than each growing its own glyphs.
	 *
	 * Issue #321 replaced the seven glyphs this used to draw by hand with Tabler's, and the
	 * argument the old header made against a package is the argument for what happened
	 * instead. It said "this app ships five glyphs; a dependency for that is more than the
	 * job needs" — true, and the count was the tell: `Flag`, `Select`, `EmptyState` and a
	 * dozen others were each drawing their own too, on three grids at five stroke widths.
	 * There is no dependency now either. `scripts/prepare-icons.mjs` vendors the named icons
	 * into `data/tabler-icons.generated.ts` and `Icon.svelte` draws them, so this file is a
	 * mapping from a journey step to a name and nothing else.
	 *
	 * What that gave up is real and worth stating: these were airport and station wayfinding
	 * pictograms, chosen so a traveller who has read a walking figure on a sign in an airport
	 * they could not read a word of reads them here without being taught. Tabler's walk, bus,
	 * train, ferry and plane are the same pictograms in another hand. Its car and clock and
	 * bed are ordinary UI icons, and the rail now matches every other icon in the app rather
	 * than being its own small system, which is what #321 was asked for.
	 *
	 * `taxi` is the one Tabler does not have. It is Tabler's own car with a roof sign added
	 * on Tabler's grid; see `COMPOSED_ICONS` in the script for why that beat the two
	 * alternatives.
	 *
	 * `aria-hidden` always, no exceptions and no prop to turn it off. Every place this is
	 * used, the label it sits beside says the same word out loud, so a screen reader
	 * announcing "walk" twice is the only thing this could add. `Icon` hides by default, so
	 * this simply never passes it a label.
	 */
	import Icon from './Icon.svelte';
	import type { IconName } from '$lib/data/tabler-icons.generated';
	import type { ModeIconKind } from './mode-icon';

	interface Props {
		kind: ModeIconKind;
		/** `sm` sits inline with a line of text. `md` is the timeline rail's marker, where
		 * the icon is the only thing in its column and has to carry the row. */
		size?: 'sm' | 'md';
		class?: string;
	}

	let { kind, size = 'sm', class: className }: Props = $props();

	/** One journey step, one Tabler name. `transit` is the bus because that is what the sign
	 *  at every airport bus stop uses for public transport; `mode-icon.ts` explains when a
	 *  transfer earns the more specific rail or ferry instead. */
	const ICON: Record<ModeIconKind, IconName> = {
		walk: 'walk',
		transit: 'bus',
		'transit-rail': 'train',
		'transit-ferry': 'ferry',
		taxi: 'taxi',
		drive: 'car',
		flight: 'plane',
		wait: 'clock',
		stopover: 'bed'
	};
</script>

<Icon name={ICON[kind]} class={['mode-icon', `mode-icon-${size}`, className]} />

<style>
	/* `:global` throughout: the `<svg>` is `Icon.svelte`'s element, not one this component's
	   scoping class lands on. `--icon-size` rather than `width`, and that is load-bearing
	   rather than a preference — this component has no element of its own to hang a scoped
	   ancestor off, so a `width` here would be a one-class selector losing to `Icon`'s own
	   scoped `.icon`, and the rail would draw at 16px while this file said 18. */
	:global(.mode-icon) {
		/* An icon beside a line of text sits on the text's own baseline-ish centre. Without
		   this it hangs below it, since an inline SVG's box is a line box like any other. */
		vertical-align: -0.15em;
	}

	:global(.mode-icon-sm) {
		--icon-size: 0.9375rem;
	}

	:global(.mode-icon-md) {
		--icon-size: 1.125rem;
		vertical-align: 0;
	}
</style>
