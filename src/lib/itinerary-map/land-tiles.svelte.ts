/**
 * The fine coast and the fine borders under a ground-leg preview, fetched per region
 * (issue #408).
 *
 * The owner: "the inerte Maps don't show the water and land in different colors, they are
 * a solid gray always (in some searches they work)". Every ground leg is a few kilometres
 * across and the vendored outline places a coast 6.8 km out, so `land.ts` refused to draw
 * one into any of them and filled the box instead. That refusal is right; what was wrong
 * was having nothing better to offer.
 *
 * `scripts/prepare-land-tiles.mjs` writes what is better: the same Natural Earth source at
 * 222 m instead of 5.5 km, cut to the one-degree cells a traveller can actually stand in
 * and grouped into 5° blocks. The whole set is 762 kB gzipped and none of it is bundled.
 * A preview asks for the one block its window falls in — a median of 389 B — and a results
 * page asks for about three, one per city the trip touches.
 *
 * ## Reading this from a `$derived` without hanging the page
 *
 * `known-airports.svelte.ts` already had this problem and solved it, and this is that
 * shape again: module state, a plain non-reactive `Set` of what has been asked for, and a
 * `$state` write that happens only inside `.then()`.
 *
 * The care is not incidental. `AGENTS.md` records a production outage from an `$effect`
 * calling an async function without awaiting it: Svelte tracks dependencies by call stack,
 * so the function's *synchronous prefix* writing state the effect reads makes the effect
 * its own dependency, and it retriggers until `effect_update_depth_exceeded`. Nothing here
 * writes a rune synchronously. `started` is a plain `Set`, `fetch` is called and dropped,
 * and `blocks[key] = ...` runs a microtask later on an empty effect stack.
 *
 * So a preview renders the honest solid fill first and the real coast when it lands, which
 * is this app's "stale first, then fresh" rule applied to a picture.
 */
import { base } from '$app/paths';
import { browser } from '$app/environment';
import {
	LAND_TILE_ALL_LAND,
	LAND_TILE_ALL_SEA,
	LAND_TILE_BLOCK_DEGREES,
	LAND_TILE_BLOCKS,
	LAND_TILE_GRID_DEGREES,
	LAND_TILE_VERSION
} from '$lib/data/land-tiles.generated';
import { decodeRing, RING_SEPARATOR } from './coastline-codec';
import { mercatorY } from './geo';

/**
 * One cell's worth of geography, already in the units `projectToBox` works in: longitude
 * by `mercatorY`, so the per-vertex trig is paid once for the session rather than once per
 * card, exactly as the vendored outline does it.
 */
export interface LandCell {
	/**
	 * The coast in this cell. `'land'` and `'sea'` are not absences — they are the answer
	 * for a cell no coastline crosses, and they are what lets an inland preview fill solid
	 * and know it is right rather than fill solid because it knows nothing.
	 */
	readonly coast: readonly Float64Array[] | 'land' | 'sea';
	/** Country boundaries crossing this cell. Open polylines, never filled. */
	readonly borders: readonly Float64Array[];
}

/** A block that has been fetched and holds no record for a cell answers `null` for it,
 *  which means "outside the area these tiles cover" and never "no land here". */
type Block = ReadonlyMap<string, LandCell> | null;

const COLUMNS = 360 / LAND_TILE_BLOCK_DEGREES;
const ROWS = 180 / LAND_TILE_BLOCK_DEGREES;

let blocks = $state<Record<string, Block>>({});

/**
 * Which blocks have been asked for, and a plain `Set` rather than a `SvelteSet` on
 * purpose. `svelte-autofixer` flags both this and the `Map` in `parseBlock` and is wrong
 * about both, so here is why before someone takes the suggestion.
 *
 * This one is the whole safety argument in the header. `landCell` is called from inside a
 * `$derived`, and it writes to this set synchronously. Reactive, that write would be the
 * derived changing something it just read, which is the `effect_update_depth_exceeded`
 * loop that took production down once already. Nothing may make it reactive.
 *
 * The `Map` is the opposite argument: Svelte does not proxy a `Map`, so a block's
 * thousands of coordinates stay plain `Float64Array`s with no signal each. A `SvelteMap`
 * would add one per cell for a value that is never mutated — it is built once and assigned
 * whole, and assigning `blocks[key]` is what a reader is subscribed to.
 */
const started = new Set<string>();

/** Whether a block exists at all, straight off the bundled manifest, so a window over open
 *  ocean or a desert no airport serves asks for nothing rather than asking for a 404. */
function blockExists(bx: number, by: number): boolean {
	const column = bx + COLUMNS / 2;
	const row = by + ROWS / 2;
	if (column < 0 || column >= COLUMNS || row < 0 || row >= ROWS) return false;
	return LAND_TILE_BLOCKS[row * COLUMNS + column] === '1';
}

function decodeParts(encoded: string): Float64Array[] {
	if (encoded === '') return [];
	return encoded.split(RING_SEPARATOR).map((part) => {
		const steps = decodeRing(part);
		const points = new Float64Array(steps.length);
		for (let i = 0; i < steps.length; i += 2) {
			points[i] = steps[i] * LAND_TILE_GRID_DEGREES;
			points[i + 1] = mercatorY(steps[i + 1] * LAND_TILE_GRID_DEGREES);
		}
		return points;
	});
}

/** `<cell x>,<cell y>|<coast>|<borders>` per line, coast being either encoded rings or one
 *  of the two single-character answers for a cell no coastline crosses. */
function parseBlock(body: string): Map<string, LandCell> {
	const cells = new Map<string, LandCell>();
	for (const line of body.split('\n')) {
		if (line === '') continue;
		const [key, coast, borders] = line.split('|');
		if (key === undefined || coast === undefined) continue;
		cells.set(key, {
			coast:
				coast === LAND_TILE_ALL_LAND
					? 'land'
					: coast === LAND_TILE_ALL_SEA
						? 'sea'
						: decodeParts(coast),
			borders: decodeParts(borders ?? '')
		});
	}
	return cells;
}

/**
 * The cell at these whole-degree coordinates: `undefined` while its block is still on the
 * way, `null` where no tile covers it.
 *
 * Starting the fetch on first read rather than from an `$effect` is deliberate. It keeps
 * every write to reactive state behind an await boundary (see this file's header), and it
 * means a `$derived` subscribes to exactly the blocks it looked at.
 */
export function landCell(x: number, y: number): LandCell | null | undefined {
	const bx = Math.floor(x / LAND_TILE_BLOCK_DEGREES);
	const by = Math.floor(y / LAND_TILE_BLOCK_DEGREES);
	if (!blockExists(bx, by)) return null;

	const key = `${bx}_${by}`;
	if (!started.has(key) && browser) {
		started.add(key);
		void fetch(`${base}/land/${key}.txt?v=${LAND_TILE_VERSION}`)
			.then((response) => (response.ok ? response.text() : null))
			.then(
				(body) => {
					blocks[key] = body === null ? null : parseBlock(body);
				},
				() => {
					// A tile that cannot be fetched is a preview that keeps the honest fill,
					// which is what it was showing anyway. Nothing here is worth an error to
					// a traveller, and `null` stops it being asked for again.
					blocks[key] = null;
				}
			);
	}

	const block = blocks[key];
	if (block === undefined) return undefined;
	if (block === null) return null;
	return block.get(`${x},${y}`) ?? null;
}

/** Test seam: drops every fetched block so a test can assert the un-upgraded picture. */
export function forgetLandTiles(): void {
	blocks = {};
	started.clear();
}
