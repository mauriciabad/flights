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
import type { IsoCurrencyCode } from '../domain';
import type { AvailableKeys, ProviderKeyValues } from '../providers/types';

export type { ProviderKeyValues };

/** A provider id as the BYOK store sees it: any string, not the closed adapter-id union
 * `../providers/types` exports under the same name (issue #69). Kept deliberately wider:
 * `parseImportedKeysFile` below must round-trip an id this app version does not recognise
 * (a newer build's adapter, or one this device no longer has registered) rather than drop
 * it, so this module's own notion of "a provider id" stays open where the registry's is
 * closed. */
export type ProviderId = string;

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
	/**
	 * The traveller's chosen search currency, so it travels with a key set instead of
	 * being re-picked on every device. Optional, and deliberately NOT a version bump: the
	 * version above exists to stop an old shape being reinterpreted with a new meaning,
	 * and this adds a field rather than changing one. A file written before this existed
	 * imports unchanged and leaves the currency alone, and a file written now imports into
	 * an older build unchanged too, since `parseImportedKeysFile` there only ever read
	 * `version` and `keys`. Neither direction loses a key, which is what the version is
	 * for.
	 */
	currency?: IsoCurrencyCode;
}

export interface ImportWarning {
	/** What in the file the warning is about. A provider id for every warning the key
	 * entries produce, and the literal `'currency'` for the one thing in the envelope that
	 * is not a provider. Kept as one field rather than a tagged union because the settings
	 * UI renders these as a flat "name: message" list and has no branch to make. */
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
	/** The currency the file carried, once applied. Absent when the file named none, or
	 * named one this app could not read as a currency code (which warns instead). The
	 * settings UI reports it, because a key file silently changing what every future
	 * search is priced in would be a surprise worth avoiding. */
	currency?: IsoCurrencyCode;
}
