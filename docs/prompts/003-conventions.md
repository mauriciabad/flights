# Prompt 003 — Conventions added during the first session

- **Date:** 2026-09-04
- **Author:** Maurici Abad Gutierrez (@mauriciabad)

## Verbatim — AI attribution on GitHub

```text
please everythign you comment in gh include some kind of prefix that lets me know it is an ai and not myself human
```

## Verbatim — background commands

```text
always run the commands on the background so you can keep working
```

## Verbatim — orchestration, not hand-coding

```text
you are meant to orchestrate a /swarm not code it yourself
```

## Verbatim — on the repo being empty early on

```text
there's nothing on the repo, no code, no issues nothing
```

## Verbatim — RapidAPI subscriptions

```text
i dont know what you mean by Click "Subscribe to Test", do it yourself
```

```text
i already have basic plan
```

Context for that last pair: a RapidAPI BASIC plan is per-API, not per-account. Having "a
basic plan" on one API grants nothing on another, and every unsubscribed API answers
`403 {"message":"You are not subscribed to this API."}`. Five hosts were checked and all
five returned 403 with a valid key.

## Verbatim — DNS

```text
i added the dns for flights.mauri.app and added it to the gh pages config for you, it is checking the dns
```

## Rules these create

1. **Every GitHub artefact written by an agent carries an AI marker.** Issues, comments, PR
   descriptions and reviews all start with the banner below, so Maurici can tell at a glance
   what he wrote and what a machine wrote.

   ```markdown
   > 🤖 Written by an AI agent (Claude), not by a human.
   ```

   Commits already carry `Co-Authored-By: Claude`. Human words quoted inside an agent's
   text stay clearly marked as quotes.

2. **Long commands run in the background** so the orchestrator keeps working.

3. **The main session orchestrates.** It sets up the skeleton, writes issues, launches the
   swarm and reviews. It does not implement features by hand while agents idle.
