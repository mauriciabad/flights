/**
 * Issue #25: the comparator's own input shape.
 *
 * The comparator's top card needs "provider and price provenance" (the issue's words),
 * but `Itinerary` (domain/itinerary.ts) carries no `ProviderSource` — provenance lives on
 * `ProviderResult` (providers/types.ts), one level up, where the search pipeline that
 * fetched each part of the itinerary would attach it. That pipeline, and the results list
 * that would select itineraries to compare (issue #23), do not exist yet.
 *
 * AGENTS.md: "If your issue depends on something that does not exist yet... define the
 * narrowest possible interface." This is that interface: an itinerary plus the sources
 * that contributed to it, `sources` optional because a comparator built from partial
 * provider data legitimately may not know where every part came from yet (AGENTS.md "When
 * the data is missing"). `id` is a stable React/Svelte-list key independent of object
 * identity, since two columns could otherwise compare `Itinerary` objects that are
 * structurally equal but not the same reference.
 */

import type { Itinerary } from '../domain';
import type { ProviderSource } from '../providers/types';

export interface ComparedItinerary {
	id: string;
	itinerary: Itinerary;
	/** One entry per provider call that contributed data to this itinerary (the two
	 * flights, the stay, the transfers), for the pinned card's "provider and price
	 * provenance" line. Omitted or empty renders as "not available yet" rather than
	 * guessing a source. */
	sources?: ProviderSource[];
}
