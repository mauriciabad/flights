import type { MapLibreMap } from 'maplibre-gl';

/**
 * Keyless MapLibre basemap. AGENTS.md's no-backend rule leaves nothing to hold an API
 * token, and the map has to render before the user has entered anything, so a style
 * that requires a key is not an option.
 *
 * CARTO has hosted these "Basemaps" vector styles for the open-source mapping
 * community for years with no signup and no key — the same styles MapLibre's own
 * getting-started guide points to. Verified directly (2026-09-04): both `style.json`
 * documents, and every vector tile / sprite / glyph URL they reference, respond
 * without an API key or a `Referer` allowlist. CARTO's newer documentation describes a
 * paid "Basemaps" platform product that does require a key, so this could change
 * without notice — if it ever does, this file is the one place to update; nothing else
 * in `ItineraryMap` holds a hardcoded style URL.
 *
 * Attribution (required either way by CARTO's terms): "© OpenStreetMap contributors,
 * © CARTO", rendered through MapLibre's own `AttributionControl` in
 * `ItineraryMap.svelte` rather than duplicated here.
 */
export const MAP_STYLE_URL = {
	dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
	light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
} as const;

export type ColorScheme = keyof typeof MAP_STYLE_URL;

/** Matches src/app.css's `@media (prefers-color-scheme: light)` override exactly: dark
 *  unless the OS explicitly signals light, never the other way around, so the map
 *  never disagrees with the rest of the app about which scheme "no preference" means. */
export function currentColorScheme(): ColorScheme {
	if (typeof window === 'undefined') return 'dark';
	return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Mirrors --color-accent / --color-stopover from src/app.css for each scheme. MapLibre
 *  paint properties are WebGL uniforms, not CSS — they cannot read a custom property,
 *  so the two tokens this map actually uses are duplicated here as plain hex and must
 *  be kept in sync by hand if app.css's palette ever changes. DOM markers don't have
 *  this problem and use `var(--color-*)` directly (see ItineraryMap.svelte's styles). */
export const SEGMENT_LINE_COLOR = {
	dark: { neutral: '#e8a33d', stopover: '#2dd4bf' },
	light: { neutral: '#8a5407', stopover: '#0f766e' }
} as const satisfies Record<ColorScheme, { neutral: string; stopover: string }>;

/** One MapLibre line layer per (role, tone) pair — four layers, each a single plain
 *  colour. `maplibre-gl` does not export the style-spec's expression types publicly
 *  (only `AddLayerObject`, checked structurally when a layer is created), so a
 *  same-layer, data-driven colour expression would need an unsound cast to type at
 *  all; four small layers sidestep that entirely, since a single hex string is exactly
 *  what `setPaintProperty('line-color', …)` expects with no assertion needed. */
export const ITINERARY_LINE_LAYER_IDS = [
	'itinerary-flights-neutral',
	'itinerary-flights-stopover',
	'itinerary-transfers-neutral',
	'itinerary-transfers-stopover'
] as const;

export type ItineraryLineLayerId = (typeof ITINERARY_LINE_LAYER_IDS)[number];

const LAYER_ID_BY_ROLE_AND_TONE: Record<
	'flight' | 'transfer',
	Record<'neutral' | 'stopover', ItineraryLineLayerId>
> = {
	flight: { neutral: 'itinerary-flights-neutral', stopover: 'itinerary-flights-stopover' },
	transfer: { neutral: 'itinerary-transfers-neutral', stopover: 'itinerary-transfers-stopover' }
};

export function layerIdFor(role: 'flight' | 'transfer', tone: 'neutral' | 'stopover'): ItineraryLineLayerId {
	return LAYER_ID_BY_ROLE_AND_TONE[role][tone];
}

/** Mirrors --color-bg / --color-bg-inset for the two base layers most visually
 *  dominant in either CARTO style, so the map reads as part of this app rather than a
 *  pasted-in generic basemap. Everything else in dark-matter/positron (roads, land,
 *  labels) is already tuned for its own scheme and is left alone. */
const BASE_LAYER_COLOR = {
	dark: { background: '#0b1020', water: '#060912' },
	light: { background: '#f6f7fb', water: '#eceef5' }
} as const satisfies Record<ColorScheme, { background: string; water: string }>;

/**
 * `property` is constrained to the three colour properties this module ever sets, all
 * of which accept a plain CSS colour string — unlike `map.setPaintProperty`'s own
 * fully generic signature, this never needs a data expression, so a bare `string`
 * argument type-checks with no cast onto MapLibre's internal (and not publicly
 * exported) per-property value types.
 *
 * Checks `getLayer` first rather than wrapping the call in try/catch: MapLibre
 * validates a `setPaintProperty` call against the style during the *next* render
 * frame, not synchronously, so a missing-layer error surfaces as an uncaught
 * exception from inside MapLibre's own render loop — after this function's stack
 * frame is long gone, where no try/catch here could ever have caught it anyway.
 */
function trySetColor(
	map: MapLibreMap,
	layerId: string,
	property: 'background-color' | 'fill-color' | 'line-color',
	color: string
): void {
	// The named layer doesn't exist yet (this app's own line layers, before
	// ItineraryMap's first renderModel() call) or was renamed upstream (CARTO's own
	// base layers) — either way, nothing to recolour yet.
	if (!map.getLayer(layerId)) return;
	map.setPaintProperty(layerId, property, color);
}

/**
 * Applies this app's palette on top of a freshly (re)loaded style: retints the base
 * fill and open water, then, if the itinerary line layers already exist, recolours
 * them too. Called once right after `ItineraryMap` adds its own sources/layers, and
 * again after every `map.setStyle()` triggered by an OS colour-scheme change, since
 * `setStyle` restores CARTO's own defaults for anything it re-fetches.
 */
export function applyThemeColors(map: MapLibreMap, scheme: ColorScheme): void {
	const base = BASE_LAYER_COLOR[scheme];
	trySetColor(map, 'background', 'background-color', base.background);
	trySetColor(map, 'water', 'fill-color', base.water);

	const colors = SEGMENT_LINE_COLOR[scheme];
	trySetColor(map, layerIdFor('flight', 'neutral'), 'line-color', colors.neutral);
	trySetColor(map, layerIdFor('flight', 'stopover'), 'line-color', colors.stopover);
	trySetColor(map, layerIdFor('transfer', 'neutral'), 'line-color', colors.neutral);
	trySetColor(map, layerIdFor('transfer', 'stopover'), 'line-color', colors.stopover);
}
