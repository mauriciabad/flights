/**
 * The shape this adapter hands callers, once transitous-mapper.ts has turned a wire
 * `TransitousGeocodePlace` into something a caller never needs to know is Transitous-shaped.
 * Kept out of `domain/` (issue #1's chokepoint) rather than added there: nothing outside
 * this adapter needs "an unpicked geocoder candidate" as a concept, only the `Location` a
 * caller builds after a person picks one — see domain/location.ts's own comment on that
 * distinction.
 */

import type { Coordinates, IsoCountryCode } from '../../domain';

export interface GeocodeAdminArea {
	name: string;
	/** Coarser is lower — 2 is roughly country level, 10+ a neighbourhood. Lets a caller
	 * render a trail ("Barcelona, Catalunya, Spain") in a sensible order without having to
	 * already know what each level means. */
	adminLevel: number;
	/** Whether this area matched a term the caller actually typed — e.g. searching
	 * "Barcelona" marks every candidate's real Barcelona area `true`, which is what lets a
	 * result list bold the part of the trail that explains why it matched. */
	matched: boolean;
}

/**
 * One ranked candidate from a free-text search. Issue #64: "Barcelona is a city in Spain
 * and also one in Venezuela, so returning one silent guess is wrong" — this is why a
 * search resolves to a list of these, never to a single picked `Location`; picking is the
 * caller's job once a person has seen `areas` and `countryCode` for each option.
 */
export interface GeocodeCandidate {
	name: string;
	coordinates: Coordinates;
	countryCode: IsoCountryCode | undefined;
	/** IANA zone, e.g. "Europe/Madrid". `undefined` on the rare candidate Transitous
	 * itself has no zone for — AGENTS.md: treat as unknown, never default to UTC. */
	timeZone: string | undefined;
	/** Broadest first, as Transitous returns them (lowest `adminLevel` first) — enough to
	 * tell Barcelona-Spain from Barcelona-Venezuela from Barcelona-Philippines at a glance. */
	areas: GeocodeAdminArea[];
}
