/**
 * BYOK key store types.
 *
 * The canonical set of provider ids belongs to the provider registry
 * (issue #2 — `src/lib/providers/`), which does not exist yet. This module
 * treats a provider id as a plain string on purpose, rather than inventing
 * a competing enum of "the providers": doing that here would go stale the
 * moment the registry lands with its own ids. A caller that already knows
 * the canonical list (the settings UI in issue #29, once #2 lands) can pass
 * it into `parseImportedKeysFile` to get real "unknown provider" warnings.
 */
export type ProviderId = string;

/** One API key string per provider id, exactly as the user pasted it. */
export type ProviderKeys = Record<ProviderId, string>;

/**
 * Current export/import file format version. Bump this and add a branch in
 * `parseImportedKeysFile` that upgrades the old shape when the envelope
 * changes — never rewrite this constant's meaning in place, or an old
 * export silently gets reinterpreted as a new one.
 */
export const KEY_FILE_VERSION = 1 as const;

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
