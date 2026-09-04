import { test as base, expect } from '@playwright/test';

/**
 * The test/expect for tests/e2e/live/**, the only place allowed to reach a real
 * provider. Running these takes two deliberate steps, not one — the `@live` tag AND
 * this environment variable — so a stray "run all tests" from an editor's test
 * explorer (which ignores `--grep`) still cannot spend real quota by accident.
 * `pnpm test:e2e:live` sets the variable; nothing else should.
 */
export const test = base.extend<{ liveTestsOptIn: void }>({
	liveTestsOptIn: [
		async ({}, use) => {
			test.skip(
				process.env.ALLOW_LIVE_TESTS !== '1',
				'Live tests hit real provider APIs and are opt-in on purpose. Run `pnpm test:e2e:live`.'
			);
			await use();
		},
		{ auto: true }
	]
});

export { expect };
