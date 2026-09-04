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

## Definition of done

- `pnpm check` passes. No new type errors, no `any` smuggled in to silence one.
- `pnpm build` passes.
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

## Money

Integer minor units and a currency code. Never a float, never a formatted string as the
canonical value. Convert at the edges, compare in minor units.

## When the data is missing

This app talks to a dozen providers, several of which will be out of quota, unsubscribed or
simply down. Partial results are the normal case. Say what you do not know rather than
guessing, and never present an estimate as a fact.
