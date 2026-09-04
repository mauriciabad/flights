import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

// Node's own built-in Web Storage global (unflagged since Node 22) shadows
// jsdom's: without a `--localstorage-file`, Node's version is a bare object
// with none of the Storage methods, so every `localStorage.getItem` call in
// a test fails, not just the ones the keys store is supposed to catch.
// Disabling it lets jsdom install its real, in-memory Storage instead —
// the same one the keys store's try/catch is written to survive without.
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --no-experimental-webstorage`.trim();

// Separate from vite.config.ts on purpose: the PWA plugin there runs a
// service-worker build step that has no reason to run under Vitest, and
// keeping the test config free of it keeps `pnpm test` fast and side-effect
// free. `sveltekit()` alone is enough to get `$lib` and rune compilation for
// `.svelte.ts` modules.
export default defineConfig({
	plugins: [sveltekit()],
	test: {
		environment: 'jsdom',
		// scripts/**: build-time scripts (issue #52's Travelpayouts fetch) get the
		// same "pure logic is tested" treatment as everything under src, even
		// though they never ship to the browser.
		include: ['src/**/*.{test,spec}.ts', 'scripts/**/*.{test,spec}.mjs']
	}
});
