import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
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
		video: 'retain-on-failure'
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
