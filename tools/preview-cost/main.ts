// Entry point for the preview-cost harness. See Harness.svelte and probe-preview-cost.mjs.
import { mount } from 'svelte';
import Harness from './Harness.svelte';

declare global {
	interface Window {
		__previewCost: {
			cards: number;
			/** ms from navigation start to the frame after the previews were mounted. */
			paintedMs?: number;
			/** ms to the frame after every preview stopped changing, which is when the
			 *  fetched regional tiles have landed and been drawn. */
			settledMs?: number;
			landPaths?: number;
			borderPaths?: number;
			solidBoxes?: number;
		};
	}
}

const cards = Number(new URLSearchParams(location.search).get('cards') ?? 5);
window.__previewCost = { cards };

const started = performance.now();
mount(Harness, { target: document.getElementById('app') as HTMLElement, props: { cards } });

/** The whole-box path `land.ts` returns when it will not vouch for the geography. */
const SOLID = /^M0 0L\d+ 0L\d+ \d+L0 \d+Z$/;

function census() {
	const land = [...document.querySelectorAll<SVGPathElement>('svg path.rp-land')];
	const masked = document.querySelectorAll('svg rect.rp-land').length;
	return {
		landPaths: land.length + masked,
		borderPaths: document.querySelectorAll('svg path.rp-border').length,
		solidBoxes: land.filter((path) => SOLID.test(path.getAttribute('d') ?? '')).length
	};
}

requestAnimationFrame(() => {
	requestAnimationFrame(() => {
		window.__previewCost.paintedMs = Math.round(performance.now() - started);
		Object.assign(window.__previewCost, census());
	});
});

// Settled means "nothing changed for two frames in a row", which is what an asynchronously
// arriving tile looks like from outside: the picture redraws once and then stops.
let last = '';
let stable = 0;
const poll = setInterval(() => {
	const now = JSON.stringify(census());
	if (now === last) {
		stable += 1;
		if (stable >= 3) {
			window.__previewCost.settledMs = Math.round(performance.now() - started);
			Object.assign(window.__previewCost, census());
			clearInterval(poll);
		}
	} else {
		stable = 0;
		last = now;
	}
}, 50);
