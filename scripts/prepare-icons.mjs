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
	'adjustments-horizontal': 'the results filter-and-sort toggle',
	'alert-triangle': 'ErrorState, severity warning',
	'arrow-right': 'FlightPicker, departure to arrival',
	'arrows-up-down': 'SearchForm, swap origin and destination',
	bed: 'ModeIcon and the ItineraryMap marker, the stopover night',
	bus: 'ModeIcon, public transport',
	'calendar-month': 'the flexible-dates link on the results page',
	car: 'ModeIcon, driving',
	check: 'a chosen option: the nights rung, the time format, the currency',
	'chevron-down': 'Select, a menu that opens downwards',
	'chevron-left': 'previous: an earlier month, an earlier photograph, back to the list',
	'chevron-right': 'next: a later month, the next photograph',
	'circle-check': 'ProviderKeyCard, a key that worked',
	'circle-x': 'ErrorState, severity error',
	clock: 'ModeIcon, the airport wait',
	ferry: 'ModeIcon, a transit transfer that rides the water',
	flag: 'ItineraryMap, the marker on where the trip ends',
	home: 'a property with no photograph, and the ItineraryMap marker on where the trip starts',
	'info-circle': 'ErrorState severity info, and a room-tile caveat',
	maximize: 'GroundLegPreviews, open the full map',
	pencil: 'SearchSummaryBar, edit this search',
	plane: 'ModeIcon, the flight',
	settings: 'the app header settings link',
	'shield-check': 'the settings privacy banner',
	ticket: 'EmptyState, nothing issued yet',
	train: 'ModeIcon, a transit transfer that rides rails',
	walk: 'ModeIcon, walking',
	x: 'dismiss: a chip, a saved search, the map dialog, a duration rule'
};

/**
 * The one icon Tabler does not have, built from one it does.
 *
 * Searched before writing this: `taxi` matches nothing in the outline set, and the only
 * icon tagged "taxi" in Tabler's own metadata is `brand-uber`, a company logo, which is not
 * what a mode of transport means. So the choice was a hand-drawn taxi beside a Tabler car
 * (two silhouettes for the same vehicle, the exact drift #321 exists to remove), a taxi
 * identical to the drive icon (the transport picker lists both, one above the other), or
 * this: Tabler's own car with a roof sign on it, drawn on Tabler's grid at Tabler's weight,
 * which is the only thing that tells the two apart on a real street either.
 *
 * The sign is one stroke rather than a filled rectangle. At the 15px this renders at, a
 * 2-unit stroke with round caps IS a solid bar, and `Icon.svelte` sets `fill="none"` once
 * for the whole set — an icon that needed its own fill would be the start of a second set.
 * `M8 5h3` sits centred on the cabin (Tabler's car roofs it from x=5 to x=14) and its lower
 * edge lands on the roof line at y=6, so the sign is on the roof rather than floating.
 */
const COMPOSED_ICONS = {
	taxi: { from: 'car', add: ['M8 5h3'], use: 'ModeIcon, a taxi: Tabler has no taxi icon' }
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

for (const [name, { from, add, use }] of Object.entries(COMPOSED_ICONS)) {
	const base = entries.find((entry) => entry.name === from);
	if (!base) {
		failures.push(`${name}: composed from ${from}, which is not in ICON_NAMES`);
		continue;
	}
	if (!allSource.includes(`'${name}'`) && !allSource.includes(`"${name}"`)) {
		failures.push(`${name}: nothing under src/ names it, so vendoring it would ship dead bytes`);
		continue;
	}
	entries.push({ name, use: `${use} (Tabler '${from}' plus ${add.join(', ')})`, paths: [...base.paths, ...add] });
}
entries.sort((a, b) => a.name.localeCompare(b.name));

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
// The ${entries.length} icons this app draws, and no others: Tabler ships 5130 and the rest
// of them are not in this file, so they cannot reach a browser. \`Icon.svelte\` renders one
// <path> per string here, on Tabler's own 24-unit grid at its own stroke weight, which is
// what makes the whole set one weight instead of fifteen hand-drawn approximations of one.
// One entry is composed rather than copied; its comment says which and from what.
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
	`Vendored ${Object.keys(ICON_NAMES).length} of 5130 Tabler icons plus ${Object.keys(COMPOSED_ICONS).length} composed from them, ${bytes} bytes of path data, from @tabler/icons ${packageJson.version}.`
);
