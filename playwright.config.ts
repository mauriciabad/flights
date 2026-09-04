import { defineConfig, devices } from '@playwright/test';

// Overridable because a dozen agents share one machine and `reuseExistingServer` below
// is on for local runs: with a fixed port, `pnpm test:e2e` in one worktree silently
// attaches to another worktree's already-running server and tests THEIR build. That
// happened — six tests failed against a sibling's build and the network guard reported an
// endpoint this branch had already deleted. `E2E_PORT=41999 pnpm test:e2e` gets your own.
// CI sets nothing and keeps 4173.
const PORT = Number(process.env.E2E_PORT ?? 4173);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
	testDir: './tests/e2e',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 2 : undefined,
	reporter: process.env.CI
		? [['dot'], ['github'], ['html', { open: 'never' }]]
		: [['list'], ['html', { open: 'never' }]],
	use: {
		baseURL,
		trace: 'on-first-retry',
		screenshot: 'only-on-failure',
		video: 'retain-on-failure',
		// Headless Chromium's own User-Agent says "HeadlessChrome", and providers read it.
		// Kiwi's public endpoint (providers/flights/kiwi-public.ts) answers that UA with a
		// 403 carrying no CORS headers while giving an ordinary Chrome UA a 200 with
		// `Access-Control-Allow-Origin: *` — measured, see docs/PROVIDERS.md. The mocked
		// suite does not care, but the `@live` suite would otherwise measure a bot wall and
		// report it as a broken provider. Real visitors always send an ordinary UA.
		userAgent:
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] }
		}
	],
	// Tests run against the built static site, served the way GitHub Pages actually
	// serves it (see tests/e2e/support/static-server.mjs) — not `vite preview`, which
	// for SvelteKit boots a Node SSR server this app never ships. The PWA plugin only
	// emits a manifest and service worker for a production build, so the offline and
	// manifest tests need this to be a real build, not `vite dev`.
	webServer: {
		command: `pnpm build && node tests/e2e/support/static-server.mjs build ${PORT}`,
		url: baseURL,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000
	}
});
