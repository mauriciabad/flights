/**
 * Wraps the build-time Travelpayouts cheap-routes dataset (issue #52, `data/cheap-routes.ts`)
 * as a `FlightProvider` (`providers/types.ts`), so it can be passed into
 * `algorithm/connections.ts`'s `ConnectionGraphOptions.flightProviders` alongside real
 * adapters — that option takes real `FlightProvider`s directly since issue #59's rebase onto
 * the merged provider interface, not a narrower route-graph-only shape this file used to
 * define itself.
 *
 * This wrapper's `searchOffers` always returns an empty, ok result: `CheapRoute`'s price is a
 * cached, possibly-hours-old fare with no proper `LocalDateTime` (no IANA zone — that file's
 * own doc comment), so it cannot become a `FlightOffer` a real itinerary could be built from
 * (AGENTS.md "Timezones"). Only `listDirectDestinations` does real work — "is this airport
 * reachable from that one" is all a route-graph source needs to answer, and
 * `estimateSearchOffersCost` reporting `0` is what keeps this wrapper in the free tier
 * everywhere else in this pipeline treats providers by tier (`cost-aware.ts`).
 */

import { getCheapRoutesFrom } from '../data/cheap-routes';
import type { FlightOffer, IataAirportCode } from '../domain';
import type { FlightProvider, ProviderHealth, ProviderResult, ProviderSource } from '../providers/types';

export const CHEAP_ROUTES_PROVIDER_ID = 'travelpayouts-cheap-routes';

function source(): ProviderSource {
	return { providerId: CHEAP_ROUTES_PROVIDER_ID, fetchedAt: new Date().toISOString() };
}

export function createCheapRoutesFlightProvider(): FlightProvider {
	return {
		kind: 'flight',
		id: CHEAP_ROUTES_PROVIDER_ID,
		label: 'Travelpayouts cheap routes (build-time)',
		needsKey: false,
		keyFields: [],

		async healthCheck(): Promise<ProviderHealth> {
			// No network call this adapter could make even if asked to — the dataset it
			// reads is a static build artefact (data/cheap-routes.generated.json), never
			// fetched at runtime, so "is this provider reachable" is trivially always yes.
			return { ok: true, data: { message: 'Static build-time dataset, always available' }, source: source(), requestsUsed: 0 };
		},

		// Always free: this wrapper does no network I/O at all.
		estimateSearchOffersCost: () => 0,

		async searchOffers(): Promise<ProviderResult<FlightOffer[]>> {
			return { ok: true, data: [], source: source(), requestsUsed: 0 };
		},

		async listDirectDestinations(iataCode: IataAirportCode): Promise<ProviderResult<IataAirportCode[]>> {
			const routes = await getCheapRoutesFrom(iataCode);
			return { ok: true, data: routes.map((route) => route.destination), source: source(), requestsUsed: 0 };
		}
	};
}
