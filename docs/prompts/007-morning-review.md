# Prompt 007 — First real user session, and what it broke on

- **Date:** 2026-09-04
- **Author:** Maurici Abad Gutierrez (@mauriciabad)

## Verbatim

```text
I just opened the production and encountered a critical mistake that doesnt let me use the app. The airport selector is missing small airports. for example i want Boa Vista, Cabo Verde and it is not in the list. Also the header bar is cut on the results page. "No bed priced for this stopover — total excludes a stay." WTF this is one of the core features it is not acceptable that is not avilable. and the map is wrong! i dont want just a map of the flights i want also the transport from starting point to airport, in the conection travel to and from hotel and to destination point, with markers for start hotel and end, this is what i meant by the select a segment to zoom, user can zoom to see the connection transport for example.
From the design perspective it is still very poor, i expet a lot more of visual elements such as icons and logos.
"Walk 11h 42m" WTF dont even show this, walk is not an option in this case. and price of walk is 0€... 
It is very important you spawn agents that criticise the application (not code) and find flaws, errors, and things that dont work as a user would expect. to later address the issues.


a good test route is Boa Vista BVC to Pafos PFO

on dates October 6 to 12

I manually did a investingation recently so I can correct your findings
```

## The reference itinerary

He researched this route by hand. **This is ground truth: the app should find something at
least this good, and if it cannot, that gap is a bug.**

- **Route:** BVC (Boa Vista, Cabo Verde) → PFO (Pafos, Cyprus)
- **Dates:** 6 to 12 October 2026
- **Flights:** €238, connecting at **LGW** (London Gatwick)
  - BVC → LGW on 6 Oct, 12:40 → 20:30
  - LGW → PFO on 7 Oct, 15:20 → 22:00
- **Stay:** €44, one night 6–7 Oct, Gainsborough Lodge, London
- **Total:** **€282**, no transport needed
- Described as both the cheapest and the shortest flight time

Sources he used: Skyscanner for the flights, Agoda for the hostel. Both are providers this app
already integrates, so the data is reachable.

## Rules this creates

1. **Spawn agents that criticise the application, not the code.** He asked for this explicitly.
   They use the deployed site as a traveller would and report what does not work as expected,
   what is confusing, and what looks unfinished. Reviewing source is not the job.
2. **The hotel price is not optional.** A stopover only beats a direct flight if you know what
   the bed costs. "No bed priced" as a resting state is a product failure, not an honest
   disclosure.
3. **The map covers the whole journey**, including every ground transfer and markers for the
   start point, the hotel and the end point. Zooming to a segment exists so you can look at the
   connection transport, which is the part a traveller actually worries about.
4. **Do not offer absurd options.** An eleven-hour walk priced at €0 is worse than showing
   nothing: it makes the panel look unserious and buries the real choices.
5. **Visual density matters.** Airline logos, place marks and mode icons. He expects to
   recognise a trip at a glance, not read a table.
