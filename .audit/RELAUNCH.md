# Relaunch plan, written 02:35 on 2026-09-05

The 5-hour session limit hit 90% with twelve agents in flight. It resets at **03:20
Europe/Madrid**. Everything below has to be re-spawned after that, fresh, never resumed:
resuming replays the whole transcript every turn and one agent reached 449k tokens that way.

I over-spawned. `docs/HANDOFF.md` says "fewer agents, batched by area" and the owner had
already raised the burn rate twice. Twelve at once was the mistake, not the batching.

## Relaunch in waves of four, not twelve

Wave order is the owner's priority: what he would notice first, cheap ones in the middle so
the count drops, least important last.

### Wave 1, the four he would notice
| branch | issues | one-line brief |
| --- | --- | --- |
| `feat/225-getting-there` | #225 #206 | Headline the total "Getting there", break it into flights / bed with nightly rate / ground with ride count, then a "Staying longer" block listing every longer length the fares support with signed deltas from real pairings. Never price a night off the bed's nightly rate; that premise died when London's 2nd night measured −€3. For #206, measure whether Hostelworld's rate is per person or per party before dividing anything, and write the finding into `docs/PROVIDERS.md`. |
| `fix/time-and-money-format` | #229 #228 #217 #192 | Sole owner of `src/lib/format.ts`. am/pm default with a 24h setting, no padded digits. Free time as `Fri 9 from 9:10pm / 2 full days: Sat, Sun / Mon 12 until 9:05am`, land-before-5am still counts, "No full days" when none, edge lines name when you leave for the airport. Fix `formatLongDuration` printing `2d 24h` by rounding to whole hours before splitting. Move the formatted-price fallback into one `moneyFromFormattedString` in `domain/money.ts` and stop reading `"60,99 €"` as 6099. |
| `fix/231-219-nights-and-beds` | #231 #219 | A gap that merely crosses midnight is charged a mandatory bed; land 23:00 fly 05:00 buys a room nobody checks into. Decide what it turns on and defend the number. And stop ranking beds on `pricePerNight` alone in `stays/rank.ts` and `fetchCheapestStay`: the pick is €13/night 48.3 km out over €52.82 at 2.8 km. The list shows no distance at all. |
| `fix/191-203-185-honest-errors` | #191 #203 #185 | Four clients still invent an error instead of printing the provider's own message and status. A stopover Hostelworld does not cover says "No bed priced" with no reason; three different cases collapsed into one sentence. The missing bed is announced eight times on one screen. Design the three as one answer. |

### Wave 2
| `feat/227-strip-tooltips` | #227 | Hover a timeline segment for what it is, when it runs, what it costs. Must work on touch and keyboard focus, not only a mouse. |
| `fix/189-filter-chips` then #198 | #189 #198 | Facets exclude what their labels say they select. Decide which half is wrong and argue it. Then: only eleven airports have a city centre and the acceptance trip's own stopover is not one. |
| `fix/194-213-187-requests` | #194 #213 #187 | Reload inside the TTL paints nothing (stale-first is the owner's own rule). OSRM routes reset and every pair is requested twice; nine `ERR_CONNECTION_RESET` measured live on the acceptance trip at 02:15. `connections.ts` asks every candidate airport for its route graph then keeps six. |
| `tools/verify-issue` | none | Build `tools/verify-issue.mjs`, a registry of per-issue production checks, wired into `.audit/check-predicate.sh --issues`. Assert the fact, never the prose: one earlier check grepped for copy that had changed and passed vacuously for a day. Run it against production BEFORE the fixes land; most checks must fail, and a pass is a bug in the check until proved otherwise. Touches `tools/`, `.audit/` and docs only, never `src/`. |

### Wave 3, last
| `feat/232-price-band` | #232 | A typical-price band from the #200 ledger. Decide how few observations is too few and say nothing by default. These are prices this browser saw, not the market, and the card must not read as a market claim. |
| `fix/119-road-plausibility` | #119 part 1 | Driving and taxi have no plausibility cap. A flat 240 minutes is not an argument; a long road route is often a real ferry link. Walking is already capped at 45 min in `search/resources.ts` and its constant defends the number. Rejected options must leave the alternatives list too. Do not write `Closes #119`; the design item stays open. |
| `design/first-screen` | files one | Home, app shell, search form, search history, and `results/when/`. Hard boundary: not `src/routes/results/` except `when/`, not `format.ts`, not `stays/`, `search/`, `algorithm/`, not `settings/`. |
| #20 audit | #20 | Validate the app against `docs/prompts/` in a real browser, file what is missing, ranked, one issue per gap. Do not close #20. |

## Every brief carries these, verbatim

- Read `AGENTS.md` in full first, then `docs/ACCEPTANCE.md`, then the issue with `--comments`.
- Start from `origin/main`. Rebase right before opening the PR.
- Every GitHub artifact opens with `> 🤖 Written by an AI agent (Claude), not by a human.`
- Commits end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01XVUfifdWD1x5xbPjtSJsBs`.
- Never the shared Playwright MCP browser. Own Chromium, closed afterwards.
- `localStorage.clear()` does not reset this app; the cache is IndexedDB `flights-cache`.
- `api.skypicker.com` 403s a `HeadlessChrome` UA. Use `PROBE_USER_AGENT` / `newProbeContext`
  from `tools/probe-browser.mjs`.
- Suspect the measurement before the code.
- `pnpm check && pnpm test && pnpm build`, then `pnpm qa`. Verify in a real browser against a
  real production build. Open the PR, do not merge.

## Partial work is on disk, do not throw it away

Nothing was pushed before the limit hit, so `origin` has nothing from these twelve. Their
working trees survive under `.claude/worktrees/agent-*`. Before re-spawning, run
`git -C <worktree> status --porcelain` and `git -C <worktree> diff` on each, and if there is
real work in one, hand the fresh agent the path and tell it to review and keep what is right.
Spawn fresh; do not resume. `tools/reclaim-worktree-space.mjs` skips any worktree with
uncommitted changes, so it will not eat them.

## Agent worktrees holding tonight's twelve

ab7617fff809b4e86 price card · a99f013a4f128d894 format · a13070ddb6c9d5551 tooltips ·
a4d36be610e16ad8a nights and beds · ae7ae124049405a1f filters · a2052fc8aab7239d9 requests ·
ab29ef9e6e758307b honest errors · a0573982df4a0bf17 audit #20 · aba056be1e6936aa9 price band ·
afb3d90dda66020bb road plausibility · a6188defeed4d804e verify-issue · a3183d3eed287e5ee design

## What actually blew the budget, 03:25 update

Not twelve agents. Twelve agents **each spawning their own review panels**. The failure
notifications named the children: "Architect A on 231 and 219", "Architect B on 231 and 219",
"Design package B", "Design package C", "Design sketch B". `poteto-mode` routes cross-boundary
work to the `architect` skill, which runs a four-model panel, so every agent was worth three
to five. A five-hour budget went in about twenty minutes.

**Every brief from now on carries: do not spawn subagents, not one, and do not use
`architect`, `arena`, `interrogate`, `how` or `why`.** That line overrides the skill.

One of those children did finish before the wall, and its output is saved at
`.audit/design-227-segment-stub.md`: a complete design package for the #227 tooltip, 600
lines, with the CSS, the copy for all five segment kinds, the interaction model and a list of
what it rejected. It also settles wording #185, #203, #206 and #228 need. It cost 232k tokens
and it is not being paid for twice.

## Wave 1 relaunched at 03:25, three agents

| branch | issues |
| --- | --- |
| `fix/time-and-money-format` | #229 #228 #217 #192 |
| `fix/191-203-185-honest-errors` | #191 #203 #185 |
| `feat/225-getting-there` | #225 #206 |

Each was pointed at the partial work its predecessor left uncommitted, so nothing restarts
from zero. Wave 2 is #189 then #198, #231 #219, #227 (which now has its design done), #194
#213 #187. Wave 3 is #232, #119 part 1, #20, and the first-screen design.

## Partial work found at 03:24, by worktree

- `agent-a99f013a4f128d894` money.ts, money.test.ts, flights-sky-money.ts, skyscanner-money.ts
- `agent-ab29ef9e6e758307b` kiwi-public-client, ryanair-client, response-evidence, agoda-client, booking-client
- `agent-ae7ae124049405a1f` Chip.svelte, filters.ts, filters.test.ts, results/+page.svelte, FilterPanel.svelte
- `agent-a2052fc8aab7239d9` connections.ts, osrm.ts, osrm.test.ts, a qa spec
- `agent-a13070ddb6c9d5551` trip-strip.ts
- `agent-aba056be1e6936aa9` src/lib/price-band/, PriceBand.svelte

## Every brief also carries this, from 03:50 onward

**The channel goes both ways.** A subagent can reach the orchestrator with `SendMessage`
and `to: "main"`. Say so in the brief, and say what it is for:

- a decision that belongs to the owner rather than the agent. He is asleep, but the
  orchestrator holds his rulings and can usually answer from them instead of the agent
  inventing a fifth option
- another agent's change colliding with this one, or a branch that has to merge first
- a real defect outside the agent's own issues, so the orchestrator routes or files it and
  the diff stays focused
- anything about to cost a long detour that the brief may not have intended

And say what it is **not** for: progress updates. `tools/agent-progress.mjs` reads the
worktree directly (branch, commits ahead, diffstat, minutes since the last file change), so
the orchestrator can watch without spending the agent's context. Asking an agent "how is it
going" costs the agent more than it costs the orchestrator to look.

The first sweep, at 03:44, immediately found the price-card agent building on the default
`worktree-agent-<id>` branch with 644 insertions and no commits. Neither would have surfaced
until its PR, or until it died.

## Two more things every brief carries, from 05:10

**Write an acceptance note in the PR, not a rationale paragraph.** The agent that shipped #235
put "the block lives in the expanded panel" inside a design-rationale section. The orchestrator's
verification probe then read the collapsed results page, found no clock times, and nearly filed
two false bugs against good work. Its own words afterwards:

> An acceptance note saying "click Show details, the block is not on the card" would have cost
> me one line and saved you a run. I proved the thing worked and left the next person to
> rediscover where to point.

So: one line at the top of the PR saying exactly where to look and what to click to see the
change. Same shape as the merge-versus-repro gap `docs/ACCEPTANCE.md` is about, one level up.

**Report an observation as an observation.** The same agent found OSRM resetting every request
and reported it, correctly, as an inference it had not tested. The orchestrator then relayed it
onto #213 as a conclusion and had to correct itself twice. If you have not tested the other
direction, say so in the sentence itself.

## Orchestrator's own mistake, recorded so the next one avoids it

`git checkout -B orchestrator origin/main` was used three times to move this branch forward. It
resets the branch pointer and the working tree, so it silently dropped every commit that had not
been merged: `.audit/RELAUNCH.md` twice, `.audit/design-227-segment-stub.md`, and
`tools/agent-progress.mjs`. All four were recovered from the reflog at 05:10, and the design
package was the expensive one, 232k tokens of work that existed nowhere else.

Use `git fetch origin main && git rebase origin/main` to move a working branch, never `-B`. If
you must reset, push first.
