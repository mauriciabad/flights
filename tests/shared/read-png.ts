import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { readMapWindow, type MapWindow } from '../../src/lib/itinerary-map/basemap-canary';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const basemapFixtures = path.join(repoRoot, 'tests', 'fixtures', 'basemap');

/**
 * A recorded picture, decoded the way a canary decodes a fresh one.
 *
 * `sharp` rather than a browser canvas because both callers are in Node: the unit test and
 * the scheduled supply check. It is already a devDependency, for `scripts/prepare-icons`.
 */
export async function readWindowFixture(name: string): Promise<MapWindow> {
	return readWindowPng(await readFile(path.join(basemapFixtures, `${name}.png`)));
}

export async function readWindowPng(png: Buffer | Uint8Array): Promise<MapWindow> {
	const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	return readMapWindow(data, info.width, info.height);
}

/**
 * The recorded key notice as a mask, from the black pixels of the picture
 * `scripts/prepare-basemap-canary-samples.mjs` writes. Stored as an image rather than as a
 * list of coordinates so a reviewer can open it and read what it says.
 */
export async function readKeyNotice(): Promise<Uint8Array> {
	const { data, info } = await sharp(path.join(basemapFixtures, 'carto-key-notice.png'))
		.greyscale()
		.raw()
		.toBuffer({ resolveWithObject: true });
	const mask = new Uint8Array(info.width * info.height);
	for (let i = 0; i < mask.length; i++) mask[i] = data[i] < 128 ? 1 : 0;
	return mask;
}
