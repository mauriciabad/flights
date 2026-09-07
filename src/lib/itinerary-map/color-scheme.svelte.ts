import { browser } from '$app/environment';
import { currentColorScheme, type ColorScheme } from './style';

/**
 * Which CARTO basemap the app is asking for, kept current as the OS scheme changes.
 *
 * `style.ts`'s `currentColorScheme()` reads the media query once, which is all MapLibre
 * needs: `ItineraryMap` holds one instance and installs its own listener beside it. The
 * ground-leg previews are the other case. Half a dozen of them are on screen at a time,
 * none of them owns a map, and each has to swap every tile it is showing when someone
 * turns dark mode off. One module-level rune and one listener serves all of them; one
 * listener per preview would be six answers to a question with one answer.
 *
 * ## The write happens in the callback and nowhere else
 *
 * `land-tiles.svelte.ts`'s header records what this rule is protecting. An `$effect` that
 * calls an async function without awaiting it runs the function's synchronous prefix on
 * the effect's own call stack, Svelte tracks dependencies by call stack, and a rune
 * written there makes the effect its own dependency. That took production down once with
 * `effect_update_depth_exceeded`.
 *
 * Nothing here writes a rune during a read. The initial value is computed once while this
 * module is being evaluated, before any component exists to read it; after that the only
 * assignment is inside a `change` event, which fires on an empty effect stack.
 *
 * The listener is never removed, deliberately. It is one listener for the life of the
 * page, on a media query the app is interested in for exactly that long.
 */
// `browser` alone is not the condition, and it is not enough for `currentColorScheme`
// either. Vitest runs with jsdom, where `browser` is true, `window` exists and
// `matchMedia` does not, so the `typeof window === 'undefined'` check inside
// `currentColorScheme` waves it straight through. Both lines below run while this module
// is being evaluated: unguarded, importing anything that imports this throws before a
// single test runs.
const observable = browser && typeof window.matchMedia === 'function';

let scheme = $state<ColorScheme>(observable ? currentColorScheme() : 'dark');

if (observable) {
	// The same query `currentColorScheme` reads, and the same asymmetry: dark unless the
	// OS explicitly signals light, matching src/app.css's own override.
	window
		.matchMedia('(prefers-color-scheme: light)')
		.addEventListener('change', (event) => (scheme = event.matches ? 'light' : 'dark'));
}

/** The current scheme, as reactive state. Safe to call from inside a `$derived`: this
 *  reads and never writes. */
export function colorScheme(): ColorScheme {
	return scheme;
}
