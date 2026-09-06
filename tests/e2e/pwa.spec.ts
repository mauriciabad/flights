import { test, expect } from './support/fixtures';
import { mockRyanair } from './support/providers';

/**
 * PWA behaviour, tracked end-to-end (installability is issue #30, but a broken
 * manifest or a service worker that never registers would break issue #18's "offline:
 * aeroplane mode still renders the shell" scenario too, so the harness owns proving
 * the parts that are already true and flagging the parts that are not).
 */
test.describe('PWA', () => {
	test('serves a valid web app manifest', async ({ request, baseURL }) => {
		const response = await request.get(new URL('manifest.webmanifest', baseURL).toString());
		expect(response.ok(), 'the manifest file should be served').toBe(true);

		const manifest = (await response.json()) as Record<string, unknown>;

		expect(typeof manifest.name).toBe('string');
		expect(typeof manifest.short_name).toBe('string');
		expect(typeof manifest.start_url).toBe('string');
		expect(manifest.display).toBe('standalone');
		expect(Array.isArray(manifest.icons)).toBe(true);
		expect((manifest.icons as unknown[]).length).toBeGreaterThan(0);
		for (const icon of manifest.icons as Record<string, unknown>[]) {
			expect(typeof icon.src).toBe('string');
			expect(typeof icon.sizes).toBe('string');
			expect(typeof icon.type).toBe('string');
		}
	});

	test('the app shell is reachable offline after a first online visit', async ({
		page,
		context
	}) => {
		await page.goto('/');

		// @vite-pwa/sveltekit's build plugin only emits sw.js and manifest.webmanifest
		// as files — for a prerendered app.html it never injects a <link rel="manifest">
		// or a registration script (confirmed against its source: the closeBundle step
		// moves files, it never touches HTML). Issue #30 added both by hand:
		// src/routes/+layout.svelte links the manifest and calls
		// src/lib/pwa/register-sw.ts on mount, which registers the worker.
		const registered = await page.evaluate(async () => {
			if (!('serviceWorker' in navigator)) return false;
			try {
				await Promise.race([
					navigator.serviceWorker.ready,
					new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
				]);
				return true;
			} catch {
				return false;
			}
		});

		// This used to be a `test.skip` with a reason attached, from back when nothing
		// registered a worker at all. One does now, and offline support is the whole
		// reason this app carries a service worker, so a registration that stops
		// happening should fail loudly rather than quietly skip the assertions below.
		expect(
			registered,
			'no service worker registered on the first visit — see src/lib/pwa/register-sw.ts'
		).toBe(true);

		await context.setOffline(true);
		try {
			const response = await page.reload();
			expect(response?.ok(), 'a cached shell should still respond once offline').toBe(true);
			await expect(page.locator('body')).not.toBeEmpty();
		} finally {
			await context.setOffline(false);
		}
	});

	test('a returning visitor is controlled by the service worker rather than queued behind it', async ({
		page
	}) => {
		// The half of the stale-shell fix that a single build can prove. Under the old
		// `registerType: 'prompt'` config a freshly installed worker sat in `waiting` and
		// never claimed the page that installed it, so `controller` stayed null for the
		// whole first visit. `clientsClaim` is what changes that, and it is also what
		// fires the `controllerchange` that src/lib/pwa/register-sw.ts reloads on when a
		// *later* deploy arrives. Two builds are needed to see that end to end, which is
		// what tools/probe-sw-update.mjs does.
		await page.goto('/');

		await expect
			.poll(
				async () =>
					page.evaluate(async () => {
						if (!('serviceWorker' in navigator)) return 'no-sw-support';
						await navigator.serviceWorker.ready;
						return navigator.serviceWorker.controller ? 'controlled' : 'uncontrolled';
					}),
				{
					timeout: 10_000,
					message:
						'the worker installed but never took over the page. Check workbox.clientsClaim in vite.config.ts.'
				}
			)
			.toBe('controlled');
	});

	test('the shipped service worker activates immediately instead of waiting for a click', async ({
		request,
		baseURL
	}) => {
		// Asserted against the built sw.js rather than against vite.config.ts, because
		// the gap between those two is exactly where this bug hides. vite-plugin-pwa
		// only translates `registerType: 'autoUpdate'` into workbox's
		// skipWaiting/clientsClaim when it is *also* generating the registration script
		// for you; this project passes `injectRegister: false` and registers by hand, so
		// registerType on its own emits byte-for-byte the sw.js that 'prompt' emitted.
		// Anyone tidying that config down to "just registerType" would put every
		// returning visitor back on the old build, and nothing else here would notice.
		const response = await request.get(new URL('sw.js', baseURL).toString());
		expect(response.ok(), 'sw.js should be served').toBe(true);
		const sw = await response.text();

		expect(sw, 'sw.js must call self.skipWaiting() (workbox.skipWaiting)').toMatch(
			/self\.skipWaiting\(\)/
		);
		expect(sw, 'sw.js must claim open clients (workbox.clientsClaim)').toMatch(/clientsClaim\(/);
		// workbox-build only bakes this listener in when skipWaiting is off, which is to
		// say when activation is gated behind a message from a button somebody has to press.
		expect(sw, 'sw.js must not gate activation behind a SKIP_WAITING message').not.toContain(
			'SKIP_WAITING'
		);
	});

	test.skip(
		'the last search results are still visible offline',
		async () => {
			// Intent (issue #18): "Offline: aeroplane mode still renders the shell and the
			// last results." The shell half is covered above. The cache that would hold a
			// result to show (issue #4, "stale first, then fresh") and the service worker
			// that keeps the shell alive to read it from (issue #30) both exist now — this
			// is blocked only on issue #23, the results list that would render one. Once
			// that lands: run an online search, go offline, reload, and assert the same
			// results are still on screen.
			// Blocked on: #23 (results list).
		}
	);

	test('a provider API call is never served from the service worker cache', async ({
		page,
		context
	}) => {
		// AGENTS.md and issue #30 both say it plainly: src/lib/cache/ already implements
		// stale-then-fresh with per-entry TTLs and an expired-fallback tier that reports
		// *why* a refresh failed, and a second cache underneath it in the service worker
		// would make results inexplicable. vite.config.ts's workbox block only precaches
		// this app's own build output (globPatterns matches local js/css/html/assets), so
		// a cross-origin provider call should never have a service-worker fetch handler to
		// answer it from Cache Storage. This proves that against a real provider host, not
		// just by reading config.
		//
		// "and sets no runtimeCaching" used to be part of that argument and no longer is.
		// #408 added exactly one rule, for the app's own /land/*.txt coastline tiles.
		// Workbox matches a RegExp against a cross-origin request from the start of the
		// whole URL, and no provider's URL begins "/land/", so the rule cannot reach one —
		// which is a claim this test is now the thing that checks.
		await mockRyanair(context);

		let hits = 0;
		// Registered after mockRyanair's own route for the same host: Playwright asks
		// the newest matching route first, so every request lands here before falling
		// through (route.fallback()) to mockRyanair's fixture response — this only
		// counts requests, it never changes what they get back.
		await context.route('https://services-api.ryanair.com/**', async (route) => {
			hits += 1;
			await route.fallback();
		});

		await page.goto('/');
		await page
			.evaluate(() =>
				Promise.race([
					navigator.serviceWorker.ready,
					new Promise((resolve) => setTimeout(resolve, 5000))
				])
			)
			.catch(() => {});

		const providerUrl = 'https://services-api.ryanair.com/farfnd/v4/oneWayFares?test=pwa-bypass';

		// Same URL, fetched twice. If the service worker had a fetch handler covering
		// this cross-origin request the way it covers the app's own precached files,
		// the second call could be answered from Cache Storage without the network
		// layer — and this test's route handler — ever seeing it again.
		await page.evaluate((url) => fetch(url).then((r) => r.json()), providerUrl);
		await page.evaluate((url) => fetch(url).then((r) => r.json()), providerUrl);

		expect(hits, 'both requests should reach the network layer, unshadowed by the service worker').toBe(
			2
		);

		// Belt and braces: confirm Cache Storage (what a service worker fetch handler
		// would draw from) never stored this response under any cache name at all.
		const cachedAnywhere = await page.evaluate(async (url) => {
			if (!('caches' in window)) return false;
			for (const name of await caches.keys()) {
				const cache = await caches.open(name);
				if (await cache.match(url)) return true;
			}
			return false;
		}, providerUrl);
		expect(
			cachedAnywhere,
			"a provider response must never land in the service worker's Cache Storage"
		).toBe(false);
	});
});
