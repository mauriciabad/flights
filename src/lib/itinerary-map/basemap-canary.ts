/**
 * Whether a basemap that answered is a basemap worth drawing (#432).
 *
 * A status code cannot tell you. `basemaps.cartocdn.com/rastertiles/...` answers 200 with a
 * real PNG that has "API KEY REQUIRED" printed across it, and `tile.openstreetmap.org`
 * answers 200 with a picture of a 403. Both were re-measured on 2026-09-07 and both still
 * do. `isStyleLoaded()` is no better: a style document with an empty `layers` array loads
 * clean and draws a blank rectangle, which is what #431 found its snapshot cache keeping.
 *
 * So this reads the picture. Everything here is pure and takes decoded pixels, because the
 * two callers decode differently: `tests/basemap/` photographs a real MapLibre render, and
 * `basemap-canary.test.ts` reads PNGs off disk.
 *
 * ## What the numbers are
 *
 * Measured 2026-09-07 over 32 windows: eight European city centres at zoom 12, each drawn
 * four ways. Clean means the two keyless CARTO vector styles this app loads, rendered
 * through MapLibre. Watermarked means the same eight tiles from CARTO's raster endpoints,
 * which carry the key notice.
 *
 * | population              |  n | inkShare        | lumaSpread      | keyNotice     |
 * | ----------------------- | -- | --------------- | --------------- | ------------- |
 * | clean CARTO renders     | 16 | 0.0272 - 0.2292 | 0.0284 - 0.0935 | 0.000 - 0.227 |
 * | watermarked raster tiles| 16 | 0.0331 - 0.2335 | 0.0612 - 0.0867 | 1.000         |
 * | openstreetmap.org 403   |  1 | 0.1661          | 0.2603          | 0.218         |
 * | style with no layers    |  1 | 0.0000          | 0.0000          | 0.000         |
 * | style with one bg layer |  1 | 0.0000          | 0.0000          | 0.000         |
 *
 * Read the first two rows before trusting a summary statistic here. `inkShare` and
 * `lumaSpread` do not separate a watermarked map from a clean one, and they cannot: CARTO's
 * watermark is text over a genuine, fully drawn map, so by every summary of its own pixels
 * it is a map. The thing that separates them is the recorded notice
 * (`tests/fixtures/basemap/carto-key-notice.png`), which scores 1.000 on all sixteen
 * watermarked tiles and at most 0.227 on a clean render.
 */

/** A window of map, one luminance per pixel in 0..1. */
export interface MapWindow {
	readonly luma: Float64Array;
	readonly width: number;
	readonly height: number;
}

export interface WindowStats {
	/** Share of pixels that differ from the window's own background brightness. */
	readonly inkShare: number;
	/** Standard deviation of luminance across the window. */
	readonly lumaSpread: number;
}

export interface WindowVerdict {
	readonly looksLikeAMap: boolean;
	readonly complaints: readonly string[];
	readonly stats: WindowStats;
	readonly keyNoticeCoverage: number;
}

/**
 * How far a pixel has to sit from the background before it counts as something drawn.
 *
 * Read off the two populations rather than argued. At this threshold the sixteen clean
 * renders ink between 2.7% and 22.9% of their pixels, so `dark-matter`'s faint roads still
 * register, and a style that draws only a background colour inks 0.0%.
 */
const INK_THRESHOLD = 0.08;

/**
 * Every threshold in one place, each one the geometric midpoint of the two populations in
 * the table above rather than a number somebody liked.
 */
export const MAP_WINDOW_LIMITS = {
	/** Below this the window drew nothing. Blank renders measure 0.0000 and the thinnest
	 *  real map 0.0272, so this sits 2.7x under the quietest map measured. */
	minInkShare: 0.01,
	/** Above this the window is a notice, not a map. Real maps reach 0.0935 and the
	 *  openstreetmap.org 403 image is 0.2603; sqrt of the two is 0.156. */
	maxLumaSpread: 0.15,
	/** Above this the window carries the provider's key notice. Watermarked tiles score
	 *  1.000 and the noisiest clean render 0.227; sqrt of the two is 0.476. */
	maxKeyNoticeCoverage: 0.5
} as const;

/** Rec. 709 luma, which is what makes grey text on a pale basemap read as ink. */
export function readMapWindow(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): MapWindow {
	const pixels = width * height;
	if (rgba.length < pixels * 4) {
		throw new Error(`Expected ${pixels * 4} bytes for a ${width}x${height} window, got ${rgba.length}`);
	}
	const luma = new Float64Array(pixels);
	for (let i = 0; i < pixels; i++) {
		luma[i] = (0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) / 255;
	}
	return { luma, width, height };
}

/**
 * The window's background brightness, as the centre of the fullest of 64 histogram bins.
 *
 * A mean would be dragged around by whichever half of the tile is sea, and this number
 * decides what counts as ink. Land and water differ by less than a bin's width in both
 * CARTO styles, so the answer is stable across a coastline.
 */
function backgroundLuma(window: MapWindow): number {
	const bins = new Array<number>(64).fill(0);
	for (const l of window.luma) bins[Math.min(63, Math.max(0, Math.floor(l * 64)))]++;
	let fullest = 0;
	for (let i = 1; i < 64; i++) if (bins[i] > bins[fullest]) fullest = i;
	return (fullest + 0.5) / 64;
}

/** One byte per pixel: 1 where the window drew something over its own background. */
export function inkMask(window: MapWindow): Uint8Array {
	const background = backgroundLuma(window);
	const mask = new Uint8Array(window.luma.length);
	for (let i = 0; i < window.luma.length; i++) {
		mask[i] = Math.abs(window.luma[i] - background) > INK_THRESHOLD ? 1 : 0;
	}
	return mask;
}

export function describeWindow(window: MapWindow): WindowStats {
	const mask = inkMask(window);
	let ink = 0;
	for (const m of mask) ink += m;

	let sum = 0;
	for (const l of window.luma) sum += l;
	const mean = sum / window.luma.length;
	let squares = 0;
	for (const l of window.luma) squares += (l - mean) ** 2;

	return {
		inkShare: ink / window.luma.length,
		lumaSpread: Math.sqrt(squares / window.luma.length)
	};
}

/**
 * How much of a recorded notice the window is drawing, from 0 to 1.
 *
 * The notice is a mask of the pixels every watermarked tile inks no matter what is under
 * them, so a window carrying it inks all of them and a window that does not inks only the
 * few its own roads happen to cross. Comparing masks rather than colours is what survives
 * the watermark being drawn with alpha: over sea it comes out pale and over a park it comes
 * out dark, but it is ink either way.
 */
export function keyNoticeCoverage(window: MapWindow, notice: Uint8Array): number {
	if (notice.length !== window.luma.length) {
		throw new Error(`Notice is ${notice.length} pixels, window is ${window.luma.length}`);
	}
	const mask = inkMask(window);
	let marked = 0;
	let drawn = 0;
	for (let i = 0; i < notice.length; i++) {
		if (!notice[i]) continue;
		marked++;
		if (mask[i]) drawn++;
	}
	if (marked === 0) throw new Error('The recorded notice marks no pixels, so it can measure nothing');
	return drawn / marked;
}

export function judgeWindow(window: MapWindow, notice: Uint8Array): WindowVerdict {
	const stats = describeWindow(window);
	const coverage = keyNoticeCoverage(window, notice);
	const complaints: string[] = [];

	if (stats.inkShare < MAP_WINDOW_LIMITS.minInkShare) {
		complaints.push(
			`drew almost nothing: ${(stats.inkShare * 100).toFixed(2)}% of pixels differ from the ` +
				`background, under the ${MAP_WINDOW_LIMITS.minInkShare * 100}% floor`
		);
	}
	if (stats.lumaSpread > MAP_WINDOW_LIMITS.maxLumaSpread) {
		complaints.push(
			`reads as a notice rather than a map: luminance spread ${stats.lumaSpread.toFixed(4)} ` +
				`over the ${MAP_WINDOW_LIMITS.maxLumaSpread} ceiling`
		);
	}
	if (coverage > MAP_WINDOW_LIMITS.maxKeyNoticeCoverage) {
		complaints.push(
			`carries the recorded key notice: ${(coverage * 100).toFixed(1)}% of it is drawn, over ` +
				`the ${MAP_WINDOW_LIMITS.maxKeyNoticeCoverage * 100}% ceiling`
		);
	}

	return { looksLikeAMap: complaints.length === 0, complaints, stats, keyNoticeCoverage: coverage };
}

/**
 * Query parameters that mean a style has stopped being keyless. Named rather than pattern
 * matched, because `key` alone appears inside perfectly ordinary tile URLs.
 */
const KEY_PARAMETERS = ['api_key', 'apikey', 'access_token', 'accesstoken', 'access-token'];

/** Words a provider uses when it is telling you to go and get a key. */
const KEY_DEMANDS = ['api key required', 'api_key required', 'requires an api key', 'sign up for a key'];

/**
 * What is wrong with a style document, as a list a failing check can print.
 *
 * The text scan is the cheap half of the watermark question and the only half with no false
 * positives. CARTO paints "API KEY REQUIRED" onto its raster tiles today; if the vector
 * styles this app loads ever go the same way, the layer that says so arrives here as JSON
 * before it ever reaches a pixel.
 */
export function complainAboutStyle(document: unknown): string[] {
	const complaints: string[] = [];

	if (typeof document !== 'object' || document === null || Array.isArray(document)) {
		return ['is not a style document at all'];
	}
	const style: Record<string, unknown> = { ...document };

	if (style.version !== 8) complaints.push(`declares style version ${JSON.stringify(style.version)}, not 8`);

	const layers = style.layers;
	if (!Array.isArray(layers)) complaints.push('has no `layers` array');
	else if (layers.length === 0) complaints.push('has an empty `layers` array, so it draws nothing');

	const sources = style.sources;
	if (typeof sources !== 'object' || sources === null || Array.isArray(sources)) {
		complaints.push('has no `sources` object');
	} else if (Object.keys(sources).length === 0) {
		complaints.push('names no sources, so it has no map data to draw');
	}

	const text = JSON.stringify(document).toLowerCase();
	for (const parameter of KEY_PARAMETERS) {
		if (text.includes(`${parameter}=`) || text.includes(`"${parameter}"`)) {
			complaints.push(`wants a key: the document mentions \`${parameter}\``);
		}
	}
	for (const demand of KEY_DEMANDS) {
		if (text.includes(demand)) complaints.push(`says "${demand}"`);
	}

	return complaints;
}
