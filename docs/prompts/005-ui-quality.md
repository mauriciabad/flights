# Prompt 005 — UI quality, parallelism, deploy cadence

- **Date:** 2026-09-04
- **Author:** Maurici Abad Gutierrez (@mauriciabad)

## Verbatim

```text
you can probably run some more agents in paralel. make sure the changes get commited and deployed frequently. When doin ui agents must load skills to make creative and usefull uis, the one you made is boring and ugly. i have many design skills installed
```

## Verbatim — on the Travelpayouts tracking script

```text
Travelpayouts is telling me somethign about Install Drive manually i dontunderstant, i dont want trackers in the app... but i guess it is mandatory to exit the account setup
```

## Rules these create

1. **UI agents load design skills before writing CSS.** `design-taste-frontend` first, then
   `ui-ux-pro-max` and `web-design-guidelines`. Recorded in `AGENTS.md` so every future
   agent inherits it. The rejected first pass was the stock SvelteKit scaffold.
2. **More agents in parallel**, and **commit and deploy often** rather than batching work
   into large merges. Every merge to `main` redeploys, so a green PR should land promptly.
3. **No third-party tracking scripts, ever.** Travelpayouts' "Drive" script rewrites links
   for affiliate attribution and is optional; the Data API needs only a token.

   The security reason is stronger than the preference. This app holds the user's API keys
   in `localStorage`, and any third-party script on the page can read `localStorage`. A
   tracker would have access to his Skyscanner and Agoda credentials. Link commission does
   not buy that. If their onboarding insists, click through it and never paste the snippet.
