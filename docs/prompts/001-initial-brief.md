# Prompt 001 — Initial brief

- **Date:** 2026-09-04
- **Author:** Maurici Abad Gutierrez (@mauriciabad)
- **Channel:** Claude Code session, opening message

## Verbatim

```text
I want you to create this web app from scratch. using svelte /svelte:svelte-code-writer   you have to create the repo in my github and issues and manage all the project there. it is important to keep my human prompts in the issues and docs.

This app is for finding flights cominations. when i eant to go to a location that doesnt have direct flights i want to spend some days in a in-between city, this saves money and gives me a trip "for free". but with tratitional flight searchers it is dificult to manage because you also have to arrange hotels and check transport combinations. this app helps me pick the best flight by fething all the info i need and presenting in a useful way.
I expect you to be fully autonomous and get yourself the api keys and deploy the site and whatever you need. ideally make it a static website (installable PWA) and deployed to gh pages i will make a custom domain flights.mauri.app. everything you need me to do, try to ask for it at the begining do i give it to you and leave you working alone all night.

/loop loop until all the features on the app are done and deployed and work in production and all issues closed

/swarm you need many agents to code it in paralel working each on their gh issues. they can even open more issues. also make agents that validate and add more issues.


I wrote many things for the app but i may have forgoten some. i give you freedom to fill the gaps and add details that you consider usefull (this is also a periodic agent)



Input:
-  Soonest departure date 
-  Latest departure date (optional, default Latest  arrival date)
-  Latest  arrival date
-  Soonest  arrival date (optional, default Soonest departure date )
-  Origin location (optional)
-  Origin airport
-  Destination airport
-  Destination location (optional)
-  Number of people (default 1)
-  Number of females (optional, used to filter or not hostels that have female only dorms)
-  Forviden connection countries or airports (optional)
- Airlines to avoid (Still fetches, but grayed out and less score)
- Min layover time (optional, default 30min)
- connection airports (optional, default all avilable)
- airport waiting times (optional, default 2h. would be nice to allow multiple values based on airport size and flight duration, like sort flight or small airport 2h, long flight or large airport 3h). Also for landing to transport time, usually 15min or 30min depending on the airport size.


For each itinerary:
- Schedule:
  - Start at Origin location
  - Travel to origin airport
  - Waiting time at origin airport
  - Fight to connection airport
  - Travel to connection hotel
  - Free time
  - Travel to connection airport
  - Waiting time at connection airport
  - Flight to destination airport
  - Travel to destination location
- Price of each part and in total
- Time of each part and total
- Times:
  - In-flight time
  - Airport waiting time (2h before flight + layovers. this is not time between flights)
  - Free time (from arrival to the hotel in connection to departure from it. include also interval datetimes)
- Nights in connection
- Public transport avilable and schedules if missed
- airlines and flight details
- map of all itinerary, user can pick what section to zoom into
- Info about the hostels and rooms and images if possible
- price per night in dorm and in private room (user can select to update total)
- price and time an dinfo avout travel methods, user can pick the one he wants and updates ui.
- price and info about the flights, user can see alternative flights for same location with their price and difference from selected one, selecting updates ui.
- the ui has the search results first, so it is easy to filter out. but it also has a comparator that you select the itinerary (connection, flights, hotels, transport...) and shows them in fullscreen as columns where the elements are aligned (subgrid) and all of them scroll the timeline together and have a card on top with info that is not in the timeline and bottom has things like total price, times etc
- airport waiting times can be edited afterwards
- the airports include icons for the city or country (https://github.com/anto1/city-icons for example)

Algorythm steps (paralelizable):
- Get flight connections (flightconnections.com or similar)
- Get all flights from Origin to Every Connection in the time period (Skyscanner)
- Get all flights from Every Connection to Destination in the time period (Skyscanner)
- Get cheapest hotels/hostels for each connection within 100km (Agoda + HostelWorld)
- Get walking, public transport time and driving time and aprox prices: (Rome to Rio)
    - from connection airport to hotels
    - from hotels to connection airport
    - from origin location to airport
    - from destination airport to location
- Match flights to find best combinations
- Group results into variants for same itinerary
- Check if there's public transport options at arrival/departure time in connection airport and travel from origin/destination airports (sometimes at night there's no public transport) and next schedules in case of missing it.


Caches the results, to show faster results, but fetches them anyway and updates the results.
```

## Notes on interpretation

These are the agent's readings, not the user's words. Each one is a guess that the code
should make easy to change later.

- **"a trip for free"** is the product thesis. A layover long enough to sleep in the
  connection city often costs less than the direct flight, so the stopover city is a
  bonus rather than a cost. Ranking has to reflect that, so a cheap itinerary with three
  nights in Vienna should be able to beat a marginally cheaper one that connects in two
  hours through an airport hotel.
- **"Number of females"** filters female-only dorms in or out. It does not change pricing
  on its own, and it never gets used for anything else.
- **"Airlines to avoid"** still get fetched and shown, greyed out with a score penalty.
  They are never dropped from results.
- **"Airport waiting time"** is explicitly *not* layover time. It is the buffer before a
  flight, defaulting to 2h, and it is added to time spent in airports.
- **"Free time"** runs from hotel check-in in the connection city to leaving the hotel,
  and the UI shows the actual start and end datetimes, not only a duration.
- **The comparator was built and then removed.** It shipped as a `/comparator/` route
  that lined itineraries up as subgrid-aligned columns. On 2026-09-04 the owner asked for
  it to be deleted outright: "completely delete the compare funcionality and all dead code
  it makes." Nothing in the app compares itineraries side by side any more, and the
  verbatim line above is kept as a record of what was asked for, not as a description of
  what exists.
- **Cache-then-revalidate** is required behaviour, not an optimisation. Show the cached
  result immediately, refetch regardless, update in place.
