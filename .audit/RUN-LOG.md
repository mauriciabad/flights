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
