import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './support/fixtures';

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
