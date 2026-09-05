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
	 * Drawn as airport and station wayfinding pictograms, not as a generic UI icon set.
	 * That is the tradition this app's subject already lives in: a traveller has read the
	 * walking figure and the bus front on a sign in an airport they could not read a word
	 * of, and reads them here without being taught. It also keeps the app's look its own
	 * rather than the stock icon-library look every other product wears.
	 *
	 * No icon package. This app ships five glyphs; a dependency for that is more than the
	 * job needs, and `Flag`, `Select` and `ItineraryMap` already draw their own SVG. Every
	 * path is on a 16-unit grid and paints in `currentColor`, so a caller colours an icon
	 * by colouring its text, and the deprioritised treatment carries over untouched.
	 *
	 * `aria-hidden` always, no exceptions and no prop to turn it off. Every place this is
	 * used, the label it sits beside says the same word out loud, so a screen reader
	 * announcing "walk" twice is the only thing this could add.
	 */

	/** `flight`, `wait` and `stopover` are timeline step kinds; the other four are exactly
	 * `TransferMode`. One union rather than two components because the timeline draws a
	 * transfer step with a mode icon and a flight step with a plane, side by side in the
	 * same rail, and they have to be the same size and weight or the rail reads as two
	 * systems. */
	export type ModeIconKind = 'walk' | 'transit' | 'taxi' | 'drive' | 'flight' | 'wait' | 'stopover';

	interface Props {
		kind: ModeIconKind;
		/** `sm` sits inline with a line of text. `md` is the timeline rail's marker, where
		 * the icon is the only thing in its column and has to carry the row. */
		size?: 'sm' | 'md';
		class?: string;
	}

	let { kind, size = 'sm', class: className }: Props = $props();
</script>

<svg
	class={['mode-icon', `mode-icon-${size}`, className]}
	viewBox="0 0 16 16"
	fill="none"
	stroke="currentColor"
	stroke-width="1.4"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
	focusable="false"
>
	{#if kind === 'walk'}
		<!-- The wayfinding walking figure, cut to what survives at 14px: a head, a torso
		     that leans into the stride, and two legs mid-step. The arms are one stroke,
		     since two at this size close up into a blob. -->
		<circle cx="9.1" cy="2.6" r="1.5" fill="currentColor" stroke="none" />
		<path d="M9.3 5.1 7.4 8l2.4 1.6.7 4.3" />
		<path d="M7.4 8 5.6 14" />
		<path d="M9.1 5.6 11.9 7" />
	{:else if kind === 'transit'}
		<!-- A bus seen head on, which is what the sign at every airport bus stop uses: two
		     windows, a bumper and two wheels below it. Seen from the side it needs a
		     length this box does not have. -->
		<rect x="3.2" y="1.9" width="9.6" height="9.4" rx="2" />
		<path d="M3.2 5.9h9.6" />
		<path d="M5.5 8.7h.01M10.5 8.7h.01" stroke-width="1.8" />
		<path d="M5.2 11.3v1.6M10.8 11.3v1.6" />
	{:else if kind === 'drive' || kind === 'taxi'}
		<!-- One car, drawn once. Taxi is the same silhouette with the roof sign on top,
		     which is the only thing that tells them apart on a real street either. -->
		{#if kind === 'taxi'}
			<rect x="6.1" y="0.9" width="3.8" height="2" rx="0.6" fill="currentColor" stroke="none" />
		{/if}
		<path d="M2.4 12.2V9.4l1.7-4a1 1 0 0 1 .9-.6h6a1 1 0 0 1 .9.6l1.7 4v2.8" />
		<path d="M2.4 9.4h11.2" />
		<circle cx="4.9" cy="12.2" r="1.3" />
		<circle cx="11.1" cy="12.2" r="1.3" />
	{:else if kind === 'flight'}
		<!-- The departures-board plane: nose up, seen from above, the shape that has meant
		     "flight" on a sign since before this app existed. -->
		<path d="M8 1.2c.8 0 1.3 1 1.3 2.2v2.3l4.7 2.8v1.6l-4.7-1.4v2.6l1.6 1.2v1.3L8 13.1l-2.9.7v-1.3l1.6-1.2V8.7L2 10.1V8.5l4.7-2.8V3.4C6.7 2.2 7.2 1.2 8 1.2Z" />
	{:else if kind === 'wait'}
		<!-- A clock, hands at a quarter past ten, which is the angle every watch photo
		     uses because it keeps both hands clear of each other at any size. -->
		<circle cx="8" cy="8.2" r="5.7" />
		<path d="M8 4.9v3.3l2.4 1.4" />
	{:else if kind === 'stopover'}
		<!-- A hotel bed, side on: the pillow end, the mattress, and one leg at each end.
		     The stopover is the night you are being given, so it gets the bed. -->
		<path d="M2 4.4v6.4M2 7.6h12v3.2M14 10.8v1.8M2 10.8v1.8" />
		<path d="M4.6 7.6V6.2h4.1a1.7 1.7 0 0 1 1.7 1.4" />
	{/if}
</svg>

<style>
	.mode-icon {
		flex-shrink: 0;
		/* An icon beside a line of text sits on the text's own baseline-ish centre. Without
		   this it hangs below it, since an inline SVG's box is a line box like any other. */
		vertical-align: -0.15em;
	}

	.mode-icon-sm {
		width: 0.9375rem;
		height: 0.9375rem;
	}

	.mode-icon-md {
		width: 1.125rem;
		height: 1.125rem;
		vertical-align: 0;
	}
</style>
