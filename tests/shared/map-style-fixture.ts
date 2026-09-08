import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ColorScheme } from '../../src/lib/itinerary-map/style';

/**
 * The basemap style both suites answer `basemaps.cartocdn.com` with, in one place because
 * thirty-six copies of it stopped agreeing.
 *
 * Every copy said `layers: []`, and that is not a map. It fetches with a 200, MapLibre
 * loads it, `isStyleLoaded()` answers true, and what it draws is a blank rectangle. The
 * ground previews photographed that blank and cached it until #431, and every assertion
 * those specs made about a picture passed against the fallback drawing rather than the
 * feature (#433).
 *
 * #433 gave it one `background` layer, which got the capture path running end to end:
 * `map-snapshot.svelte.ts` refuses to cache a capture from a style with no layers. What it
 * drew was still a flat colour, and a flat colour measures 0.0000 ink and 0.0000 luminance
 * spread, exactly what the layerless style measures. So no spec in `pnpm test:e2e` could
 * tell a map from a fill (#443).
 *
 * ## What it draws now
 *
 * A street grid, from a 256x256 PNG carried in the style document as a `data:` URL. Nothing
 * here touches the network: a `data:` tile is decoded by the browser, so a spec about bus
 * fares still pays no request for a map it never looks at, and a capture settles in about
 * 430ms against 310ms for the flat one (`tools/probe-fixture-basemap.mjs`).
 *
 * A raster tile rather than inline `geojson`, because the picture has to ink at *any*
 * camera. `cameraForFrame` turns a leg's span into a zoom, so the app asks for anything from
 * z5 over a continent to z24 over a one-metre walk, anywhere on Earth. Geometry fine enough
 * to cross a z24 window would be a graticule of hundreds of thousands of lines; one tile
 * repeated costs 1.3kB and draws at every zoom and every place.
 *
 * Measured over both schemes and seven cameras from z4.6 to z24.6, land and open sea. Across
 * those 14 windows it inks 0.0546 to 0.0891 of its pixels at a luminance spread of 0.0396 to
 * 0.0720. The floor is 0.01 and the ceiling 0.15, so it clears both by a factor of five and
 * of two, and it sits inside the range sixteen real CARTO renders measured
 * (`basemap-canary.ts` holds that table).
 *
 * Every figure in those two sentences is recorded rather than transcribed (#469).
 * `tools/probe-fixture-basemap.mjs` writes them into `tests/fixtures/basemap/fixture-range.tsv`
 * and `basemap-canary.test.ts` reads this comment and that file and fails on any one that
 * disagrees, so a run of the probe is the only thing that can move a number here. The date of
 * the run went into that file with them. A date in prose is the same kind of claim as the
 * range was, true on the day somebody typed it and unchecked ever after.
 *
 * `maxzoom: 24` is measured, not guessed. At the MapLibre default of 22 the tile is stretched
 * past z22 and inks 0.0000 by z25; at 26 the source never goes idle at all past z22 and draws
 * nothing. 24 holds from z4.6 to z25.
 *
 * ## One document per scheme, because that is what CARTO serves
 *
 * The app asks for `dark-matter` or `positron` by URL (`MAP_STYLE_URL`), and those are two
 * differently coloured maps. One fixture answering both puts a dark map behind a light page,
 * which is what `docs/screenshots/324-stays-375-light.png` photographed the first time this
 * fixture drew anything at all. `ItineraryMap` hides that by recolouring `background` itself
 * once its map fires `load`, but `StaysMap` and `ConnectionsMap` never call
 * `applyThemeColors`, so for them the document's own colour is the ground.
 *
 * The grid is one mid grey at 60% alpha in both, which is why the tile is transparent between
 * its lines rather than opaque. The same drawing has to read against #0b1020 and against
 * #f6f7fb, and letting the `background` layer through is what makes that one tile instead of
 * two.
 *
 * The instrument that says whether any of this is a map is
 * `src/lib/itinerary-map/basemap-canary.ts`, the same one pointed at the live basemap.
 * `tools/probe-fixture-basemap.mjs` re-takes the measurements above and redraws the tile.
 */
const tile = readFileSync(
	path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		'..',
		'fixtures',
		'basemap',
		'fixture-street-grid.png'
	)
);

/** Mirrors `BASE_LAYER_COLOR` in `src/lib/itinerary-map/style.ts`, which is what
 *  `applyThemeColors` paints over this wherever the caller is `ItineraryMap`. */
const GROUND = { dark: '#0b1020', light: '#f6f7fb' } as const satisfies Record<ColorScheme, string>;

export function fixtureMapStyle(scheme: ColorScheme) {
	return {
		version: 8,
		name: `fixture-${scheme}`,
		sources: {
			'street-grid': {
				type: 'raster',
				tiles: [`data:image/png;base64,${tile.toString('base64')}`],
				tileSize: 256,
				maxzoom: 24
			}
		},
		layers: [
			{ id: 'background', type: 'background', paint: { 'background-color': GROUND[scheme] } },
			{ id: 'street-grid', type: 'raster', source: 'street-grid' }
		]
	} as const;
}

/**
 * Which of the two styles the app asked for. Anything else is answered dark, because dark is
 * what `currentColorScheme` answers when the OS signals no preference.
 *
 * Matched on CARTO's slug rather than against `MAP_STYLE_URL` itself, because `tools/` and
 * `scripts/` load this module through bare Node, where an extensionless relative import into
 * `src/` does not resolve. The type-only import above is erased before it can be one.
 * `basemap-canary.test.ts` pins both slugs against the real constant, so a change to either
 * URL fails a test rather than silently answering every request dark.
 */
export function fixtureMapStyleFor(styleUrl: string) {
	return fixtureMapStyle(styleUrl.includes('positron') ? 'light' : 'dark');
}
