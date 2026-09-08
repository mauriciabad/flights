/**
 * What the shared test basemap fixture draws, measured rather than asserted (#443).
 *
 * `tests/shared/map-style-fixture.ts` is the style both suites answer
 * `basemaps.cartocdn.com` with. Until #443 it was one `background` layer and nothing else,
 * which renders 0.0000 ink at every camera. A style with no layers at all measures the same
 * 0.0000, so every spec asserting on a picture was passing against numbers that could not
 * tell the feature from the blank rectangle #431 and #433 were about.
 *
 * This renders the fixture through real MapLibre at cameras spanning the zooms
 * `cameraForFrame` can produce, and scores each window with the instrument the live basemap
 * canary uses (`src/lib/itinerary-map/basemap-canary.ts`). Reusing that is the point. One
 * opinion about whether a picture is a map, pointed at two supplies.
 *
 *   node tools/probe-fixture-basemap.mjs           # the shipped fixture, plus the flat control
 *   node tools/probe-fixture-basemap.mjs --redraw  # redraw the tile, then measure it
 *
 * Exits non-zero when the fixture fails the canary's limits at any camera the app can ask
 * for, which is the property `route-previews.spec.ts` now leans on.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import {
	describeWindow,
	MAP_WINDOW_LIMITS,
	readMapWindow
} from '../src/lib/itinerary-map/basemap-canary.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const TILE_FILE = path.join(repo, 'tests', 'fixtures', 'basemap', 'fixture-street-grid.png');
const PORT = Number(process.env.FIXTURE_BASEMAP_PORT ?? 41884);

/** The style #443 is about, kept as the control: it inks 0.0000 at every camera below, and
 *  a suite that cannot tell it from the one that ships has learnt nothing. */
const FLAT_CONTROL = {
	version: 8,
	name: 'flat',
	sources: {},
	layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#101820' } }]
};

/**
 * The tile itself: a street grid, drawn pixel by pixel so it comes out crisp.
 *
 * Crisp rather than rasterised from a drawing, because an antialiased edge spreads one line
 * over three luminances and `inkMask` counts the middle one as ground. Every line sits away
 * from the tile's own edges so the pattern repeats seamlessly, and the diagonal runs corner
 * to corner for the same reason.
 *
 * Transparent everywhere else. The `background` layer under it is what `applyThemeColors`
 * recolours, so the picture is this app's own ground in whichever scheme is on, with the
 * grid over it. An opaque tile would hide that and photograph a dark map on a light page.
 */
const TILE_PIXELS = 256;

/**
 * Mid grey at 60% alpha. Grey because the ground under it is either #0b1020 or #f6f7fb and
 * one colour has to read against both; 60% because the alpha is what keeps the luminance
 * spread down. At full strength the grid measured 0.1209 spread against the canary's 0.15
 * ceiling, which is not enough room for the antialiasing at a camera nobody has tried yet.
 */
const INK = [0x7d, 0x8e, 0xa3, 0x99];

async function drawTile() {
	const pixels = Buffer.alloc(TILE_PIXELS * TILE_PIXELS * 4);
	const set = (x, y) => {
		if (x < 0 || y < 0 || x >= TILE_PIXELS || y >= TILE_PIXELS) return;
		pixels.set(INK, (y * TILE_PIXELS + x) * 4);
	};
	for (let along = 0; along < TILE_PIXELS; along++) {
		for (const street of [32, 96, 160, 224]) {
			set(street, along);
			set(along, street);
		}
		// Three pixels wide, so a reader can tell an avenue from a street at native zoom.
		for (const offset of [-1, 0, 1]) {
			set(128 + offset, along);
			set(along, 128 + offset);
		}
		set(along, along);
		set(along + 1, along);
	}
	const png = await sharp(pixels, { raw: { width: TILE_PIXELS, height: TILE_PIXELS, channels: 4 } })
		.png({ compressionLevel: 9, palette: true })
		.toBuffer();
	writeFileSync(TILE_FILE, png);
	console.log(`Wrote ${path.relative(repo, TILE_FILE)}, ${png.length} bytes`);
}

/**
 * Cameras the app can actually ask for, not a tour of the world.
 *
 * `cameraForFrame` turns a leg's span into a zoom and `SUPERSAMPLE` adds log2(3) on top, so
 * a transcontinental flight lands near z5 and the tightest walk `map-snapshot.test.ts`
 * checks lands near z24. Open sea is here because a fixture must not depend on being over a
 * city, and both schemes are here because `applyThemeColors` paints the ground the grid has
 * to read against and the light one is the harder of the two.
 */
const CAMERAS = [
	{ name: 'europe z4.6', center: [10, 48], zoom: 4.6 },
	{ name: 'barcelona z9.6', center: [2.1734, 41.3851], zoom: 9.6 },
	{ name: 'vienna z13.6', center: [16.3738, 48.2082], zoom: 13.6 },
	{ name: 'tallinn z17', center: [24.7536, 59.437], zoom: 17 },
	{ name: 'street z20.6', center: [26.1021, 44.4396], zoom: 20.6 },
	{ name: 'one-metre walk z24.6', center: [-9.1393, 38.7223], zoom: 24.6 },
	{ name: 'open sea z13.6', center: [-30, 35], zoom: 13.6 }
];

/** The supersampled box a ground preview captures: 120x88 units at SUPERSAMPLE 3. */
const WINDOW = { width: 360, height: 264 };

/** Both halves of the fixture, because the grid has to read against either ground and the
 *  light one is the harder of the two. */
const SCHEMES = ['dark', 'light'];

function serveMapLibre() {
	const server = spawn(
		process.execPath,
		[path.join(repo, 'tests', 'basemap', 'support', 'maplibre-server.mjs'), String(PORT)],
		{ stdio: ['ignore', 'pipe', 'inherit'] }
	);
	return new Promise((resolve) => server.stdout.once('data', () => resolve(server)));
}

async function photograph(page, style, camera) {
	return page.evaluate(
		async ({ styleText, camera, size }) => {
			const container = document.getElementById('map');
			container.style.width = `${size.width}px`;
			container.style.height = `${size.height}px`;
			const map = new window.MapLibreMap({
				container,
				style: JSON.parse(styleText),
				center: camera.center,
				zoom: camera.zoom,
				// The app's own ceiling (`MAX_CAPTURE_ZOOM`), so this measures what the hidden
				// renderer would measure rather than a camera MapLibre would clamp.
				maxZoom: 26,
				interactive: false,
				attributionControl: false,
				canvasContextAttributes: { preserveDrawingBuffer: true },
				fadeDuration: 0
			});
			const startedAt = performance.now();
			// The same 8s `map-snapshot.svelte.ts` gives a window before it photographs
			// whatever has drawn, so a style that never settles is reported as one.
			await new Promise((resolve) => {
				const timer = setTimeout(resolve, 8_000);
				map.on('idle', () => {
					clearTimeout(timer);
					resolve();
				});
			});
			const settledMs = performance.now() - startedAt;
			const png = map.getCanvas().toDataURL('image/png');
			map.remove();
			return { png, settledMs };
		},
		{ styleText: JSON.stringify(style), camera, size: WINDOW }
	);
}

async function readWindow(dataUrl) {
	const { data, info } = await sharp(Buffer.from(dataUrl.split(',')[1], 'base64'))
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	return readMapWindow(data, info.width, info.height);
}

if (process.argv.includes('--redraw')) await drawTile();

// Imported after any redraw, because the module reads the tile off disk once.
const { fixtureMapStyle } = await import('../tests/shared/map-style-fixture.ts');

const server = await serveMapLibre();
const browser = await chromium.launch();
const page = await browser.newPage();
let offenders = 0;

try {
	await page.goto(`http://127.0.0.1:${PORT}/`);
	await page.waitForFunction(() => window.maplibreReady === true);

	for (const [label, styleFor, judged] of [
		['the flat style #443 is about', () => FLAT_CONTROL, false],
		['the shipped fixture', fixtureMapStyle, true]
	]) {
		console.log(`\n${label}`);
		console.log('  scheme camera                inkShare  lumaSpread  settled  verdict');
		for (const scheme of SCHEMES) {
			for (const camera of CAMERAS) {
				const { png, settledMs } = await photograph(page, styleFor(scheme), camera);
				const stats = describeWindow(await readWindow(png));
				const complaints = [];
				if (stats.inkShare < MAP_WINDOW_LIMITS.minInkShare) complaints.push('drew almost nothing');
				if (stats.lumaSpread > MAP_WINDOW_LIMITS.maxLumaSpread) complaints.push('reads as a notice');
				if (judged && complaints.length > 0) offenders++;
				console.log(
					`  ${scheme.padEnd(6)} ${camera.name.padEnd(20)} ` +
						`${stats.inkShare.toFixed(4).padStart(8)}  ${stats.lumaSpread.toFixed(4).padStart(10)}  ` +
						`${`${Math.round(settledMs)}ms`.padStart(7)}  ${complaints.join(', ') || 'a map'}`
				);
			}
		}
	}
} finally {
	await browser.close();
	server.kill();
}

console.log(
	`\nLimits: inkShare >= ${MAP_WINDOW_LIMITS.minInkShare}, lumaSpread <= ${MAP_WINDOW_LIMITS.maxLumaSpread}`
);
if (offenders > 0) {
	console.error(`\n${offenders} window(s) of the shipped fixture do not read as a map.`);
	process.exitCode = 1;
}
