/**
 * Holds every registered adapter and answers "which of these can I actually call right
 * now, given the keys I have." Issue #2: "The registry reports which adapters are usable
 * right now given which keys are present."
 *
 * This file has logic (types.ts does not, by design — see its header). Kept small on
 * purpose: registration, lookup, and the usability check. Deciding WHICH usable adapter to
 * actually call for a given search, in what order, and within what quota, is the search
 * pipeline's job (issue #22), not this file's.
 */

import type {
	AnyProvider,
	AvailableKeys,
	ProviderContext,
	ProviderId,
	ProviderKeyValues,
	ProviderKind,
	ProviderKindMap
} from './types';

/**
 * True when this adapter can be called right now: either it doesn't need a key at all, or
 * every key field it declares has a non-empty value in `keys`. This is the cheap,
 * no-network check — safe to run before every search, unlike ProviderBase.healthCheck
 * (types.ts), which can itself cost a metered request.
 *
 * A blank string counts as absent, not present: a settings form that clears a field to ""
 * rather than deleting it must not read back as "configured."
 */
export function isProviderUsable(
	provider: Pick<AnyProvider, 'id' | 'needsKey' | 'keyFields'>,
	keys: AvailableKeys
): boolean {
	if (!provider.needsKey) return true;
	const own = keys[provider.id];
	if (!own) return false;
	return provider.keyFields.every((field) => (own[field.id] ?? '').trim().length > 0);
}

/** Slices one adapter's own key values out of the full AvailableKeys map. Returns
 * `undefined` rather than `{}` when the store has nothing for this id yet, so
 * `ProviderContext.keys` reads as "not configured" rather than "configured with nothing" —
 * an adapter checking `ctx.keys?.apiKey` behaves the same either way, but a health check or
 * log line that reports presence gets the right answer. */
export function keysFor(
	providerId: ProviderId,
	keys: AvailableKeys
): ProviderKeyValues | undefined {
	return keys[providerId];
}

/** Builds the ProviderContext for one call: this adapter's own slice of `keys`, the
 * caller's signal, and an optional per-call request budget. A small helper rather than
 * asking every call site to remember `{ signal, keys: keysFor(id, keys), maxRequests }`. */
export function contextFor(
	providerId: ProviderId,
	keys: AvailableKeys,
	signal: AbortSignal,
	maxRequests?: number
): ProviderContext {
	return { signal, keys: keysFor(providerId, keys), maxRequests };
}

/**
 * Every registered adapter, of all four kinds, addressable by id or by kind. One class
 * rather than four parallel arrays so a caller only imports one thing, and so a settings
 * page listing every provider's status regardless of kind (`all()`, `usableAll()`) doesn't
 * need to know the four kinds exist.
 */
export class ProviderRegistry {
	#providers = new Map<ProviderId, AnyProvider>();

	constructor(initial: Iterable<AnyProvider> = []) {
		for (const provider of initial) this.register(provider);
	}

	/**
	 * Registers one adapter. Throws on a duplicate id — two adapters racing for the same
	 * id is a wiring mistake in app startup code, not a runtime condition to degrade from,
	 * so it fails loudly immediately rather than silently shadowing one adapter with
	 * another.
	 */
	register(provider: AnyProvider): void {
		if (this.#providers.has(provider.id)) {
			throw new Error(`provider "${provider.id}" is already registered`);
		}
		this.#providers.set(provider.id, provider);
	}

	byId(id: ProviderId): AnyProvider | undefined {
		return this.#providers.get(id);
	}

	/** Every registered adapter, of every kind. */
	all(): readonly AnyProvider[] {
		return Array.from(this.#providers.values());
	}

	/** Every registered adapter of one kind, correctly typed — e.g.
	 * `registry.ofKind('flight')` returns `readonly FlightProvider[]`, not `AnyProvider[]`. */
	ofKind<K extends ProviderKind>(kind: K): readonly ProviderKindMap[K][] {
		return this.all().filter((provider): provider is ProviderKindMap[K] => provider.kind === kind);
	}

	/** Adapters of one kind that are usable right now given `keys` — the registry's core
	 * answer to issue #2's "which adapters are usable right now given which keys are
	 * present," narrowed to the kind a caller actually needs (e.g. a flight search only
	 * cares about `usable('flight', keys)`, never the stay or transfer adapters). */
	usable<K extends ProviderKind>(kind: K, keys: AvailableKeys): readonly ProviderKindMap[K][] {
		return this.ofKind(kind).filter((provider) => isProviderUsable(provider, keys));
	}

	/** Every usable adapter regardless of kind, for a settings page that shows overall
	 * provider status in one list. */
	usableAll(keys: AvailableKeys): readonly AnyProvider[] {
		return this.all().filter((provider) => isProviderUsable(provider, keys));
	}
}
