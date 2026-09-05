# Overnight run, 2026-09-05

Orchestrator session started 02:00 CEST. Owner asleep, wants the app finished by morning.

## Exit predicate

`.audit/check-predicate.sh` reports PREDICATE MET. Baseline at 02:05: P1 fails (20 open
issues), P2/P3a/P3b/P3c pass. So the app works and the tracker is the gap.

Owner's own words on the finish line tonight:

> ideally all issues would be closed, but it is fine if that doesnt hapen. it is important
> that if we find bugs or improvements we open issues, but keep a mindset of trying to do
> the most important first and leave for last the least important. you can also make the
> quick issues in the middle so the number decreases fast.

So: order by what he would notice, put the cheap ones in the middle to drop the count, and
never stop filing what is found.

## Decision taken tonight

**#225.** Shown the measurement that London's second night costs −€3, he chose "name the
number, keep the +/− deltas". Full shape in the issue comment. No invented per-night
addition anywhere; every delta comes from a real pairing's real total.

## Iterations

| # | time | what changed | predicate moved? |
| --- | --- | --- | --- |
| 0 | 02:05 | baseline measured | 20 open issues, P2-P3 green |
| 1 | 02:20 | wave 1 spawned, 9 agents, batched by area | not yet |

### Wave 1 assignments

| agent | issues | branch |
| --- | --- | --- |
| price card | #225 #206 | `feat/225-getting-there` |
| time and money format | #229 #228 #217 #192 | `fix/time-and-money-format` |
| strip tooltips | #227 | `feat/227-strip-tooltips` |
| nights and beds | #231 #219 | `fix/231-219-nights-and-beds` |
| filter chips, then city centres | #189, then #198 | `fix/189-filter-chips` |
| request efficiency | #194 #213 #187 | `fix/194-213-187-requests` |
| honest errors and bed copy | #191 #203 #185 | `fix/191-203-185-honest-errors` |
| validate against the brief | #20 | audit, files issues |
| typical price band | #232 | `feat/232-price-band` |

Held back on purpose: #119 (walking at 11h, header clipping, design too plain), because its
diff lands on the same results card the #225 agent is rebuilding. It goes out once that
merges.

### Iteration 5, 04:05 to 04:35. First real fix of the night lands.

**PR #235 merged and verified on production.** #229, #228, #217 and #192, about 1300 lines,
four new test files, one agent. Deploy `dd7eea3` succeeded and I re-ran every one of the four
issues' own repros against `flights.mauri.app` rather than trusting the merge.

```
PASS  itineraries on the page        4 of 4 itineraries
PASS  #229 no padded am/pm clock
PASS  #229 clocks read as am/pm      14 found: 10:32pm, 11:43am, 12:40pm, 8:30pm
PASS  #229 no 24h clock left over
PASS  #217 no "Nd 24h"
PASS  #228 free time counted in days No full days | No full days | No full days
PASS  #228 edge lines with real times Tue 6 from 10:32pm | Wed 7 until 11:43am
PASS  #228 no explanatory text
PASS  #192 no 100x price on screen
FAIL  no console errors              net::ERR_CONNECTION_RESET x3
```

The console failure is **not** a regression. The same OSRM resets were measured at 02:15
against the pre-merge build, nine of them. It is #213, already owned.

**The measurement was wrong before the code was.** My first run of `.audit/verify-235.mjs`
reported #229 and #228 failing. Both were the probe: the seven-line block lives in the
expanded panel and the probe never opened a card, so it was reading a screen that legitimately
has no clock times on it. Expanding the first card turned three FAILs into PASSes and changed
nothing in the app. That is the third time on this project the instrument was the defect, and
the reason AGENTS.md says to suspect it first.

`.audit/verify-235.mjs` is the seed of the `tools/verify-issue.mjs` registry the agent that
died at 02:30 was building. Whoever picks that up should fold it in rather than start over,
and should note that any check touching the expanded panel has to click into it.

### Rulings I made on the owner's behalf while he sleeps

Each is labelled as mine in its PR so he can reverse it in one commit.

- **A provider outage gets no action button.** When Hostelworld 503s, quote its status and
  wording and offer nothing. An action beside an outage reads as "press this and it works",
  and Agoda is a different product at a different price, not a remedy.
- **#185's scope widens.** It was told to leave two rows alone because #161 would fix them by
  construction. An agent measured that #161 does not, for any airport #162 has not covered,
  including LGW on the acceptance route. The instruction rested on a false premise.
- **#228 is the whole seven-line block**, read from existing sources, never re-derived.
- **The seven-line block lives in the expanded panel**, card keeps its one-line count. His
  comment does not say which surface and seven lines times four cards is not a results screen.
- **#225's "Staying longer" ships as wrapping tear-off stubs, not stacked rows.** Same content.
  Stacked rows cost 44px each on a card #197 fought down to 462px, and a list of only-longer
  options has no way back once you extend.

### #206 is settled, with evidence

The price-card agent re-ran the guest-count comparison against `api.m.hostelworld.com`,
London, 9-12 Oct, at 1, 2, 3, 4 and 6 guests. Every property and room rate byte-identical
across all five; only `pagination.totalNumberOfItems` moved, 74/74/71/69/66. And Safestay
Kensington sells a twin private at 79.03 rising to 306.37 for a fifteen-bed, against its own
cheapest dorm bed at 19.10, with Hostelworld's own words: "3 persons booking a 4 bed private
room will need to select and pay for 4 persons".

So both prior readings were half right. Dorm rates are quoted per person; private rooms are
priced per room. `Stay.pricePerPersonPerNight` is populated only where a provider actually
quoted per person, and nothing is ever divided by heads.

### Iterations 6 to 9, 04:00 to 04:40. Four PRs merged, tracker halved.

| PR | issues | verified on production |
| --- | --- | --- |
| #235 | #229 #228 #217 #192 | yes, nine checks |
| #236 | follow-ups to #228 | yes |
| #237 | #191 #203 #185 | partial, see below |
| #238 | #225 #206 | pending |
| #239 | #189 | pending |

**Open issues 20 to 10.** Remaining: #232 #231 #227 #219 #213 #198 #194 #187 #119 #20.

**#238 is the owner's flagship and it shipped with real data behind it.** Six nights on his own
trip is cheaper than five. That number is the whole argument for reading deltas off pairings
rather than off a nightly rate, which is the premise he was shown at 02:10 and chose against.

**#206 settled with measurement, not argument.** Guest counts of 1, 2, 3, 4 and 6 against
`api.m.hostelworld.com` returned byte-identical rates with only `totalNumberOfItems` moving.
Safestay Kensington prices a twin private at 79.03 rising to 306.37 for a fifteen-bed. Dorms
are quoted per person, private rooms per room, nothing is divided by heads. Both halves are in
`docs/PROVIDERS.md`.

**#239's real find was not the filter semantics.** `Chip.selected` was `$bindable` and the chip
flipped its own copy after calling `onclick`, so a local write to an unbound bindable prop
shadowed every later parent value and `aria-pressed` stuck true forever. Fixing it retired a
`{#key filtersGeneration}` remount that had been destroying keyboard focus on every filter
change.

### Instruments that lied tonight, all four of them mine

1. **`tools/stale-servers.mjs` never worked.** `ps -o etimes` is a Linux extension; BSD ps
   rejects it, the call threw for every process, the catch swallowed it and `continue`d, so the
   loop skipped every listener and printed "No node listeners from this project." The run that
   convinced me it worked was one where I had already killed all fourteen by hand. AGENTS.md
   tells agents to trust it before a suite. Found by the #225 agent, whose own preview server it
   could not see. Fixed to parse BSD `etime`, and it now exits non-zero rather than answering
   "nothing there" when it cannot see.
2. **The #235 verification probe read the collapsed results page**, where the seven-line block
   legitimately does not appear, and reported #229 and #228 as failing. Three false failures.
3. **The #237 verification probe counted "Ground, 2 rides not priced" as a bed announcement.**
   `.audit/check-predicate.sh` carries a comment warning about exactly this, which I had read
   four hours earlier.
4. **I relayed an agent's untested inference onto #213 as a conclusion**, corrected it, then
   found the real answer: `curl` gets `status=000` on every OSRM endpoint while ICMP is clean at
   0% loss, so this machine's IP is blocked at the connection level. Three comments on one issue
   to get one fact right.

The pattern is worth naming, because it is the same one the repo already documents about
itself: every one of these was an instrument reporting confidently on something it could not
actually see.

### #237's verification, honestly

**Verified on production:** the fabricated claim is gone. With Hostelworld forced to `503`,
the page no longer says "the stay providers had nothing near London for these dates". The
provider strip reads `Hostelworld (no key required) FAILED 6 reqs`. The happy path still
returns 4 of 4 itineraries with a bed priced. That was the severe half and it holds.

**Not verified by me:** that the provider's verbatim status reaches the rendered page. Seven
attempts, none of which got `[data-testid="stay-notice"]` to appear. Three reasons, all of
them correct behaviour rather than bugs:

1. The notice is in `{#snippet stepOptions(segment)}`, rendered only for the timeline row the
   reader has opened. Two clicks, not one.
2. `stayIsRelevant` is `nightsInConnection > 0 || stay !== undefined`, so a zero-night flight
   change shows nothing, correctly.
3. With every stay provider failing, the builder returns different pairings than it does when
   beds are priced, so the card with a night is not reliably where I expected it.

The agent that wrote it did read the rendered sentence in its own browser, and
`no-stays-reason.test.ts` pins the wording. So the evidence is a browser session plus unit
tests, and not a repeatable check. Filed as **#240**, low severity, small: a `pnpm qa` case
that forces the 503 and asserts on `[data-testid="stay-provider-failure"]`.

I am recording this as unverified rather than claiming either result. Six of my own
measurements were wrong tonight and the seventh is not evidence of a defect, only of my
failing to establish the state.

**A product observation for the owner, not a bug.** The provider's own words are two clicks
deep: expand the card, then open the free-time row. The strip shows FAILED at the top level so
nothing is concealed, but someone wondering "why is there no bed?" has to go looking. #191's
rule is satisfied either way; whether that is the right depth is his call.

### 05:50. A regression I merged, and how it was found

**Read #255 first in the morning.** The acceptance route returns 2 itineraries instead of 4.
Manchester and Birmingham are gone; Rome and London remain. It is live.

It came from #248, which I reviewed and merged. The change is good in principle: stop asking
every outbound airport for its route graph and instead rank candidates first, probing only the
top slice. BCN went from 79 questions to 18. The defect is that the ranking uses
`scoreGeography`, bundled data only, so **geography alone decides which candidates ever get
asked** — and a city can look mediocre geographically while being the one that actually flies
onward. That is the question the probe exists to answer, so ranking it out beforehand is
circular.

`connections.ts` also justified the ceiling with a false claim: "18 is also above the 19 route
lookups issue #187 measured for the whole BVC to PFO search". 18 is not above 19. I read that
PR carefully and did not catch it.

**How it was actually found, because the route matters more than the bug.** It was not a test
and not a review. It was a one-line oddity in an unrelated verification: a probe printed
`2 of 2 itineraries` where earlier runs said 4. I nearly wrote it off as live fare
availability, which is a completely plausible explanation for a thin route searched forty times
in one night.

What stopped that was refusing to explain it away without a second reading. Three measurements
settled it:

1. The facet rail lists `Rome FCO (1)` and `London LGW (1)` only. Facets are derived from
   results, so the absent cities were never produced rather than produced and filtered.
2. Two unrelated date windows return the **identical** pair of cities. A market does not do
   that; a cap does.
3. Every provider answered `200` on both runs. Nothing failed.

**And the reason the PR's own testing missed it is the third instance of one pattern tonight.**
#248 measured "itineraries unchanged at 4" against the qa bench, honestly. The bench serves
providers from fixtures with a fixed candidate set, so it structurally cannot show a live
ranking dropping cities. #240 and #242 are the same shape: a suite measuring a path the real
world does not take. That is the finding worth carrying into next week, not the ceiling.

### Standing instruction I gave the fix

Do not raise the ceiling until the acceptance route passes. That trades one arbitrary number
for another and the next thin route breaks silently. Confirm by bisect first, and measure the
fix against live production on two date windows reporting cities, not counts.
