// Imported from `../providers/types` directly, not `../keys`: this catalog's ids are
// always one of the real registered adapters, exactly what the closed `ProviderId` union
// models (issue #69) — `../keys`'s own `ProviderId` is deliberately wider, for a BYOK key
// file's forward-compatible id (see that module's doc comment).
import type { ProviderId, ProviderKeyField } from '../providers/types';

/**
 * The settings screen's own list of RapidAPI-metered providers (issue #29), independent of
 * `src/lib/providers/registry.ts`. It has to be independent for now: even though all four
 * adapters here have since merged (Skyscanner #5, Booking/Agoda #10, Flights Sky #61),
 * nothing anywhere assembles a `ProviderRegistry` instance an app screen could iterate —
 * confirmed by searching `src/` for `new ProviderRegistry`, which only appears in
 * `registry.test.ts` and this comment. Building this settings page against a registry that
 * does not exist would mean inventing a competing draft of someone else's issue, the exact
 * failure mode AGENTS.md warns about, so this file owns only what a settings row needs:
 * display copy, the provider's key fields (in the shared `ProviderKeyField` shape from
 * `providers/types.ts`, issue #49), and a cheap real call to validate them (`key-check.ts`,
 * routed through issue #22's real request budget).
 *
 * Once a registry instance exists, this can shrink to the display copy (`blurb`,
 * `pricingUrl`, `monthlyQuota`) and delegate `id`/`keyFields`/health-checking to
 * `registry.all()` and `provider.healthCheck` — the two should describe the same
 * providers, so `id` here is kept aligned with each adapter's own `PROVIDER_ID` (confirmed
 * against all four merged adapters, plus Ryanair for the keyless baseline), and each
 * `check` below reuses the exact endpoint and params the corresponding adapter's own
 * `healthCheck` calls, not a separately-guessed one — re-verified against each adapter as
 * it landed while this file was in flight (see git history for what was a guess when
 * written and what was confirmed once the real adapter existed to check against).
 *
 * That alignment already caught one real gap, since fixed: `providers/budget/caps.ts`
 * (issue #22) used to key its `DEFAULT_PROVIDER_CAPS` table by RapidAPI's host slugs
 * (`sky-scrapper`, `agoda-com`, `booking-com15`) rather than each adapter's own `id`
 * (`skyscanner`, `agoda`, `booking`) — this catalog's own ids, matching the real adapters,
 * exposed the mismatch. Issue #69 fixed `caps.ts` to key by the real adapter ids and made
 * `ProviderId` (`providers/types.ts`) a closed union of them, imported here instead of a
 * bare string, so this catalog's own ids drifting from the real adapters' would now be a
 * compile error rather than a silent cap-table miss.
 *
 * Ids and RapidAPI hosts/slugs come straight from docs/PROVIDERS.md's "Provider slugs"
 * list, which also names the exact `tests/e2e/support/providers.ts` mocks already wired
 * into the e2e network guard. Quotas are that same document's measured 2026-09-04 numbers
 * — re-verify before trusting them, per its own opening line.
 */

export type SettingsProviderCategory = 'flight' | 'stay';

/** One cheap, real, GET-only request used to prove a key is valid and subscribed. Kept
 * separate from `ProviderKeyField` (the settings-form side) because it is a network
 * concern, not a display one. Every field this provider declares is sent as a request
 * header keyed by its `id` — true for every provider in this catalog today, since RapidAPI
 * authenticates with a single `x-rapidapi-key` header regardless of how many form fields a
 * future provider ends up declaring. */
export interface KeyCheckSpec {
	host: string;
	path: string;
	/** A function, not a plain object, so a provider whose cheapest real endpoint needs a
	 * near-future date (Agoda, Booking — a stale hardcoded date risks the provider itself
	 * rejecting the request as malformed, which this settings screen would then have to
	 * explain as a bad key) computes it fresh on every call, exactly like the real
	 * adapters' own `healthCheck` do. */
	params(): Readonly<Record<string, string>>;
	/**
	 * False when the exact endpoint could not be confirmed. This does not affect whether
	 * the check works: RapidAPI's gateway checks the API key against the subscribed host
	 * before routing to a specific path, so the not-subscribed/invalid-key/quota-exceeded
	 * classification below is reliable even if the path itself turns out to be wrong for
	 * this specific product. An unverified path only risks a confusing "unknown" result on
	 * an otherwise-fine key if the underlying app has some unexpected behaviour for a
	 * route it doesn't recognise — never a false "your key is bad".
	 */
	verified: boolean;
}

/** Matches the same-named private helper in `providers/stays/agoda.ts` and `booking.ts`:
 * both hotel APIs reject a checkin/checkout date in the past, so their own `healthCheck`
 * computes a near-future date rather than hardcoding one. Duplicated here rather than
 * imported, since neither adapter module exports it and this file intentionally stays
 * independent of `providers/stays/` (see the module doc above). */
function nearFutureDate(daysFromNow: number): string {
	const date = new Date(Date.now() + daysFromNow * 24 * 60 * 60_000);
	return date.toISOString().slice(0, 10);
}

export interface SettingsProviderDescriptor {
	id: ProviderId;
	label: string;
	category: SettingsProviderCategory;
	/** "What it unlocks" — shown directly on the settings row. */
	blurb: string;
	/** Same shape a real adapter's `ProviderBase.keyFields` declares (providers/types.ts),
	 * so the settings form renders each provider's fields from data instead of hardcoding
	 * one input per provider — issue #49's whole point was making a second field
	 * representable, and a settings UI that only ever renders `keyFields[0]` would defeat
	 * that the day one of these needs a second value. */
	keyFields: readonly ProviderKeyField[];
	/** RapidAPI's marketplace slug, e.g. "sky-scrapper" in `rapidapi.com/apiheya/api/sky-scrapper`. */
	rapidApiSlug: string;
	/** The pricing tab specifically — where "subscribe to the free BASIC plan" happens.
	 * Deliberately a different link from `keyFields[].helpUrl` (which points at the
	 * listing itself, for someone who does not have a key yet): the not-subscribed case
	 * needs the pricing tab precisely because the account already has a key, just not a
	 * subscription. */
	pricingUrl: string;
	/** Requests per month on the free tier, hard limit (docs/PROVIDERS.md). */
	monthlyQuota: number;
	check: KeyCheckSpec;
}

const SKY_SCRAPPER_HOST = 'sky-scrapper.p.rapidapi.com';
const FLIGHTS_SKY_HOST = 'flights-sky.p.rapidapi.com';
const AGODA_HOST = 'agoda-com.p.rapidapi.com';
const BOOKING_HOST = 'booking-com15.p.rapidapi.com';

/** One RapidAPI key field, the shape every provider in this catalog declares today. Pulled
 * into a helper so the four entries below don't repeat the same four properties with only
 * `helpUrl` changing — but each provider's `keyFields` array still holds its own object, so
 * adding a second field to just one provider later is a one-line change, not a schema change. */
function rapidApiKeyField(helpUrl: string): ProviderKeyField {
	return {
		id: 'apiKey',
		label: 'RapidAPI key',
		placeholder: 'Paste your RapidAPI key',
		helpUrl
	};
}

export const SETTINGS_PROVIDERS: readonly SettingsProviderDescriptor[] = [
	{
		id: 'skyscanner',
		label: 'Skyscanner (Sky Scrapper)',
		category: 'flight',
		blurb:
			'The flight search the owner called non-negotiable — the aggregator most likely to have the cheapest fare.',
		keyFields: [rapidApiKeyField('https://rapidapi.com/apiheya/api/sky-scrapper')],
		rapidApiSlug: 'sky-scrapper',
		pricingUrl: 'https://rapidapi.com/apiheya/api/sky-scrapper/pricing',
		monthlyQuota: 20,
		check: {
			host: SKY_SCRAPPER_HOST,
			// Verified against the merged Skyscanner adapter (issue #5): the exact
			// endpoint and params its own `healthCheck` calls, the cheapest real request
			// this host has, since there is no dedicated ping route. docs/PROVIDERS.md:
			// this host costs one request PER CALL regardless of path, so this is exactly
			// as expensive as any other call — never run it automatically, only from the
			// settings "test" button.
			path: '/api/v1/flights/searchAirport',
			params: () => ({ query: 'london', locale: 'en-US' }),
			verified: true
		}
	},
	{
		id: 'flights-sky',
		label: 'Flights Sky',
		category: 'flight',
		blurb:
			'A second flight aggregator, for the cross-price check that tests whether Skyscanner really is cheapest.',
		keyFields: [rapidApiKeyField('https://rapidapi.com/ntd119/api/flights-sky')],
		rapidApiSlug: 'flights-sky',
		pricingUrl: 'https://rapidapi.com/ntd119/api/flights-sky/pricing',
		monthlyQuota: 50,
		check: {
			host: FLIGHTS_SKY_HOST,
			// Verified against the merged Flights Sky adapter (issue #61): the exact
			// endpoint and query its own `healthCheck` calls (`fetchAutoComplete`).
			// Nothing like Sky Scrapper's `/api/v1/flights/searchAirport` — an earlier
			// version of this file guessed that shape by analogy before this adapter
			// existed to check against, which is exactly why `verified` exists.
			path: '/flights/auto-complete',
			params: () => ({ query: 'london' }),
			verified: true
		}
	},
	{
		id: 'booking',
		label: 'Booking.com',
		category: 'stay',
		blurb: 'Hotel prices near the stopover, from one of the two hotel searchers the owner named directly.',
		keyFields: [rapidApiKeyField('https://rapidapi.com/DataCrawler/api/booking-com15')],
		rapidApiSlug: 'booking-com15',
		pricingUrl: 'https://rapidapi.com/DataCrawler/api/booking-com15/pricing',
		monthlyQuota: 50,
		check: {
			host: BOOKING_HOST,
			// Verified against the merged Booking adapter (issue #10): the exact
			// endpoint and params its own `healthCheck` calls (Paris city centre, a
			// generous radius, `MIN_SEARCH_RADIUS_KM` in booking-client.ts). Booking's
			// RapidAPI wrapper genuinely supports coordinate+radius search, unlike
			// Agoda's below.
			path: '/api/v1/hotels/searchHotelsByCoordinates',
			params: () => ({
				latitude: '48.8566',
				longitude: '2.3522',
				radius: '15',
				arrival_date: nearFutureDate(30),
				departure_date: nearFutureDate(32),
				room_qty: '1',
				temperature_unit: 'c',
				languagecode: 'en-us',
				units: 'metric'
			}),
			verified: true
		}
	},
	{
		id: 'agoda',
		label: 'Agoda',
		category: 'stay',
		blurb:
			'The other hotel searcher the owner named. Its free tier (500/month) is generous enough to check every candidate stopover.',
		keyFields: [rapidApiKeyField('https://rapidapi.com/ntd119/api/agoda-com')],
		rapidApiSlug: 'agoda-com',
		pricingUrl: 'https://rapidapi.com/ntd119/api/agoda-com/pricing',
		monthlyQuota: 500,
		check: {
			host: AGODA_HOST,
			// Verified against the merged Agoda adapter (issue #10): the exact endpoint
			// and params its own `healthCheck` calls. Agoda's RapidAPI wrapper takes a
			// free-text place name, not a coordinate — confirmed live by that adapter's
			// author (a `latitude`/`longitude` search returned "The location cannot be
			// empty"), which is why this is a city name rather than coordinates the way
			// Booking's check above is.
			path: '/hotels-homes/overnight-stays/search',
			params: () => ({
				location: 'Paris, France',
				checkin_date: nearFutureDate(30),
				checkout_date: nearFutureDate(32)
			}),
			verified: true
		}
	}
];

/** Every id this catalog knows about, for `KeyStore.importFromFile`'s `knownProviderIds`
 * and `parseImportedKeysFile`'s "unknown provider" warnings. */
export const SETTINGS_PROVIDER_IDS: readonly ProviderId[] = SETTINGS_PROVIDERS.map((p) => p.id);
