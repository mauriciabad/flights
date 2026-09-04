/**
 * Prints, at the end of every `pnpm qa` run, which invariants hold and which are pinned to
 * an open defect.
 *
 * A suite that reports "6 passed" while four of those six are expected failures is lying by
 * omission, and this project has already lost time to exactly that shape of reassurance —
 * "closed issues are not the measure" (docs/ACCEPTANCE.md). So the summary names every
 * pinned defect and its issue, every run, whether or not anything failed.
 */

import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter';
import { PINNED_DEFECTS } from '../known-broken';

export default class QaReporter implements Reporter {
	#held: string[] = [];
	#broke: string[] = [];
	#pinned: string[] = [];
	#unpinned: string[] = [];

	onTestEnd(test: TestCase, result: TestResult): void {
		const title = test.titlePath().slice(1).filter(Boolean).join(' › ');
		const failed = result.status === 'failed' || result.status === 'timedOut';
		if (test.expectedStatus === 'failed') {
			// Playwright already fails the run when a pinned check passes, but the message it
			// prints does not say what to do about it.
			(failed ? this.#pinned : this.#unpinned).push(title);
		} else if (failed) {
			this.#broke.push(title);
		} else if (result.status === 'passed') {
			this.#held.push(title);
		}
	}

	onEnd(result: FullResult): void {
		const lines: string[] = ['', '─'.repeat(72), 'pnpm qa — invariants about how the app behaves, not whether its parts work'];

		lines.push('', `Holding (${this.#held.length}):`);
		for (const title of this.#held) lines.push(`  ok    ${title}`);

		const pinnedEntries = Object.entries(PINNED_DEFECTS);
		if (pinnedEntries.length > 0) {
			lines.push(
				'',
				`Pinned to an open defect (${pinnedEntries.length} declared, ${this.#pinned.length} observed failing) — these fail on purpose:`
			);
			for (const [key, defect] of pinnedEntries) {
				lines.push(`  #${defect.issue}  ${defect.summary}`);
				lines.push(`        observed: ${defect.observed}`);
				lines.push(`        un-pin by deleting '${key}' from tests/qa/known-broken.ts once it is fixed`);
			}
		}

		if (this.#unpinned.length > 0) {
			lines.push('', 'A pinned invariant now PASSES. That is a fix worth banking:');
			for (const title of this.#unpinned) lines.push(`  fixed ${title}`);
			lines.push('  Delete its entry from tests/qa/known-broken.ts so it stays fixed.');
		}

		if (this.#broke.length > 0) {
			lines.push('', `BROKEN (${this.#broke.length}) — an invariant nobody had pinned:`);
			for (const title of this.#broke) lines.push(`  FAIL  ${title}`);
		}

		lines.push('', `Result: ${result.status}`, '─'.repeat(72), '');
		process.stdout.write(lines.join('\n'));
	}
}
