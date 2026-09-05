# What happened overnight

For the owner, 2026-09-05. Written as it went, so the last section may lag the tracker by a
few minutes. `.audit/RUN-LOG.md` is the full trail; this is the part worth your coffee.

## Read these three things first

1. **#255 is a regression I merged and it is live.** Your acceptance route returns 2
   itineraries instead of 4. Manchester and Birmingham are gone. An agent is fixing it. Details
   below.
2. **Your London card now costs €304.85, not €265.00.** That is deliberate and it is your own
   ruling. Details below.
3. **Everything else is better than it was**, and all four of your design asks shipped.

## Your four design asks, all merged and verified on production

- **#225 the price card.** Headlined "Getting there" with a flights/bed/ground breakdown, then
  "Staying longer" listing every length the fares support with signed deltas. On your trip six
  nights is cheaper than five, which is exactly why the deltas come from real pairings and not
  from a nightly rate. You chose that shape at 02:10 after being shown that London's second
  night costs −€3.
- **#227 the strip tooltips.** Hover, tap or arrow onto any segment. Four panels: flight,
  airport wait, transport, stopover. One panel for the whole stopover run, which is your own
  ruling on the issue.
- **#228 free time in days.** `Tue 6 from 10:32pm / No full days / Wed 7 until 11:43am`, plus
  the stay block underneath, in your exact format.
- **#229 am/pm** with a 24-hour setting, no padded digits anywhere.

## The one number that moved against you

Your London card went from **€265.00 to €304.85**. The bed changed from a €13 dorm **48.3 km**
from Gatwick, reached by a walk, a bus and two Tube lines, to a €52.85 private room **2.8 km**
away.

That is above the €282 sighting shot in `docs/ACCEPTANCE.md`, and I merged it anyway because
it is what you asked for on #219: those far hotels are "TOO FAR away to be an acceptable
result". The €13 dorm is still in the list, one tap away, and now shows its distance, which it
never did before. If you disagree, the ranking lives in `src/lib/stays/stopover-cost.ts` and the
crossover is measured: one night by the runway, four nights in town.

## The regression, and how it was found

**#255.** #248 stopped asking every outbound airport for its route graph and instead ranks
candidates first, probing only the top slice. That is a good change and its numbers are real,
79 questions down to 18. The defect is that the ranking uses geography alone, so **geography
decides which candidates ever get asked** — and a city can look mediocre geographically while
being the one that actually flies onward. That is the question the probe exists to answer.

The comment justifying the ceiling also says "18 is also above the 19 route lookups issue #187
measured". 18 is not above 19. I read that PR closely and did not catch it.

It surfaced from one odd number in an unrelated check, `2 of 2 itineraries` where earlier runs
said 4. I nearly wrote it off as fare availability on a thin route. Three measurements settled
it: the missing cities have no facets at all, so they were never produced rather than filtered;
two unrelated date windows return the identical pair of cities; and every provider answered 200.

## The pattern worth more than any single fix

Five times tonight a test suite measured a path the real world does not take.

- **#240** no automated check that a provider's verbatim error reaches the page.
- **#242** no test anywhere asserts a Transitous transfer, so a fixture whose leg the mapper
  correctly rejects survived indefinitely and `pnpm qa` spent its life measuring the
  malformed-response branch.
- **#255** the bench serves a fixed candidate set, so it cannot show a live ranking dropping
  cities. That is why #248's own testing said "itineraries unchanged at 4", honestly.
- **#257** two more fixtures in shapes no mapper can read.
- And my own verification probes were wrong six times, three of them asserting against a screen
  that could not show the thing.

If you fix one thing structurally this week, make it this.

## Judgement calls I made on your behalf

Each is labelled as mine in its PR so you can reverse it in one commit.

- **A provider outage gets no action button.** When Hostelworld 503s, quote its status and
  wording and offer nothing. A button beside an outage reads as "press this and it works".
- **The seven-line free-time block lives in the expanded panel**, not the card. Seven lines
  times four cards is not a results screen.
- **#225's "Staying longer" ships as wrapping tear-off stubs**, not your stacked rows. Same
  content; stacked rows cost 44px each on a card already past a phone viewport, and a
  longer-only list has no way back.
- **#219's ranking charges the ride twice per stay**, so the far bed wins from four nights on.
- **#231 charges a bed only when the free-time window covers six hours of a 9pm-9am night.**
  Rounded down deliberately: an unwanted room costs money, a deleted room leaves a stopover
  with nowhere to sleep and no way back.

## Two things that need you, not an agent

- **#249.** No ground transfer is ever priced, so every total ends "excludes unpriced ground
  transport". The two questions are in the issue.
- **#244.** "Confirm an exact price" costs 55 requests against a 15-request Skyscanner cap, so
  that provider is unreachable by any path. An agent is on it, but which way to resolve it is a
  product call.

## Production verification, 06:15

Four merged PRs checked against `flights.mauri.app` after deploy, on your route.

```
FAIL  #255 four itineraries          2 of 2 itineraries     <- the known regression
PASS  #245 no rating printed out of 5
FAIL  #245 rating on a real scale                            <- see below, not a defect
PASS  #245 no bare zero rating
PASS  #247 no negative layover minutes
PASS  #219 bed states a distance     2.8 km from the airport | 22.7 km from centre
PASS  #225 the total is named
FAIL  #232 price band                                        <- see below, not a defect
```

**The #245 "failure" is two fixes agreeing, and it is worth seeing.** My probe expected a
rating in the shape `x.y/10` and found none. That is correct. #254 changed the London pick to
The Gatwick White House Hotel, and #258 measured that exact property returning
`overallRating.overall: 0` with `ratingBreakdown.ratingsCount: 0` — nobody has rated it. So the
app shows no rating line, which is what #245 asked for: never a bare `0.0`. Two agents working
different issues an hour apart landed on the same property and their fixes agree on it.

**The #232 "failure" is the floor working.** The band needs 14 priced departure dates and this
browser has not seen that many for BVC-PFO, so it says nothing rather than drawing a band from
three observations. `buildPriceBand` returns a `too-little-history` value rather than a null, so
that silence is enforced by the type.

**The one real failure is #255**, still live, agent on it.

## Final state, 06:45

**Eight issues open**, from twenty at midnight. Six of the eight were filed tonight; two of the
original twenty remain (#119 and #213, both with agents on them).

**Seventeen PRs merged.** The last four were #256 the price band, #258 three wrong numbers,
#259 the regression fix, #260 the Skyscanner budget.

**#255 is fixed and verified on production**, both date windows:

```
6-12 Oct    4 of 4 | London LGW · Manchester MAN · Rome FCO · Birmingham BHX
13-19 Oct   4 of 4 | Rome FCO · London LGW · Manchester MAN · Birmingham BHX
```

Kiwi at 29 requests, one fewer than before the regression was introduced. The app finds twice
as much for slightly less, because the recovered candidates are answered from the bundled
Ryanair snapshot rather than over the network.

**#244 was not what its issue said either.** 55 requests was the price of a request the app
never sends: the estimate priced the whole date range while the spend narrowed the outbound leg
first, so the real cost was 8 and the quote was 11, computed from two different queries that
nothing compared. Narrowing all four date fields from one shared definition makes a confirm 2
per stopover, 12 for six, inside both caps. The onward leg had never been narrowed at all, under
a comment saying it had.

**A machine-load note, since it produced three false alarms tonight.** With several agents
working this repo the load average sits near 17 idle and reached 34.9 under test. Three agents
saw timing-sensitive specs fail and pass again on a quiet re-run. AGENTS.md now says to read
`uptime` before reading a surprising failure.

## Still open, and who has it

| # | what | who |
| --- | --- | --- |
| #243 #250 | detail-view edits do not propagate | agent, PR close |
| #119 | long road transfers, plausibility half | agent, PR close |
| #213 #242 #257 | OSRM burst, transit coverage, dead fixtures | agent, six commits, PR pending |
| #249 | no ground transfer is ever priced | **you** |
| #20 | validate against the brief | stays open by design |

## One failure of mine worth recording

I lost my own files to `git checkout -B orchestrator origin/main` four separate times tonight:
the relaunch plan twice, the #227 design package, the agent-progress tool, and this report. Each
time the branch pointer moved and took the working tree with it. Everything was recovered from
the reflog, but one recovery cost the #227 agent ten minutes hunting for a design package I had
pointed it at by a path that only existed on an unmerged branch.

The lesson is not "be careful with -B". It is that an orchestrator's own artefacts belong on
`main` as soon as they exist, not on a working branch it keeps rebasing. That is what this PR
does.


## Closing state, 07:20

**Predicate:** P2 and all three P3 legs pass. P1 fails at 6 open issues, which
`.audit/EXIT-PREDICATE.md` calls bookkeeping in its own words: "P3 is the one that decides
it, and P3 can fail with a clean tracker."

```
FAIL  P1 open issues 6
PASS  P2 open PRs 0
PASS  P3a itineraries 4
PASS  P3b a bed is in the total
PASS  P3c no console errors
```

**21 PRs merged**, each verified against production after its own deploy, not at merge.

**Issues 20 to 6.** Only two of the original twenty remain, and both are yours: #119's design
half and #20. The other four were filed in the last hour by agents finding real defects while
fixing others.

| # | what | who |
| --- | --- | --- |
| #267 | route to the property the traveller picks | the honest half of #243, left deliberately |
| #266 | a waiting-time edit stales the timetable | agent working now |
| #265 | free time gated on a stay after #161 changed the builder | agent working now |
| #249 | no ground transfer is ever priced | **you**, two questions in the issue |
| #119 | design half | **you** |
| #20 | validate against the brief | open by design |

**The acceptance route, verified on production at 06:51 after the last deploy:**

```
4 of 4 itineraries · London LGW · Manchester MAN · Rome FCO · Birmingham BHX
routing.openstreetmap.de 200x10   (zero 429s; it was 4-of-14 an hour earlier)
```

## What I would fix first, if you only do one thing

Not a bug. The measurement gap. Five times last night a suite reported green on a path the
real world does not take, and one of those let a regression halve this route while its PR
honestly reported "itineraries unchanged at 4". Issues #240, #242, #255 and #257 are the
instances; the pattern is that a bench with a fixed candidate set and hand-written fixtures
cannot see what live data does. #262's `fixture-mappers.spec.ts` is the first structural
answer: it runs every fixture through the code that reads its shape and fails when one has no
entry. More of that.

## What I got wrong, in one place

- **I merged the regression.** #248's ceiling comment contained "18 is above 19" and I read
  that PR closely and did not catch it.
- **Six of my own probes were wrong**, three asserting against screens that could never have
  shown the thing, one counting a sentence about ground transport as a bed announcement, one
  relaying an untested inference as a conclusion on #213, one shadowing the global `URL`.
- **I lost my own files four times** to `git checkout -B`, including a design package another
  agent then spent ten minutes hunting for because I had pointed it at a path that existed only
  on my branch.
- **I double-spawned once**, putting an agent on an e2e fix another agent was already finishing.
- **I queried an agent's PR over a diff that was a measurement artefact**, because my own sweep
  tool reads a working tree and I treated a snapshot as a trend.

Everything except the regression was caught the same way: by not explaining away a number I
could not account for.
