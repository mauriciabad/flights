import { normalizeCurrencyCode } from './currency';
import type { IsoCurrencyCode } from '../domain';
import type { ProviderKeys, ProviderKeyValues } from './types';

/** Namespaced so this doesn't collide with some other feature's storage key. */
const STORAGE_KEY = 'flights.byokKeys.v1';

/**
 * The traveller's chosen search currency, in its own entry rather than inside the keys
 * blob above. Two reasons, both about failure: a `JSON.parse` throw on the keys entry
 * would otherwise take the currency down with it, and a browser that refuses one write
 * (Safari private mode, quota) still leaves the other readable. It is also a plain string,
 * so it can be read without parsing anything.
 */
const CURRENCY_STORAGE_KEY = 'flights.searchCurrency.v1';

/**
 * `localStorage` throws in Safari private mode, in some embedded webviews,
 * and whenever the origin's storage quota is exceeded. Every access in this
 * file goes through a try/catch, and callers get "keys are absent" rather
 * than an exception — the app must still work with no keys at all.
 */
function readRaw(storageKey: string): string | null {
	try {
		if (typeof localStorage === 'undefined') return null;
		return localStorage.getItem(storageKey);
	} catch {
		return null;
	}
}

function writeRaw(storageKey: string, raw: string): boolean {
	try {
		if (typeof localStorage === 'undefined') return false;
		localStorage.setItem(storageKey, raw);
		return true;
	} catch {
		return false;
	}
}

function removeRaw(storageKey: string): void {
	try {
		if (typeof localStorage === 'undefined') return;
		localStorage.removeItem(storageKey);
	} catch {
		// Nothing to roll back to and nothing the caller can do about it either.
	}
}

/** Reads every stored key. Never throws — corrupt or missing data reads as "no keys yet".
 * A provider entry that isn't itself an object (the pre-issue-#49 shape stored a bare
 * string) is dropped the same as any other corrupt entry, rather than half-read — this is
 * the same "unreadable reads as absent" rule the try/catch below already applies. */
export function loadKeysFromStorage(): ProviderKeys {
	const raw = readRaw(STORAGE_KEY);
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
		// Mutable while building, read-only once handed back as `ProviderKeys`.
		const keys: Record<string, ProviderKeyValues> = {};
		for (const [providerId, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
			const fields: Record<string, string> = {};
			for (const [fieldId, fieldValue] of Object.entries(value as Record<string, unknown>)) {
				// Do not log `fieldValue` here, even on this defensive path — it may be a
				// live provider key.
				if (typeof fieldValue === 'string') fields[fieldId] = fieldValue;
			}
			if (Object.keys(fields).length > 0) keys[providerId] = fields;
		}
		return keys;
	} catch {
		return {};
	}
}

/** Writes every key back. Returns whether the write actually landed. */
export function saveKeysToStorage(keys: ProviderKeys): boolean {
	try {
		return writeRaw(STORAGE_KEY, JSON.stringify(keys));
	} catch {
		return false;
	}
}

export function clearKeysFromStorage(): void {
	removeRaw(STORAGE_KEY);
}

/**
 * The saved search currency, or `undefined` when nothing usable is stored. A value that
 * is not a well-formed ISO 4217 code reads as absent rather than being handed on: the
 * caller then falls back to `DEFAULT_SEARCH_CURRENCY`, which the providers understand,
 * rather than putting whatever was in storage into a provider's query string.
 */
export function loadCurrencyFromStorage(): IsoCurrencyCode | undefined {
	return normalizeCurrencyCode(readRaw(CURRENCY_STORAGE_KEY));
}

/** Writes the chosen currency back. Returns whether the write actually landed. A code
 * this function cannot make sense of is refused rather than stored, so a bad value can
 * never become the saved one. */
export function saveCurrencyToStorage(currency: IsoCurrencyCode): boolean {
	const code = normalizeCurrencyCode(currency);
	if (code === undefined) return false;
	return writeRaw(CURRENCY_STORAGE_KEY, code);
}

export function clearCurrencyFromStorage(): void {
	removeRaw(CURRENCY_STORAGE_KEY);
}
