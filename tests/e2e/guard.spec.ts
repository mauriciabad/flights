import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './support/fixtures';
import { FIXTURE_MARKER_TOKENS } from './support/fixture-markers';

/**
 * The network guard (support/network-guard.ts) only protects a spec file that actually
 * imports `test`/`expect` from support/fixtures.ts. Nothing stops a future spec from
 * importing '@playwright/test' directly instead and quietly talking to the real
 * internet, so this test makes that mistake fail the suite rather than fail silently —
 * the whole point, given the Skyscanner free tier is 20 requests a month.
 *
 * Live tests are the one deliberate exception: they import support/live-fixtures.ts
 * and live under tests/e2e/live/, so this checks each half of the codebase separately.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const thisFile = fileURLToPath(import.meta.url);

function findSpecFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'support') return [];
			return findSpecFiles(full);
		}
		return entry.name.endsWith('.spec.ts') ? [full] : [];
	});
}

function importsDirectlyFrom(file: string, moduleSpecifier: string): boolean {
	const source = readFileSync(file, 'utf-8');
	const pattern = new RegExp(`from ['"]${moduleSpecifier.replace(/[/]/g, '\\/')}['"]`);
	return pattern.test(source);
}

const repoRoot = path.resolve(e2eDir, '..', '..');

function findFiles(dir: string, matches: (name: string) => boolean): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return findFiles(full, matches);
		return matches(entry.name) ? [full] : [];
	});
}

function relative(file: string): string {
	return path.relative(repoRoot, file);
}

/**
 * Drops block comments and whole-line `//` comments, so the scans below judge what a file
 * *does* rather than what it explains. Deliberately leaves trailing `//` comments alone:
 * stripping those would also swallow the rest of any line holding a `https://` URL, and a
 * scan that silently skips code is worse than one that reads a stray comment.
 */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.filter((line) => !line.trimStart().startsWith('//'))
		.join('\n');
}

test.describe('test harness self-checks', () => {
	test('default suite specs import test/expect from support/fixtures, not @playwright/test', () => {
		const offenders = findSpecFiles(e2eDir)
			.filter((file) => file !== thisFile)
			.filter((file) => !file.includes(`${path.sep}live${path.sep}`))
			.filter((file) => importsDirectlyFrom(file, '@playwright/test'))
			.map((file) => path.relative(process.cwd(), file));

		expect(
			offenders,
			'These specs import "@playwright/test" directly, which bypasses the real-network ' +
				"guard:\n" +
				offenders.join('\n') +
				"\nImport { test, expect } from './support/fixtures' instead."
		).toEqual([]);
	});

	test('live suite specs import test/expect from support/live-fixtures, not @playwright/test', () => {
		const liveDir = path.join(e2eDir, 'live');
		const offenders = findSpecFiles(liveDir)
			.filter((file) => importsDirectlyFrom(file, '@playwright/test'))
			.map((file) => path.relative(process.cwd(), file));

		expect(
			offenders,
			'These live specs import "@playwright/test" directly, which skips the opt-in ' +
				"guard that keeps them from running by accident:\n" +
				offenders.join('\n') +
				"\nImport { test, expect } from '../support/live-fixtures' instead."
		).toEqual([]);
	});

	// Deliberately doesn't say the tag literally in the title: Playwright's --grep
	// matches test titles too, and a title containing "@live" would make
	// `--grep-invert @live` exclude this very test from the default run.
	test('every live-suite test carries the live tag, and no default-suite test does', () => {
		const liveDir = path.join(e2eDir, 'live');
		const liveFiles = findSpecFiles(liveDir);
		const untaggedLiveFiles = liveFiles
			.filter((file) => !readFileSync(file, 'utf-8').includes('@live'))
			.map((file) => path.relative(process.cwd(), file));

		const defaultFiles = findSpecFiles(e2eDir).filter(
			(file) => file !== thisFile && !file.includes(`${path.sep}live${path.sep}`)
		);
		const taggedDefaultFiles = defaultFiles
			.filter((file) => readFileSync(file, 'utf-8').includes('@live'))
			.map((file) => path.relative(process.cwd(), file));

		expect(untaggedLiveFiles, `Missing an '@live' tag: ${untaggedLiveFiles.join(', ')}`).toEqual([]);
		expect(
			taggedDefaultFiles,
			`'@live' tag found outside tests/e2e/live/: ${taggedDefaultFiles.join(', ')}`
		).toEqual([]);
	});
});

/**
 * The second half of this file guards the fixtures rather than the harness.
 *
 * An agent reported "1 itinerary, BVC -> LGW -> PFO, EUR 238.00, via Ryanair, with zero
 * keys configured" and believed the app worked. It was reading a mock: the fixture that
 * answered had been built to match the owner's reference itinerary exactly, down to two
 * leg prices summing to his EUR 238, so nothing about the answer could tell a mock apart
 * from the app succeeding. The rules below make that shape of mistake fail the suite
 * instead of reaching a report.
 */
test.describe('fixtures cannot be mistaken for real results', () => {
	test('every mock payload carries a marker identifying it as fake', () => {
		const fixturesDir = path.join(e2eDir, 'fixtures');
		const manifest = path.join(fixturesDir, 'markers.json');
		const carriesMarker = (source: string) => FIXTURE_MARKER_TOKENS.some((token) => source.includes(token));

		// Fixture files on disk...
		const unmarkedFixtures = findFiles(fixturesDir, (name) => name.endsWith('.json'))
			.filter((file) => file !== manifest)
			.filter((file) => !carriesMarker(readFileSync(file, 'utf-8')));

		// ...and the payloads specs build inline, which is where the escaped one came from.
		// A spec that names a flight number or a room rate is manufacturing an offer,
		// whatever it calls the variable.
		const offerTokens = ['flightNumber', 'hotel_name', 'grossPrice', 'gross_amount_per_night'];
		const unmarkedSpecs = findSpecFiles(e2eDir)
			.filter((file) => file !== thisFile)
			.map((file) => ({ file, code: stripComments(readFileSync(file, 'utf-8')) }))
			.filter(({ code }) => offerTokens.some((token) => code.includes(token)))
			.filter(({ code }) => !carriesMarker(code))
			.map(({ file }) => file);

		const unmarked = [...unmarkedFixtures, ...unmarkedSpecs].map(relative);

		expect(
			unmarked,
			'These mocks carry none of the markers in tests/e2e/fixtures/markers.json, so a ' +
				'response served from one would read as a real provider answer:\n' +
				unmarked.join('\n') +
				'\nTake the values from support/fixture-markers.ts: a FIXTURE-prefixed name, a ' +
				'ZZ00xx flight number, a five-figure price. tools/probe-results.mjs reads the ' +
				'same markers to refuse a measurement it took off a mocked page.'
		).toEqual([]);
	});

	test('no mock manufactures an offer on the route docs/ACCEPTANCE.md decides this project on', () => {
		// BVC -> PFO is the one trip that says whether this app works, so a mocked *result*
		// on it is the one mock nobody can sanity-check by eye — which is exactly how one
		// got reported as a success.
		//
		// Searching that route is fine and `provider-answered-nothing.spec.ts` has to:
		// proving Ryanair's 404 reads as "answered with nothing" is the honest half of the
		// same story. What is banned is naming those airports in a file that also builds a
		// bookable-looking payload.
		const offerTokens = ['flightNumber', 'hotel_name', 'grossPrice', 'gross_amount_per_night'];
		const offenders = findFiles(e2eDir, (name) => name.endsWith('.ts') || name.endsWith('.json'))
			.filter((file) => file !== thisFile)
			.map((file) => ({ file, code: stripComments(readFileSync(file, 'utf-8')) }))
			.filter(({ code }) => code.includes('BVC') || code.includes('PFO'))
			.filter(({ code }) => offerTokens.some((token) => code.includes(token)))
			.map(({ file }) => relative(file));

		expect(
			offenders,
			'These files mock a flight or a stay on the acceptance route (BVC/PFO):\n' +
				offenders.join('\n') +
				'\nMock the offer on any other airports, or drop the offer and keep the route. ' +
				'See docs/ACCEPTANCE.md and tests/e2e/fixtures/README.md.'
		).toEqual([]);
	});

	test('no spec gets hold of a browser that could outlive it', () => {
		// A spec only ever mocks through the `page`/`context` Playwright hands it, which
		// Playwright disposes when the test ends. A spec that launched or attached to a
		// browser of its own could leave route handlers armed in something longer-lived —
		// which is the failure this repo actually hit, from the other direction: mocks
		// pasted by hand into the shared Playwright MCP browser answered a different
		// agent's page half an hour later. See AGENTS.md, "Mocks belong to a test".
		const forbidden = ['chromium.launch', 'chromium.connect', 'launchPersistentContext', 'newContext('];
		const offenders = findFiles(e2eDir, (name) => name.endsWith('.ts'))
			.filter((file) => file !== thisFile)
			.map((file) => ({ file, code: stripComments(readFileSync(file, 'utf-8')) }))
			.filter(({ code }) => forbidden.some((call) => code.includes(call)))
			.map(({ file }) => relative(file));

		expect(
			offenders,
			'These specs reach for a browser of their own instead of the per-test one:\n' +
				offenders.join('\n') +
				`\nForbidden: ${forbidden.join(', ')}. Mock through the \`page\` or \`context\` ` +
				'fixture, which Playwright closes at the end of the test.'
		).toEqual([]);
	});

	test('nothing waits for the results page to stop saying "still searching"', () => {
		// Issue #337. `toHaveCount(0)` on that text is satisfied by absence, and the text is
		// absent on a page that has not started searching for the same reason it is absent
		// on a finished one. Ten runs on the fixture results-layout.spec.ts uses: nine
		// returned in under 40ms with zero cards on screen, and the first card arrived 3.8
		// seconds later. Both suites wait on `data-search-phase` now
		// (tests/shared/search-wait.ts), and half a migration would keep the flake while
		// hiding which specs still have it.
		const suiteDirs = [e2eDir, path.join(repoRoot, 'tests', 'qa')];
		const offenders = suiteDirs
			.flatMap((dir) => findFiles(dir, (name) => name.endsWith('.ts')))
			.filter((file) => file !== thisFile)
			.map((file) => ({ file, code: stripComments(readFileSync(file, 'utf-8')) }))
			.filter(({ code }) => code.includes("getByText('still searching')"))
			.map(({ file }) => relative(file));

		expect(
			offenders,
			'These files wait on the "still searching" text:\n' +
				offenders.join('\n') +
				'\nThat wait passes before the search starts. Use `waitForSearchToSettle` from ' +
				'tests/shared/search-wait.ts, which waits for the page to say it settled.'
		).toEqual([]);
	});

	test('the probe tools observe the network, never answer it', () => {
		// tools/probe-*.mjs are the instruments AGENTS.md and docs/ACCEPTANCE.md tell
		// agents to verify production with. An instrument that can serve a fixture cannot
		// be trusted to detect one.
		const toolsDir = path.join(repoRoot, 'tools');
		const forbidden = ['.route(', 'routeFromHAR', 'route.fulfill', 'setOffline'];
		const offenders = findFiles(toolsDir, (name) => name.endsWith('.mjs'))
			.map((file) => ({ file, code: stripComments(readFileSync(file, 'utf-8')) }))
			.filter(({ code }) => forbidden.some((call) => code.includes(call)))
			.map(({ file }) => relative(file));

		expect(
			offenders,
			'These probe tools can intercept or fake a response:\n' +
				offenders.join('\n') +
				`\nForbidden: ${forbidden.join(', ')}. A probe reports what production did; ` +
				'anything that answers a request belongs in a spec.'
		).toEqual([]);
	});
});
