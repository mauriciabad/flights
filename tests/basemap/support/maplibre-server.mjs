// Serves MapLibre and one blank page for the basemap canary, and nothing else.
//
// The canary has to draw the real style to judge it, because CARTO's styles are vector: the
// pixels a traveller sees do not exist until MapLibre has made them. This app's own build is
// not the place to do that. It would need a search, and a search costs the owner's quota.
//
// So: an empty page from a real http origin, with the library on it. A file:// page cannot
// be used instead, because its origin is null and every cross-origin fetch to CARTO would be
// refused before a tile arrived.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', '..', '..', 'node_modules', 'maplibre-gl', 'dist');
const port = Number(process.argv[2] ?? 4175);

// maplibre-gl v6 ships ES modules only, so the page loads it as one. The relative imports
// inside it resolve against this origin, which is why the whole dist directory is served
// rather than the entry file alone.
const page = `<!doctype html><meta charset="utf-8"><title>basemap canary</title>
<link rel="stylesheet" href="/maplibre-gl.css">
<style>html,body{margin:0;background:#fff}#map{width:256px;height:256px}</style>
<div id="map"></div>
<script type="module">
import { MapLibreMap } from '/maplibre-gl.mjs';
window.MapLibreMap = MapLibreMap;
window.maplibreReady = true;
</script>`;

createServer((request, response) => {
	if (request.url === '/' || request.url.startsWith('/?')) {
		response.writeHead(200, { 'content-type': 'text/html' });
		response.end(page);
		return;
	}
	let body;
	try {
		body = readFileSync(path.join(dist, path.basename(request.url)));
	} catch {
		response.writeHead(404).end('Not found');
		return;
	}
	response.writeHead(200, { 'content-type': request.url.endsWith('.css') ? 'text/css' : 'text/javascript' });
	response.end(body);
}).listen(port, () => {
	console.log(`Serving maplibre-gl at http://127.0.0.1:${port}`);
});
