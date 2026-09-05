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
