# Handoff to the next orchestrator

Written 2026-09-06, 05:45, at the end of an overnight run. Read `AGENTS.md` first, then this.

## Where the app actually is

**`.audit/check-predicate.sh` passes.** All five checks, for the first time:

```
PASS  P1 open issues 0
PASS  P2 open PRs 0
PASS  P3a itineraries 3
PASS  P3b a bed is in the total
PASS  P3c no console errors
```

Main is `90e921f`, green and deployed. Every issue in the tracker is closed. Flights are
keyless (Kiwi's public GraphQL), beds keyless (Hostelworld), transfers keyless (OSRM,
Transitous).

That is a state, not a finish line. #20 is a standing audit and was closed as "this pass is
complete"; reopen it for the next one. Six passes are recorded in its comments, back to
4 September, and each found real work.

**Do not trust a merge as evidence.** Re-run the issue's own repro against production after
the deploy. That gap is where this project has lost the most time, and every fix below was
re-checked on the live site before being called done.

## What the owner decided this session, in his words

These are law. They reverse earlier decisions in the brief and in the code, and they are
already recorded in `AGENTS.md` and on the issues.

- **2h airport wait everywhere.** "the default waiting airport time is too much 3h. i want 2h
  always by default." Shipped.
- **Minimum nights by default.** "the nights should be kept to a minimum by default" and "i
  can decide to add more nights if the city is interesting and the hotel in the center."
  Shipped in #230.
- **Mandatory versus optional pricing** (#225). The mandatory part is flights, the nights the
  itinerary forces on you, and every transfer including to your departure airport and from
  your arrival airport. Optional is nights you add, per night per person. **Not built, and
  there is a measured problem with it: London's second night costs −€3, because it moves you
  to a different onward flight. Nights are not independently priced. He has not yet decided
  what the card should say instead.**
- **Free time in days, not durations** (#228). Format he chose:
  ```
  Fri 9 from 9:10pm
  2 full days: Sat, Sun
  Mon 12 until 9:05am
  ```
  Land before 5am and that day still counts. No explanatory text like "still counts". "No full
  days" when there are none. Edge lines name when you leave for the airport, not the flight.
- **Formatting**: am/pm not 24h with a setting (#229), no padded digits anywhere, currency
  symbol first (`€52.82/night`), "each way" not "/way".
- **All times in the local timezone of the place they refer to. Everywhere.** One journey
  shows several timezones at once and that is correct.

## What is left

**Nothing is open.** What follows was found during the night, judged too large to fix in the
PR that found it, and written into that PR's body rather than filed, because the owner asked
for a finished tracker. Each is real. Read the named PR for the measurement.

- **Draft-only refinements still do not re-sort.** #403 fixed the committed half; a bed swap,
  transport pick or waiting-time change still leaves the order stale. Covering it needs a
  score for a drafted itinerary. PR #403.
- **The destination leg still does arithmetic instead of reading its timetable.** #397 fixed
  the stopover's two edges and #402 the origin leg. This is the last of the four ground legs,
  and fixing it moves `times.total` again. PR #402.
- **The strip and the timeline disagree by seven minutes** on a transit leg's length. PR #402.
- **`SegmentCustomiser` never passes `widenOptions` to `FlightPicker`**, so the paid-expansion
  rows have been unreachable from the rail since #278. Confirmed at both call sites. PR #396.
- **No taxi rate card covers 92.5% of the app's airports.** That, not the arithmetic, is why
  the ground fare range is wide. PR #398.
- **Six of the eleven cities in `METRO_CODE_MEMBERS` have no routed member** in
  `direct-routes.generated.json` (Moscow, New York, Tokyo, Osaka, Chicago, Washington). The
  vendored graph is European. PR #400.
- **`FALLBACK_ROUTES` is unpinned in the e2e suite**, deliberately: it is compiled in, so
  nothing over the wire can answer for it. PR #401.
- **The worst-case card fixture may no longer produce #249's two-currency ground rows.**
  Recorded, not chased. PR #394.

## Decisions made on the owner's behalf while he slept

He said to decide rather than block, and to state the reasoning so he can reverse it. These
are the ones worth his attention.

- **The departure-date ladder is in calendar order, not sorted by price.** He asked twice for
  "shorted by best price". The agent argued from Google Flights, Ryanair (whose Fare Finder
  sorts by cheapest while its booking-page date strip runs chronologically), Kayak, Baymard
  and NN/g that price order belongs to discovery and this control sits after it, so price
  picks *which* seven days appear and the calendar arranges them. Live, `Fri 18 +€28.98` sits
  after `Thu 17 +€50.80`. Cheap to reverse.
- **The ground fare band got wider, not narrower.** He wanted a tighter range. The fallback
  card had been reading GBP, CHF, SEK and CZK minor units as euro cents; a 5 km ride claimed
  €6.00–€22.00 against a true €6.50–€34.02. There is no honest way to narrow it, because the
  width is the width of the evidence.
- **Door to door is now substantially longer on every card**, because the origin wait was
  never counted. "Waiting at BCN 2h" was 6h 14m. This is the app telling the truth, not a
  regression.
- **#345 closed as a documented no.** No ride-hail provider can price a leg here. Uber's own
  endpoint reference forbids price comparison against third-party services in its terms, so
  the feature is barred even with a backend; the one architecturally viable RapidAPI listing
  resells the estimator already compiled into `taxi-rate-table.ts`.
- **#303's budget is now the list of blocks a card may carry**, each tied to the issue that
  put it there, rather than a screen-derived number the card never met. A new block fails by
  existing. Nothing was cut from the card.
- **#284 was a bug, not a tradeoff.** `a.hwstatic.com` is a Cloudinary account and the earlier
  "dumb origin" finding tested query parameters against a path that ignores them. Photo weight
  across one search went 300.7 MB to 7.7 MB.

## Traps that cost real time here

**Four instruments lied in one night, and every one printed a reassuring sentence.** This is
the pattern to distrust above all others: a check you have never watched fail is not a check.

- Five committed probes clicked a "Show details" button #278 deleted, so they reported an
  empty card rather than a broken probe. One printed `BEDS 0` for a page with a bed on it.
- `cost-per-search.qa.ts`, the check standing between the owner's free tier and an agent's
  afternoon, passed on searches that made no requests at all.
- `tools/stale-servers.mjs` matched command strings against `Projects/flights|vite|sirv|preview`
  and missed `node tests/e2e/support/static-server.mjs`, the one server this repo leaks,
  because agents run it from a worktree with a relative path. Four were holding ports for up
  to 26 hours under "No node listeners from this project". Its header already documented a
  *previous* version of the same failure.
- An agent's own probe reported "no control offered" on its own fixed build three times.
  Playwright's `hasText` with a RegExp does not normalise whitespace, and the button renders
  as `Sort 2\n\t\t\t\ttrips into place`. Match on `innerText` or the accessible name.

**Absence assertions are the same disease.** `toHaveCount(0)`, `not.toContain`, `toEqual([])`
pass when the page is broken as readily as when the claim is true. #382 proposed a lint for
it; the measurement killed the lint (18 flagged, none real, and 0 of the 5 historical cases
caught) but located the real shape: fifteen assertions are `expect(<scan>).toEqual([])`, and
eight of those are this repo's own guards. Rename `tests/e2e/` and every guard goes green
while guarding nothing. `findSpecFiles` and `findFiles` throw on an empty result now.

**A CSS grid flex factor below 1 means "take this fraction of the leftover space", not
"fill".** `sqrtShares` normalises to a total of 1, so once the 24px tap floors bound at phone
width the survivors' factors summed well under 1 and the trip strip left a quarter of its
track blank. Scaling every factor so the smallest is `1fr` preserves the proportions exactly.

**A trailing space at the end of an element's text is collapsed away.** A `visually-hidden`
label ending in a space produced the accessible name "DepartsWed 16". Use `&nbsp;`.

**A vite preview server here may bind IPv6 only.** Reach it on `localhost`, not `127.0.0.1`.

**Agents fan out unless the brief forbids it.** poteto-mode's "Guard the context window" tells
them to delegate, and five top-level agents became fourteen processes before the owner counted
them. Put the prohibition in every brief: nothing reachable with Grep, Glob or Read, no
fanning out over a list of files or specs, one delegate only with a one-sentence justification.

**Mergeable is textual, not semantic.** GitHub will call a PR clean while its CI ran on a base
that has since changed. When a PR shares a file with something newly merged, `gh pr update-branch`
and wait for a fresh green. This caught #394 twice in one night.

**A string match in a page's markup is not evidence the page contains that thing**, because a
search URL echoes its own query back into the document. An agent nearly reported a property as
present on Agoda from two matches that were both its own query string in a JavaScript shell.


- **Never use the shared Playwright MCP browser.** It carries a dozen tabs and switches
  between them mid-measurement. It produced two false bug reports. Launch your own Chromium.
  The repo's own `AGENTS.md` says this; the global config still loads the MCP server anyway.
- **`localStorage.clear()` does not reset this app.** The response cache is IndexedDB:
  `indexedDB.deleteDatabase('flights-cache')`.
- **`api.skypicker.com` 403s a `HeadlessChrome` user agent.** Use `PROBE_USER_AGENT` and
  `newProbeContext` from `tools/probe-browser.mjs`, or you will manufacture a provider outage.
- **Suspect your measurement before the code.** Three times this session the measuring method
  was the bug: a bed check that grepped for wording the UI had changed, a filter probe that
  polluted its own state by toggling, and an `innerText` reading that showed a space the pixels
  did not have. When a result surprises you, re-measure differently first.
- **A curl success proves nothing about CORS.** `prod.apigee.hostelworld.com` returned 200 to
  curl from anywhere and reflected CORS headers only to its own domain. It passed every unit
  test and died in the browser. Fetch from a real page origin.
- **`git checkout main` fails here**, because main is checked out in another worktree. It fails
  quietly if you have redirected stderr. I committed onto a merged branch that way.
- **A cached value whose shape changed needs a new key.** #131 shipped map geometry that every
  existing cache entry silently overrode.

## How he wants this run

- **Fewer agents.** He raised the burn rate three times and once counted the running
  processes himself. Batch related issues into one agent, cap top-level agents at four or
  five, and forbid subagents in the brief.
- **Check in every fifteen minutes.** He asked for this by name, so an agent gets resteered
  before it spends an hour on a bad premise. It paid twice in one night: one agent was told
  to cut scope and committed within the tick, and two were told an issue can be wrong before
  they built what it asked for.
- **An issue can be wrong, and rejecting one is a real outcome.** #371's code was already
  correct and only wanted its decision pinned in a test. #380's own proposal cost 1,235 more
  route questions for three fewer candidates. #382's proposed lint caught none of the five
  cases it was filed for. All three shipped the measurement instead of the feature.
- **Spawn fresh, never resume.** Resuming replays the agent's whole transcript every turn; one
  had reached 449k tokens. Debrief once if it holds knowledge you need, write the facts into
  the new brief, and spawn new. There is a memory file about this.
- **Stop each agent once its PR merges.** A finished agent lingers as resumable and clutters
  the listing.
- **Kill your own servers.** Static servers accumulate; four were holding ports for up to
  26 hours. Serve and kill in the same command, and run `node tools/stale-servers.mjs` at the
  end of a session rather than trusting that you were tidy.
- **Background long commands** so you keep working.
- **Prefix every GitHub artifact** with `> 🤖 Written by an AI agent (Claude), not by a human.`
  He asked for this so he can tell his words from a machine's.

## Tools worth knowing

`.audit/` holds the predicate script and one-off probes written this session (route line,
facets, transit requests, Hostelworld responses, the trip strip). `tools/` holds the committed
ones: `probe-results.mjs` refuses to report a count if it detects fixture data,
`probe-sw-update.mjs` answers "would a returning visitor see this deploy", `probe-cors.mjs`
tests CORS from a real page origin.

`pnpm qa` is a CI gate as of #168. It asserts behaviour, not units, and it caught a request-cost
regression on its own tonight.
