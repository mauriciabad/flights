/**
 * Records what a map is supposed to look like, and what CARTO's key notice looks like when
 * it is painted over one (#432).
 *
 * `pnpm data:basemap-canary`
 *
 * Writes five pictures into tests/fixtures/basemap/ and prints the calibration table that
 * src/lib/itinerary-map/basemap-canary.ts quotes, scored by that module's own functions.
 * Re-run it when CARTO changes the notice, or when a threshold in that module needs its
 * evidence checked. It only ever reads the network; nothing here answers a request.
 *
 * The notice is derived rather than drawn: it is the set of pixels that carry ink in every
 * one of the sixteen watermarked tiles, across eight cities and both raster styles. Anything
 * the map itself contributes differs city to city and drops out of the intersection, so what
 * is left is the overlay and nothing else. Open the file it writes and you can read it.
 *
 * The clean half has to be rendered rather than fetched, because the styles this app draws
 * are vector: the pixels only exist once MapLibre has made them. That is also the honest
 * comparison, since it is the same code path a traveller gets.
 */
import http from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import sharp from 'sharp';
// What the two test suites answer this host with, imported rather than copied. A private
// copy here is how the table below would go on reporting a fixture nobody serves any more.
import { fixtureMapStyle } from '../tests/shared/map-style-fixture.ts';
// The arithmetic the thresholds police, imported for the same reason (#462). This script is
// what the calibration table was read off, so a private copy of `inkMask` here would mean
// the table and the check that quotes it came from two implementations, free to drift with
// nothing failing. Bare Node resolves it because the module imports nothing at all.
import {
	describeWindow,
	inkMask,
	keyNoticeCoverage,
	readMapWindow
} from '../src/lib/itinerary-map/basemap-canary.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const outDir = path.join(repo, 'tests', 'fixtures', 'basemap');
const maplibreDist = path.join(repo, 'node_modules', 'maplibre-gl', 'dist');
const PORT = Number(process.env.BASEMAP_CANARY_PORT ?? 41892);

const ZOOM = 12;
const SIZE = 256;

/** Eight city centres, all dense land at this zoom so a window is never mostly sea. A tile
 *  of open water inks almost nothing and would tell you nothing about either population. */
const CITIES = {
	barcelona: [2.1734, 41.3851],
	vienna: [16.3738, 48.2082],
	bucharest: [26.1021, 44.4396],
	berlin: [13.405, 52.52],
	madrid: [-3.7038, 40.4168],
	rome: [12.4964, 41.9028],
	warsaw: [21.0122, 52.2297],
	lisbon: [-9.1393, 38.7223]
};

const VECTOR_STYLES = {
	'vector-dark': 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
	'vector-light': 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
};

const RASTER_STYLES = {
	'raster-voyager': 'https://basemaps.cartocdn.com/rastertiles/voyager',
	'raster-dark': 'https://basemaps.cartocdn.com/rastertiles/dark_all'
};

const LAYERLESS_STYLE = { version: 8, name: 'empty', sources: {}, layers: [] };

/** What the shared fixture was until #443: the layer `map-snapshot.svelte.ts` insists on and
 *  nothing that draws. Kept beside the one that ships so the two rows can be read together. */
const BACKGROUND_ONLY_STYLE = {
	version: 8,
	name: 'background only',
	sources: {},
	layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#101820' } }]
};

const tileOf = (lon, lat) => {
	const x = Math.floor(((lon + 180) / 360) * 2 ** ZOOM);
	const rad = (lat * Math.PI) / 180;
	const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** ZOOM);
	return [x, y];
};
const lonEdge = (x) => (x / 2 ** ZOOM) * 360 - 180;
const latEdge = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** ZOOM))) * 180) / Math.PI;
const boundsOfTile = (x, y) => [
	[lonEdge(x), latEdge(y + 1)],
	[lonEdge(x + 1), latEdge(y)]
];

const CANARY_PAGE = `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="/maplibre-gl.css">
<style>html,body{margin:0}#map{width:${SIZE}px;height:${SIZE}px}</style>
<div id="map"></div>
<script type="module">
import { Map as MapLibreMap } from '/maplibre-gl.mjs';
window.MapLibreMap = MapLibreMap;
window.maplibreReady = true;
</script>`;

function serveMapLibre() {
	const server = http.createServer((request, response) => {
		if (request.url === '/' || request.url.startsWith('/?')) {
			response.writeHead(200, { 'content-type': 'text/html' });
			response.end(CANARY_PAGE);
			return;
		}
		let body;
		try {
			body = readFileSync(path.join(maplibreDist, path.basename(request.url)));
		} catch {
			response.writeHead(404).end();
			return;
		}
		response.writeHead(200, {
			'content-type': request.url.endsWith('.css') ? 'text/css' : 'text/javascript'
		});
		response.end(body);
	});
	return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

async function renderWindow(browser, style, bounds) {
	const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
	try {
		await page.goto(`http://127.0.0.1:${PORT}/`);
		await page.waitForFunction(() => window.maplibreReady === true);
		const dataUrl = await page.evaluate(
			async ({ style, bounds }) => {
				const map = new window.MapLibreMap({
					container: 'map',
					style,
					bounds,
					fitBoundsOptions: { padding: 0, animate: false },
					interactive: false,
					attributionControl: false,
					preserveDrawingBuffer: true
				});
				await new Promise((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error('style never went idle')), 60_000);
					map.once('idle', () => {
						clearTimeout(timer);
						resolve();
					});
				});
				return map.getCanvas().toDataURL('image/png');
			},
			{ style, bounds }
		);
		return Buffer.from(dataUrl.split(',')[1], 'base64');
	} finally {
		await page.close();
	}
}

async function windowOf(png) {
	const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	return readMapWindow(data, SIZE, SIZE);
}

async function fetchPng(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${url} answered ${response.status}`);
	return Buffer.from(await response.arrayBuffer());
}

mkdirSync(outDir, { recursive: true });
const server = await serveMapLibre();
const browser = await chromium.launch();

const watermarked = [];
const clean = [];
try {
	for (const [city, [lon, lat]] of Object.entries(CITIES)) {
		const [x, y] = tileOf(lon, lat);
		for (const [name, base] of Object.entries(RASTER_STYLES)) {
			watermarked.push({ label: `${name} ${city}`, png: await fetchPng(`${base}/${ZOOM}/${x}/${y}.png`) });
		}
		for (const [name, styleUrl] of Object.entries(VECTOR_STYLES)) {
			clean.push({ label: `${name} ${city}`, png: await renderWindow(browser, styleUrl, boundsOfTile(x, y)) });
		}
		console.log(`recorded ${city}`);
	}

	const [viennaX, viennaY] = tileOf(...CITIES.vienna);
	const blank = await renderWindow(browser, LAYERLESS_STYLE, boundsOfTile(viennaX, viennaY));
	const backgroundOnly = await renderWindow(browser, BACKGROUND_ONLY_STYLE, boundsOfTile(viennaX, viennaY));
	const fixture = await renderWindow(browser, fixtureMapStyle('dark'), boundsOfTile(viennaX, viennaY));
	const notFound = await fetchPng(`https://tile.openstreetmap.org/${ZOOM}/${viennaX}/${viennaY}.png`);

	// The intersection, which is the whole trick: a pixel survives only if all sixteen
	// watermarked tiles ink it, and only the overlay is in all sixteen.
	const notice = new Uint8Array(SIZE * SIZE).fill(1);
	for (const { png } of watermarked) {
		const mask = inkMask(await windowOf(png));
		for (let i = 0; i < notice.length; i++) if (!mask[i]) notice[i] = 0;
	}
	let marked = 0;
	for (const bit of notice) marked += bit;

	const noticePixels = Buffer.alloc(SIZE * SIZE, 255);
	for (let i = 0; i < notice.length; i++) if (notice[i]) noticePixels[i] = 0;
	await sharp(noticePixels, { raw: { width: SIZE, height: SIZE, channels: 1 } })
		.png()
		.toFile(path.join(outDir, 'carto-key-notice.png'));

	writeFileSync(path.join(outDir, 'carto-vector-dark-vienna.png'), clean.find((s) => s.label === 'vector-dark vienna').png);
	writeFileSync(path.join(outDir, 'carto-raster-voyager-vienna.png'), watermarked.find((s) => s.label === 'raster-voyager vienna').png);
	writeFileSync(path.join(outDir, 'openstreetmap-refusal.png'), notFound);
	writeFileSync(path.join(outDir, 'style-with-no-layers.png'), blank);

	const report = async (label, samples) => {
		const rows = [];
		for (const { png } of samples) {
			const window = await windowOf(png);
			rows.push({ ...describeWindow(window), coverage: keyNoticeCoverage(window, notice) });
		}
		const range = (key, digits) => {
			const values = rows.map((r) => r[key]);
			return `${Math.min(...values).toFixed(digits)} - ${Math.max(...values).toFixed(digits)}`;
		};
		console.log(
			`${label.padEnd(26)} n=${String(rows.length).padStart(2)}  inkShare ${range('inkShare', 4).padEnd(17)}` +
				`lumaSpread ${range('lumaSpread', 4).padEnd(17)}keyNotice ${range('coverage', 3)}`
		);
	};

	console.log(`\nnotice: ${marked} pixels (${((marked / (SIZE * SIZE)) * 100).toFixed(2)}% of a tile)\n`);
	await report('clean CARTO renders', clean);
	await report('watermarked raster tiles', watermarked);
	await report('openstreetmap.org refusal', [{ png: notFound }]);
	await report('style with no layers', [{ png: blank }]);
	await report('style with one bg layer', [{ png: backgroundOnly }]);
	await report('the shared test fixture', [{ png: fixture }]);
} finally {
	await browser.close();
	server.close();
}
