import { defineConfig, devices } from '@playwright/test';

/**
 * `pnpm qa` — the suite that asks whether the app behaves properly when a person uses it,
 * rather than whether its parts work. See tests/qa/README.md for what that distinction buys
 * and why it sits alongside `pnpm test` and `pnpm test:e2e` rather than replacing either.
 *
 * Its own port (4174, not e2e's 4173) so `pnpm test:e2e` and `pnpm qa` can run at once
 * without one killing the other's server.
 */

const PORT = 4174;
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
	testDir: './tests/qa',
	testMatch: '**/*.qa.ts',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,

	// No retries, deliberately, where the e2e config takes two in CI. A QA check that only
	// fails sometimes is describing something the app only does sometimes, and hiding that
	// behind a retry is how a real intermittent defect becomes invisible. If one of these
	// flakes, the check is wrong and needs fixing, not re-running.
	retries: 0,

	// One worker: several checks count the requests one search makes, and a second search
	// racing it on another worker shares nothing but does share the machine, which is enough
	// to move a timing assertion. Six checks against one build is fast enough anyway.
	workers: 1,

	// Live keyless providers are an order of magnitude slower than a recording, so a run
	// that talks to them needs room a recorded run should never be given.
	timeout: process.env.QA_LIVE === '1' ? 300_000 : 90_000,
	reporter: process.env.CI
		? [['list'], ['github'], ['html', { open: 'never' }], ['./tests/qa/support/reporter.ts']]
		: [['list'], ['./tests/qa/support/reporter.ts']],

	use: {
		baseURL,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},

	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

	// The real production build, served the way GitHub Pages serves it — same reasoning as
	// playwright.config.ts, and the same static server. A QA suite run against `vite dev`
	// would be checking a bundle nobody ships.
	webServer: {
		command: `pnpm build && node tests/e2e/support/static-server.mjs build ${PORT}`,
		url: baseURL,
		reuseExistingServer: !process.env.CI,
		timeout: 180_000
	}
});
