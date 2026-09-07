/**
 * One hidden MapLibre instance for the whole page, drawing each ground-leg preview's
 * window once and handing back a PNG.
 *
 * The owner, on the three ground previews: "they should use a normal map but inert. the
 * current map has no ptecision and shows no roads". A picture of the real map is inert by
 * construction, and it is the same map: `MAP_STYLE_URL` here is the style the dialog
 * loads, so a preview and the map it opens are one basemap drawn twice.
 *
 * ## Why a snapshot rather than the two obvious answers
 *
 * A live instance per preview is measured and refused. `tools/probe-map-cost.mjs` renders
 * four per card on a throttled 375px phone: sixteen take 12.6s with 10.3s of blocking,
 * and twenty never settle, because Chromium holds sixteen WebGL contexts and evicts the
 * oldest past that. Scrolling back to card one would find blank rectangles.
 *
 * CARTO's raster tiles are the other answer and they are worse than they look. The
 * `rastertiles` endpoints answer 200 with a real PNG carrying "API KEY REQUIRED" stamped
 * diagonally across it, so a status check passes and the map is ruined; the same shape of
 * trap sits behind `tile.openstreetmap.org`, whose 200 is a picture of a 403. The vector
 * style needs no key and is already in production here.
 *
 * Measured on this design, headless Chromium at dpr 2, a 120x88 box: the first window
 * settles in 1272ms and every window after it on the same instance in about 215ms, so
 * the instance is worth keeping alive between captures and expensive to build per
 * capture. `map.remove()` takes the page's canvas count back to zero.
 *
 * ## Why the capture is bigger than the box
 *
 * MapLibre sizes labels in CSS pixels, so a 120px-wide map gets the same "VIENNA" a
 * full-screen one does and the word covers the leg. The first build of this shipped
 * previews reading "ENNA" and "ROPE", which is a feature that looks broken.
 *
 * So the hidden container is `SUPERSAMPLE` times the preview's box in each direction and
 * the same bounds are fitted into it. The geography does not move, because the bounds are
 * what fixes it and MapLibre takes the extra `log2(SUPERSAMPLE)` of zoom to cover them.
 * What changes is that a label drawn at its normal pixel size sits on a picture that is
 * then scaled down into the box, so it comes out at 1/N of the apparent size. The device
 * pixel ratio still multiplies on top, so a phone gets N x dpr real pixels per box pixel.
 *
 * ## Reading a snapshot from a `$derived` without hanging the page
 *
 * This is `land-tiles.svelte.ts`'s shape again, and its header records the outage the
 * shape is protecting against: an `$effect` calling an async function without awaiting it
 * runs that function's synchronous prefix on the effect's own call stack, Svelte tracks
 * dependencies by call stack, and a rune written there makes the effect its own
 * dependency until `effect_update_depth_exceeded`.
 *
 * So `asked` is a plain `Set`, `queue` a plain array, `draining` a plain boolean, and the
 * only reactive write in the file is `snapshots[key] = …` inside `drain`, past an await.
 * Nothing a `$derived` calls here writes a rune on its stack.
 *
 * A window that is not ready yet answers `undefined` and starts the work, which is this
 * app's "stale first, then fresh" rule: the preview shows the solid fill it always showed
 * and swaps in the map when it lands.
 */
import { browser } from '$app/environment';
import { colorScheme } from './color-scheme.svelte';
import { inverseMercatorY, type PreviewFrame } from './geo';
import { applyThemeColors, MAP_STYLE_URL, type ColorScheme } from './style';
import type { MapLibreMap } from 'maplibre-gl';

/** Where a captured window sits and how far in, in MapLibre's own camera terms. */
export interface SnapshotCamera {
	center: [longitude: number, latitude: number];
	zoom: number;
}

/** MapLibre's world is `512 * 2 ** zoom` pixels across and covers 360° of longitude, and
 *  its y axis uses the same units per pixel as its x axis. That is the whole conversion
 *  below, and it is also why a `PreviewFrame` can drive it at all: `projectToBox` scales
 *  longitude and `mercatorY` by one factor, so the rectangle it reports has the box's own
 *  aspect ratio and one zoom fits both axes. */
const TILE_SIZE = 512;

/**
 * How many times the preview's box the map is actually drawn at, before the picture is
 * scaled back down into it. See the header for why a small map needs this at all.
 *
 * Three, read off the pictures rather than picked. The box is 120 units wide and renders
 * anywhere from about 92px on a 375px phone to about 205px on a 1280px screen, so the
 * desktop row is where a label is largest against its picture and where crowding shows
 * first. At one, "VIENNA" ran past both edges and read "ENNA". At two it still lost its
 * first letter at 1280. At three every city and country name sits inside its own
 * thumbnail, and a dpr-2 phone still gets 720x528 real pixels for an 88px-tall box, which
 * is more than enough for the roads the owner asked for.
 */
export const SUPERSAMPLE = 3;

/**
 * The zoom the hidden map is allowed to reach, past MapLibre's own default of 22.
 *
 * The ceiling exists because clamping would silently frame a different window from the one
 * the route is drawn against, which is the one thing these pictures may not do. Past 22
 * CARTO has no deeper tile and MapLibre stretches the last one, which is blurrier and
 * still in the right place, so overshooting the tile set costs nothing that matters.
 *
 * 26 rather than 24 because `SUPERSAMPLE` adds `log2(SUPERSAMPLE)` to every zoom, and the
 * headroom has to survive that. `map-snapshot.test.ts` checks the tightest leg this app
 * can produce against it rather than trusting the arithmetic here.
 */
export const MAX_CAPTURE_ZOOM = 26;

/**
 * The camera that puts exactly this frame in a box this many CSS pixels wide.
 *
 * Exact rather than close: the route is drawn over the picture by `RoutePreview` against
 * the same frame, so a zoom half a level out would leave the roads and the road the
 * traveller is being shown a few hundred metres apart. A frame with no width has no
 * camera and says so.
 */
export function cameraForFrame(frame: PreviewFrame, width: number): SnapshotCamera | undefined {
	const span = frame.east - frame.west;
	if (!(span > 0) || !(width > 0)) return undefined;
	return {
		center: [(frame.west + frame.east) / 2, inverseMercatorY((frame.south + frame.north) / 2)],
		zoom: Math.log2((width * 360) / (span * TILE_SIZE))
	};
}

/**
 * Everything that changes the pixels, and nothing else.
 *
 * The cache is what makes this cheap. Every card in one search shares an origin window
 * and a destination window, so a five-card page asks for a handful of distinct keys
 * rather than fifteen captures.
 *
 * Rounded before it is written, because a key built from raw floats is a key that misses:
 * two runs of the same arithmetic agree bit for bit, but nothing guarantees that across
 * two routes that reach the same window by different additions. Six decimals is about
 * 10 cm, far finer than anything a 120px box can show.
 */
export function snapshotKey(
	frame: PreviewFrame,
	width: number,
	height: number,
	pixelRatio: number,
	supersample: number,
	scheme: ColorScheme
): string {
	const round = (n: number) => Math.round(n * 1e6) / 1e6;
	const bounds = [frame.west, frame.south, frame.east, frame.north].map(round).join(',');
	return `${scheme}|${width}x${height}@${round(pixelRatio)}x${supersample}|${bounds}`;
}

interface SnapshotRequest {
	key: string;
	camera: SnapshotCamera;
	/** The preview's own box, in CSS pixels. The map is drawn at `SUPERSAMPLE` times this. */
	width: number;
	height: number;
	pixelRatio: number;
	supersample: number;
	scheme: ColorScheme;
}

interface Renderer {
	map: MapLibreMap;
	container: HTMLDivElement;
	width: number;
	height: number;
	pixelRatio: number;
	supersample: number;
	scheme: ColorScheme;
}

/** Finished pictures, keyed by `snapshotKey`. The one reactive thing in this module. */
let snapshots = $state<Record<string, string>>({});

/** Which keys have been queued, and a plain `Set` on purpose: `mapSnapshot` writes to it
 *  from inside a `$derived`, and a reactive write there is the self-retriggering loop
 *  this file's header is about. `land-tiles.svelte.ts` carries the same note. */
const asked = new Set<string>();

const queue: SnapshotRequest[] = [];
let draining = false;
let renderer: Renderer | undefined;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

/** How long the instance survives with nothing queued. A results page nobody scrolls
 *  should not sit on a WebGL context for the session, and rebuilding one costs the 1272ms
 *  in the header, which is a price worth paying once a traveller has stopped looking. */
const IDLE_RELEASE_MS = 5_000;

/** A window that never settles must not stall every window behind it. Long enough that a
 *  cold vector style on a slow connection finishes first, short enough that a queue of
 *  three cannot outlive the card. What gets captured on a timeout is whatever has drawn,
 *  which beats a preview that stays grey forever. */
const SETTLE_TIMEOUT_MS = 8_000;

/**
 * The snapshot for this window, or `undefined` while it is being drawn.
 *
 * Safe to call from a `$derived`. It reads reactive state and starts work; the write that
 * answers it happens later, on an empty effect stack.
 */
export function mapSnapshot(frame: PreviewFrame, width: number, height: number): string | undefined {
	if (!browser) return undefined;
	// Framed for the supersampled canvas, not for the box. Same bounds either way, so the
	// picture shows the same ground; the zoom is what absorbs the difference.
	const camera = cameraForFrame(frame, width * SUPERSAMPLE);
	if (!camera) return undefined;

	const scheme = colorScheme();
	const pixelRatio = window.devicePixelRatio || 1;
	const key = snapshotKey(frame, width, height, pixelRatio, SUPERSAMPLE, scheme);

	if (!asked.has(key)) {
		asked.add(key);
		queue.push({ key, camera, width, height, pixelRatio, supersample: SUPERSAMPLE, scheme });
		void drain();
	}

	return snapshots[key];
}

async function drain(): Promise<void> {
	if (draining) return;
	draining = true;
	// The await is the point, not a formality. Everything above it runs on whatever
	// `$derived` asked for the first snapshot and touches only plain state; everything
	// below it runs a microtask later, where writing a rune is safe.
	await Promise.resolve();
	try {
		for (let request = queue.shift(); request; request = queue.shift()) {
			const png = await capture(request);
			// A capture that failed leaves the key in `asked`, so it is never retried. The
			// preview keeps the solid fill it was already showing, which is the honest
			// answer and the same one `land-tiles.svelte.ts` gives a tile it cannot fetch.
			// A retry loop against a broken WebGL context would spend a phone's battery to
			// produce the same grey.
			if (png !== undefined) snapshots[request.key] = png;
		}
	} finally {
		draining = false;
		scheduleRelease();
	}
}

async function capture(request: SnapshotRequest): Promise<string | undefined> {
	try {
		const current = matches(renderer, request) ? renderer : undefined;
		if (current) {
			await afterJump(current.map, request.camera);
		} else {
			release();
			await build(request);
		}
		// A style that never loaded still goes idle, because nothing is pending, and it
		// captures as a flat rectangle of MapLibre's own background. Cached, that would be
		// a worse fallback than the fill the preview is already showing, and permanent.
		if (!renderer?.map.isStyleLoaded()) return undefined;
		return renderer.map.getCanvas().toDataURL('image/png');
	} catch {
		// No WebGL, a lost context, a style that would not parse. The instance is dropped
		// rather than left for the rest of the queue to fail against one by one.
		release();
		return undefined;
	}
}

function matches(current: Renderer | undefined, request: SnapshotRequest): current is Renderer {
	return (
		current !== undefined &&
		current.scheme === request.scheme &&
		current.width === request.width &&
		current.height === request.height &&
		current.pixelRatio === request.pixelRatio &&
		current.supersample === request.supersample
	);
}

async function build(request: SnapshotRequest): Promise<void> {
	const maplibregl = await import('maplibre-gl');
	// The same two lines `ItineraryMap` opens with, and for the reason its comment gives:
	// MapLibre v6 parses vector tiles in a worker it cannot locate through a bundler on
	// its own, and without this every tile silently never parses.
	const { default: workerUrl } = await import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url');
	maplibregl.setWorkerUrl(workerUrl);

	const container = document.createElement('div');
	// Off to the side rather than hidden: `display: none` or `visibility: hidden` stops
	// WebGL drawing anything, and a canvas that never drew captures as a blank square.
	// The class is how `visibleMapCanvases` (tests/e2e/support/results-ui.ts) tells this
	// one canvas apart from a dialog's when it counts live contexts.
	container.className = 'map-snapshot-renderer';
	container.setAttribute('aria-hidden', 'true');
	const drawn = { width: request.width * request.supersample, height: request.height * request.supersample };
	container.style.cssText = `position:fixed;top:0;left:-10000px;pointer-events:none;width:${drawn.width}px;height:${drawn.height}px`;
	// Attached before the instance exists, because MapLibre sizes itself from the
	// container's `clientWidth` and a detached element measures zero. So a constructor that
	// throws, which is what a device with no WebGL does, has to take the element back out
	// by hand: nothing owns it yet.
	document.body.appendChild(container);

	let map: MapLibreMap;
	try {
		map = createMap(maplibregl, container, request);
	} catch (error) {
		container.remove();
		throw error;
	}
	// Registered before the first render rather than after `load`, so the app's own
	// background and water colours are on the map by the time it goes idle and there is no
	// second render to wait for.
	map.on('style.load', () => applyThemeColors(map, request.scheme));

	// Attached synchronously, in the same turn the map is constructed: `idle` can fire in
	// the same render as `load`, and a listener added a microtask later would miss it and
	// wait out the timeout on every cold start.
	const settled = afterIdle(map);
	renderer = {
		map,
		container,
		width: request.width,
		height: request.height,
		pixelRatio: request.pixelRatio,
		supersample: request.supersample,
		scheme: request.scheme
	};
	await settled;
}

function createMap(
	maplibregl: typeof import('maplibre-gl'),
	container: HTMLDivElement,
	request: SnapshotRequest
): MapLibreMap {
	return new maplibregl.Map({
		container,
		style: MAP_STYLE_URL[request.scheme],
		center: request.camera.center,
		zoom: request.camera.zoom,
		// Nothing may move this map, and nothing may draw furniture on it: the picture is
		// the whole output, and a zoom button or an attribution box would be baked into it.
		// The credit is printed under the row instead (`GroundLegPreviews.svelte`).
		interactive: false,
		attributionControl: false,
		// Without this the drawing buffer is cleared before `toDataURL` can read it, and
		// the capture is a transparent rectangle. MapLibre v6 moved the flag off the top
		// level of the options into here.
		canvasContextAttributes: { preserveDrawingBuffer: true },
		// A tile fading in is a tile that is not finished, and this reads the canvas the
		// moment the map goes idle.
		fadeDuration: 0,
		maxZoom: MAX_CAPTURE_ZOOM,
		pixelRatio: request.pixelRatio
	});
}

function afterIdle(map: MapLibreMap): Promise<void> {
	return new Promise((resolve) => {
		const finish = (): void => {
			clearTimeout(timer);
			map.off('idle', finish);
			resolve();
		};
		const timer = setTimeout(finish, SETTLE_TIMEOUT_MS);
		map.on('idle', finish);
	});
}

function afterJump(map: MapLibreMap, camera: SnapshotCamera): Promise<void> {
	const settled = afterIdle(map);
	map.jumpTo(camera);
	return settled;
}

function scheduleRelease(): void {
	if (releaseTimer !== undefined) clearTimeout(releaseTimer);
	releaseTimer = setTimeout(() => {
		releaseTimer = undefined;
		if (draining || queue.length > 0) return;
		release();
	}, IDLE_RELEASE_MS);
}

function release(): void {
	renderer?.map.remove();
	renderer?.container.remove();
	renderer = undefined;
}
