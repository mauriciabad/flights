#!/usr/bin/env node
// Vendors the Tabler icons this app draws into src/lib/data/tabler-icons.generated.ts.
//
// Why vendored rather than imported: AGENTS.md's no-backend rule means the whole app is a
// static bundle a browser downloads, and @tabler/icons ships 5130 outline SVGs. An icon
// package in `dependencies` puts the tree-shaker between "what we import" and "what a
// visitor downloads", and nobody reviewing a PR can see through it. The generated file
// below is the answer instead: it is in the repository, it is a list a reader can count,
// and an icon that is not in it cannot reach a browser. Same reasoning, same shape and the
// same `pnpm run data:*` habit as scripts/prepare-flags.mjs, which vendors the flags.
//
// Source: @tabler/icons 3.46.0 (https://github.com/tabler/tabler-icons), MIT, whose LICENSE
// is a real file in the published package — checked, because issue #11 already rejected an
// icon set whose README claimed a licence the repository did not carry. The licence text is
// copied to src/lib/data/tabler-icons.LICENSE so it travels with the copies.
//
// Run `pnpm run data:icons` after adding a name to ICON_NAMES below. The output is
// committed so `pnpm build` never depends on node_modules or a network.
//
// Two things this refuses to do, both of them the point:
//
//   - Vendor an icon no source file names. Every entry in ICON_NAMES has to appear in a
//     `src/` file, or this exits non-zero. That is what makes "only the icons in use ship"
//     a property a reviewer can re-check by rerunning the script rather than a claim.
//   - Vendor an icon that is not a plain run of <path d="…"/>. Icon.svelte draws one
//     <path> per string and sets stroke, cap and join once for the whole set, so an icon
//     carrying a <circle>, a fill or a per-element stroke width would silently lose it.

import { readFile, readdir, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every Tabler icon this app draws, by its Tabler name, with the concept it stands for.
 * Sorted, because the generated file is sorted and a diff of either should read as one
 * line added rather than a reshuffle.
 */
const ICON_NAMES = {
	'alert-triangle': 'ErrorState, severity warning',
	'arrow-right': 'FlightPicker, departure to arrival',
	'arrows-up-down': 'SearchForm, swap origin and destination',
	check: 'a chosen option: the nights rung, the time format, the currency',
	'chevron-down': 'Select, a menu that opens downwards',
	'chevron-left': 'DateWindowPicker, earlier months',
	'chevron-right': 'DateWindowPicker, later months',
	'circle-check': 'ProviderKeyCard, a key that worked',
	'circle-x': 'ErrorState, severity error',
	'info-circle': 'ErrorState, severity info',
	maximize: 'GroundLegPreviews, open the full map',
	settings: 'the app header settings link',
	'shield-check': 'the settings privacy banner',
	ticket: 'EmptyState, nothing issued yet',
	x: 'dismiss: a chip, a saved search, the map dialog, a duration rule'
};

const root = fileURLToPath(new URL('..', import.meta.url));
const OUTPUT_PATH = path.join(root, 'src', 'lib', 'data', 'tabler-icons.generated.ts');
const LICENCE_PATH = path.join(root, 'src', 'lib', 'data', 'tabler-icons.LICENSE');
const SOURCE_DIR = path.join(root, 'src');

// By path rather than `require.resolve`: @tabler/icons publishes an `exports` map that does
// not expose its own package.json, and the raw SVGs are files on disk, not module entries.
const packageDir = path.join(root, 'node_modules', '@tabler', 'icons');
const packageJson = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf-8'));
const iconsDir = path.join(packageDir, 'icons', 'outline');

/** Tabler opens every icon with an invisible 24×24 box so the glyph keeps its bounds when
 *  someone drops it into a layout that measures ink. Icon.svelte sizes the <svg> itself, so
 *  the box is bytes with no job. */
const BOUNDING_BOX = 'M0 0h24v24H0z';

const failures = [];

/** Every `.svelte`, `.ts` and `.svelte.ts` file under src/, flattened, so a name can be
 *  checked against what the app actually writes. */
async function sourceFiles(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
		else if (/\.(svelte|ts)$/.test(entry.name) && full !== OUTPUT_PATH) files.push(full);
	}
	return files;
}

const sources = await Promise.all(
	(await sourceFiles(SOURCE_DIR)).map((file) => readFile(file, 'utf-8'))
);
const allSource = sources.join('\n');

function pathsOf(name, svg) {
	const body = svg.replace(/<svg[^>]*>/, '').replace('</svg>', '');
	const elements = body.match(/<[a-z]+[^>]*\/>/g) ?? [];
	const paths = [];
	for (const element of elements) {
		if (!element.startsWith('<path ')) {
			failures.push(`${name}: ${element.trim()} is not a <path>, and Icon.svelte draws only paths`);
			continue;
		}
		const d = element.match(/\sd="([^"]+)"/)?.[1];
		if (!d) {
			failures.push(`${name}: a <path> with no d attribute`);
			continue;
		}
		if (d.startsWith(BOUNDING_BOX)) continue;
		const extra = element.replace(/\sd="[^"]*"/, '').match(/\s([a-z-]+)="[^"]*"/g);
		if (extra) {
			failures.push(`${name}: <path> carries ${extra.join(' ')}, which Icon.svelte would drop`);
			continue;
		}
		paths.push(d);
	}
	if (paths.length === 0) failures.push(`${name}: no drawable path survived`);
	return paths;
}

const entries = [];
for (const [name, use] of Object.entries(ICON_NAMES).sort(([a], [b]) => a.localeCompare(b))) {
	let svg;
	try {
		svg = await readFile(path.join(iconsDir, `${name}.svg`), 'utf-8');
	} catch {
		failures.push(`${name}: no such icon in @tabler/icons ${packageJson.version}`);
		continue;
	}
	if (!allSource.includes(`'${name}'`) && !allSource.includes(`"${name}"`)) {
		failures.push(`${name}: nothing under src/ names it, so vendoring it would ship dead bytes`);
		continue;
	}
	entries.push({ name, use, paths: pathsOf(name, svg) });
}

if (failures.length > 0) {
	console.error(`prepare-icons refused to write:\n  ${failures.join('\n  ')}`);
	process.exit(1);
}

await copyFile(path.join(packageDir, 'LICENSE'), LICENCE_PATH);

const body = entries
	.map(({ name, use, paths }) => {
		const key = /^[a-z][a-z0-9]*$/.test(name) ? name : `'${name}'`;
		const drawn = paths.map((d) => `\t\t'${d}'`).join(',\n');
		return `\t/** ${use} */\n\t${key}: [\n${drawn}\n\t]`;
	})
	.join(',\n');

const bytes = entries.reduce((total, entry) => total + entry.paths.join('').length, 0);

const file = `// Generated by scripts/prepare-icons.mjs. Do not edit by hand.
//
// The ${entries.length} Tabler icons this app draws, and no others: 5130 exist and the rest
// of them are not in this file, so they cannot reach a browser. \`Icon.svelte\` renders one
// <path> per string here, on Tabler's own 24-unit grid at its own stroke weight, which is
// what makes the whole set one weight instead of fifteen hand-drawn approximations of one.
//
// Source: @tabler/icons ${packageJson.version} (MIT). See tabler-icons.LICENSE beside this file.
// Add a name to ICON_NAMES in the script and run \`pnpm run data:icons\`; the script refuses
// a name no source file uses, so this list cannot drift ahead of the app.

export const TABLER_ICON_PATHS = {
${body}
} as const;

/** Every icon a caller may ask \`Icon.svelte\` for. A name outside this union is a type
 *  error rather than an empty <svg> nobody notices until it is on screen. */
export type IconName = keyof typeof TABLER_ICON_PATHS;
`;

await writeFile(OUTPUT_PATH, file);

console.log(
	`Vendored ${entries.length} of 5130 Tabler icons, ${bytes} bytes of path data, from @tabler/icons ${packageJson.version}.`
);
