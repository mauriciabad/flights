import { KEY_FILE_VERSION } from './types';
import type { ImportWarning, KeyFileEnvelope, ProviderId, ProviderKeys } from './types';

/** Pure — builds the export file's contents. The actual browser download is in `download.ts`. */
export function buildExportEnvelope(keys: ProviderKeys): KeyFileEnvelope {
	return {
		version: KEY_FILE_VERSION,
		exportedAt: new Date().toISOString(),
		keys: { ...keys }
	};
}

export type ParseImportResult =
	| { ok: true; keys: ProviderKeys; warnings: ImportWarning[] }
	| { ok: false; error: string };

/**
 * Validates and reads an imported file's parsed JSON. Pure and synchronous —
 * the caller owns reading the `File` and calling `JSON.parse`, so this stays
 * testable without touching the DOM.
 *
 * `knownProviderIds`, when given, flags ids the caller doesn't recognise.
 * They are still imported rather than dropped: a file from a newer app
 * version, or a shared file naming a provider this device hasn't set up
 * yet, should not lose data on the way in.
 */
export function parseImportedKeysFile(
	raw: unknown,
	knownProviderIds?: readonly ProviderId[]
): ParseImportResult {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return { ok: false, error: 'Not a valid key file: expected a JSON object.' };
	}
	const envelope = raw as Record<string, unknown>;

	// Version 1 is the only shape that has ever existed. A future bump adds a
	// branch here that upgrades the old shape, instead of rejecting it.
	if (envelope.version !== KEY_FILE_VERSION) {
		return {
			ok: false,
			error: `Unsupported key file version "${String(envelope.version)}". Expected ${KEY_FILE_VERSION}.`
		};
	}
	if (typeof envelope.keys !== 'object' || envelope.keys === null || Array.isArray(envelope.keys)) {
		return { ok: false, error: 'Not a valid key file: "keys" must be an object.' };
	}

	const warnings: ImportWarning[] = [];
	const keys: ProviderKeys = {};
	for (const [providerId, value] of Object.entries(envelope.keys as Record<string, unknown>)) {
		if (typeof value !== 'string' || value.trim().length === 0) {
			// Never include the offending value in the warning — it may well be a
			// half-formed key.
			warnings.push({ providerId, message: 'Skipped: the key value must be a non-empty string.' });
			continue;
		}
		if (knownProviderIds && !knownProviderIds.includes(providerId)) {
			warnings.push({
				providerId,
				message: 'Unknown provider id. Imported anyway in case a newer app version recognises it.'
			});
		}
		keys[providerId] = value.trim();
	}
	return { ok: true, keys, warnings };
}

/**
 * Merges imported keys into the existing set. Anything the file doesn't
 * mention is left exactly as it was — import can only add to or overwrite
 * the entries it names, never wipe the rest.
 */
export function mergeProviderKeys(
	existing: ProviderKeys,
	incoming: ProviderKeys
): { merged: ProviderKeys; added: ProviderId[]; updated: ProviderId[]; unchanged: ProviderId[] } {
	const merged: ProviderKeys = { ...existing };
	const added: ProviderId[] = [];
	const updated: ProviderId[] = [];
	const unchanged: ProviderId[] = [];
	for (const [providerId, value] of Object.entries(incoming)) {
		if (!(providerId in existing)) {
			added.push(providerId);
		} else if (existing[providerId] !== value) {
			updated.push(providerId);
		} else {
			unchanged.push(providerId);
		}
		merged[providerId] = value;
	}
	return { merged, added, updated, unchanged };
}
