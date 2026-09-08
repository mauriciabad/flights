import { describe, expect, it } from 'vitest';
import { readKeyNotice, readWindowFixture } from '../../../tests/shared/read-png';
import { fixtureMapStyle, fixtureMapStyleFor } from '../../../tests/shared/map-style-fixture';
import { MAP_STYLE_URL } from './style';
import { complainAboutStyle, judgeWindow, MAP_WINDOW_LIMITS } from './basemap-canary';

/**
 * The four pictures under tests/fixtures/basemap/ are the ones this decision was made on,
 * recorded by `pnpm data:basemap-canary` on 2026-09-07. Testing against them rather than
 * against a synthesised gradient is the point: a threshold argued from an invented image
 * would be a number somebody liked.
 */
describe('judging a window of basemap', () => {
	it('passes a real CARTO render', async () => {
		const verdict = judgeWindow(await readWindowFixture('carto-vector-dark-vienna'), await readKeyNotice());

		expect(verdict.complaints).toEqual([]);
		expect(verdict.looksLikeAMap).toBe(true);
	});

	it('refuses a style with no layers, which loads clean and draws a rectangle', async () => {
		const verdict = judgeWindow(await readWindowFixture('style-with-no-layers'), await readKeyNotice());

		expect(verdict.stats.inkShare).toBe(0);
		expect(verdict.looksLikeAMap).toBe(false);
		expect(verdict.complaints.join(' ')).toContain('drew almost nothing');
	});

	it('refuses openstreetmap.org answering 200 with a picture of a 403', async () => {
		const verdict = judgeWindow(await readWindowFixture('openstreetmap-refusal'), await readKeyNotice());

		expect(verdict.looksLikeAMap).toBe(false);
		expect(verdict.complaints.join(' ')).toContain('reads as a notice');
	});

	it("refuses CARTO's raster tile, which is a real map with a key notice over it", async () => {
		const verdict = judgeWindow(await readWindowFixture('carto-raster-voyager-vienna'), await readKeyNotice());

		expect(verdict.keyNoticeCoverage).toBe(1);
		expect(verdict.looksLikeAMap).toBe(false);
		expect(verdict.complaints.join(' ')).toContain('carries the recorded key notice');
	});

	/**
	 * The limit of the cheap answer, pinned so nobody rediscovers it in an outage.
	 *
	 * "A watermark does not resemble any real tile" is the intuition this started from and
	 * it is wrong for the case that matters. CARTO draws its notice over a fully rendered
	 * map, so every summary of that tile's own pixels reads as a map, and only the recorded
	 * notice separates them.
	 */
	it('cannot tell the watermarked tile from a real one by its own statistics alone', async () => {
		const watermarked = judgeWindow(await readWindowFixture('carto-raster-voyager-vienna'), await readKeyNotice());

		expect(watermarked.stats.inkShare).toBeGreaterThan(MAP_WINDOW_LIMITS.minInkShare);
		expect(watermarked.stats.lumaSpread).toBeLessThan(MAP_WINDOW_LIMITS.maxLumaSpread);
	});

	it('keeps daylight between a clean render and a watermarked one', async () => {
		const notice = await readKeyNotice();
		const clean = judgeWindow(await readWindowFixture('carto-vector-dark-vienna'), notice);
		const watermarked = judgeWindow(await readWindowFixture('carto-raster-voyager-vienna'), notice);

		expect(watermarked.keyNoticeCoverage / clean.keyNoticeCoverage).toBeGreaterThan(4);
	});
});

describe('judging a style document', () => {
	const keylessStyle = {
		version: 8,
		sources: { carto: { type: 'vector', url: 'https://basemaps.cartocdn.com/vector/carto.streets/v1/tiles.json' } },
		layers: [{ id: 'background', type: 'background' }]
	};

	it('accepts the shape CARTO serves today', () => {
		expect(complainAboutStyle(keylessStyle)).toEqual([]);
	});

	it('refuses a style that draws nothing', () => {
		expect(complainAboutStyle({ ...keylessStyle, layers: [] })).toEqual([
			'has an empty `layers` array, so it draws nothing'
		]);
	});

	it('refuses a style that has started wanting a key', () => {
		const keyed = {
			...keylessStyle,
			sources: { carto: { type: 'vector', url: 'https://basemaps.cartocdn.com/v1/tiles.json?api_key=YOUR_KEY' } }
		};

		expect(complainAboutStyle(keyed)).toEqual(['wants a key: the document mentions `api_key`']);
	});

	it('refuses a style that says so in words', () => {
		const scolding = {
			...keylessStyle,
			layers: [...keylessStyle.layers, { id: 'notice', type: 'symbol', layout: { 'text-field': 'API KEY REQUIRED' } }]
		};

		expect(complainAboutStyle(scolding)).toEqual(['says "api key required"']);
	});

	it('refuses something that is not a style at all', () => {
		expect(complainAboutStyle('<html>404</html>')).toEqual(['is not a style document at all']);
	});

	/**
	 * The fixture both suites answer `basemaps.cartocdn.com` with, held to the same rules as
	 * the real thing (#443).
	 *
	 * It failed this for two years' worth of issues. `layers: []` was thirty-six private
	 * copies of a style that draws nothing (#433), and the one background layer that replaced
	 * them named no sources, so a spec asserting on a picture of it was asserting about a
	 * flat colour. A fixture that this function refuses is a fixture no mocked spec can tell
	 * from a blank.
	 */
	it.each(['dark', 'light'] as const)('accepts the %s fixture the mocked suites answer with', (scheme) => {
		expect(complainAboutStyle(fixtureMapStyle(scheme))).toEqual([]);
	});

	/**
	 * The fixture picks its scheme off CARTO's slug rather than off `MAP_STYLE_URL`, so that
	 * bare Node can load it from `tools/` and `scripts/`. This is what stops that shortcut
	 * from quietly answering every request with the dark document if either URL moves.
	 */
	it('answers each CARTO style URL with the matching scheme', () => {
		expect(fixtureMapStyleFor(MAP_STYLE_URL.light).name).toBe('fixture-light');
		expect(fixtureMapStyleFor(MAP_STYLE_URL.dark).name).toBe('fixture-dark');
	});
});
