# Prompt 006 — Keep the code maintainable

- **Date:** 2026-09-04
- **Author:** Maurici Abad Gutierrez (@mauriciabad)

## Verbatim

```text
from time to time run agents that refactor and clean up and organize the code, so it doesnt become a pile of unmantainable code
```

```text
i go to sleep
```

## Why he is right

A dozen agents writing in parallel, each seeing only its own issue, converges on a mess by
default. It already started. Three separate agents each added Vitest and a `vitest.config.ts`
before one landed, and every provider adapter is at risk of inventing its own retry, its own
error mapping and its own fetch wrapper because none of them can see the others.

Nobody holds the whole picture. That is the orchestrator's job, and periodic cleanup is how
it gets done.

## Cadence, and why not continuously

Refactoring shared files while a dozen branches are open would put a conflict into every one
of them, and the agents that hit those conflicts would resolve them inconsistently. So
cleanup runs **between waves**, not during them:

1. A wave of feature agents runs and their PRs merge.
2. A read-only audit runs at any time, including during a wave, and files issues rather than
   editing anything.
3. A refactor agent runs when the wave has drained and few branches are open.

The audit is safe during parallel work because it writes nothing. The refactor is not.

## What cleanup looks for

Duplication across adapters that wants to become one shared helper. Types that drifted apart
because two agents modelled the same idea. Dead code from a superseded approach. Inconsistent
error handling. Files that grew past the point of being readable. Comments that narrate the
code instead of explaining why. Tests asserting implementation detail rather than behaviour.

The bar is whether the next person to open the file can follow it, not whether it is clever.
