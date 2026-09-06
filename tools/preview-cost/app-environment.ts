// The SvelteKit module `land-tiles.svelte.ts` asks whether it may fetch. In the harness it
// always may: the whole point is to measure the fetch landing.
export const browser = true;
export const building = false;
export const dev = false;
export const version = 'preview-cost-harness';
