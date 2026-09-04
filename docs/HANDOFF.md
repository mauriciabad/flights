# Handoff to the next orchestrator

Written 2026-09-05 at the end of a long session. Read `AGENTS.md` first, then this.

## Where the app actually is

**It works.** Every condition in `docs/ACCEPTANCE.md` passes on production, in a browser with
no keys at all. The owner's reference trip:

```
Boa Vista BVC → London LGW → Paphos PFO      1 night      €265.00
                → Manchester MAN              1 night      €301.48
                → Rome FCO                    1 night      €318.55   (fastest, 2d 8h)
                → Birmingham BHX              1 night      €344.95
```

Against the €282 he planned by hand. Flights are keyless (Kiwi's public GraphQL), beds are
keyless (Hostelworld's mobile backend), transfers are keyless (OSRM, Transitous).

Run `.audit/check-predicate.sh` to see it for yourself. It is the definition of done and it
is a script, not a paragraph. `--full` adds the build gates and the service-worker check.
Today it reports one failing check, the open-issue count.

**Do not trust a merge as evidence.** Re-run the issue's own repro against production after
the deploy. That gap is where this project has lost the most time.

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

## What is left, in the order I would do it

**User-facing, he would notice:**
#231 a short overnight wait charged a hotel · #219 the walkable bed is last of 33 with no
distance · #189 a filter chip changes results but not itself · #185 the missing bed announced
six times · #206 bed price per night per person · #203 "No bed priced" with no reason · #217
`2d 24h` printed · #192 `60,99 €` read as 6099

**His four design asks:** #225 pricing split · #227 strip tooltips · #228 day-counted free
time · #229 am/pm

**Correctness, invisible until it bites:**
#194 a reload paints nothing while three Kiwi lookups run · #213 OSRM routes reset and every
pair is requested twice · #191 four clients invent error messages · #187 we ask every airport
for its route graph then keep six

**Coverage:** #198 only eleven airports have a city centre · #232 a typical-price band from
the #200 ledger

**Last:** #20 validate against the brief.

## Traps that cost real time here

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

- **Fewer agents.** He raised the burn rate twice. Batch related issues into one agent rather
  than one agent per issue.
- **Spawn fresh, never resume.** Resuming replays the agent's whole transcript every turn; one
  had reached 449k tokens. Debrief once if it holds knowledge you need, write the facts into
  the new brief, and spawn new. There is a memory file about this.
- **Stop each agent once its PR merges.** A finished agent lingers as resumable and clutters
  the listing.
- **Kill your own servers.** Static servers for screenshots accumulate; four were left
  listening. Serve and kill in the same command.
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
