/**
 * `Icon.svelte`, as a string, for the one caller that cannot mount a component.
 *
 * MapLibre takes a marker as a DOM element it owns and positions itself, and
 * `ItineraryMap` fills that element with `innerHTML`. No Svelte component can render into
 * it, so the three map glyphs (a house, a bed, a flag) were hand-drawn on their own 16-unit
 * grid at their own stroke weight while the rest of the app moved to Tabler in issue #321.
 * Two of the three concepts were already drawn a second time elsewhere from the vendored
 * set, which is the drift #321 exists to remove: the timeline's stopover night and the map
 * pin under it were two different beds.
 *
 * The obvious objection to a second renderer is that it drifts from the first. Answered by
 * `icon-markup.test.ts`, which mounts `Icon.svelte` and compares the two element for
 * element and attribute for attribute, so a change to the component's weight, grid or caps
 * that this file does not follow fails the unit suite.
 *
 * Decorative only. Every glyph this produces goes inside an element that already carries
 * the name a screen reader reads, so there is no `label` here and no way to ask for one.
 */
import { TABLER_ICON_PATHS, type IconName } from '$lib/data/tabler-icons.generated';

export function iconMarkup(name: IconName): string {
	const paths = TABLER_ICON_PATHS[name].map((d) => `<path d="${d}"></path>`).join('');
	return (
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
		' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
		paths +
		'</svg>'
	);
}
