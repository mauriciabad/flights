/**
 * Every adapter actually registered in this codebase, by id. Issue #69: three modules
 * (adapters, the budget module's cap table, the settings catalog) each invented this
 * vocabulary on their own and drifted apart — `getProviderCap('skyscanner')` was silently
 * missing the cap table entirely because it was keyed `'sky-scrapper'`, RapidAPI's host
 * slug, not the adapter's own id. This list is the fix: the one place a provider id is
 * spelled out, so every other module imports `ProviderId` instead of retyping the string.
 *
 * Unlike IataAirportCode/IsoCurrencyCode (domain/codes.ts), which stay plain strings
 * because their real values come from data too large and too dynamic to enumerate at the
 * type level, providers are exactly the opposite: a small, fixed set, wired up by hand in
 * source, one new entry whenever an adapter is added. A closed union is what makes a typo
 * or a drifted id a compile error at the point it's written, rather than a lookup miss
 * that quietly falls through to a fallback.
 *
 * ## Why this sits in `domain/` rather than in `providers/types.ts`, where it was written
 *
 * Issue #450 put a provider's own id on a `Stay`, so which provider said a thing became
 * part of the data rather than a fact about the call that fetched it. `domain/index.ts`
 * takes no import from outside this directory, so the alternative was a bare `string` on
 * `StaySource.provider` — which is exactly the drift this list exists to stop, one layer
 * further in. `providers/types.ts` re-exports both names, so every module that imports
 * from there is untouched.
 */
export const PROVIDER_IDS = [
	'skyscanner',
	'flights-sky',
	'kiwi',
	'kiwi-public',
	'ryanair',
	'agoda',
	'booking',
	'hostelworld',
	'transitous',
	'transitous-geocode',
	'travelpayouts-cheap-routes',
	'osrm'
] as const;

/** Stable identifier for a registered adapter. See `PROVIDER_IDS` above — this is its
 * derived union, not a separately maintained list. */
export type ProviderId = (typeof PROVIDER_IDS)[number];
