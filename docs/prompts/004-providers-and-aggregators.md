# Prompt 004 — Aggregators, not single airlines

- **Date:** 2026-09-04
- **Author:** Maurici Abad Gutierrez (@mauriciabad)

## Context

The agent had found that RapidAPI's free tiers are tiny (Sky Scrapper gives 20 requests
per month) and proposed making the keyless Ryanair API the default search engine, with
other budget airlines added alongside it. Maurici rejected that.

## Verbatim — on Skyscanner having its own API

```text
i think skyscanner already has a free api themselves, in hackathons i always see them giving access
```

## Verbatim — rejecting the single-airline approach

```text
no, this is not the way to go. we must use flight agregators that check multiple websites, i dont care wich. i usually use skyscanner because fetches so many providers
```

## Verbatim — access granted during setup

```text
i logged in rapidapi
```

```text
I logged into https://app.travelpayouts.com/ on the playwright for you
```

```text
always run the commands on the background so you can keep working
```

```text
you have 4 active shells in the background, dont forget about them one is very old and may be stuck
```

```text
no need to tag me in the prefix
```

## What was checked, and what came back

On the Skyscanner question: their own Travel API is partner-only and approved case by
case, aimed at established travel businesses with an existing audience. Hackathon access
is granted through the event organiser rather than self-serve signup. So it is real, and
it is not obtainable in one night.

## Rules this creates

1. **Aggregators, not airlines.** A source that queries one carrier is not acceptable as
   the primary engine. The value of Skyscanner is that it checks many sellers at once,
   and that property is what has to be preserved, whichever provider supplies it.
2. **Which aggregator is negotiable, having one is not.** "i dont care wich" applies to
   the brand, not to the aggregation.
3. **Ryanair stays, with a demoted role.** Not as the search engine, which was the
   rejected proposal, but as ground truth for verifying aggregator prices, and as
   something that works before any key is entered.

## Consequences for the architecture

Free-tier quotas make request budget a product concern rather than a tuning detail.
Twenty Skyscanner calls a month cannot drive an interactive search, so the pipeline must
narrow candidates using cheap or free sources first and spend metered aggregator calls
only on the survivors. Issue #22 owns this.

Travelpayouts becomes more interesting under this rule than it first appeared: it
aggregates many agencies through Aviasales, costs nothing, needs no card, and allows 300
requests per minute. Its limitation is cached rather than live prices, which is an
acceptable trade for the ranking step and not for the final quote.
