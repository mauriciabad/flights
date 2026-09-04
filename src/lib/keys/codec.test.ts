import { describe, expect, it } from 'vitest';
import { buildExportEnvelope, mergeProviderKeys, parseImportedKeysFile } from './codec';
import { KEY_FILE_VERSION } from './types';

describe('buildExportEnvelope', () => {
	it('carries the current version and a copy of every provider field map', () => {
		const keys = { skyscanner: { apiKey: 'sk-live-1234' } };
		const envelope = buildExportEnvelope(keys);
		expect(envelope.version).toBe(KEY_FILE_VERSION);
		expect(envelope.keys).toEqual(keys);
		expect(envelope.keys).not.toBe(keys); // a copy, not the live object
		expect(envelope.keys.skyscanner).not.toBe(keys.skyscanner); // nested maps too
		expect(() => new Date(envelope.exportedAt).toISOString()).not.toThrow();
	});
});

describe('parseImportedKeysFile', () => {
	it('reads back exactly what buildExportEnvelope wrote', () => {
		const keys = { skyscanner: { apiKey: 'sk-live-1234' }, agoda: { apiKey: 'ag-9999' } };
		const envelope = buildExportEnvelope(keys);
		const result = parseImportedKeysFile(envelope);
		expect(result).toEqual({ ok: true, keys, warnings: [] });
	});

	it('reads back a provider with more than one field, e.g. a key and a secret', () => {
		const keys = { amadeus: { apiKey: 'am-key', apiSecret: 'am-secret' } };
		const envelope = buildExportEnvelope(keys);
		const result = parseImportedKeysFile(envelope);
		expect(result).toEqual({ ok: true, keys, warnings: [] });
	});

	it('rejects a file that is not a JSON object', () => {
		expect(parseImportedKeysFile(null).ok).toBe(false);
		expect(parseImportedKeysFile('a string').ok).toBe(false);
		expect(parseImportedKeysFile(['array']).ok).toBe(false);
	});

	it('rejects an envelope with the wrong version instead of guessing its shape', () => {
		const result = parseImportedKeysFile({ version: 999, keys: {} });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('999');
	});

	it('rejects an envelope whose "keys" field is not an object', () => {
		expect(parseImportedKeysFile({ version: KEY_FILE_VERSION, keys: 'nope' }).ok).toBe(false);
		expect(parseImportedKeysFile({ version: KEY_FILE_VERSION, keys: null }).ok).toBe(false);
	});

	it('skips a provider entry that is not an object, with a warning, keeping the rest', () => {
		const result = parseImportedKeysFile({
			version: KEY_FILE_VERSION,
			keys: { skyscanner: { apiKey: 'sk-live-1234' }, broken: 42, blankString: '   ' }
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.keys).toEqual({ skyscanner: { apiKey: 'sk-live-1234' } });
		expect(result.warnings.map((w) => w.providerId).sort()).toEqual(['blankString', 'broken']);
	});

	it('drops non-string or blank field values within a provider, keeping the good fields', () => {
		const result = parseImportedKeysFile({
			version: KEY_FILE_VERSION,
			keys: { amadeus: { apiKey: 'am-key', apiSecret: 42, extra: '   ' } }
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.keys).toEqual({ amadeus: { apiKey: 'am-key' } });
	});

	it('skips a provider entry with a warning once every field value is dropped', () => {
		const result = parseImportedKeysFile({
			version: KEY_FILE_VERSION,
			keys: { skyscanner: { apiKey: 'sk-live-1234' }, agoda: { apiKey: 42, other: '   ' } }
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.keys).toEqual({ skyscanner: { apiKey: 'sk-live-1234' } });
		expect(result.warnings).toEqual([{ providerId: 'agoda', message: 'Skipped: no non-empty field values.' }]);
	});

	it('warns on an unknown provider id but still imports it, rather than discarding it', () => {
		const result = parseImportedKeysFile(
			{
				version: KEY_FILE_VERSION,
				keys: { skyscanner: { apiKey: 'sk-live-1234' }, 'brand-new-provider': { apiKey: 'xyz' } }
			},
			['skyscanner', 'agoda']
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.keys).toEqual({
			skyscanner: { apiKey: 'sk-live-1234' },
			'brand-new-provider': { apiKey: 'xyz' }
		});
		expect(result.warnings).toEqual([
			{
				providerId: 'brand-new-provider',
				message: 'Unknown provider id. Imported anyway in case a newer app version recognises it.'
			}
		]);
	});

	it('does not warn about unknown ids when no known list is given', () => {
		const result = parseImportedKeysFile({
			version: KEY_FILE_VERSION,
			keys: { 'anything-at-all': { apiKey: 'sk-live-1234' } }
		});
		expect(result).toEqual({
			ok: true,
			keys: { 'anything-at-all': { apiKey: 'sk-live-1234' } },
			warnings: []
		});
	});
});

describe('mergeProviderKeys', () => {
	it('reports added, updated and unchanged separately', () => {
		const existing = { skyscanner: { apiKey: 'old-key' }, agoda: { apiKey: 'same-key' } };
		const incoming = {
			skyscanner: { apiKey: 'new-key' },
			agoda: { apiKey: 'same-key' },
			rome2rio: { apiKey: 'r2r-key' }
		};
		const result = mergeProviderKeys(existing, incoming);
		expect(result.added).toEqual(['rome2rio']);
		expect(result.updated).toEqual(['skyscanner']);
		expect(result.unchanged).toEqual(['agoda']);
		expect(result.merged).toEqual({
			skyscanner: { apiKey: 'new-key' },
			agoda: { apiKey: 'same-key' },
			rome2rio: { apiKey: 'r2r-key' }
		});
	});

	it('leaves every existing provider the file does not mention untouched', () => {
		const existing = { skyscanner: { apiKey: 'sk-key' }, agoda: { apiKey: 'ag-key' } };
		const result = mergeProviderKeys(existing, { rome2rio: { apiKey: 'r2r-key' } });
		expect(result.merged).toEqual({
			skyscanner: { apiKey: 'sk-key' },
			agoda: { apiKey: 'ag-key' },
			rome2rio: { apiKey: 'r2r-key' }
		});
	});

	it('merges per field: an incoming field the file names overwrites, a field it does not name survives', () => {
		const existing = { amadeus: { apiKey: 'old-key', apiSecret: 'old-secret' } };
		const incoming = { amadeus: { apiKey: 'new-key' } };
		const result = mergeProviderKeys(existing, incoming);
		expect(result.updated).toEqual(['amadeus']);
		expect(result.merged).toEqual({ amadeus: { apiKey: 'new-key', apiSecret: 'old-secret' } });
	});

	it('treats a provider as unchanged only when every field value is identical', () => {
		const existing = { amadeus: { apiKey: 'key', apiSecret: 'secret' } };
		const result = mergeProviderKeys(existing, { amadeus: { apiKey: 'key', apiSecret: 'secret' } });
		expect(result.unchanged).toEqual(['amadeus']);
		expect(result.updated).toEqual([]);
	});
});
