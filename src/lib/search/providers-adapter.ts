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

import { getCheapRoutesFrom, loadCheapRoutesDataset } from '../data/cheap-routes';
import type { FlightOffer, IataAirportCode } from '../domain';
import type { FlightProvider, ProviderHealth, ProviderResult, ProviderSource } from '../providers/types';

export const CHEAP_ROUTES_PROVIDER_ID = 'travelpayouts-cheap-routes';

/**
 * Issue #169: the dataset's own fetch instant, never `new Date()`.
 *
 * This used to stamp every answer with the clock at the moment of the call, which made a
 * build artefact compiled into the bundle weeks ago report itself as seconds old. The
 * other nine adapters #151 fixed were stamping a *cache read* as a fetch; this one had
 * nothing underneath it to read a real instant from at all, because the generator wrote
 * none. It writes one now (scripts/fetch-cheap-routes.mjs), and this is where it lands.
 *
 * `ProviderSource.fetchedAt` means "the instant the adapter finished fetching this", and
 * for a build-time dataset the fetch happened in CI, not in this browser. CI's clock is
 * still the right answer to "when did we retrieve this": it is *our* retrieval, just not
 * this device's. What it is not, and must never be quietly replaced by, is Travelpayouts'
 * own `expiresAt` on each row -- that is the provider's claim about its cached fare, a
 * different fact with a different meaning.
 *
 * Awaiting the dataset costs nothing after the first call: `loadCheapRoutesDataset`
 * memoizes, and every method here already had to await it for the rows anyway.
 */
async function source(): Promise<ProviderSource> {
	const { fetchedAt } = await loadCheapRoutesDataset();
	return { providerId: CHEAP_ROUTES_PROVIDER_ID, fetchedAt };
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
			return {
				ok: true,
				data: { message: 'Static build-time dataset, always available' },
				source: await source(),
				requestsUsed: 0
			};
		},

		// Always free: this wrapper does no network I/O at all.
		estimateSearchOffersCost: () => 0,

		async searchOffers(): Promise<ProviderResult<FlightOffer[]>> {
			return { ok: true, data: [], source: await source(), requestsUsed: 0 };
		},

		async listDirectDestinations(iataCode: IataAirportCode): Promise<ProviderResult<IataAirportCode[]>> {
			const routes = await getCheapRoutesFrom(iataCode);
			return {
				ok: true,
				data: routes.map((route) => route.destination),
				source: await source(),
				requestsUsed: 0
			};
		}
	};
}
