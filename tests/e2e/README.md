# End-to-end tests

Issue #18. Playwright, run against a real production build served the way GitHub Pages
serves it — see `playwright.config.ts` and `support/static-server.mjs` for why that is
not `vite preview`.

## The one rule

**Never import from `@playwright/test` in a spec under `tests/e2e/` (outside
`tests/e2e/live/`).** Import `test` and `expect` from `./support/fixtures` instead:

```ts
import { test, expect } from './support/fixtures';
```

That import brings a fixture that blocks every request leaving the app's own origin
unless a test mocked it first, and fails the test with the exact blocked URL if one
slips through. `guard.spec.ts` enforces the import itself, so a spec that reaches for
`@playwright/test` directly fails the suite rather than silently skipping the guard.

Why this exists: Skyscanner's RapidAPI free tier is 20 requests **a month**, for the
whole account. One test run without this guard could spend the whole month by accident.

## Mocking a provider

Ready-made mocks live in `support/providers.ts`: `mockRyanair`, `mockSkyscanner`,
`mockRome2Rio`, `mockBookingCom`, `mockTransitous`, `mockOsrm`, plus
`mockAllKeylessProviders` and `mockAllProviders`. Call one before `page.goto()`:

```ts
import { test, expect } from './support/fixtures';
import { mockRyanair, mockSkyscanner } from './support/providers';

test('shows results from both providers', async ({ page }) => {
	await mockRyanair(page.context());
	await mockSkyscanner(page.context());
	await page.goto('/');
	// ...
});
```

Each mock answers with a fixture from `tests/e2e/fixtures/<provider>/`. Pass a second
argument to use a different fixture (empty results, an error shape, and so on), or call
`page.context().route(...)` yourself for a one-off case — a route registered after
`mockRyanair()` gets first refusal, so it can override just the parts it cares about.

**Adding a new provider that isn't in `support/providers.ts` yet:** add its host and a
mock function there, add a realistic fixture under `tests/e2e/fixtures/`, and add a line
to `tests/e2e/fixtures/README.md` saying what the fixture models. The network guard blocks
by default, so a new provider is unreachable in tests until you do this — that's the point.

**Then add it to `fixture-mappers.spec.ts`,** which runs every fixture in that directory
through the code that reads its shape and fails when one has no entry. A fixture the app
cannot read looks exactly like one that works: `transitous/plan.json` had no `duration` on
its leg, the mapper was right to refuse it, and both suites measured the
malformed-response branch for months without a single test disagreeing (issues #194,
#242). Two more fixtures had the same defect and are fixed in that spec's PR.

## Fixture values are worthless on purpose

Realistic **shape**, worthless **values**. Prices, flight numbers and place names come
from `support/fixture-markers.ts`: five-figure fares, `ZZ00xx` flight numbers that no
airline could issue, `FIXTURE`-prefixed airports, cities, carriers and hotels. `BVC` and
`PFO` are banned outright, because a mock of the route `docs/ACCEPTANCE.md` decides this
project on is the one mock nobody can sanity-check by eye.

This is not neatness. A fixture built to look exactly like the goal got reported as the
app reaching the goal, and it took an hour and a second browser to disprove.
`guard.spec.ts` fails the suite if a fixture carries no marker, and
`tools/probe-results.mjs` refuses to report an itinerary count from a page where one turns
up. Read the top of `fixtures/README.md` before writing a new payload.

Never register a mock on the shared Playwright MCP browser, whatever you are debugging.
AGENTS.md, "Mocks belong to a test and to nothing else", says what that cost.

## Adding a test for a screen that just landed

Several spec files already exist for screens that don't yet — `search.spec.ts`,
`itinerary-editing.spec.ts`, and the second half of `pwa.spec.ts` — each with
`test.skip(...)` placeholders that name the exact scenario from issue #18 and the
issue(s) it's blocked on. When one of those issues closes:

1. Open the matching spec file and find the placeholder.
2. Replace the comment-only body with a real test: mock the providers it needs, drive
   the actual UI with real selectors (prefer `getByRole`/`getByLabel` over CSS), and
   assert on the result.
3. Change `test.skip(...)` to `test(...)`.
4. If the screen needs a provider with no mock yet, follow "Adding a new provider"
   above first.

If a screen exists but doesn't fit any current file, add a new one and import
`test`/`expect` from `./support/fixtures` the same way.

## The `@live` suite

`tests/e2e/live/` is the one place allowed to call a real provider. It never runs as
part of `pnpm test:e2e` or in CI — only `pnpm test:e2e:live`, which also sets
`ALLOW_LIVE_TESTS=1` so a stray "run all tests" from an editor can't trigger it by
accident (see `support/live-fixtures.ts`). Specs there import from
`../support/live-fixtures`, not `./support/fixtures` — real network access is the
point, so the guard would only get in the way.

Every test there is currently a skipped placeholder, because no provider adapter exists
yet to drive from the app (issues #5-#10). Once one lands, fill in its placeholder with
one real, minimal call — and if it's Skyscanner, keep it to one call, run by a person,
on purpose, not in a loop and not as part of routine verification.

## Running things

- `pnpm test:e2e` — the default suite (mocked, no `@live` tests). This is what CI runs.
- `pnpm test:e2e:live` — the `@live` suite. Real network. Run by hand only.
- `pnpm exec playwright show-report` (or `pnpm test:e2e:report`) — open the last HTML
  report.
- `pnpm exec playwright test --ui` — Playwright's UI mode, for iterating on a spec.
