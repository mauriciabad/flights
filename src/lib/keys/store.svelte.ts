import { buildExportEnvelope, mergeProviderKeys, parseImportedKeysFile } from './codec';
import { clearKeysFromStorage, loadKeysFromStorage, saveKeysToStorage } from './storage';
import { redactKey } from './redact';
import type { ImportOutcome, KeyFileEnvelope, ProviderId, ProviderKeys, ProviderKeyValues } from './types';

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

	/** Every provider id that currently has at least one field value, for listing in a UI. */
	get providerIds(): ProviderId[] {
		return this.#providerIds;
	}

	/** The whole store's contents, exactly as `ProviderRegistry.usable`/`usableAll` and
	 * `contextFor` (providers/registry.ts) expect their `AvailableKeys` argument — this is
	 * the seam issue #49 closed: wiring a real search pipeline to this store is
	 * `registry.usable('flight', keyStore.availableKeys)`, no conversion function needed. */
	get availableKeys(): ProviderKeys {
		return this.#keys;
	}

	/** True once this provider has at least one field with a non-empty value. This is the
	 * cheap "has the user entered anything at all" check for a settings-page badge — it
	 * does not know which fields a provider actually requires. `isProviderUsable`
	 * (providers/registry.ts) is the check that also knows that, from the provider's own
	 * declared `keyFields`. */
	hasKey(providerId: ProviderId): boolean {
		const values = this.#keys[providerId];
		if (!values) return false;
		return Object.values(values).some((value) => value.length > 0);
	}

	/** This provider's own field values, or `undefined` when nothing is stored for it —
	 * the same lookup `keysFor` (providers/registry.ts) does against `AvailableKeys`. */
	getValues(providerId: ProviderId): ProviderKeyValues | undefined {
		return this.#keys[providerId];
	}

	/**
	 * One field's raw value. Callers may only use this to attach it to a request meant
	 * for the provider that owns it (a header, a query param the provider itself defines)
	 * — never log it, persist it elsewhere, or put it somewhere that ends up in browser
	 * history.
	 */
	getFieldValue(providerId: ProviderId, fieldId: string): string | undefined {
		return this.#keys[providerId]?.[fieldId];
	}

	/** Redacted to the last 4 characters. Safe to render or, if it ever comes to it, to log. */
	getRedactedFieldValue(providerId: ProviderId, fieldId: string): string | undefined {
		const value = this.getFieldValue(providerId, fieldId);
		return value === undefined ? undefined : redactKey(value);
	}

	/** Sets one field's value. A blank value clears the field instead of storing an empty
	 * string — a settings form row that's just emptied out must not read back as
	 * "configured with nothing." */
	setFieldValue(providerId: ProviderId, fieldId: string, value: string): void {
		const trimmed = value.trim();
		if (trimmed.length === 0) {
			this.clearField(providerId, fieldId);
			return;
		}
		const existing = this.#keys[providerId] ?? {};
		this.#keys = { ...this.#keys, [providerId]: { ...existing, [fieldId]: trimmed } };
		this.#persist();
	}

	/** Clears one field. Removes the provider entirely once it has no fields left, rather
	 * than leaving an empty `{}` behind, so `hasKey`/`providerIds` read it as gone. */
	clearField(providerId: ProviderId, fieldId: string): void {
		const existing = this.#keys[providerId];
		if (!existing || !Object.hasOwn(existing, fieldId)) return;
		const nextFields = { ...existing };
		delete nextFields[fieldId];
		const next = { ...this.#keys };
		if (Object.keys(nextFields).length === 0) {
			delete next[providerId];
		} else {
			next[providerId] = nextFields;
		}
		this.#keys = next;
		this.#persist();
	}

	/** Clears every field for one provider. */
	clearProvider(providerId: ProviderId): void {
		if (!Object.hasOwn(this.#keys, providerId)) return;
		const next = { ...this.#keys };
		delete next[providerId];
		this.#keys = next;
		this.#persist();
	}

	/** Clears every key for every provider. Used by the settings UI's "remove all keys" action. */
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
	 * provider ids (and, within a provider, the field ids) the file names — every field
	 * already in the store that the file doesn't mention is left untouched, and an
	 * unknown provider id warns rather than getting silently dropped along with the rest
	 * of the file's keys.
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
