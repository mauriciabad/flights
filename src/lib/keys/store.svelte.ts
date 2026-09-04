import { buildExportEnvelope, mergeProviderKeys, parseImportedKeysFile } from './codec';
import { clearKeysFromStorage, loadKeysFromStorage, saveKeysToStorage } from './storage';
import { redactKey } from './redact';
import type { ImportOutcome, KeyFileEnvelope, ProviderId, ProviderKeys } from './types';

/**
 * Every BYOK provider key for the app's whole lifetime, not one component
 * tree — the settings page (issue #29), a header "keys configured" badge
 * and every provider adapter all need to read this independently, so it
 * cannot live as `$state` inside a single component. This is the Svelte 5
 * replacement for a classic `writable()` store: a plain class whose fields
 * are runes, exported as one module-level instance.
 *
 * The class itself (not just the singleton below) is exported so a test can
 * construct a second instance sharing the same `localStorage` to simulate a
 * page reload without actually reloading the page.
 */
export class KeyStore {
	#keys = $state<ProviderKeys>({});
	// True once the constructor has run. SvelteKit prerenders this module on
	// the server, where there is no localStorage and keys always read as
	// empty — a UI built on this store should gate on `hydrated` (or defer
	// to onMount) rather than trust an empty result as "no keys configured".
	#hydrated = $state(false);
	#providerIds = $derived(Object.keys(this.#keys));

	constructor() {
		this.#keys = loadKeysFromStorage();
		this.#hydrated = true;
	}

	get hydrated(): boolean {
		return this.#hydrated;
	}

	/** Every provider id that currently has a key, for listing in a UI. */
	get providerIds(): ProviderId[] {
		return this.#providerIds;
	}

	hasKey(providerId: ProviderId): boolean {
		return Object.hasOwn(this.#keys, providerId) && this.#keys[providerId].length > 0;
	}

	/**
	 * The raw key. Callers may only use this to attach it to a request meant
	 * for the provider that owns it (a header, a query param the provider
	 * itself defines) — never log it, persist it elsewhere, or put it
	 * somewhere that ends up in browser history.
	 */
	getKey(providerId: ProviderId): string | undefined {
		return this.#keys[providerId];
	}

	/** Redacted to the last 4 characters. Safe to render or, if it ever comes to it, to log. */
	getRedactedKey(providerId: ProviderId): string | undefined {
		const key = this.#keys[providerId];
		return key === undefined ? undefined : redactKey(key);
	}

	setKey(providerId: ProviderId, value: string): void {
		const trimmed = value.trim();
		if (trimmed.length === 0) {
			this.clearKey(providerId);
			return;
		}
		this.#keys = { ...this.#keys, [providerId]: trimmed };
		this.#persist();
	}

	clearKey(providerId: ProviderId): void {
		if (!Object.hasOwn(this.#keys, providerId)) return;
		const next = { ...this.#keys };
		delete next[providerId];
		this.#keys = next;
		this.#persist();
	}

	/** Clears every key. Used by the settings UI's "remove all keys" action. */
	clearAll(): void {
		this.#keys = {};
		clearKeysFromStorage();
	}

	/** Pure data for the export file. The download side-effect itself is in `download.ts`. */
	exportEnvelope(): KeyFileEnvelope {
		return buildExportEnvelope(this.#keys);
	}

	/**
	 * Merges an imported file's keys in. This can only add or overwrite the
	 * provider ids the file names — every key already in the store that the
	 * file doesn't mention is left untouched, and an unknown provider id
	 * warns rather than getting silently dropped along with the rest of the
	 * file's keys.
	 *
	 * `knownProviderIds` lets a caller that already has the provider
	 * registry (issue #2) flag ids it doesn't recognise; without it, every
	 * syntactically valid entry is accepted.
	 */
	importFromFile(raw: unknown, knownProviderIds?: readonly ProviderId[]): ImportOutcome {
		const parsed = parseImportedKeysFile(raw, knownProviderIds);
		if (!parsed.ok) {
			return { added: [], updated: [], unchanged: [], warnings: [], error: parsed.error };
		}
		const { merged, added, updated, unchanged } = mergeProviderKeys(this.#keys, parsed.keys);
		this.#keys = merged;
		this.#persist();
		return { added, updated, unchanged, warnings: parsed.warnings };
	}

	#persist(): void {
		saveKeysToStorage(this.#keys);
	}
}

export const keyStore = new KeyStore();
