import { describe, expect, it } from 'vitest';
import { buildExportEnvelope, mergeProviderKeys, parseImportedKeysFile } from './codec';
import { KEY_FILE_VERSION } from './types';

describe('buildExportEnvelope', () => {
	it('carries the current version and a copy of every key', () => {
		const keys = { skyscanner: 'sk-live-1234' };
		const envelope = buildExportEnvelope(keys);
		expect(envelope.version).toBe(KEY_FILE_VERSION);
		expect(envelope.keys).toEqual(keys);
		expect(envelope.keys).not.toBe(keys); // a copy, not the live object
		expect(() => new Date(envelope.exportedAt).toISOString()).not.toThrow();
	});
});

describe('parseImportedKeysFile', () => {
	it('reads back exactly what buildExportEnvelope wrote', () => {
		const keys = { skyscanner: 'sk-live-1234', agoda: 'ag-9999' };
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

	it('skips a non-string or blank key value with a warning, keeping the rest', () => {
		const result = parseImportedKeysFile({
			version: KEY_FILE_VERSION,
			keys: { skyscanner: 'sk-live-1234', broken: 42, blank: '   ' }
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.keys).toEqual({ skyscanner: 'sk-live-1234' });
		expect(result.warnings.map((w) => w.providerId).sort()).toEqual(['blank', 'broken']);
	});

	it('warns on an unknown provider id but still imports it, rather than discarding it', () => {
		const result = parseImportedKeysFile(
			{ version: KEY_FILE_VERSION, keys: { skyscanner: 'sk-live-1234', 'brand-new-provider': 'xyz' } },
			['skyscanner', 'agoda']
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.keys).toEqual({ skyscanner: 'sk-live-1234', 'brand-new-provider': 'xyz' });
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
			keys: { 'anything-at-all': 'sk-live-1234' }
		});
		expect(result).toEqual({ ok: true, keys: { 'anything-at-all': 'sk-live-1234' }, warnings: [] });
	});
});

describe('mergeProviderKeys', () => {
	it('reports added, updated and unchanged separately', () => {
		const existing = { skyscanner: 'old-key', agoda: 'same-key' };
		const incoming = { skyscanner: 'new-key', agoda: 'same-key', rome2rio: 'r2r-key' };
		const result = mergeProviderKeys(existing, incoming);
		expect(result.added).toEqual(['rome2rio']);
		expect(result.updated).toEqual(['skyscanner']);
		expect(result.unchanged).toEqual(['agoda']);
		expect(result.merged).toEqual({
			skyscanner: 'new-key',
			agoda: 'same-key',
			rome2rio: 'r2r-key'
		});
	});

	it('leaves every existing key the file does not mention untouched', () => {
		const existing = { skyscanner: 'sk-key', agoda: 'ag-key' };
		const result = mergeProviderKeys(existing, { rome2rio: 'r2r-key' });
		expect(result.merged).toEqual({
			skyscanner: 'sk-key',
			agoda: 'ag-key',
			rome2rio: 'r2r-key'
		});
	});
});
