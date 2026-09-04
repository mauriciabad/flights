/**
 * Assembles the one `ProviderRegistry` a real search actually needs. `providers/registry.ts`
 * confirms nobody has done this yet ("`new ProviderRegistry` ... only appears in
 * `registry.test.ts`", `settings/provider-catalog.ts`'s own header, issue #29), and
 * `search/types.ts`'s `SearchDependencies` needs exactly this shape. Composition only: every
 * adapter here is a finished, tested module from its own issue (#5, #6, #8, #9, #10, #60,
 * #61) exporting a ready singleton or a zero-argument factory, so this file registers them
 * and nothing else, no adapter logic lives here.
 *
 * Two unrelated things share the Kiwi name below, so read the ids rather than the brand.
 * `kiwi` is a third party's RapidAPI listing reselling Kiwi data, whose backend is offline;
 * it is not registered, for the reasons that follow. `kiwi-public` is Kiwi's own keyless
 * GraphQL endpoint, which works, needs no key at all, and IS registered — none of the
 * reasoning below applies to it.
 *
 * Kiwi (issue #51) is deliberately NOT registered here, even though the adapter module
 * itself exists, is tested, and stays importable for whenever this changes. It used to be:
 * the reasoning was "a key nobody can enter yet just means `registry.usable` never selects
 * it, indistinguishable from any other unconfigured provider" — true for every code path
 * that skips non-usable providers, but issue #128 found one that does not. The results
 * page's "widen this search" panel exists specifically to offer an UNCONFIGURED-but-
 * configurable provider with an "Add a key to use this" link (`estimatePriceCalendarWidenCost`,
 * `$lib/search/price-calendar.ts`), and it iterates every REGISTERED provider of the right
 * kind to build that list — it has no way to tell "not configured yet" apart from "cannot
 * ever be configured," so a registered-but-uncatalogued adapter reads as the former and
 * gets offered with a link to a settings row that does not exist. `settings/
 * provider-catalog.ts`'s own `SETTINGS_PROVIDER_IDS` is this app's one list of providers a
 * traveller can actually configure; being missing from it is not an oversight to route
 * around; it should mean "do not offer this at all."
 *
 * And Kiwi specifically should never be offered regardless: docs/PROVIDERS.md records a
 * real subscribed key hitting `HTTP 402 {"error":{"message":"Payment required"}}` on both
 * of its endpoints, alongside `x-vercel-error: DEPLOYMENT_DISABLED` and a genuine
 * `x-rapidapi-request-id` — RapidAPI's gateway really did forward the request, to a
 * third-party backend its own owner has taken offline. No key any user could paste in
 * fixes that. Adding a settings card would let someone spend real effort finding and
 * subscribing to a listing that can never answer, which is worse than the dead link this
 * fixes: a subscription with no working feature behind it, discovered only after paying
 * the "$0/month plan" the same attention a working one gets. Un-registering, rather than
 * only filtering it out of the widen panel, keeps this the one place a future feature has
 * to get right instead of a rule every new call site must separately remember. `caps.ts`'s
 * tuned entry for `kiwi` is left in place; it costs nothing to keep and saves a re-measure
 * if the backend ever comes back and this decision is revisited.
 *
 * A module-level singleton (not rebuilt per search) because every adapter's own internal
 * state (Skyscanner's per-key "not subscribed" memo, each one's cache-store handle) is
 * meant to persist for the app's lifetime, the same reasoning `keyStore` (`$lib/keys`) uses
 * for its own singleton.
 */

import { ryanairFlightProvider } from '$lib/providers/flights/ryanair';
import { createSkyscannerFlightProvider } from '$lib/providers/flights/skyscanner';
import { flightsSkyFlightProvider } from '$lib/providers/flights/flights-sky';
import { kiwiPublicFlightProvider } from '$lib/providers/flights/kiwi-public';
import { agodaStayProvider } from '$lib/providers/stays/agoda';
import { bookingStayProvider } from '$lib/providers/stays/booking';
import { osrmTransferProvider } from '$lib/providers/transfers/osrm';
import { transitousTransferProvider } from '$lib/providers/transfers/transitous';
import { ProviderRegistry } from '$lib/providers/registry';
import type { ProviderKeys } from '$lib/keys';

let registry: ProviderRegistry | undefined;

/** Every adapter this app is willing to offer a traveller, registered once. Safe to call
 * during SvelteKit's prerender: every adapter here only touches the network or a
 * browser-only store (cache, IndexedDB) from inside its async methods, never at
 * construction time, same convention `keyStore`'s own "hydrated" flag exists to work
 * around for `localStorage`. See this module's own header for why the RapidAPI `kiwi`
 * adapter is not among these despite existing and being fully tested — and for why
 * `kiwi-public`, a different endpoint entirely, is. */
export function getProviderRegistry(): ProviderRegistry {
	registry ??= new ProviderRegistry([
		ryanairFlightProvider,
		// Registered next to Ryanair because it plays the same role — a keyless source that
		// works before any key is entered — but across every airline instead of one. It is
		// also the only registered adapter whose `listDirectDestinations` answers for an
		// arbitrary airport, which is what `algorithm/connections.ts` needs before it can
		// propose a single stopover (see that adapter's own header).
		kiwiPublicFlightProvider,
		createSkyscannerFlightProvider(),
		flightsSkyFlightProvider,
		agodaStayProvider,
		bookingStayProvider,
		osrmTransferProvider,
		transitousTransferProvider
	]);
	return registry;
}

/**
 * Whether a bed can be priced at all with the keys currently held.
 *
 * Both stay adapters are `needsKey: true`, so with nothing pasted in `search/resources.ts`
 * filters them out before a single request goes out and every stopover comes back with no
 * stay and, because the connection-side transfers are fetched only after a stay is priced,
 * no ground transport either.
 *
 * Issue #140: `StayKeyNotice` (the banner above the results list) and `ResultDetail` (the
 * expanded card, screens below it) were each answering that question their own way, and
 * the page ended up saying "No stay provider configured" at the top and "try again once
 * the search finishes" further down. One expression, two callers, so they cannot disagree
 * about the same fact again.
 */
export function hasUsableStayProvider(keys: ProviderKeys): boolean {
	return getProviderRegistry().usable('stay', keys).length > 0;
}
