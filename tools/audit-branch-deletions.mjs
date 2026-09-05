/**
 * Does this branch delete something it did not set out to delete?
 *
 *   node tools/audit-branch-deletions.mjs [--base origin/main] [--allow path,path]
 *
 * Exits non-zero when the branch removes a file, or guts one, that its own story does not
 * mention. Run it before you push.
 *
 * On 5 September 2026 a branch came out of a rebase deleting an e2e spec, its probe, and 235
 * lines of a component that had merged an hour earlier. One conflict was reported, in an
 * unrelated stylesheet. CI was green. Nothing in a 44-file diff would have made a reviewer
 * ask, because a file you never mention is absent from the diff's story rather than present
 * in it as a change.
 *
 * The sequence that produced it: `git reset --soft origin/main` to tidy history, then
 * `git add -A`. The soft reset moves your base forward without touching the working tree, so
 * stale copies of files you never opened become a difference against the new base, and
 * `add -A` signs your name to it. What comes out is a well-formed commit that happens to say
 * "delete this feature", and every later rebase applies it cleanly.
 *
 * A deletion you meant is fine: pass it to --allow and the intent is on the record.
 */
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const readFlag = (name, fallback) => {
	const i = args.indexOf(name);
	return i === -1 ? fallback : args[i + 1];
};
const base = readFlag('--base', 'origin/main');
const allowed = new Set(
	(readFlag('--allow', '') || '')
		.split(',')
		.map((p) => p.trim())
		.filter(Boolean)
);

const git = (...a) => execFileSync('git', a, { encoding: 'utf-8' }).trim();

const deleted = git('diff', '--diff-filter=D', '--name-only', `${base}...HEAD`)
	.split('\n')
	.filter(Boolean)
	.filter((p) => !allowed.has(p));

/** A file that loses far more than it gains is a revert wearing an edit's clothes. The
 * threshold is deliberately loose: an extraction that moves 174 lines out of a component is
 * normal and should not trip this, so it fires only when a file is essentially emptied. */
const GUTTED_RATIO = 8;
const GUTTED_FLOOR = 40;
const gutted = git('diff', '--numstat', `${base}...HEAD`)
	.split('\n')
	.filter(Boolean)
	.map((line) => {
		const [added, removed, path] = line.split('\t');
		return { added: Number(added), removed: Number(removed), path };
	})
	.filter(
		(f) =>
			Number.isFinite(f.added) &&
			Number.isFinite(f.removed) &&
			!allowed.has(f.path) &&
			f.removed >= GUTTED_FLOOR &&
			f.removed >= f.added * GUTTED_RATIO
	);

if (deleted.length === 0 && gutted.length === 0) {
	console.log(`This branch deletes nothing against ${base}.`);
	process.exit(0);
}

for (const path of deleted) console.log(`DELETED  ${path}`);
for (const f of gutted) console.log(`GUTTED   ${f.path}  +${f.added} -${f.removed}`);
console.log(
	`\nIf you meant these, pass them to --allow so the intent is recorded. If you did not, you are\n` +
		`about to remove somebody else's work: check whether ${base} moved under you, and read\n` +
		`AGENTS.md on "A rebase can delete a file nobody conflicted over".`
);
process.exit(1);
