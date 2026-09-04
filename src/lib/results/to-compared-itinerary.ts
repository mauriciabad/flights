/**
 * Issue #103: the results list has real `ScoredResult`s; the comparator wants
 * `ComparedItinerary` (`$lib/components/comparator-types.ts`), a narrower shape that issue
 * #25 defined before this pipeline existed ("provenance" as a flat `ProviderSource[]`, not
 * `ScoredResult.price`'s richer freshness/parts breakdown). This is the one place that gap
 * gets bridged, so neither side has to know about the other's shape.
 */

import type { ComparedItinerary } from '../components/comparator-types';
import type { ScoredResult } from './types';

export function toComparedItinerary(result: ScoredResult): ComparedItinerary {
	return {
		id: result.id,
		itinerary: result.itinerary,
		sources: result.price.parts.map((part) => ({ providerId: part.providerId, fetchedAt: part.fetchedAt }))
	};
}
