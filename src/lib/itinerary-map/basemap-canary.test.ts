import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * The calibration table in `basemap-canary.ts`, against the run that recorded it (#466).
 *
 * A human used to copy that table out of `pnpm data:basemap-canary`'s console. One cell
 * arrived wrong. The shared fixture's luminance spread was written 0.0662 while the drawing
 * that shipped in the same commit measures 0.0695. No threshold is read off that row, so
 * nothing failed and nothing could.
 *
 * The script writes `calibration.tsv` now and this reads both files. It is a check on prose,
 * which is unusual and is the point. The table is the evidence for every threshold in that
 * module, and evidence nobody can check is a number somebody liked.
 *
 * Ranges are collapsed the way the comment writes them. The script always prints `min - max`
 * and the table shows one figure where the two are equal, which is a formatting rule rather
 * than a difference in what was measured.
 */
describe('the calibration table is the recorded one (issue #466)', () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const repo = path.join(here, '..', '..', '..');

	interface Row {
		population: string;
		n: string;
		inkShare: string;
		lumaSpread: string;
		keyNotice: string;
	}

	function recorded(): Row[] {
		const lines = readFileSync(path.join(repo, 'tests/fixtures/basemap/calibration.tsv'), 'utf8')
			.split('\n')
			.filter((line) => line.length > 0 && !line.startsWith('#'));
		const collapse = (cell: string) => {
			const [low, high] = cell.split(' - ');
			return high === undefined || low === high ? low : cell;
		};
		return lines.slice(1).map((line) => {
			const [population, n, inkShare, lumaSpread, keyNotice] = line.split('\t');
			return {
				population,
				n,
				inkShare: collapse(inkShare),
				lumaSpread: collapse(lumaSpread),
				keyNotice: collapse(keyNotice)
			};
		});
	}

	function documented(): Row[] {
		const source = readFileSync(path.join(here, 'basemap-canary.ts'), 'utf8');
		return source
			.split('\n')
			.filter((line) => line.trimStart().startsWith('* |'))
			.map((line) =>
				line
					.trim()
					.slice(2)
					.split('|')
					.map((cell) => cell.trim())
					.filter((cell) => cell.length > 0)
			)
			.filter(([population]) => population !== 'population' && !population.startsWith('---'))
			.map(([population, n, inkShare, lumaSpread, keyNotice]) => ({
				population,
				n,
				inkShare,
				lumaSpread,
				keyNotice
			}));
	}

	it('quotes every cell the last run measured, in the order it measured them', () => {
		expect(documented()).toEqual(recorded());
	});

	it('reads a table at all, so a comment that lost its rows fails rather than passes', () => {
		// Both sides of the check above are parsed out of files, and two empty lists are
		// equal. This is what stops a reformatted comment or a truncated file from reading as
		// agreement.
		expect(documented().length).toBeGreaterThanOrEqual(6);
	});
});

/**
 * The shared fixture's own range, against the run that recorded it (issue #469).
 *
 * The same defect as #466 one level down, in the file the block above already imports.
 * `tests/shared/map-style-fixture.ts` said what it draws in prose, copied out of a tool that
 * printed the numbers and kept none of them, so the sentence had the half-life of any other
 * transcription. `tools/probe-fixture-basemap.mjs` writes `fixture-range.tsv` now and this
 * reads both.
 *
 * Nothing is re-measured here, and that is deliberate. Those figures come from fourteen real
 * MapLibre renders, seven cameras in each of the two schemes, and this suite is jsdom and has
 * no renderer to take them with. The probe stays the measurement. This is only the check that
 * the paragraph beside the fixture still quotes what the probe last found, which is the half
 * that was missing.
 */
describe("the fixture's measured range is the recorded one (issue #469)", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const repo = path.join(here, '..', '..', '..');

	interface Range {
		windows: string;
		zoom: string;
		inkShare: string;
		lumaSpread: string;
	}

	function recorded(): Range {
		const lines = readFileSync(path.join(repo, 'tests/fixtures/basemap/fixture-range.tsv'), 'utf8')
			.split('\n')
			.filter((line) => line.length > 0 && !line.startsWith('#'));
		const row = lines
			.slice(1)
			.map((line) => line.split('\t'))
			.find(([style]) => style === 'the shipped fixture');
		if (!row) throw new Error(`no shipped-fixture row among ${lines.length - 1} recorded`);
		const [, windows, zoom, inkShare, lumaSpread] = row;
		return { windows, zoom, inkShare, lumaSpread };
	}

	/**
	 * The comment's figures, read off the prose it is written as.
	 *
	 * Prose rather than the markdown table #466 could parse, because this one is a paragraph
	 * arguing why the fixture draws what it draws, and a table in the middle of it would be a
	 * worse comment for the sake of an easier regex. The comment markers come off and the
	 * whole file collapses to one line first, so the sentence can wrap wherever it reads best.
	 */
	function documented(): Range {
		const prose = readFileSync(path.join(repo, 'tests/shared/map-style-fixture.ts'), 'utf8')
			.split('\n')
			.map((line) => line.replace(/^\s*\*\s?/, ''))
			.join(' ')
			.replace(/\s+/g, ' ');
		// Every figure is `\d+\.?\d*` rather than `[\d.]+`, so the full stop that ends the
		// sentence stays out of the last one.
		const found = prose.match(
			/from z(\d+\.?\d*) to z(\d+\.?\d*)[^.]*\. Across those (\d+) windows it inks (\d+\.?\d*) to (\d+\.?\d*) of its pixels at a luminance spread of (\d+\.?\d*) to (\d+\.?\d*)/
		);
		if (!found) throw new Error('map-style-fixture.ts no longer states its measured range');
		const [, zoomLow, zoomHigh, windows, inkLow, inkHigh, spreadLow, spreadHigh] = found;
		return {
			windows,
			zoom: `${zoomLow} - ${zoomHigh}`,
			inkShare: `${inkLow} - ${inkHigh}`,
			lumaSpread: `${spreadLow} - ${spreadHigh}`
		};
	}

	// No companion check that a range is stated at all, which #466's table needed because two
	// empty lists compare equal. Both readers here throw with their own sentence when they
	// find nothing, so a comment that lost its range cannot read as agreement.
	it('quotes every figure the last run measured', () => {
		expect(documented()).toEqual(recorded());
	});
});
