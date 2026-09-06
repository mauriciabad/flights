#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const MAX_AGE_MINUTES = Number(process.env.STALE_AFTER_MINUTES ?? 90);
const kill = process.argv.includes('--kill');

const listeners = () => {
	let out = '';
	try {
		out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
	} catch {
		return [];
	}
	const pids = new Set();
	for (const line of out.split('\n').slice(1)) {
		const [command, pid, , , , , , , name] = line.trim().split(/\s+/);
		if (command === 'node' && pid) pids.add(`${pid} ${name ?? ''}`);
	}
	return [...pids];
};


/**
 * BSD ps has no `etimes`, only `etime`, formatted [[dd-]hh:]mm:ss. Asking for `etimes`
 * makes ps exit non-zero, and the first version of this script swallowed that and
 * `continue`d, so every listener was skipped and it always printed "no listeners". It
 * reported a clean machine while a preview server held a port, which is the exact
 * condition it exists to catch.
 */
function elapsedToSeconds(value) {
	const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value ?? '');
	if (!match) return undefined;
	const [, days, hours, minutes, seconds] = match;
	return (
		Number(days ?? 0) * 86400 +
		Number(hours ?? 0) * 3600 +
		Number(minutes) * 60 +
		Number(seconds)
	);
}

const found = [];
let unreadable = 0;
for (const entry of listeners()) {
	const [pid, port] = entry.split(' ');
	let ps = '';
	try {
		ps = execFileSync('ps', ['-o', 'etime=,command=', '-p', pid], { encoding: 'utf8' }).trim();
	} catch (error) {
		console.log(`could not read pid ${pid}: ${error.message.split('\n')[0]}`);
		unreadable++;
		continue;
	}
	const [elapsed, ...rest] = ps.split(/\s+/);
	const seconds = elapsedToSeconds(elapsed);
	const command = rest.join(' ');
	if (seconds === undefined) {
		console.log(`could not parse an age for pid ${pid} from "${elapsed}"`);
		unreadable++;
		continue;
	}
	// `static-server` is in here because leaving it out made this script lie a second time.
	// Every agent works in a git worktree, so the one server this repo actually leaks is
	// `node tests/e2e/support/static-server.mjs build <port>`, launched with a relative path
	// from a worktree. No absolute path, no "vite", no "preview", so the old pattern skipped
	// it and printed a clean machine over four of them holding ports for up to 26 hours.
	if (!/Projects\/flights|vite|sirv|preview|static-server/.test(command)) continue;
	found.push({ pid, port, minutes: Math.round(seconds / 60), command: command.slice(0, 80) });
}

const stale = found.filter((s) => s.minutes >= MAX_AGE_MINUTES);

if (found.length === 0) {
	console.log(
		unreadable === 0
			? 'No node listeners from this project.'
			: `No node listeners readable, but ${unreadable} process(es) could not be inspected. Do not treat this as a clean machine.`
	);
	process.exit(unreadable === 0 ? 0 : 1);
}

for (const s of found) {
	console.log(`${s.minutes >= MAX_AGE_MINUTES ? 'STALE ' : 'live  '} pid ${s.pid} ${s.port} ${s.minutes}m  ${s.command}`);
}

if (!kill) {
	console.log(`\n${stale.length} older than ${MAX_AGE_MINUTES}m. Re-run with --kill to end them.`);
	process.exit(stale.length === 0 ? 0 : 1);
}

for (const s of stale) {
	try {
		process.kill(Number(s.pid));
		console.log(`killed ${s.pid}`);
	} catch (error) {
		console.log(`could not kill ${s.pid}: ${error.message}`);
	}
}
