#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const WORKTREES = join(ROOT, '.claude', 'worktrees');
const REGENERABLE = ['node_modules', '.svelte-kit', 'build', 'test-results', 'playwright-report'];
const IDLE_HOURS = Number(process.env.IDLE_HOURS ?? 8);
const remove = process.argv.includes('--remove');

if (!existsSync(WORKTREES)) {
	console.log('No agent worktrees.');
	process.exit(0);
}

const locked = new Set(
	execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' })
		.split('\n\n')
		.filter((block) => block.includes('locked'))
		.map((block) => block.split('\n')[0].replace('worktree ', ''))
);

const cutoff = Date.now() - IDLE_HOURS * 3600 * 1000;
let reclaimed = 0;
let skipped = 0;

for (const name of readdirSync(WORKTREES)) {
	const dir = join(WORKTREES, name);
	if (locked.has(dir)) {
		skipped++;
		continue;
	}
	let newest = 0;
	for (const target of REGENERABLE) {
		const path = join(dir, target);
		if (!existsSync(path)) continue;
		newest = Math.max(newest, statSync(path).mtimeMs);
	}
	if (newest === 0) continue;
	if (newest > cutoff) {
		skipped++;
		continue;
	}
	let dirty = '';
	try {
		dirty = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
	} catch {
		skipped++;
		continue;
	}
	if (dirty) {
		console.log(`skip ${name}: ${dirty.split('\n').length} uncommitted changes`);
		skipped++;
		continue;
	}
	for (const target of REGENERABLE) {
		const path = join(dir, target);
		if (!existsSync(path)) continue;
		if (remove) rmSync(path, { recursive: true, force: true });
		reclaimed++;
	}
	console.log(`${remove ? 'cleared' : 'would clear'} ${name}`);
}

console.log(`\n${reclaimed} regenerable directories in idle worktrees, ${skipped} worktrees left alone.`);
if (!remove) console.log('Re-run with --remove to delete them. Branches and commits are never touched.');
