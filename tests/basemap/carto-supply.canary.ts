import { expect, test, type Page } from '@playwright/test';
import type { StyleSpecification } from 'maplibre-gl';
import { MAP_STYLE_URL, type ColorScheme } from '../../src/lib/itinerary-map/style';
import { complainAboutStyle, judgeWindow } from '../../src/lib/itinerary-map/basemap-canary';
import { readKeyNotice, readWindowPng } from '../shared/read-png';

/**
 * Is the basemap this app draws still keyless, and still a map? (#432)
 *
 * Not a test of this app. Every assertion below is about somebody else's server, so a
 * failure here means the supply changed, not that a commit broke something. It runs weekly
 * rather than per pull request for that reason.
 *
 * Both halves are needed and neither is enough. The style document is where a demand for a
 * key arrives first and arrives in words, and reading it costs one request. The picture is
 * where a demand arrives that the document never mentions: CARTO's raster tiles answer 200
 * with a fully drawn map that has "API KEY REQUIRED" printed across it, and no header, no
 * status code and no `isStyleLoaded()` says so.
 */

/**
 * What `support/maplibre-server.mjs` puts on its page. A type rather than a `declare
 * global`, so `window.MapLibreMap` stays a type error everywhere else in this repo, where it
 * would also be a runtime error. It has to be widened inline at each use: a helper would be
 * a closure, and a closure does not cross into `page.evaluate`.
 */
type CanaryWindow = Window &
	typeof globalThis & {
		MapLibreMap: typeof import('maplibre-gl').MapLibreMap;
		maplibreReady?: boolean;
	};

/**
 * Vienna city centre at zoom 12, as an exact Web Mercator tile.
 *
 * Exact, because the recorded key notice in tests/fixtures/basemap/ is a mask of tile
 * pixels: a window framed a few hundred metres off would move the map under the notice and
 * measure a different picture. Vienna because the window has to be dense land. A tile of
 * open sea inks almost nothing, and a statistic about how much a window drew says nothing
 * when the honest answer is "very little, correctly".
 */
const CANARY_TILE = { z: 12, x: 2234, y: 1420 };

const boundsOfTile = ({ z, x, y }: typeof CANARY_TILE): [[number, number], [number, number]] => {
	const lon = (tx: number) => (tx / 2 ** z) * 360 - 180;
	const lat = (ty: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / 2 ** z))) * 180) / Math.PI;
	return [
		[lon(x), lat(y + 1)],
		[lon(x + 1), lat(y)]
	];
};

/**
 * Draws one window of a style and hands back the PNG.
 *
 * The style crosses into the page as text, whether it is a URL or a document. Playwright
 * types every argument it serialises, and `StyleSpecification` is a union deep enough that
 * the compiler gives up on it ("type instantiation is excessively deep"). A string costs
 * nothing and the page knows which kind it holds from its first character.
 */
async function photographTheWindow(page: Page, style: string | StyleSpecification): Promise<Uint8Array> {
	await page.goto('/');
	await page.waitForFunction(() => (window as CanaryWindow).maplibreReady === true);

	const dataUrl = await page.evaluate(
		async ({ styleText, bounds }) => {
			const map = new (window as CanaryWindow).MapLibreMap({
				container: 'map',
				style: styleText.startsWith('{') ? JSON.parse(styleText) : styleText,
				bounds,
				fitBoundsOptions: { padding: 0, animate: false },
				interactive: false,
				attributionControl: false,
				// Without this the drawing buffer is gone by the time anything can read it, and
				// `toDataURL` answers a transparent rectangle rather than throwing.
				canvasContextAttributes: { preserveDrawingBuffer: true }
			});
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('the style never went idle')), 90_000);
				// Only before the style has loaded. A style that cannot be fetched never goes
				// idle, so without this the wait is the full timeout; a missing tile on a style
				// that did load raises the same event, and ending there would photograph half a
				// map and call it a supply failure.
				map.once('error', (event) => {
					if (map.isStyleLoaded()) return;
					clearTimeout(timer);
					reject(new Error(`MapLibre raised: ${event.error?.message ?? 'an error with no message'}`));
				});
				map.once('idle', () => {
					clearTimeout(timer);
					resolve();
				});
			});
			return map.getCanvas().toDataURL('image/png');
		},
		{
			styleText: typeof style === 'string' ? style : JSON.stringify(style),
			bounds: boundsOfTile(CANARY_TILE)
		}
	);

	return Buffer.from(dataUrl.split(',')[1], 'base64');
}

for (const scheme of Object.keys(MAP_STYLE_URL) as ColorScheme[]) {
	const styleUrl = MAP_STYLE_URL[scheme];

	test(`the ${scheme} style is still served without a key`, async ({ request }) => {
		const response = await request.get(styleUrl);

		expect(response.status(), `${styleUrl} answered ${response.status()}`).toBe(200);

		const complaints = complainAboutStyle(await response.json());
		expect(complaints, `${styleUrl}\n  ${complaints.join('\n  ')}`).toEqual([]);
	});

	test(`the ${scheme} style still draws a map`, async ({ page }) => {
		const window = await readWindowPng(await photographTheWindow(page, styleUrl));
		const verdict = judgeWindow(window, await readKeyNotice());

		expect(
			verdict.complaints,
			`${styleUrl} at z${CANARY_TILE.z}/${CANARY_TILE.x}/${CANARY_TILE.y}\n  ` +
				`${verdict.complaints.join('\n  ')}\n` +
				`  inkShare ${verdict.stats.inkShare.toFixed(4)}, ` +
				`lumaSpread ${verdict.stats.lumaSpread.toFixed(4)}, ` +
				`keyNotice ${verdict.keyNoticeCoverage.toFixed(3)}`
		).toEqual([]);
	});
}

test('the raster endpoint is still the one that wants a key', async ({ page }) => {
	// The negative control, and the reason to believe the two tests above. It photographs the
	// endpoint this app deliberately does not use, and asserts the canary still catches it.
	// Without this, "the basemap is fine" and "the detector has quietly stopped working" look
	// identical for as long as CARTO leaves the vector styles alone.
	const raster: StyleSpecification = {
		version: 8,
		sources: {
			raster: {
				type: 'raster',
				tiles: ['https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png'],
				tileSize: 256
			}
		},
		layers: [{ id: 'raster', type: 'raster', source: 'raster' }]
	};

	const verdict = judgeWindow(await readWindowPng(await photographTheWindow(page, raster)), await readKeyNotice());

	expect(
		verdict.complaints.join(' '),
		`The raster endpoint now looks clean, which means either CARTO dropped the notice or ` +
			`the canary stopped seeing it. Re-record with \`pnpm data:basemap-canary\` and read ` +
			`the picture it writes. Measured: keyNotice ${verdict.keyNoticeCoverage.toFixed(3)}`
	).toContain('carries the recorded key notice');
});
