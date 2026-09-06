// A standalone Vite build of the preview harness, deliberately not the app's own.
//
// The app's config is SvelteKit's, and SvelteKit builds routes rather than an arbitrary
// page. What is wanted here is one HTML file that mounts `RoutePreview` and nothing else,
// so the number the probe reports is the previews and not a results page around them.
//
// `$app/*` is stubbed rather than imported: `land-tiles.svelte.ts` asks SvelteKit for the
// base path and for whether it is in a browser, and those are the only two things any of
// this reaches into the framework for.
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// `PREVIEW_COST_SRC` points the harness at a different checkout's `src/`, which is how a
// before-and-after is measured: the harness stays identical and only the app under it
// changes. Without it, the repo this file lives in.
const repo = process.env.PREVIEW_COST_SRC
	? `${process.env.PREVIEW_COST_SRC.replace(/\/$/, '')}/`
	: fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
	root: fileURLToPath(new URL('.', import.meta.url)),
	plugins: [svelte({ compilerOptions: { runes: true } })],
	resolve: {
		alias: [
			{ find: '$lib', replacement: `${repo}src/lib` },
			{ find: '$app/paths', replacement: fileURLToPath(new URL('./app-paths.ts', import.meta.url)) },
			{
				find: '$app/environment',
				replacement: fileURLToPath(new URL('./app-environment.ts', import.meta.url))
			}
		]
	},
	server: { fs: { allow: [repo] } },
	build: {
		outDir: fileURLToPath(new URL('./dist', import.meta.url)),
		emptyOutDir: true
	}
});
