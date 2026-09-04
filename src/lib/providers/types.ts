/**
 * Provider interface: the shape every adapter (Skyscanner, Ryanair, Rome2Rio, Transitous,
 * OSRM, Agoda, Booking, OurAirports, ...) implements, and every caller (the search
 * pipeline, the cross-price-check, the settings page) programs against.
 *
 * Types only — no logic, no I/O, no Svelte, same rule as domain/index.ts and for the same
 * reason: this file is a chokepoint six adapters and the whole pipeline get written
 * against in parallel, so it has to stay a stable contract rather than something that
 * grows behaviour of its own. Runtime logic (the registry, usability checks) lives in
 * registry.ts.
 *
 * Issue #2: "Provider interface and registry."
 */

import type {
	Airport,
	Coordinates,
	FlightOffer,
	IataAirportCode,
	IsoCalendarDate,
	IsoCurrencyCode,
	LocalDateTime,
	RoomKind,
	Stay,
	Transfer,
	TransferMode
} from '../domain';

/**
 * Stable identifier for a registered adapter, e.g. "skyscanner", "ryanair", "ourairports".
 * A plain string rather than a branded type, matching IataAirportCode/IsoCountryCode in
 * domain/codes.ts: adapters hardcode this as a literal, and branding would only add casts
 * at every one of those literals for no safety this file can actually check.
 */
export type ProviderId = string;

/**
 * One piece of credential material an adapter needs — one row in a settings-page form.
 * `id` is the key the BYOK store (issue #3) uses to look the value up and the key of
 * ProviderKeyValues below; it is scoped to the adapter that declares it; two adapters can
 * both declare a field with id "apiKey" without colliding, because lookup is always
 * `keysFor(providerId)[field.id]`, never a global namespace.
 */
export interface ProviderKeyField {
	id: string;
	/** Shown as the form field's label, e.g. "RapidAPI Key". */
	label: string;
	placeholder?: string;
	/** Where to go get one, e.g. a link to the RapidAPI subscribe page. */
	helpUrl?: string;
}

/** This adapter's own key material, keyed by ProviderKeyField.id. An empty string counts
 * as absent (a cleared-but-not-removed field) — see registry.ts `isProviderUsable`. */
export type ProviderKeyValues = Readonly<Record<string, string>>;

/** Key material for every adapter, keyed by ProviderId, as the registry needs it to
 * answer "which adapters are usable right now." This is also the exact shape the BYOK
 * store (`src/lib/keys/`, issue #3) persists to localStorage and hands back — one model
 * for "a provider's key material" shared by both modules, not a second one translated at
 * the seam (issue #49). Deliberately a plain nested record rather than a class or a lookup
 * callback, so this file takes no dependency on the store's internals beyond its exported
 * types (AGENTS.md: "define the narrowest possible interface"). */
export type AvailableKeys = Readonly<Record<ProviderId, ProviderKeyValues>>;

/**
 * Passed as the last argument to every adapter method. One shape for all four provider
 * kinds so a caller fanning out across many adapters builds it once per adapter and reuses
 * it, rather than assembling a bespoke argument list per kind.
 */
export interface ProviderContext {
	/** Every call takes one. Searches fan out wide and get cancelled often (the user
	 * changes a date, navigates away, fires a wider search before the first finishes), so
	 * an adapter mid-fetch has to be able to stop, not just have its result discarded. */
	signal: AbortSignal;
	/** This adapter's own keys, already sliced from AvailableKeys — see registry.ts
	 * `keysFor`. Absent (not `{}`) when the store has nothing for this adapter at all. */
	keys?: ProviderKeyValues;
	/** Soft cap on how many of THIS adapter's own network requests this one call may
	 * spend. Exists because a "convenient" method that quietly turns a date range into one
	 * request per day is exactly how the Skyscanner RapidAPI free tier (20 requests per
	 * MONTH, hard limit, no burst) gets burned in a single afternoon. An adapter that
	 * would exceed this must stop and return whatever it already has as an ok result, not
	 * an error — running out of budget mid-search is a partial result, not a failure.
	 * Omitted means "no caller-imposed cap beyond the adapter's own defaults." */
	maxRequests?: number;
}

/**
 * Where one piece of data came from and when, carried on every ProviderResult so the UI
 * can show provenance ("via Skyscanner, 2 minutes ago") and the cross-provider price check
 * (issue #17) can compare two results for the same flight by their source instead of by
 * guesswork.
 */
export interface ProviderSource {
	providerId: ProviderId;
	/** ISO instant the adapter finished fetching this, not when a caller later reads it
	 * out of a cache — issue #4 ("stale first, then fresh") needs the original fetch time
	 * to judge staleness even after the value has sat in a cache for a while. */
	fetchedAt: string;
}

/**
 * The error cases that actually happen when talking to a third-party API from the
 * browser with a user-supplied key, per adapter (docs/prompts/003-conventions.md recorded
 * five hosts all answering with these exact shapes). Modelled as a discriminated union on
 * `code`, one variant per case, because each needs different UI treatment: "add your key"
 * is not "we're rate-limited, try later" is not "this account can't use this API at all."
 * A single flat `{ code: string }` would let those get confused at the call site; this
 * union makes the compiler check that every case is handled.
 */
export type ProviderError =
	/** No key configured at all. Distinct from `not-subscribed`: this one is fixed by
	 * pasting a key into settings, that one is not fixed by any key the user could paste. */
	| { code: 'missing-key'; message: string }
	/** RapidAPI's actual 403 body: `{"message":"You are not subscribed to this API."}`
	 * (docs/prompts/003-conventions.md). A BASIC plan is per-API, not per-account, so this
	 * is a permanent failure for the session (issue #22), not something to retry. */
	| { code: 'not-subscribed'; message: string; status: 403 }
	/** HTTP 429. `retryAfterSeconds`, when the provider sends a Retry-After header, is
	 * what issue #22's exponential backoff needs to wait the right amount rather than
	 * guessing. */
	| { code: 'quota-exceeded'; message: string; status: 429; retryAfterSeconds?: number }
	/** Fetch itself failed: offline, DNS, a CORS rejection, a timeout. No HTTP status,
	 * because none was ever received. */
	| { code: 'network-error'; message: string; cause?: unknown }
	/** A response came back with a 2xx (or an unrecognised non-2xx) but didn't parse into
	 * what this adapter expects — a provider changed its schema, or returned an HTML error
	 * page with a 200 status. Kept distinct from `network-error` because the fix is
	 * different: this is an adapter bug or an upstream contract change, not a connectivity
	 * problem, and retrying it will not help. */
	| { code: 'malformed-response'; message: string; cause?: unknown }
	/** The ProviderContext.signal fired before or during the call. Adapters must catch
	 * their own AbortError and resolve with this rather than letting the promise reject,
	 * so a caller fanning out with Promise.all never has one cancelled leg take the whole
	 * search down with it. */
	| { code: 'cancelled'; message: string }
	/** Anything else. Kept as an explicit last case rather than letting adapters throw for
	 * the unmodelled remainder, so "one provider failing must never fail a search" holds
	 * even for a failure mode nobody has seen yet. */
	| { code: 'unknown'; message: string; cause?: unknown };

/**
 * What every adapter call resolves to: never a bare value, always this envelope, so the
 * source and the request cost travel with the data whether or not the call succeeded (a
 * 429 can still have spent a request). A discriminated union on `ok` rather than a
 * `data | undefined` plus an `error | undefined` pair, so the compiler — not a runtime
 * check the adapter author has to remember — forces narrowing before `data` is read.
 *
 * This is also the whole reason one provider failing can never fail a search: adapters
 * resolve this, they do not reject their promise except in ways described on
 * ProviderContext.signal above, so `Promise.all` across many adapters is safe to use as-is.
 */
export type ProviderResult<T> =
	| { ok: true; data: T; source: ProviderSource; requestsUsed: number }
	| { ok: false; error: ProviderError; source: ProviderSource; requestsUsed: number };

/** healthCheck's result. Reuses ProviderResult rather than a bespoke boolean so a health
 * check that itself costs a metered request (see the warning on ProviderBase.healthCheck)
 * reports that cost the same way every other call does. */
export type ProviderHealth = ProviderResult<{ message?: string }>;

/** Fields shared by all four provider kinds. Adapters implement one of the kind-specific
 * interfaces below, each of which extends this. */
export interface ProviderBase {
	readonly kind: ProviderKind;
	readonly id: ProviderId;
	/** Shown in the UI, e.g. "Skyscanner (RapidAPI)". */
	readonly label: string;
	/** Whether this adapter needs any key material at all. False for the keyless baseline
	 * (Ryanair, OSRM, Transitous, OurAirports — docs/prompts/002 "derived decisions": these
	 * exist so the app is useful before any key is entered). */
	readonly needsKey: boolean;
	/** Empty when needsKey is false. When needsKey is true, at least one field, and the
	 * registry's usability check requires all of them to have a non-empty value. */
	readonly keyFields: readonly ProviderKeyField[];
	/**
	 * Checks that this adapter is actually callable right now: key present AND accepted
	 * by the provider (a key can be present but wrong, or present but unsubscribed).
	 *
	 * NOT assumed cheap. For a metered adapter this may itself spend real quota (there is
	 * often no free "ping" endpoint), so callers must run this once — e.g. right after a
	 * key is saved in settings — and cache the ProviderHealth, never before every search.
	 * `isProviderUsable` in registry.ts is the cheap, no-network check ("is a key present
	 * at all") that IS safe to call before every search; this is the expensive one.
	 */
	healthCheck(ctx: ProviderContext): Promise<ProviderHealth>;
}

/** Issue #2: "search offers between two airports over a date range; list direct
 * destinations from an airport." One-way only — a round trip is two of these, since the
 * itinerary this app builds (domain/itinerary.ts) is never a simple round trip. */
export interface FlightSearchQuery {
	origin: IataAirportCode;
	destination: IataAirportCode;
	/** Inclusive range of departure dates to search across. */
	earliestDeparture: IsoCalendarDate;
	latestDeparture: IsoCalendarDate;
	/** Default is domain's DEFAULT_TRAVELLERS (search-query.ts) if omitted. */
	travellers?: number;
	/** Adapter falls back to its own default (usually the provider's local currency)
	 * when omitted. */
	currency?: IsoCurrencyCode;
}

export interface FlightProvider extends ProviderBase {
	readonly kind: 'flight';
	/**
	 * How many of this adapter's own network requests a call to `searchOffers` with this
	 * exact query would cost — WITHOUT making any request. Pure and synchronous on
	 * purpose, so a caller on a metered plan (Skyscanner: 20/month) can check its
	 * remaining budget and decide NOT to call `searchOffers` at all, rather than finding
	 * out the cost by spending it. An adapter with a native date-range endpoint returns a
	 * constant 1; one that only takes a single date and must be called once per day in
	 * the range returns that day count.
	 */
	estimateSearchOffersCost(query: FlightSearchQuery): number;
	/**
	 * Searches the whole date range in one logical call, which may itself take more than
	 * one of this adapter's own requests — `estimateSearchOffersCost` said how many up
	 * front, `requestsUsed` on the resolved result says how many it actually spent.
	 * Stops early at `ctx.maxRequests` rather than exceeding it, returning whatever
	 * offers were already found as an ok result.
	 */
	searchOffers(
		query: FlightSearchQuery,
		ctx: ProviderContext
	): Promise<ProviderResult<FlightOffer[]>>;
	/** IATA codes of every airport this adapter has a direct flight to from `origin` — the
	 * connection-graph input issue #12 needs ("which airports can actually sit in the
	 * middle"), not priced offers. */
	listDirectDestinations(
		origin: IataAirportCode,
		ctx: ProviderContext
	): Promise<ProviderResult<IataAirportCode[]>>;
}

/** Issue #2: "cheapest beds near a coordinate for a date range, dorm and private priced
 * separately." The "priced separately" part is already how domain/stay.ts models a Stay
 * (one room kind per record, brief line 65), so this query just asks for both kinds and
 * lets the caller compare; the provider does not pre-select a "cheapest" one. */
export interface StaySearchQuery {
	near: Coordinates;
	radiusKm: number;
	checkIn: IsoCalendarDate;
	checkOut: IsoCalendarDate;
	/** Both kinds if omitted. */
	roomKinds?: RoomKind[];
	travellers?: number;
	currency?: IsoCurrencyCode;
}

export interface StayProvider extends ProviderBase {
	readonly kind: 'stay';
	/** Same reasoning as FlightProvider.estimateSearchOffersCost: a check-in/check-out
	 * range risks the same silent per-night fan-out on a metered plan (Agoda and Booking
	 * are both reached through RapidAPI — docs/prompts/002). */
	estimateSearchStaysCost(query: StaySearchQuery): number;
	/** One Stay per priced room-kind option at a property (an adapter's response likely
	 * has one property with both a dorm and a private price — that is two Stay records
	 * out of this call, not one). */
	searchStays(query: StaySearchQuery, ctx: ProviderContext): Promise<ProviderResult<Stay[]>>;
}

/** Issue #2: "how to get from A to B, with times." */
export interface TransferSearchQuery {
	from: Coordinates;
	to: Coordinates;
	/** When this transfer should depart, if known. Needed for a transit adapter to look
	 * up a real timetable (Transitous, issue #8: "the last bus problem"); irrelevant for
	 * a mode like walking where the duration doesn't depend on time of day. */
	departure?: LocalDateTime;
	/** Restrict to a subset, e.g. only 'transit', when the caller already has a driving
	 * estimate from elsewhere and only wants public transport. All modes this adapter
	 * supports if omitted. */
	modes?: TransferMode[];
}

export interface TransferProvider extends ProviderBase {
	readonly kind: 'transfer';
	/** One call may return more than one Transfer — e.g. both 'walk' and 'transit' for
	 * the same A-to-B, since domain/transfer.ts models each mode as its own record and the
	 * caller (or the traveller) picks between them. */
	searchTransfers(
		query: TransferSearchQuery,
		ctx: ProviderContext
	): Promise<ProviderResult<Transfer[]>>;
}

/** Issue #2: "metadata and geography." Backs issue #11's airport dataset and the airport
 * pickers in issue #16/#28. */
export interface AirportDataProvider extends ProviderBase {
	readonly kind: 'airport-data';
	/** `undefined` data (not an error) when this adapter has no record for the code — a
	 * small airport missing from one dataset but present in another is normal, not a
	 * failure of this call. */
	getAirport(
		iataCode: IataAirportCode,
		ctx: ProviderContext
	): Promise<ProviderResult<Airport | undefined>>;
	/** Airports within `radiusKm` of a point — the proximity queries issue #12's
	 * connection graph and issue #13's hotel-near-connection matching both need. */
	findAirportsNear(
		coordinates: Coordinates,
		radiusKm: number,
		ctx: ProviderContext
	): Promise<ProviderResult<Airport[]>>;
	/** Free-text lookup by name, IATA or ICAO code — what an airport picker autocomplete
	 * (issue #16/#28) types into. */
	searchAirports(query: string, ctx: ProviderContext): Promise<ProviderResult<Airport[]>>;
}

/**
 * Maps each provider kind to its interface, in one place, so a kind literal ('flight',
 * 'stay', ...) always resolves to the right adapter type wherever it is used — the
 * registry's generic methods below index this map instead of repeating one method per
 * kind or relying on `as` casts to narrow a union.
 */
export interface ProviderKindMap {
	flight: FlightProvider;
	stay: StayProvider;
	transfer: TransferProvider;
	'airport-data': AirportDataProvider;
}

export type ProviderKind = keyof ProviderKindMap;

/** Every adapter the registry can hold, regardless of kind. */
export type AnyProvider = ProviderKindMap[ProviderKind];
