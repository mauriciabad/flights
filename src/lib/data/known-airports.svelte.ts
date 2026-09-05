/**
 * Issue #327: every IATA code this app knows, as something a `$derived` can read without
 * awaiting anything.
 *
 * `validateSearchFields` is pure and synchronous and has to stay that way, but the one
 * question it could not answer was the one a broken link asks: is `ZZZ` an airport at all?
 * A results URL carrying a code the dataset has never heard of used to reach `runSearch`,
 * which threw "require both airports to resolve" into the console while the page said
 * "0 of 0 itineraries shown". That is a claim that a search had run and answered nothing.
 *
 * Module-level state rather than context, because the answer is a property of a generated
 * dataset rather than of any traveller: it is the same set for everyone, it never changes
 * while the app is open, and both the search form and the results page ask for it. There
 * is no per-user data here to leak across a prerender.
 *
 * Costs nothing until something asks. The load starts on the first read, and it shares
 * `loadAirports`' own memoized promise, so a page that was going to resolve an airport
 * anyway downloads and parses the dataset exactly once either way.
 */
import { browser } from '$app/environment';
import { loadAirports } from './airports';

let codes = $state<ReadonlySet<string> | undefined>(undefined);
let started = false;

/**
 * `undefined` until the dataset has loaded, which means "not known yet" and never "not an
 * airport". A caller that turned that into an error would tell someone their perfectly
 * real airport does not exist for as long as the download takes.
 */
export function knownAirportCodes(): ReadonlySet<string> | undefined {
	if (!started && browser) {
		started = true;
		void loadAirports().then((airports) => {
			codes = new Set(airports.map((airport) => airport.iataCode));
		});
	}
	return codes;
}
