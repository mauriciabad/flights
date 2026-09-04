import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import { defineConfig } from 'vite';

// When the custom domain is live this is empty. Building for
// mauriciabad.github.io/flights needs BASE_PATH=/flights instead.
const base = process.env.BASE_PATH ?? '';

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
			registerType: 'autoUpdate',
			injectRegister: 'auto',
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
				globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
				// Provider responses are cached by the app's own layered cache, not
				// by the service worker, so it must not shadow them.
				navigateFallback: null,
				cleanupOutdatedCaches: true
			}
		})
	]
});
