import type { ProviderKeys, ProviderKeyValues } from './types';

/** Namespaced so this doesn't collide with some other feature's storage key. */
const STORAGE_KEY = 'flights.byokKeys.v1';

/**
 * `localStorage` throws in Safari private mode, in some embedded webviews,
 * and whenever the origin's storage quota is exceeded. Every access in this
 * file goes through a try/catch, and callers get "keys are absent" rather
 * than an exception — the app must still work with no keys at all.
 */
function readRaw(): string | null {
	try {
		if (typeof localStorage === 'undefined') return null;
		return localStorage.getItem(STORAGE_KEY);
	} catch {
		return null;
	}
}

function writeRaw(raw: string): boolean {
	try {
		if (typeof localStorage === 'undefined') return false;
		localStorage.setItem(STORAGE_KEY, raw);
		return true;
	} catch {
		return false;
	}
}

function removeRaw(): void {
	try {
		if (typeof localStorage === 'undefined') return;
		localStorage.removeItem(STORAGE_KEY);
	} catch {
		// Nothing to roll back to and nothing the caller can do about it either.
	}
}

/** Reads every stored key. Never throws — corrupt or missing data reads as "no keys yet".
 * A provider entry that isn't itself an object (the pre-issue-#49 shape stored a bare
 * string) is dropped the same as any other corrupt entry, rather than half-read — this is
 * the same "unreadable reads as absent" rule the try/catch below already applies. */
export function loadKeysFromStorage(): ProviderKeys {
	const raw = readRaw();
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
		return writeRaw(JSON.stringify(keys));
	} catch {
		return false;
	}
}

export function clearKeysFromStorage(): void {
	removeRaw();
}
