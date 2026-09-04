/**
 * BYOK key store types.
 *
 * A provider's key material is the provider registry's `AvailableKeys` shape
 * (`src/lib/providers/types.ts`, issue #2): a field id to string map, not a single string,
 * because a provider can need more than one piece of credential material — Amadeus wants a
 * key and a secret, Google Maps wants a key plus optional referrer restrictions. This
 * module re-exports those types under names that read naturally for "the whole store's
 * data" and "one provider's data," rather than defining a second, incompatible shape the
 * way it used to (issue #49 reconciled the two).
 */
import type { AvailableKeys, ProviderId, ProviderKeyValues } from '../providers/types';

export type { ProviderId, ProviderKeyValues };

/** Every provider's key material, keyed by provider id. An alias for `AvailableKeys`
 * (providers/types.ts): same shape, named for how this module talks about it. */
export type ProviderKeys = AvailableKeys;

/**
 * Current export/import file format version. Bumped from 1 to 2 when this module's `keys`
 * entries changed from a single string per provider to a `ProviderKeyValues` field map
 * (issue #49), so an old export is rejected rather than silently reinterpreted with the
 * new meaning. No version-1 file was ever produced by a shipped settings UI (issue #29
 * isn't built yet), so there was nothing in the wild to write an upgrade branch for. A
 * future bump that changes the envelope again should add one here instead of following
 * this precedent — never rewrite this constant's meaning in place.
 */
export const KEY_FILE_VERSION = 2 as const;

/** The JSON shape written by export and read back by import. */
export interface KeyFileEnvelope {
	version: typeof KEY_FILE_VERSION;
	/** Informational only — nothing reads this back to make a decision. */
	exportedAt: string;
	keys: ProviderKeys;
}

export interface ImportWarning {
	providerId: string;
	message: string;
}

/** What changed as a result of merging an imported file into the store. */
export interface ImportOutcome {
	added: ProviderId[];
	updated: ProviderId[];
	unchanged: ProviderId[];
	warnings: ImportWarning[];
	/** Set when the file itself could not be read at all; nothing was merged. */
	error?: string;
}
