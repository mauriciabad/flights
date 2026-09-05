/**
 * `iconMarkup` is the second thing in this app that turns a Tabler name into an `<svg>`,
 * and a second renderer is only worth having while it cannot disagree with the first. So
 * this does not check the string against a fixture. It mounts `Icon.svelte` on the same
 * name and compares the two trees: same tag, same attributes, same paths in the same order.
 *
 * That is the whole objection to the helper, answered. Change the stroke weight, the grid,
 * the caps or the joins in `Icon.svelte` and this fails until `iconMarkup` follows, rather
 * than the map quietly keeping the old weight the way the hand-drawn glyphs did.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import Icon from './Icon.svelte';
import { iconMarkup } from './icon-markup';
import { TABLER_ICON_PATHS, type IconName } from '$lib/data/tabler-icons.generated';

let host: HTMLElement | undefined;
let component: Record<string, unknown> | undefined;

/** What `Icon.svelte` puts on screen for a decorative icon, which is every icon the map
 *  draws: no `label`, so no `role` and no `aria-label`. */
function rendered(name: IconName): SVGElement {
	host = document.createElement('div');
	document.body.appendChild(host);
	component = mount(Icon, { target: host, props: { name } });
	flushSync();
	return host.querySelector('svg')!;
}

function fromMarkup(name: IconName): SVGElement {
	const holder = document.createElement('div');
	holder.innerHTML = iconMarkup(name);
	return holder.querySelector('svg')!;
}

/** Every attribute except `class`. The component's is Svelte's scoping hash plus `icon`,
 *  which is exactly what a string built outside a component cannot have and does not want:
 *  the marker's own stylesheet sizes it. */
function attributes(element: Element): Record<string, string> {
	const found: Record<string, string> = {};
	for (const attribute of element.attributes) {
		if (attribute.name === 'class') continue;
		found[attribute.name] = attribute.value;
	}
	return found;
}

afterEach(() => {
	if (component) unmount(component);
	host?.remove();
	component = undefined;
	host = undefined;
});

describe('iconMarkup', () => {
	// The three the map draws, plus one composed icon, which is the case where the path
	// list is built rather than copied and so the one most able to come out different.
	for (const name of ['home', 'bed', 'flag', 'taxi'] as const) {
		it(`draws ${name} exactly as Icon.svelte draws it`, () => {
			const component = rendered(name);
			const markup = fromMarkup(name);

			expect(markup.tagName).toBe(component.tagName);
			expect(attributes(markup)).toEqual(attributes(component));

			const drawn = (element: SVGElement) =>
				[...element.querySelectorAll('path')].map((path) => attributes(path));
			expect(drawn(markup)).toEqual(drawn(component));
			expect(drawn(markup).map((path) => path.d)).toEqual([...TABLER_ICON_PATHS[name]]);
		});
	}

	it('carries no name of its own, so nothing announces the glyph twice', () => {
		const markup = fromMarkup('home');
		expect(markup.getAttribute('aria-hidden')).toBe('true');
		expect(markup.getAttribute('role')).toBeNull();
		expect(markup.getAttribute('aria-label')).toBeNull();
	});
});
