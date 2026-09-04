import { KEY_FILE_VERSION } from './types';
import type { ImportWarning, KeyFileEnvelope, ProviderId, ProviderKeys, ProviderKeyValues } from './types';

/** Pure — builds the export file's contents. The actual browser download is in `download.ts`. */
export function buildExportEnvelope(keys: ProviderKeys): KeyFileEnvelope {
	return {
		version: KEY_FILE_VERSION,
		exportedAt: new Date().toISOString(),
		// Copy each provider's field map too, not just the top-level object — the result
		// must not alias anything the live store could later mutate in place.
		keys: Object.fromEntries(Object.entries(keys).map(([id, values]) => [id, { ...values }]))
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

	// Version 2 is the only shape that has ever existed. A future bump adds a
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
	// Built up mutably here, then returned as the caller-facing `Readonly<...>` shape —
	// `ProviderKeys`'s index signature is read-only precisely so a caller can't do this.
	const keys: Record<ProviderId, ProviderKeyValues> = {};
	for (const [providerId, rawValue] of Object.entries(envelope.keys as Record<string, unknown>)) {
		if (typeof rawValue !== 'object' || rawValue === null || Array.isArray(rawValue)) {
			// Never include the offending value in the warning — it may well contain a
			// half-formed key.
			warnings.push({
				providerId,
				message: 'Skipped: the key value must be an object mapping field id to string.'
			});
			continue;
		}
		const fields: Record<string, string> = {};
		for (const [fieldId, fieldValue] of Object.entries(rawValue as Record<string, unknown>)) {
			if (typeof fieldValue === 'string' && fieldValue.trim().length > 0) {
				fields[fieldId] = fieldValue.trim();
			}
		}
		if (Object.keys(fields).length === 0) {
			warnings.push({ providerId, message: 'Skipped: no non-empty field values.' });
			continue;
		}
		if (knownProviderIds && !knownProviderIds.includes(providerId)) {
			warnings.push({
				providerId,
				message: 'Unknown provider id. Imported anyway in case a newer app version recognises it.'
			});
		}
		keys[providerId] = fields;
	}
	return { ok: true, keys, warnings };
}

/** True when two field maps hold the exact same field ids and values. */
function fieldsEqual(a: ProviderKeyValues, b: ProviderKeyValues): boolean {
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;
	return aKeys.every((key) => a[key] === b[key]);
}

/**
 * Merges imported keys into the existing set, per field rather than replacing a whole
 * provider wholesale: an imported provider entry only adds or overwrites the field ids it
 * names, so a field the file doesn't mention (or an entire provider it doesn't mention)
 * survives untouched — same "the file can only add to what's here, never wipe it" rule
 * this always followed, now applied one level deeper.
 */
export function mergeProviderKeys(
	existing: ProviderKeys,
	incoming: ProviderKeys
): { merged: ProviderKeys; added: ProviderId[]; updated: ProviderId[]; unchanged: ProviderId[] } {
	// Same reasoning as parseImportedKeysFile above: mutable while building, read-only once
	// handed back.
	const merged: Record<ProviderId, ProviderKeyValues> = { ...existing };
	const added: ProviderId[] = [];
	const updated: ProviderId[] = [];
	const unchanged: ProviderId[] = [];
	for (const [providerId, incomingFields] of Object.entries(incoming)) {
		const existingFields = existing[providerId];
		if (!existingFields) {
			added.push(providerId);
			merged[providerId] = { ...incomingFields };
			continue;
		}
		const mergedFields = { ...existingFields, ...incomingFields };
		merged[providerId] = mergedFields;
		if (fieldsEqual(existingFields, mergedFields)) {
			unchanged.push(providerId);
		} else {
			updated.push(providerId);
		}
	}
	return { merged, added, updated, unchanged };
}
