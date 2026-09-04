/**
 * Which provider a request belongs to, decided from its URL alone.
 *
 * The harness has to answer "who did this request go to" for every request the app makes,
 * including one to a host nobody expected. Matching on the URL rather than on a mock's own
 * registration is deliberate: a mock that never fires tells you nothing, and the interesting
 * failure is always the request that went somewhere the test author did not think about.
 *
 * Hosts are imported from the adapters where the adapter exports one (`OSRM_BASE_URL`), and
 * written out otherwise. `tests/e2e/support/providers.ts` already learned what a copied host
 * costs: `mockOsrm` intercepted `router.project-osrm.org` for months after the adapter moved
 * to `routing.openstreetmap.de`, and nothing noticed (issue #132).
 */

import { OSRM_BASE_URL } from '../../../src/lib/providers/transfers/osrm';
import { BASE_URL as TRANSITOUS_BASE_URL } from '../../../src/lib/providers/transfers/transitous-client';
import type { ProviderId } from '../../../src/lib/providers/types';

export const RYANAIR_FARES_HOST = 'services-api.ryanair.com';
export const RYANAIR_WEB_HOST = 'www.ryanair.com';
export const AGODA_HOST = 'agoda-com.p.rapidapi.com';
export const BOOKING_HOST = 'booking-com15.p.rapidapi.com';
export const SKYSCANNER_HOST = 'sky-scrapper.p.rapidapi.com';
export const KIWI_HOST = 'kiwi-com-cheap-flights.p.rapidapi.com';
export const NOMINATIM_HOST = 'nominatim.openstreetmap.org';
/** Kiwi's own keyless GraphQL endpoint (issue #157), not the dead RapidAPI listing above. */
export const KIWI_PUBLIC_HOST = 'api.skypicker.com';
/** Hostelworld's own keyless mobile backend, the bed equivalent of the line above.
 * Hostelworld has no RapidAPI listing at all, so there is no metered twin to confuse it
 * with. */
export const HOSTELWORLD_HOST = 'api.m.hostelworld.com';
export const OSRM_HOST = new URL(OSRM_BASE_URL).host;
export const TRANSITOUS_HOST = new URL(TRANSITOUS_BASE_URL).host;

/** Flights Sky's host is built from a constant the client keeps private, so it is written
 * out here. Kept beside the others rather than inlined at the one use site so the whole
 * host list reads in one place. */
export const FLIGHTS_SKY_HOST = 'flights-sky.p.rapidapi.com';

const HOST_TO_PROVIDER: Readonly<Record<string, ProviderId>> = {
	[RYANAIR_FARES_HOST]: 'ryanair',
	[RYANAIR_WEB_HOST]: 'ryanair',
	[AGODA_HOST]: 'agoda',
	[BOOKING_HOST]: 'booking',
	[SKYSCANNER_HOST]: 'skyscanner',
	[KIWI_HOST]: 'kiwi',
	[KIWI_PUBLIC_HOST]: 'kiwi-public',
	[HOSTELWORLD_HOST]: 'hostelworld',
	[FLIGHTS_SKY_HOST]: 'flights-sky',
	[OSRM_HOST]: 'osrm',
	[TRANSITOUS_HOST]: 'transitous'
};

/**
 * `undefined` means "this host belongs to no adapter this app has" — which is a finding,
 * not a gap in this table. `cost-per-search.qa.ts` reports such a host by name rather than
 * silently bucketing it somewhere.
 */
export function providerForUrl(url: string): ProviderId | undefined {
	let host: string;
	try {
		host = new URL(url).host;
	} catch {
		return undefined;
	}
	// Transitous serves both the transfer planner and the geocoder from one host; the path
	// is the only thing that separates them, and they draw on the same rate limit anyway.
	if (host === TRANSITOUS_HOST && url.includes('/geocode')) return 'transitous-geocode';
	return HOST_TO_PROVIDER[host];
}

