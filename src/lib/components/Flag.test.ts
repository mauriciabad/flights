/**
 * Two things are being protected here.
 *
 * The component half: a flag is either a real `<img>` or a deliberate placeholder, and
 * never a broken image. That was structurally true of the emoji lookup this replaces
 * (issue #11: "never a broken one") because emoji have no URL to fail, so swapping in
 * real files has to earn the property back rather than assume it.
 *
 * The asset half: `FLAG_ASSET_CODES` is only a real guarantee while it agrees with both
 * the airport dataset and the files on disk. Regenerating airports.generated.json with a
 * new country, or losing an SVG in a rebase, both fail here rather than in front of the
 * traveller.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Country } from '../domain';
import { FLAG_ASSET_CODES } from '../data/flag-assets.generated';
import airports from '../data/airports.generated.json';
import Flag from './Flag.svelte';

const croatia: Country = { isoCode: 'HR', name: 'Croatia' };

let host: HTMLElement | undefined;
let component: Record<string, unknown> | undefined;

function render(props: Record<string, unknown>): HTMLElement {
	host = document.createElement('div');
	document.body.appendChild(host);
	component = mount(Flag, { target: host, props });
	flushSync();
	return host;
}

afterEach(() => {
	if (component) unmount(component);
	host?.remove();
	component = undefined;
	host = undefined;
});

describe('Flag', () => {
	it('draws the vendored SVG for a country that has one, named for a screen reader', () => {
		const image = render({ country: croatia }).querySelector('img');
		expect(image?.getAttribute('src')).toBe('/flags/hr.svg');
		expect(image?.getAttribute('alt')).toBe('Flag of Croatia');
	});

	it('hides the flag from a screen reader when the country is already written beside it', () => {
		const image = render({ country: croatia, decorative: true }).querySelector('img');
		expect(image?.getAttribute('alt')).toBe('');
	});

	it('draws a placeholder rather than an <img> for a country with no flag file', () => {
		// Antarctica has no scheduled-service airport, so it is deliberately not among
		// the vendored flags: the point is that this renders nothing that can 404.
		const element = render({ country: { isoCode: 'AQ', name: 'Antarctica' } });
		expect(element.querySelector('img')).toBeNull();
		expect(element.querySelector('.flag-empty')).not.toBeNull();
	});

	it('draws a placeholder for a missing country instead of failing', () => {
		expect(render({ country: undefined }).querySelector('img')).toBeNull();
		expect(render({ country: null }).querySelector('.flag-empty')).not.toBeNull();
	});
});

describe('flag assets', () => {
	const flagsDir = path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		'..',
		'..',
		'..',
		'static',
		'flags'
	);

	it('has a file on disk for every code the component is willing to render', () => {
		const onDisk = new Set(
			readdirSync(flagsDir)
				.filter((name) => name.endsWith('.svg'))
				.map((name) => name.slice(0, -4))
		);
		for (const code of FLAG_ASSET_CODES) {
			expect(onDisk.has(code), `static/flags/${code}.svg is missing`).toBe(true);
		}
	});

	it('covers every country the airport dataset can put on screen', () => {
		const countries = new Set(
			(airports as { countryCode?: string }[])
				.map((airport) => airport.countryCode?.toLowerCase())
				.filter((code): code is string => Boolean(code))
		);
		const uncovered = [...countries].filter((code) => !FLAG_ASSET_CODES.has(code));
		expect(uncovered, 'run `pnpm run data:flags` after changing the airport dataset').toEqual(
			[]
		);
	});

	it('ships the licence next to the copies it applies to', () => {
		expect(readdirSync(flagsDir)).toContain('LICENSE.md');
	});
});
