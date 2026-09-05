# Working on this repo as an agent

Read this before touching anything. Then read [docs/prompts/](docs/prompts/), which is the
source of truth for what this app is meant to do.

## Attribution, not optional

Everything you write on GitHub starts with this line:

```markdown
> 🤖 Written by an AI agent (Claude), not by a human.
```

Issues, comments, PR descriptions, reviews. The owner asked for this so he can tell his own
words from a machine's at a glance. Commits carry `Co-Authored-By: Claude Opus 5` instead.

When you quote him, mark it as a quote and keep his words exactly, typos included.

## The three rules that shape the code

1. **No backend. None.** No server, no proxy, no serverless function, no build-time secret.
   Every API call goes from the browser straight to the provider using a key the user pasted
   into the UI. If a provider does not send CORS headers, it cannot be used, so check before
   you build against it.
2. **Keys belong to the user.** They live in `localStorage`, they are exportable as JSON, and
   they never reach a log, a URL, an error report or a network request to anywhere but the
   provider that owns them.
3. **Stale first, then fresh.** Show the cached answer immediately, refetch anyway, update in
   place. The owner asked for this by name.

## Scope

Work only on your issue. If you find something else broken, open an issue rather than fixing
it in your PR. A focused diff gets merged; a sprawling one blocks four other agents.

If your issue depends on something that does not exist yet, do not invent a competing version
of it. Check whether another issue owns it, and if it does, either wait or define the
narrowest possible interface and say so in your PR.

## Design, for anything with a UI

Before writing CSS or a component's visual layer, load these skills and follow them:

- `design-taste-frontend` — the primary one. It exists to stop interfaces looking templated.
- `ui-ux-pro-max` — style systems, palettes, font pairings, interaction states.
- `web-design-guidelines` — check your work against it before opening the PR.

The owner rejected the first pass as "boring and ugly", and he was right: it was the stock
scaffold. Default system fonts, flat grey cards and a generic blue accent are the failure
mode to avoid.

What the product is actually about should drive the look. This app finds flights to places
with no direct route by turning the connection into a trip of its own, so the pitch is
getting a second city for free. It deals in time, cities and money, and its central screen
is a timeline of a journey. Boarding passes, departure boards, transit maps and ticket
stubs are all fair ground. It should look like something a frequent traveller wants to open.

None of that overrides the constraints: dark-first around `#0b1020` with
`prefers-color-scheme` working both ways, mobile first, real focus rings, and contrast that
survives the greyed-out treatment used for deprioritised airlines.

## Svelte

Svelte 5, runes, TypeScript throughout.

Use the `svelte-file-editor` agent for `.svelte` and `.svelte.ts` files, and run the Svelte
MCP `svelte-autofixer` on every component before you open a PR. It catches the runes mistakes
that are easy to make and hard to spot.

Prefer `$state` and `$derived` over stores. Reach for a store only when state genuinely has
to outlive a component tree, and say why in a comment.

## `main` moves while you work

Check `origin/main` again immediately before you open your PR, not only when you start.

A dozen agents are working at once and things merge underneath you. Two agents have already
concluded the provider interface did not exist, each built its own narrow substitute, and
were both correct at the moment they looked and both wrong by the time they finished. The
result was two modules with contracts that disagreed at the seam.

So before you finalise:

```bash
git fetch origin main && git log --oneline HEAD..origin/main
```

If something landed that your issue depends on, rebase and use the real thing. Deleting your
placeholder is cheaper now than reconciling two designs later.

## The Svelte trap that cost us a working search

An `$effect` that calls an async function **without awaiting it** runs that function's
synchronous prefix on the effect's own call stack. Svelte tracks effect dependencies by call
stack, not lexical scope, so any `$state` that prefix reads and writes counts as the effect
reading and writing its own dependency. The effect retriggers itself forever and Svelte aborts
with `effect_update_depth_exceeded`.

That is what broke every search in production (#87). The page froze before a single result
rendered, and the offending line was `searchesInFlight += 1` at the top of an unawaited call.

It survived 849 passing unit tests and a fully green deploy, because nothing exercised the page
in a real browser.

Wrap such a call in `untrack()`, or restructure so the async work is started outside the
reactive graph. And when you touch anything reactive, verify it in a real browser against a
real build. `pnpm check` and a jsdom test cannot see this class of bug at all.

## Clear the build cache before believing a hydration bug

A stale `.svelte-kit` or `build` directory can produce symptoms identical to a real
SSR/hydration defect: content silently falling to the wrong branch, present in the server HTML
and gone after hydration.

That happened here. A component's header was reported as a Svelte bug and worked around in
shipped code. A later investigation could not reproduce it four different ways against real
production builds, confirmed the Svelte and Kit versions had not changed, then reproduced the
exact symptom on purpose by rebuilding without clearing `.svelte-kit` first. A clean rebuild
made it vanish.

So before concluding the framework is wrong: `rm -rf .svelte-kit build && pnpm build`. If it
survives that, it is real.

## Show the error you got, never the one you assumed

When a provider fails, surface **its own message and status code, verbatim**. Our own
classification is an addition on top, never a replacement.

This has already cost real time, twice, and the second time we did it to ourselves.

Agoda returned `200` with `{"status":false,"message":"The location cannot be empty"}`, which
points straight at a malformed request on our side. Separately, the owner saw the settings
screen report that his account had not subscribed, when he had. Someone concluded the second
was caused by the first, and that story was repeated for hours, written into this file, and
told to the owner as fact.

Reading the code settles it: `not-subscribed` requires a real `403` carrying RapidAPI's own
wording (`classify-error.ts`), so a `200` with a `status:false` body could never produce that
message. The two observations were never connected. The real defect in that path was the
opposite direction, `performCheck` branching on `response.ok` before reading the body, so a
malformed-request response read as a plain success.

So the rule applies to us, not only to the UI:

- A headline and a suggested action are useful, but only when they are true and only alongside
  the raw response.
- Never assert a cause you did not observe. "Agoda returned 200 with: The location cannot be
  empty" is worth more than a confident wrong diagnosis, and two symptoms appearing on the same
  afternoon are not evidence that one caused the other.
- Include the status code. `403` versus `200`-with-an-error-body is exactly the distinction that
  went missing, and it is what eventually resolved this.

The owner's words: "we should show the actual errors recieved, not invent our own".

## Testing the live app without lying to yourself

Two failures already made agents report bugs that were not there, and both are cheap to avoid.

**Use your own browser, not the shared one.** Every agent on this project shares one Playwright
MCP browser. When five agents run at once it carries a dozen tabs, and it will switch tabs
underneath you between two tool calls, so the page you measure is not the page you loaded. An
issue got reopened on evidence gathered that way. Launch your own instead, from the repo so the
import resolves:

```js
import { chromium } from '@playwright/test';
const page = await (await (await chromium.launch()).newContext()).newPage();
```

Attach `page.on('response')` and `page.on('console')` before `goto`. The request log is usually
the answer: a route that returns nothing because Ryanair `404`s the airport looks identical on
screen to one that returns nothing because of a bug.

**Clearing site data does not reset this app.** The response cache is in IndexedDB, so
`localStorage.clear()` and deleting Cache Storage both leave it fully intact:

```js
indexedDB.deleteDatabase('flights-cache');
```

A fresh browser context gets all three at once, which is one more reason to prefer it.

**Re-run the issue's own repro before you close it.** Not the test suite, not the PR checks. The
URL or the steps written in the issue body, against production, after the deploy finished. "The
PR merged" is not the same claim as "the acceptance test in the issue passes", and the gap
between those two is where this project has lost the most time.

## Mocks belong to a test and to nothing else

On 2026-09-04 an agent reported the owner's own route working, in his own words back to
him: "the owner's exact URL ... now returns 1 itinerary, BVC->LGW->PFO, EUR 238.00, via
Ryanair, with ZERO keys configured." Ryanair does not serve BVC. The page was answering
out of a Playwright route handler, and the agent was reading its own side of a mock.

What the transcripts show, in order:

- 10:41 an agent working issue #118 saved `tests/e2e/itinerary-map-transfers.spec.ts`.
  Its mocks answered `services-api.ryanair.com` and `www.ryanair.com` with two fares
  priced 149 and 89, on the owner's route, at his dates, adding up to his EUR 238.
- 10:51 to 10:53 that same agent pasted the same handlers into the **shared Playwright MCP
  browser** through `browser_run_code_unsafe`, to look at the rendered map:
  `await page.context().route('https://services-api.ryanair.com/**', ...)`.
- Nothing closed that browser. The last `browser_close` anywhere in the run was 08:03.
- 11:00 a different agent, on a different issue, navigated the same browser to a results
  URL and saw €238.00. At 11:18 it reported that as a live result.
- 11:25 `node tools/probe-results.mjs`, which launches its own Chromium, printed
  `0 of 0 itineraries` for the identical URL, with `www.ryanair.com` returning `404` for
  BVC. The tell in the payload was `"countryName":"Test"`.

**The spec did not leak.** Playwright disposes a test's context when the test ends, and no
spec in `tests/e2e/` builds a browser of its own; `guard.spec.ts` now fails the suite if
one tries. What crossed the boundary was a copy-paste into a browser that outlives
everything: the MCP server runs `@playwright/mcp` with no `--isolated`, so a single
persistent context serves every tool call from every agent on this project.

So:

- **Never register a route on the MCP browser.** A context route stays armed until someone
  closes the browser, across tabs, across origins, across agents who have no idea you
  exist. A page route outlives the tool call that made it too.
- If you need mocked data in front of your eyes, launch your own Chromium the way
  `tools/probe-*.mjs` do, and close it. A dead process leaks nothing.
- If you catch yourself pasting a spec's fixture into a browser, run the spec instead.
  `pnpm exec playwright test tests/e2e/<file> --headed` shows you the same page with the
  same mocks, and throws them away afterwards.

Two things now make this loud instead of silent. Every mock payload carries a marker from
`tests/e2e/fixtures/markers.json`, so an escaped fixture reads as €9,111.11 on flight
ZZ0000 out of FIXTURE Alpha rather than €238 on a Ryanair flight. And
`tools/probe-results.mjs` refuses to print an itinerary count when it finds a marker in
the page or in a provider response; it prints "MEASUREMENT INVALID" and exits non-zero.

A fixture is a stand-in for an answer, so it has to be shaped like one. It must never be
worth anything as one.

**The same shape of mistake caught the branch that wrote this section, an hour later.**
`playwright.config.ts` sets `reuseExistingServer: !process.env.CI`, and with a dozen
worktrees on one machine port 4173 is often already held by somebody else's build. A
`pnpm test:e2e` run silently attached to one and failed 22 tests against a branch nobody
here had ever seen: the network guard blocked `pics.avs.io` airline logos, a feature that
exists in neither that branch nor `origin/main`. So when the suite has to have measured
*your* build, run `CI=1 E2E_PORT=<pick one> pnpm test:e2e`. It starts its own server and fails loudly if the
port is taken, instead of quietly testing someone else's work.

Those servers do not go away on their own. On the morning of 2026-09-05 there were fourteen
still listening, every one of them from an agent that had finished the day before, and each
one is a port `reuseExistingServer` can silently attach to. `node tools/stale-servers.mjs`
lists the ones this project left behind with their ages, and `--kill` ends anything older
than 90 minutes. Run it before a suite you need to trust, and kill your own when you are
done rather than leaving them for whoever comes next.

**And do not run two suites at once on this machine.** Three agents hit this on one night.
One saw `pnpm test:e2e` report 32 failures while `pnpm qa` and two vite builds ran alongside
it; a clean serial run was 55 passed. Another saw `pwa.spec.ts`'s offline test fail at load
average 34.9 and pass alone. All three re-ran rather than filing phantom defects, but the next
agent might not.

So before you read a surprising failure, read `uptime`. With several agents working this repo
the load average sits near 17 even when nothing is testing, and a timing-sensitive spec is the
first thing to break. A failure you cannot reproduce on a quiet machine is not a failure.

Better than disbelieving a failure is not causing one. **Read `uptime` before you start
`pnpm test:e2e` or `pnpm qa`, and if the one-minute load average is above 40, wait and read it
again.** Five agents each driving their own headless Chromium took this machine to 89.6 on the
morning of 5 September 2026, and at that load the suites fail specs that have nothing wrong
with them. Unit tests and `pnpm check` are cheap enough to run whenever.

When you do report a failure you decided was the machine, name the load average you saw. That
is the difference between a judgement a reviewer can check and a suite you re-ran until it went
green.

## Scratch files are shared, so name yours after yourself

A dozen agents run at once and the scratchpad directory is one directory. An agent drafting
a PR body in `pr-body.md` had it overwritten mid-session by another agent doing the same
thing, and only noticed because it checked the posted PR against what it wrote.

**And never `git stash` here at all.** `refs/stash` lives in the repo's common git dir, not in
your worktree, so every agent in this repo pushes onto and pops from **one shared stack**. On
2026-09-05 two agents stashed within the same minute before rebasing and each popped the
other's work: one asked for two spec files and received the other's in-progress search-form
redesign, including a deleted component and three new ones. Nothing was lost only because one
of them read what it had popped instead of carrying on.

Unlike the scratchpad, no naming convention saves you: the stack is anonymous and `stash pop`
takes whatever is on top.

Use this instead, which is per-worktree and cannot collide:

```bash
git diff > /private/tmp/.../<your-branch>.patch
git checkout -- .
```

Put your agent id or branch name in any temporary file you write: `pr-body-<branch>.md`, not
`pr-body.md`. The same goes for a port, a database name, or anything else two of you could
pick independently and both believe you own.

## If you merge other agents' PRs

Green CI is not a review. It means the tests that exist passed, and the bug worth catching is
usually the one nobody wrote a test for.

Before merging, read the diff and ask what happens to a user who already has state. #131 shipped
real map geometry and was merged on green CI with a defect sitting in plain sight: the OSRM route
cache keys on `{service, profile, origin, destination}` with a 30-day TTL, so every entry written
before the change carries no geometry and gets served straight back. Anyone who had used the app
that month, the owner included, would have installed the fix and still seen straight lines. A
cached value whose shape changed needs a key that no longer resolves to the old one.

Do not merge a PR that has an unresolved review comment on it, and post blocking feedback as a
PR review rather than only as a message to the author, so whoever merges can see it.

## The owner's quota is real money he told us he would not spend

He pays nothing, by his own instruction. Every metered request comes out of a free tier that
resets on the 1st, and once it is gone it is gone for the rest of the month.

Eighty-five percent of his Booking.com allowance went in a single morning, spent by agents
testing, while the settings card still read "0 of 40 requests spent". Both numbers were
right. The cap lives in `localStorage`, the quota belongs to the RapidAPI account, so a
counter is per browser profile and the allowance is per key. Every fresh Chromium starts
again at zero believing it has the full allowance, and the instruction in the section above
to launch your own browser is what multiplied that by the number of agents running.

So:

- **Do not call a metered provider to look at something.** Booking, Agoda, Skyscanner,
  Flights Sky and Kiwi all cost. Ryanair, OSRM and Transitous are free, use those to explore.
- **Capture once, then work offline.** A response you already received is a fixture. Request
  construction, parsing and classification are all testable without the network, and that is
  where the bugs have actually been. `{"status":false,"message":"The location cannot be
  empty"}` was a malformed request of ours, provable from one captured response.
- **Ask before a live confirmation, with a number.** One request at the end to prove the fix
  is reasonable. Ten to explore is not. Say how many and why.
- **Never press Test repeatedly to debug.** Saving a key spends a request today, and the
  button has no cooldown. Debugging the key screen is the most expensive thing in the app.

If your work genuinely cannot proceed without spending, say so and stop. Being blocked and
saying it is better than quietly emptying his month.

## Check which branch you are on before you commit

Agents share one clone plus a worktree each, and worktrees have been switched and reaped
underneath running agents. Both have already happened today: a commit meant for `main` landed
on another agent's PR branch, and one agent found its worktree deleted mid-session with its
shell fallen back to the shared checkout, which held someone else's staged changes.

So, every time, before `git add`:

```sh
git branch --show-current
```

Confirm it is the branch you think it is. If it is not, do not "fix it quickly" by committing
anyway. Save your work as a patch (`git format-patch`, or `git diff > /tmp/...`), reset the
branch back to its remote so you leave no trace on someone else's work, and re-apply on a
worktree you created yourself.

Never commit into a tree you did not create, and never resolve a surprise by force-pushing a
branch that is not yours.

## Definition of done

- `pnpm check` passes. No new type errors, no `any` smuggled in to silence one.
- `pnpm build` passes.
- `pnpm qa` passes. It drives the built app in a browser and asserts how the whole thing
  behaves over a whole interaction: what one search costs per provider, that pricing a bed
  never deletes the trip, that a reload paints from cache before the network answers, that
  the quota on screen is the provider's number, and that no offer names an airline its
  provider does not fly. Read `tests/qa/README.md` before adding to it. It never calls a
  metered provider, in any mode.
  - Some checks are pinned to open defects in `tests/qa/known-broken.ts` and fail on
    purpose. If your change makes one PASS, the run goes red on purpose too: delete its
    entry, say so in the PR, and close the issue. That is the only way a fix gets banked.
  - If you change which endpoint an adapter calls, answer the new one in
    `tests/qa/support/responses.ts` in the same PR. A bench that answers an endpoint
    nobody calls any more produces zero itineraries, and every behavioural check then
    fails at its "is there anything on screen" line — which reads exactly like several
    unrelated invariants breaking at once. That happened here: #166 landed 48 seconds
    before this suite's first CI run, and the three failures it produced were reported
    onward as a cache bug, a currency bug and a fabricated itinerary. None of them had
    happened. `bench-answers.qa.ts` now says so first.
- Tests for anything with logic in it. Pure functions especially, since the algorithm modules
  are where a wrong answer hides quietly.
- No secrets, no keys, no personal data in the diff.
- The PR says what you chose and what you rejected. A reviewer should not have to guess why
  the timeline rows are proportional to time rather than to segment order.

## Comments in code

Explain why, never what. `// increment i` earns nothing. `// local wall-clock, not an instant,
because a 00:30 arrival is the next day at the airport but not in UTC` earns its line.

## Timezones, since this app is mostly timezones

Every flight time is a local wall-clock time at a specific airport. Store the offset with it.
Do not normalise everything to UTC and format it back, because that is how an overnight
connection silently loses a night, and a lost night is a wrong price and a wrong hotel booking.

The owner extended this to everything the app prints, not only flights: "all times should be
in the local timezone of the place they reffer to. everywhere." So a hotel check-in reads in
the stopover's timezone, a bus departure in the city it leaves from, an airport wait in that
airport's. One journey therefore shows several timezones at once, and that is correct: the
traveller is standing in one of them at a time.

Never call `toLocaleTimeString` without an explicit timezone. It silently uses the browser's,
which renders a Cyprus departure in Madrid time on the owner's own machine.

## How the app writes times and money

- **am/pm, not 24-hour**, with a setting for 24-hour (#229).
- **No padded digits, anywhere in the UI.** `9:05am`, never `09:05am`. His words: "i dont
  like pad digits, anywhere in ui".
- **Currency symbol first**, English convention, since the app is in English. He noted Spanish
  puts it last and chose English deliberately. A rate reads `€52.82/night`.
- **"each way", not "/way"**, for a fare paid in both directions: `€10 each way`. He flagged
  `/way` as probably wrong and it is: it is not English.

## Money

Integer minor units and a currency code. Never a float, never a formatted string as the
canonical value. Convert at the edges, compare in minor units.

## When the data is missing

This app talks to a dozen providers, several of which will be out of quota, unsubscribed or
simply down. Partial results are the normal case. Say what you do not know rather than
guessing, and never present an estimate as a fact.

## A rebase can delete a file nobody conflicted over

Check `git diff --diff-filter=D --name-only origin/main...HEAD` before you push a branch that
adds a feature. It should be empty.

On 5 September 2026 the connections-map branch, cut before #329 merged, came out of a rebase
deleting `tests/e2e/flight-picker-dates.spec.ts` and `tools/probe-flight-picker-dates.mjs`.
Neither file has anything to do with maps. Git reported one conflict, in an unrelated
stylesheet, and none on those two. CI was green. Nothing in the diff would have made a
reviewer ask, because a deletion of a file you never mention does not read as a change you
made.

Main moved eight times that afternoon. Any branch older than the last merge can carry this,
and the cost is a green test and its instrument quietly ceasing to exist.

**The sequence that produced it, because nothing warns you about it.** The agent finished with
`git reset --soft origin/main` and then `git add -A` to sweep up "everything else". The soft
reset moves your base forward without touching the working tree, so stale copies of files you
never opened are now a difference against the new base, and `git add -A` records that difference
as your authorship. What comes out is a well-formed commit that happens to say "delete this
feature", and every later rebase applies it cleanly because there is nothing wrong with it as a
commit.

`node tools/audit-branch-deletions.mjs` runs this check for you and exits non-zero. Run it
before you push. It reports files the branch deletes and files it guts, and `--allow path,path`
records a deletion you meant. Against the commit that caused all this it finds both deleted files
plus `FlightPicker.svelte +8 -128`, `FlightPicker.test.ts +0 -107` and
`recompute-selection.test.ts +1 -56`, with one entry for a deliberate extraction that belongs in
`--allow`.

So `git reset --soft` onto a base that has moved is only safe if you know what your working tree
holds. If you want a single tidy commit, prefer `git add` on the paths you actually changed. And
whichever way you get there, read `git diff --stat origin/main...HEAD` before pushing and look for
a file where you delete far more than you add. That agent verified its feature exhaustively in a
browser and never looked at what its own commit contained.

## Kiwi blocks the headless user agent, and it looks like everything else

`api.skypicker.com` rejects a request from a browser whose User-Agent says headless. Playwright's
default does. The failure is `net::ERR_FAILED` / "Failed to fetch" with **no status code**, which
reads exactly like CORS, a rate limit, or a provider outage.

Pass a real Chrome User-Agent to `newPage` when driving anything that reaches Kiwi:

```js
const page = await browser.newPage({
	userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
		'(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
});
```

On 5 September 2026 this cost about an hour and produced two confident wrong diagnoses: that Kiwi
blocks localhost origins, and that a nineteen-request burst was hitting a rate limit. Neither was
true. The tell that broke it was the **first** request of the run failing at 132ms — a burst limit
cannot kill request number one — and that Node and `curl` from the same machine both got HTTP 200
at the same moment.

So when a provider looks down from a browser, try it from Node before believing the browser.
