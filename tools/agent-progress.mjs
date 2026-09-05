#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const WORKTREES = join(ROOT, '.claude', 'worktrees');
const IDS = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const SKIP = /^(node_modules|\.svelte-kit|build|test-results|playwright-report|\.git)$/;

const newestTouch = (dir, depth = 0) => {
	let newest = 0;
	let file = '';
	let entries = [];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return { newest, file };
	}
	for (const entry of entries) {
		if (SKIP.test(entry.name)) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (depth > 4) continue;
			const deeper = newestTouch(path, depth + 1);
			if (deeper.newest > newest) ({ newest, file } = deeper);
			continue;
		}
		let stat;
		try {
			stat = statSync(path);
		} catch {
			continue;
		}
		if (stat.mtimeMs > newest) {
			newest = stat.mtimeMs;
			file = path.slice(ROOT.length + 1);
		}
	}
	return { newest, file };
};

const git = (dir, args) => {
	try {
		return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
	} catch {
		return '';
	}
};

const names = IDS.length ? IDS.map((id) => `agent-${id.replace(/^agent-/, '')}`) : readdirSync(WORKTREES);
const now = Date.now();
const rows = [];

for (const name of names) {
	const dir = join(WORKTREES, name);
	if (!existsSync(dir)) {
		rows.push({ name, note: 'no worktree' });
		continue;
	}
	const { newest, file } = newestTouch(dir);
	const idleMin = newest ? Math.round((now - newest) / 60000) : Infinity;
	if (IDS.length === 0 && idleMin > 30) continue;
	const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
	const ahead = git(dir, ['rev-list', '--count', 'origin/main..HEAD']) || '0';
	const stat = git(dir, ['diff', '--shortstat']);
	const staged = git(dir, ['diff', '--cached', '--shortstat']);
	const untracked = git(dir, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean).length;
	rows.push({ name, branch, ahead, stat, staged, untracked, idleMin, file });
}

if (rows.length === 0) {
	console.log('No agent worktree touched in the last 30 minutes.');
	process.exit(0);
}

for (const r of rows) {
	if (r.note) {
		console.log(`${r.name}  ${r.note}`);
		continue;
	}
	const flag = r.idleMin >= 12 ? '  <-- STALLED?' : '';
	console.log(`${r.name}  ${r.branch}`);
	console.log(`  ${r.ahead} commits ahead · ${r.stat || 'no unstaged diff'}${r.staged ? ` · staged: ${r.staged}` : ''} · ${r.untracked} untracked`);
	console.log(`  last touched ${r.idleMin}m ago: ${r.file}${flag}`);
}
