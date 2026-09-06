import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import { defineConfig } from 'vite';

// When the custom domain is live this is empty. Building for
// mauriciabad.github.io/flights needs BASE_PATH=/flights instead.
// SvelteKit types base as '' or a string starting with a slash, so the env
// value is narrowed here rather than cast at the point of use.
const raw = process.env.BASE_PATH ?? '';
const base: '' | `/${string}` = raw === '' ? '' : raw.startsWith('/') ? (raw as `/${string}`) : `/${raw}`;

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// These sit at the top level of the plugin options, not under a `kit`
			// key. Nesting them makes vite-plugin-svelte warn and ignore them,
			// which silently drops the base path and breaks every asset URL.
			adapter: adapter({ fallback: '404.html', strict: false }),
			paths: { base, relative: false },
			// There is no server. Every route is a shell that hydrates and
			// then fetches from the provider APIs in the browser.
			prerender: { handleHttpError: 'warn' },
			appDir: 'app'
		}),
		SvelteKitPWA({
			// 'autoUpdate', not 'prompt'. This was 'prompt' because a silently-reloading
			// tab loses whatever the user was doing with it. That reasoning has since
			// stopped applying: every screen keeps its state in the URL, /results
			// rebuilds a whole search from its query string, and the comparator the old
			// comment cited was deleted in #178. A reload now costs a re-run of a search
			// that the IndexedDB cache already holds the answers to.
			//
			// What 'prompt' cost instead: a new deploy installed and then sat in
			// `waiting` until somebody clicked a toast, so a visitor who did not click
			// kept the old shell indefinitely. Measured with tools/probe-sw-update.mjs
			// before this change — 20 seconds after a deploy to the same origin, in the
			// same browser, the page was still rendering the previous build.
			registerType: 'autoUpdate',
			// @vite-pwa/sveltekit's build plugin only emits sw.js and
			// manifest.webmanifest; it never injects a <link rel="manifest"> or a
			// registration script into a prerendered app.html (confirmed against its
			// source: SvelteKitPlugin's closeBundle step moves files, it never touches
			// HTML). `injectRegister: false` says so explicitly, rather than leaving a
			// registerSW.js in the build that nothing ever links to. Registration
			// itself happens in src/routes/+layout.svelte (the manifest link) and
			// src/lib/pwa/register-sw.ts, which calls navigator.serviceWorker.register()
			// directly — see that file's comment for why it doesn't go through
			// vite-plugin-pwa's own virtual:pwa-register/svelte helper.
			injectRegister: false,
			manifest: {
				name: 'Layover — flights with a free trip in between',
				short_name: 'Layover',
				description:
					'Find cheap multi-leg flights where the stopover city is long enough to be a trip of its own.',
				theme_color: '#0b1020',
				background_color: '#0b1020',
				display: 'standalone',
				start_url: base ? `${base}/` : '/',
				scope: base ? `${base}/` : '/',
				icons: [
					{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
					{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
					{
						src: 'icons/icon-512-maskable.png',
						sizes: '512x512',
						type: 'image/png',
						purpose: 'maskable'
					}
				]
			},
			workbox: {
				// static/land/*.txt is deliberately outside this. Those are the 1,001
				// regional coastline tiles from scripts/prepare-land-tiles.mjs, 762 kB
				// gzipped in total, of which a traveller needs the two or three their
				// own trip touches. Adding txt here, or shipping them as generated
				// modules so the js glob swept them up, would download all of it on
				// install for every visitor — the same bytes-up-front cost the region
				// split exists to avoid, moved out of the bundle and into the service
				// worker. The runtimeCaching rule below keeps the ones used instead.
				globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
				// Provider responses are cached by the app's own layered cache, not
				// by the service worker, so it must not shadow them.
				navigateFallback: null,
				// The one runtime rule, and it is same-origin by construction: workbox
				// matches a RegExp against a cross-origin request from the start of the
				// whole URL, and no provider's URL begins "/land/". `pwa.spec.ts` proves
				// that separately against a real provider host, because "there is no
				// runtimeCaching at all" used to be the argument and no longer is.
				//
				// CacheFirst because a tile is immutable at its URL: `?v=` is a content
				// hash over every tile, so changed data is a changed URL rather than a
				// stale hit. This is what makes a preview that showed water keep showing
				// it in aeroplane mode, which is where a traveller often is.
				runtimeCaching: [
					{
						urlPattern: /\/land\/-?\d+_-?\d+\.txt/,
						handler: 'CacheFirst',
						options: {
							cacheName: 'land-tiles',
							expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 180 },
							cacheableResponse: { statuses: [0, 200] }
						}
					}
				],
				cleanupOutdatedCaches: true,
				// These two are what actually make 'autoUpdate' happen, and they have to
				// be written out by hand here. vite-plugin-pwa only translates
				// registerType into these workbox flags when it is also generating the
				// registration script for you (`injectRegister === 'auto' || == null`,
				// node_modules/vite-plugin-pwa/dist/index.js). We pass
				// `injectRegister: false` and register by hand, so registerType alone is
				// inert: flipping it to 'autoUpdate' and stopping there emits byte-for-byte
				// the same sw.js as 'prompt' did, and the stale-shell bug survives a diff
				// that looks like it fixed it.
				//
				// skipWaiting: a new worker activates on install instead of queueing
				// behind the tab that is still open. clientsClaim: it then takes over the
				// pages already on screen, which is what fires `controllerchange` and lets
				// src/lib/pwa/register-sw.ts reload them onto the new build.
				skipWaiting: true,
				clientsClaim: true
			}
		})
	]
});
