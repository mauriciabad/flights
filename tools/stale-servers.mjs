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

const found = [];
for (const entry of listeners()) {
	const [pid, port] = entry.split(' ');
	let ps = '';
	try {
		ps = execFileSync('ps', ['-o', 'etimes=,command=', '-p', pid], { encoding: 'utf8' }).trim();
	} catch {
		continue;
	}
	const seconds = Number(ps.split(/\s+/)[0]);
	const command = ps.slice(String(seconds).length).trim();
	if (!/Projects\/flights|vite|sirv|preview/.test(command)) continue;
	found.push({ pid, port, minutes: Math.round(seconds / 60), command: command.slice(0, 80) });
}

const stale = found.filter((s) => s.minutes >= MAX_AGE_MINUTES);

if (found.length === 0) {
	console.log('No node listeners from this project.');
	process.exit(0);
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
