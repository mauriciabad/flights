/**
 * Which built chunk serves a bundled dataset, for a suite that wants to answer for one.
 *
 * Issue #379. Three of the sources `algorithm/connections.ts` ranks candidates from are not
 * providers: they are JSON files the app reaches with a plain dynamic `import()`. A suite
 * that mocks every provider still ranks against whatever those files happen to hold, so a
 * spec's fixture can stop describing its own scenario and nothing says so until the data
 * moves. That is what #361 did to three e2e specs.
 *
 * Both suites run against the real production build on purpose (`playwright.config.ts` and
 * `qa.config.ts` build and serve it), so the dataset has to be answered over the wire rather
 * than swapped at build time. SvelteKit names every chunk by content hash alone, as in
 * `app/immutable/chunks/CSe2j8Wu.js` with nothing of the source path left in it, so no URL
 * pattern can find one. Vite's build manifest maps source module to emitted file, which is
 * exactly the question.
 *
 * `tests/qa/support/bundled-data.ts` (issue #395) found the chunks this way first. This is
 * that lookup, split out, because `tests/e2e/support/bundled-data.ts` needs the same answer
 * about the same build and says something different in the chunk.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..');
const MANIFEST = path.join(repoRoot, '.svelte-kit', 'output', 'client', '.vite', 'manifest.json');

/**
 * The served pathname of the chunk built from each source module, e.g.
 * `src/lib/data/direct-routes.generated.json` to `/app/immutable/chunks/D42Weird.js`.
 *
 * Throws rather than skipping a source it cannot find. Skipping would mean quietly reading
 * the real shipped dataset again, which is the whole defect, and it would look like a
 * passing suite.
 */
export function chunkPathnames(sources: readonly string[]): Map<string, string> {
	let manifest: Record<string, { file?: string }>;
	try {
		manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8'));
	} catch (cause) {
		throw new Error(
			`Could not read Vite's build manifest at ${MANIFEST}. ` +
				'A suite needs it to find which hashed chunk serves each bundled dataset. ' +
				'Run `pnpm build` first, or update this path if the build output moved.',
			{ cause }
		);
	}

	const byPathname = new Map<string, string>();
	for (const source of sources) {
		const file = manifest[source]?.file;
		if (!file) {
			throw new Error(
				`Vite's build manifest does not name a chunk for ${source}. ` +
					'Either the module stopped being a dynamic import, in which case its data is now ' +
					'inside a shared chunk and no suite can answer for it, or the file was renamed. ' +
					'Either way a scenario is silently ranking against real shipped data again, which ' +
					'is issue #379.'
			);
		}
		byPathname.set(`/${file}`, source);
	}
	return byPathname;
}
