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
 * One `background` layer, and the layer is the point: `map-snapshot.svelte.ts` refuses to
 * cache a capture from a style with none, so a mock without one quietly stops exercising
 * the picture path. `background` is also the id `applyThemeColors` recolours, so the app's
 * own palette is exercised on the way past.
 *
 * No sources, deliberately. Nothing here requests a tile, so a capture settles at once and
 * a spec about bus fares does not pay for a map it never looks at. That also means the
 * picture is a flat colour rather than a drawing of anywhere, which is enough for "the
 * capture path ran" and not enough for "this looks like a map". The instrument that can
 * tell those apart is `src/lib/itinerary-map/basemap-canary.ts`, and it is pointed at the
 * live basemap rather than at this.
 */
export const FIXTURE_MAP_STYLE = {
	version: 8,
	name: 'fixture',
	sources: {},
	layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#101820' } }]
} as const;

export const FIXTURE_MAP_STYLE_JSON = JSON.stringify(FIXTURE_MAP_STYLE);
