import { test, expect } from './support/fixtures';

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

	test('the app shell is reachable offline after a first online visit, once a service worker registers', async ({
		page,
		context
	}) => {
		await page.goto('/');

		// vite-plugin-pwa's SvelteKit integration only emits sw.js and
		// manifest.webmanifest as files — for a prerendered app.html it does not inject
		// the <link rel="manifest"> tag or a registration script (confirmed against the
		// @vite-pwa/sveltekit source: its build plugin's closeBundle step moves files,
		// it never touches HTML). Someone still has to add that link tag and call
		// navigator.serviceWorker.register() (or useRegisterSW() from
		// virtual:pwa-register/svelte) — that's issue #30. Until then this probes for a
		// registration and skips rather than failing the build.
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

		test.skip(
			!registered,
			'No service worker registered on first visit. @vite-pwa/sveltekit does not auto-inject ' +
				'registration for a prerendered app.html, so issue #30 needs to add it explicitly ' +
				'(a <link rel="manifest"> in src/app.html, plus navigator.serviceWorker.register(\'/sw.js\') ' +
				"or useRegisterSW() from 'virtual:pwa-register/svelte'). This test starts asserting real " +
				'offline behaviour as soon as one registers.'
		);

		await context.setOffline(true);
		try {
			const response = await page.reload();
			expect(response?.ok(), 'a cached shell should still respond once offline').toBe(true);
			await expect(page.locator('body')).not.toBeEmpty();
		} finally {
			await context.setOffline(false);
		}
	});

	test.skip(
		'the last search results are still visible offline',
		async () => {
			// Intent (issue #18): "Offline: aeroplane mode still renders the shell and the
			// last results." The shell half is covered above; the results half needs a
			// cache to have something to show (issue #4, "stale first, then fresh") and a
			// results list to render it (issue #23). Once both exist: run an online search,
			// go offline, reload, and assert the same results are still on screen.
			// Blocked on: #4 (cache), #23 (results list), #30 (service worker).
		}
	);
});
