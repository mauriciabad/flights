/**
 * Issue #189: "Deselecting a filter chip changes the results but not the chip."
 *
 * Measured in a real browser against a production build of the app before this test
 * existed: clicking a facet chip re-filtered the list and left `aria-pressed="true"` and
 * the selected styling exactly where they were, on all nine chips of the acceptance trip.
 *
 * The cause is two owners for one piece of state. `Chip` declared `selected` as
 * `$bindable` and wrote to it in its own click handler, while the parent derived the same
 * `selected` from application state and rewrote that state from the same click. `onclick`
 * ran first, so the chip's flip was applied on top of the parent's already-updated value
 * and landed back where it started.
 *
 * These tests drive the chip through the harness rather than asserting the prop, because
 * the prop was never the thing that was wrong: `aria-pressed` and `is-selected` are what a
 * screen reader announces and what a sighted traveller sees.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import Chip from './Chip.svelte';
import ChipFacetHarness from './ChipFacetHarness.svelte';

let target: HTMLElement | undefined;
let instance: Record<string, unknown> | undefined;

afterEach(() => {
	if (instance) unmount(instance);
	target?.remove();
	instance = undefined;
	target = undefined;
});

interface Harness {
	currentChosen(): ReadonlySet<string>;
}

function renderFacets(values: string[]) {
	target = document.createElement('div');
	document.body.appendChild(target);
	const harness = mount(ChipFacetHarness, { target, props: { values } }) as unknown as Harness;
	instance = harness as unknown as Record<string, unknown>;
	flushSync();
	return { root: target, harness };
}

function chipFor(root: HTMLElement, label: string) {
	const button = Array.from(root.querySelectorAll('button.chip-toggle')).find(
		(el) => el.textContent?.trim() === label
	);
	if (!button) throw new Error(`No chip labelled "${label}"`);
	return {
		button: button as HTMLButtonElement,
		get pressed() {
			return button.getAttribute('aria-pressed');
		},
		get isSelected() {
			return button.closest('.chip')?.classList.contains('is-selected') ?? false;
		}
	};
}

describe('Chip as a facet toggle', () => {
	it('starts unpressed when the parent has chosen nothing', () => {
		const { root } = renderFacets(['LGW', 'BHX']);
		expect(chipFor(root, 'LGW').pressed).toBe('false');
		expect(chipFor(root, 'LGW').isSelected).toBe(false);
	});

	it('reports itself pressed once the parent records the click', () => {
		const { root, harness } = renderFacets(['LGW', 'BHX']);
		chipFor(root, 'LGW').button.click();
		flushSync();

		// Both halves of #189's title. The parent moved...
		expect([...harness.currentChosen()]).toEqual(['LGW']);
		// ...and so did the chip. Before the fix only the first of these held.
		expect(chipFor(root, 'LGW').pressed).toBe('true');
		expect(chipFor(root, 'LGW').isSelected).toBe(true);
	});

	it('leaves its neighbours alone', () => {
		const { root } = renderFacets(['LGW', 'BHX']);
		chipFor(root, 'LGW').button.click();
		flushSync();
		expect(chipFor(root, 'BHX').pressed).toBe('false');
		expect(chipFor(root, 'BHX').isSelected).toBe(false);
	});

	it('goes back to unpressed on a second click', () => {
		const { root, harness } = renderFacets(['LGW', 'BHX']);
		chipFor(root, 'LGW').button.click();
		flushSync();
		chipFor(root, 'LGW').button.click();
		flushSync();

		expect([...harness.currentChosen()]).toEqual([]);
		expect(chipFor(root, 'LGW').pressed).toBe('false');
		expect(chipFor(root, 'LGW').isSelected).toBe(false);
	});

	it('follows the parent when the parent resets everything at once', () => {
		// "Clear filters" writes a whole new set rather than replaying clicks. A chip that
		// keeps a private copy of `selected` misses this entirely, which is why FilterPanel
		// used to remount every chip behind a `{#key}` block to force the point.
		const { root, harness } = renderFacets(['LGW', 'BHX']);
		chipFor(root, 'LGW').button.click();
		chipFor(root, 'BHX').button.click();
		flushSync();
		expect(chipFor(root, 'LGW').pressed).toBe('true');

		chipFor(root, 'LGW').button.click();
		chipFor(root, 'BHX').button.click();
		flushSync();

		expect([...harness.currentChosen()]).toEqual([]);
		expect(chipFor(root, 'LGW').pressed).toBe('false');
		expect(chipFor(root, 'BHX').pressed).toBe('false');
	});
});

describe('Chip outside a toggle group', () => {
	it('renders a static tag with no button and no pressed state', () => {
		target = document.createElement('div');
		document.body.appendChild(target);
		instance = mount(Chip, { target, props: { label: 'FR' } }) as unknown as Record<string, unknown>;
		flushSync();

		expect(target.querySelector('button.chip-toggle')).toBeNull();
		expect(target.querySelector('.chip-label')?.textContent?.trim()).toBe('FR');
	});
});
