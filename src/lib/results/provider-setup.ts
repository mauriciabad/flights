/**
 * Assembles the one `ProviderRegistry` a real search actually needs. `providers/registry.ts`
 * confirms nobody has done this yet ("`new ProviderRegistry` ... only appears in
 * `registry.test.ts`", `settings/provider-catalog.ts`'s own header, issue #29), and
 * `search/types.ts`'s `SearchDependencies` needs exactly this shape. Composition only: every
 * adapter here is a finished, tested module from its own issue (#5, #6, #8, #9, #10, #60,
 * #61) exporting a ready singleton or a zero-argument factory, so this file registers them
 * and nothing else, no adapter logic lives here.
 *
 * Kiwi is registered even though its backend is currently down (docs/PROVIDERS.md) and its
 * settings-page key field doesn't exist yet (issue #29's own catalog omits it): a key
 * nobody can enter yet just means `registry.usable('flight', keys)` never selects it, which
 * is indistinguishable from any other unconfigured provider, and this file does not have to
 * change again once that gap closes elsewhere.
 *
 * A module-level singleton (not rebuilt per search) because every adapter's own internal
 * state (Skyscanner's per-key "not subscribed" memo, each one's cache-store handle) is
 * meant to persist for the app's lifetime, the same reasoning `keyStore` (`$lib/keys`) uses
 * for its own singleton.
 */

import { ryanairFlightProvider } from '$lib/providers/flights/ryanair';
import { createSkyscannerFlightProvider } from '$lib/providers/flights/skyscanner';
import { flightsSkyFlightProvider } from '$lib/providers/flights/flights-sky';
import { kiwiFlightProvider } from '$lib/providers/flights/kiwi';
import { agodaStayProvider } from '$lib/providers/stays/agoda';
import { bookingStayProvider } from '$lib/providers/stays/booking';
import { osrmTransferProvider } from '$lib/providers/transfers/osrm';
import { transitousTransferProvider } from '$lib/providers/transfers/transitous';
import { ProviderRegistry } from '$lib/providers/registry';

let registry: ProviderRegistry | undefined;

/** Every adapter this app has, registered once. Safe to call during SvelteKit's
 * prerender: every adapter here only touches the network or a browser-only store (cache,
 * IndexedDB) from inside its async methods, never at construction time, same convention
 * `keyStore`'s own "hydrated" flag exists to work around for `localStorage`. */
export function getProviderRegistry(): ProviderRegistry {
	registry ??= new ProviderRegistry([
		ryanairFlightProvider,
		createSkyscannerFlightProvider(),
		flightsSkyFlightProvider,
		kiwiFlightProvider,
		agodaStayProvider,
		bookingStayProvider,
		osrmTransferProvider,
		transitousTransferProvider
	]);
	return registry;
}
