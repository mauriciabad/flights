import { base } from '$app/paths';

/**
 * Registers the service worker and gets an already-open tab onto the newest build.
 *
 * This replaced src/lib/pwa/UpdateToast.svelte, which implemented the `prompt` flow from
 * issue #30: a deploy installed quietly and then waited for a click before anything
 * changed. Nobody clicked. The owner spent a day filing bugs against a build we had
 * already replaced, including flight paths drawn straight on the map, which #72 had
 * fixed. tools/probe-sw-update.mjs reproduces that: deploy a second build to the same
 * origin, revisit in the same browser, and twenty seconds later the page is still
 * rendering the first one.
 *
 * The reload is safe here because this app keeps its state in the URL. /results
 * reconstructs an entire search from its query string, and the answers it needs are
 * already in the IndexedDB response cache, so a reload costs a re-render rather than a
 * lost session or a spent provider request.
 *
 * `navigator.serviceWorker.register()` is called directly rather than through
 * `virtual:pwa-register/svelte` (vite-plugin-pwa's usual helper, which wraps
 * workbox-window). That virtual module's generated code contains a dynamic
 * `import("workbox-window")`, and every route here is prerendered, so this module is
 * part of the SvelteKit SSR build that generates the static HTML — a build Vite 8's
 * Rolldown bundler cannot resolve that import for
 * (`[vite]: Rolldown failed to resolve import "workbox-window"`), failing `pnpm build`
 * outright. `navigator.serviceWorker` is a plain browser global with nothing to import.
 */

/**
 * A navigation makes the browser re-check sw.js, and so does register(). A tab left open
 * on /results does neither for hours. Chromium does appear to look again on its own at
 * some point (a run of tools/probe-sw-update.mjs found the update on a tab that never
 * navigated), but nothing says when, and "the current build, eventually, if the browser
 * feels like it" is the guarantee we just got rid of. So the app asks.
 *
 * Five minutes, used both as the polling period and as the floor between two checks, so
 * rapid tab-switching cannot turn into a request per switch. Each check is one
 * revalidating GET of a 7.6 KB gzipped file on GitHub Pages, answered 304 when nothing
 * shipped. It costs no provider quota; the app's own metered calls are a separate layer
 * that this never touches.
 */
const UPDATE_CHECK_INTERVAL_MS = 5 * 60_000;

export function registerServiceWorker(): void {
	if (!('serviceWorker' in navigator)) return;

	// Read before registering. On a browser's very first visit there is no controller,
	// and clientsClaim fires `controllerchange` the moment the new worker activates.
	// That is an install, not an update, and reloading through it would make every first
	// visit flash for nothing.
	const wasAlreadyControlled = navigator.serviceWorker.controller !== null;

	let reloading = false;
	navigator.serviceWorker.addEventListener('controllerchange', () => {
		if (!wasAlreadyControlled || reloading) return;
		// Latched: `controllerchange` can fire more than once, and a reload loop on a
		// travel app is worse than a stale one.
		reloading = true;
		window.location.reload();
	});

	navigator.serviceWorker
		.register(`${base}/sw.js`, { scope: `${base}/` })
		.then((registration) => {
			// Starts at 0, not at Date.now(): register() has just run its own check, but a
			// tab coming back to the foreground is the single moment most likely to be
			// looking at a build that shipped while it was hidden, and one extra 304 is
			// cheaper than being wrong about that.
			let lastCheck = 0;

			const checkForUpdate = () => {
				if (Date.now() - lastCheck < UPDATE_CHECK_INTERVAL_MS) return;
				lastCheck = Date.now();
				// Rejects while offline, which is not worth reporting to anyone.
				registration.update().catch(() => {});
			};

			document.addEventListener('visibilitychange', () => {
				if (document.visibilityState === 'visible') checkForUpdate();
			});
			// Covers the tab that is never hidden and never navigated — a laptop left on
			// the results page — which the visibility listener alone would never reach.
			setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
		})
		.catch(() => {
			// The app still works online without a worker; it just loses offline support
			// and the install prompt for this session. Nothing to tell the user.
		});
}
