/**
 * What four map previews per result card actually cost on a phone (issue #280).
 *
 * The owner asked for a permanently visible flight preview plus three ground-leg
 * previews on every card. That is four map instances per card, and a results list is
 * long, so "use MapLibre for all of them" is a claim that needs a number rather than an
 * opinion. This launches its own Chromium (never the shared MCP browser, see AGENTS.md),
 * renders N cards of previews at a 375px phone viewport with the CPU throttled, and
 * prints what each approach costs.
 *
 *   node tools/probe-map-cost.mjs            # 1, 2, 3 and 5 cards, both approaches
 *   node tools/probe-map-cost.mjs 5          # just 5 cards
 *
 * The number that decides it is `webglLost`. Chromium keeps at most 16 live WebGL
 * contexts per page and silently kills the oldest beyond that, so the fifth card's maps
 * evict the first card's and the traveller scrolls back up to blank rectangles. That is
 * not a slow map, it is a broken one, and no amount of lazy-loading fixes it while four
 * live contexts per card is the design.
 */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const maplibreDist = path.join(repo, 'node_modules', 'maplibre-gl', 'dist');

const onlyCards = process.argv[2] ? Number(process.argv[2]) : undefined;
const CARD_COUNTS = onlyCards ? [onlyCards] : [1, 2, 3, 5];
const PORT = Number(process.env.MAP_COST_PORT ?? 41880);

const STYLE_URL = {
	dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
};

/** Barcelona, Vienna, Bucharest plus plausible ground endpoints: one real-shaped trip,
 *  reused for every card so the two approaches draw the same geometry. */
const TRIP = {
	originLocation: [2.1734, 41.3851],
	originAirport: [2.0785, 41.2971],
	connectionAirport: [16.5697, 48.1103],
	stay: [16.3738, 48.2082],
	destinationAirport: [26.1021, 44.5711],
	destinationLocation: [26.0963, 44.4396]
};

function greatCircle([lon1, lat1], [lon2, lat2], steps = 64) {
	const rad = (d) => (d * Math.PI) / 180;
	const deg = (r) => (r * 180) / Math.PI;
	const φ1 = rad(lat1);
	const λ1 = rad(lon1);
	const φ2 = rad(lat2);
	const λ2 = rad(lon2);
	const d =
		2 *
		Math.asin(
			Math.sqrt(Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2)
		);
	if (d < 1e-9) return [[lon1, lat1]];
	const points = [];
	for (let i = 0; i <= steps; i++) {
		const f = i / steps;
		const a = Math.sin((1 - f) * d) / Math.sin(d);
		const b = Math.sin(f * d) / Math.sin(d);
		const x = a * Math.cos(φ1) * Math.cos(λ1) + b * Math.cos(φ2) * Math.cos(λ2);
		const y = a * Math.cos(φ1) * Math.sin(λ1) + b * Math.cos(φ2) * Math.sin(λ2);
		const z = a * Math.sin(φ1) + b * Math.sin(φ2);
		points.push([deg(Math.atan2(y, x)), deg(Math.atan2(z, Math.sqrt(x * x + y * y)))]);
	}
	return points;
}

const PREVIEWS = [
	{
		name: 'flight',
		lines: [
			greatCircle(TRIP.originAirport, TRIP.connectionAirport),
			greatCircle(TRIP.connectionAirport, TRIP.destinationAirport),
			greatCircle(TRIP.originAirport, TRIP.destinationAirport)
		]
	},
	{ name: 'origin', lines: [[TRIP.originLocation, TRIP.originAirport]] },
	{ name: 'hotel', lines: [[TRIP.connectionAirport, TRIP.stay]] },
	{ name: 'destination', lines: [[TRIP.destinationAirport, TRIP.destinationLocation]] }
];

function boundsOf(lines) {
	const all = lines.flat();
	let w = all[0][0];
	let e = all[0][0];
	let s = all[0][1];
	let n = all[0][1];
	for (const [lon, lat] of all) {
		w = Math.min(w, lon);
		e = Math.max(e, lon);
		s = Math.min(s, lat);
		n = Math.max(n, lat);
	}
	return [w, s, e, n];
}

/** The SVG approach: the same polylines, projected to Web Mercator and fitted to the
 *  box, drawn as plain paths. No tiles, no WebGL, no library. */
function svgFor(preview, width, height) {
	const merc = ([lon, lat]) => [lon, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * (180 / Math.PI)];
	const projected = preview.lines.map((line) => line.map(merc));
	const all = projected.flat();
	let minX = all[0][0];
	let maxX = all[0][0];
	let minY = all[0][1];
	let maxY = all[0][1];
	for (const [x, y] of all) {
		minX = Math.min(minX, x);
		maxX = Math.max(maxX, x);
		minY = Math.min(minY, y);
		maxY = Math.max(maxY, y);
	}
	const pad = 6;
	const spanX = Math.max(maxX - minX, 1e-6);
	const spanY = Math.max(maxY - minY, 1e-6);
	const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
	const ox = (width - spanX * scale) / 2;
	const oy = (height - spanY * scale) / 2;
	const place = ([x, y]) => [(x - minX) * scale + ox, (maxY - y) * scale + oy];
	const paths = projected
		.map((line, i) => {
			const d = line.map(place).map(([x, y], j) => `${j === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
			const dashed = i === projected.length - 1 && preview.name === 'flight';
			return `<path d="${d}" fill="none" stroke="${dashed ? '#7b8496' : '#e8a33d'}" stroke-width="${dashed ? 1 : 1.75}" ${dashed ? 'stroke-dasharray="3 3"' : ''}/>`;
		})
		.join('');
	return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${paths}</svg>`;
}

function pageHtml(mode, cards) {
	const previewsPerCard = PREVIEWS.map((p, i) => ({ ...p, i }));
	const cardMarkup = Array.from({ length: cards }, (_, c) => {
		const previews = previewsPerCard
			.map((p) => {
				if (mode === 'svg') {
					const wide = p.name === 'flight';
					return `<div class="preview ${wide ? 'wide' : ''}">${svgFor(p, wide ? 320 : 100, wide ? 96 : 76)}</div>`;
				}
				return `<div class="preview ${p.name === 'flight' ? 'wide' : ''}" data-map="${c}-${p.i}" data-preview="${p.i}"></div>`;
			})
			.join('');
		return `<article class="card"><h2>Card ${c + 1}</h2><div class="flight-slot">${previews.split('</div>')[0]}</div></div><div class="ground-row">${previews.split('</div>').slice(1).join('</div>')}</article>`;
	}).join('');

	return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/mgl/maplibre-gl.css">
<style>
  body { margin:0; background:#0b1020; color:#e6e9f2; font:14px system-ui; }
  .card { border:1px solid #23283a; border-radius:12px; margin:12px; padding:12px; }
  h2 { font-size:13px; margin:0 0 8px; }
  .ground-row { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:8px; }
  .preview { height:76px; border-radius:8px; overflow:hidden; background:#060912; }
  .preview.wide { height:96px; }
  .preview svg { display:block; width:100%; height:100%; }
</style></head><body>
<div id="cards">${cardMarkup}</div>
<script type="module">
  window.__ready = false;
  window.__timing = { start: performance.now() };
  const longTasks = [];
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) longTasks.push(e.duration); })
      .observe({ entryTypes: ['longtask'] });
  } catch {}
  window.__longTasks = longTasks;

  const MODE = ${JSON.stringify(mode)};
  if (MODE === 'svg') {
    window.__timing.ready = performance.now();
    window.__ready = true;
  } else {
    const { Map } = await import('/mgl/maplibre-gl.mjs');
    const PREVIEWS = ${JSON.stringify(PREVIEWS.map((p) => ({ name: p.name, lines: p.lines, bounds: boundsOf(p.lines) })))};
    const nodes = [...document.querySelectorAll('[data-map]')];
    window.__instances = nodes.length;
    let settled = 0;
    for (const node of nodes) {
      const preview = PREVIEWS[Number(node.dataset.preview)];
      const map = new Map({
        container: node,
        style: ${JSON.stringify(STYLE_URL.dark)},
        interactive: false,
        attributionControl: false,
        bounds: [[preview.bounds[0], preview.bounds[1]], [preview.bounds[2], preview.bounds[3]]],
        fitBoundsOptions: { padding: 8, animate: false }
      });
      map.on('load', () => {
        map.addSource('lines-' + node.dataset.map, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: preview.lines.map((line) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } })) }
        });
        map.addLayer({ id: 'l-' + node.dataset.map, type: 'line', source: 'lines-' + node.dataset.map, paint: { 'line-color': '#e8a33d', 'line-width': 1.75 } });
      });
      map.once('idle', () => {
        settled += 1;
        if (settled === nodes.length) {
          window.__timing.ready = performance.now();
          window.__ready = true;
        }
      });
    }
  }
</script></body></html>`;
}

function serve() {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			const url = new URL(req.url, `http://localhost:${PORT}`);
			if (url.pathname.startsWith('/mgl/')) {
				const file = path.join(maplibreDist, url.pathname.slice(5));
				if (!file.startsWith(maplibreDist) || !existsSync(file)) {
					res.writeHead(404).end('no');
					return;
				}
				res.writeHead(200, {
					'content-type': file.endsWith('.css') ? 'text/css' : 'text/javascript'
				});
				res.end(readFileSync(file));
				return;
			}
			const mode = url.searchParams.get('mode') ?? 'maps';
			const cards = Number(url.searchParams.get('cards') ?? 1);
			res.writeHead(200, { 'content-type': 'text/html' });
			res.end(pageHtml(mode, cards));
		});
		server.listen(PORT, () => resolve(server));
	});
}

async function measure(browser, mode, cards) {
	const context = await browser.newContext({
		viewport: { width: 375, height: 812 },
		deviceScaleFactor: 2,
		userAgent:
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
	});
	const page = await context.newPage();
	const consoleLines = [];
	page.on('console', (m) => consoleLines.push(m.text()));
	const requests = [];
	page.on('response', (r) => {
		const u = r.url();
		if (u.includes('cartocdn.com')) requests.push(u);
	});

	// A mid-range phone is roughly 4x slower than this machine's core. Without the
	// throttle every approach looks fine and the measurement says nothing.
	const cdp = await context.newCDPSession(page);
	await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

	const started = Date.now();
	await page.goto(`http://localhost:${PORT}/?mode=${mode}&cards=${cards}`, { waitUntil: 'load' });
	let ready = true;
	try {
		await page.waitForFunction('window.__ready === true', null, { timeout: 45000 });
	} catch {
		ready = false;
	}
	const wallMs = Date.now() - started;

	const fps = await page.evaluate(async () => {
		const frames = [];
		let last = performance.now();
		await new Promise((done) => {
			let n = 0;
			function tick(t) {
				frames.push(t - last);
				last = t;
				window.scrollBy(0, 24);
				if (++n < 90) requestAnimationFrame(tick);
				else done();
			}
			requestAnimationFrame(tick);
		});
		frames.sort((a, b) => a - b);
		return {
			medianFrameMs: frames[Math.floor(frames.length / 2)],
			worstFrameMs: frames[frames.length - 1]
		};
	});

	const heap = await cdp
		.send('Runtime.evaluate', { expression: 'performance.memory ? performance.memory.usedJSHeapSize : 0' })
		.then((r) => r.result.value ?? 0)
		.catch(() => 0);

	const longTasks = await page.evaluate('window.__longTasks ?? []');
	const readyMs = await page.evaluate('window.__timing.ready ? Math.round(window.__timing.ready - window.__timing.start) : null');

	const webglComplaints = consoleLines.filter((l) => /too many active webgl|context lost|webglcontextlost/i.test(l));
	const webglLost = webglComplaints.length;
	// AGENTS.md, "Show the error you got, never the one you assumed": the browser's own
	// sentence is the evidence, not our paraphrase of it.
	if (webglComplaints[0]) console.error(`[${mode} ${cards} cards] ${webglComplaints[0]}`);

	await context.close();
	return {
		mode,
		cards,
		instances: mode === 'maps' ? cards * 4 : 0,
		ready,
		readyMs,
		wallMs,
		webglLost,
		tileRequests: requests.length,
		heapMB: Math.round((heap / 1024 / 1024) * 10) / 10,
		blockingMs: Math.round(longTasks.reduce((a, b) => a + Math.max(0, b - 50), 0)),
		medianFrameMs: Math.round(fps.medianFrameMs * 10) / 10,
		worstFrameMs: Math.round(fps.worstFrameMs)
	};
}

const server = await serve();
const browser = await chromium.launch();
const rows = [];
for (const cards of CARD_COUNTS) {
	for (const mode of ['maps', 'svg']) {
		rows.push(await measure(browser, mode, cards));
	}
}
await browser.close();
server.close();

const header = ['mode', 'cards', 'instances', 'ready', 'readyMs', 'wallMs', 'webglLost', 'tileRequests', 'heapMB', 'blockingMs', 'medianFrameMs', 'worstFrameMs'];
console.log(header.join('\t'));
for (const row of rows) console.log(header.map((k) => row[k]).join('\t'));
