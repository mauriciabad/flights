import { beforeEach, describe, expect, it } from 'vitest';
import { KeyStore } from './store.svelte';
import { KEY_FILE_VERSION } from './types';

beforeEach(() => {
	localStorage.clear();
});

describe('KeyStore persistence', () => {
	it('set a field, then survives a reload', () => {
		const before = new KeyStore();
		before.setFieldValue('skyscanner', 'apiKey', 'sk-live-1234');

		// Simulate a reload: a fresh instance reads whatever the first one
		// wrote to localStorage, exactly like a new page load re-running this
		// module from scratch.
		const afterReload = new KeyStore();
		expect(afterReload.getFieldValue('skyscanner', 'apiKey')).toBe('sk-live-1234');
		expect(afterReload.hasKey('skyscanner')).toBe(true);
	});

	it('a cleared field does not come back after a reload', () => {
		const before = new KeyStore();
		before.setFieldValue('skyscanner', 'apiKey', 'sk-live-1234');
		before.clearField('skyscanner', 'apiKey');

		const afterReload = new KeyStore();
		expect(afterReload.hasKey('skyscanner')).toBe(false);
		expect(afterReload.getFieldValue('skyscanner', 'apiKey')).toBeUndefined();
	});

	it('a provider with more than one field stores and reloads both', () => {
		const before = new KeyStore();
		before.setFieldValue('amadeus', 'apiKey', 'am-key');
		before.setFieldValue('amadeus', 'apiSecret', 'am-secret');

		const afterReload = new KeyStore();
		expect(afterReload.getValues('amadeus')).toEqual({ apiKey: 'am-key', apiSecret: 'am-secret' });
	});

	it('clearing one field of a multi-field provider leaves the other field intact', () => {
		const store = new KeyStore();
		store.setFieldValue('amadeus', 'apiKey', 'am-key');
		store.setFieldValue('amadeus', 'apiSecret', 'am-secret');
		store.clearField('amadeus', 'apiSecret');

		expect(store.getValues('amadeus')).toEqual({ apiKey: 'am-key' });
	});

	it('clearing the last field of a provider removes the provider entirely', () => {
		const store = new KeyStore();
		store.setFieldValue('skyscanner', 'apiKey', 'sk-live-1234');
		store.clearField('skyscanner', 'apiKey');

		expect(store.getValues('skyscanner')).toBeUndefined();
		expect(store.providerIds).toEqual([]);
	});

	it('clearProvider removes every field for that provider in one call', () => {
		const store = new KeyStore();
		store.setFieldValue('amadeus', 'apiKey', 'am-key');
		store.setFieldValue('amadeus', 'apiSecret', 'am-secret');
		store.clearProvider('amadeus');

		expect(store.getValues('amadeus')).toBeUndefined();
	});

	it('setting a field to a blank value clears it instead of storing an empty string', () => {
		const store = new KeyStore();
		store.setFieldValue('skyscanner', 'apiKey', 'sk-live-1234');
		store.setFieldValue('skyscanner', 'apiKey', '   ');
		expect(store.hasKey('skyscanner')).toBe(false);
	});

	it('trims the field value before storing it', () => {
		const store = new KeyStore();
		store.setFieldValue('skyscanner', 'apiKey', '  sk-live-1234  ');
		expect(store.getFieldValue('skyscanner', 'apiKey')).toBe('sk-live-1234');
	});
});

describe('KeyStore.availableKeys', () => {
	it('is exactly the shape the provider registry expects, with no conversion needed', () => {
		const store = new KeyStore();
		store.setFieldValue('sky', 'apiKey', 'secret');
		expect(store.availableKeys).toEqual({ sky: { apiKey: 'secret' } });
	});
});

describe('KeyStore.getRedactedFieldValue', () => {
	it('never returns the raw key', () => {
		const store = new KeyStore();
		store.setFieldValue('skyscanner', 'apiKey', 'sk-live-1234');
		expect(store.getRedactedFieldValue('skyscanner', 'apiKey')).toBe('••••1234');
	});

	it('is undefined for a field with no value', () => {
		const store = new KeyStore();
		expect(store.getRedactedFieldValue('skyscanner', 'apiKey')).toBeUndefined();
	});
});

describe('KeyStore export / import round trip', () => {
	it('export, clear, import: the keys come back identical', () => {
		const store = new KeyStore();
		store.setFieldValue('skyscanner', 'apiKey', 'sk-live-1234');
		store.setFieldValue('agoda', 'apiKey', 'ag-live-5678');

		const envelope = store.exportEnvelope();

		store.clearAll();
		expect(store.providerIds).toEqual([]);

		const outcome = store.importFromFile(envelope);

		expect(store.getFieldValue('skyscanner', 'apiKey')).toBe('sk-live-1234');
		expect(store.getFieldValue('agoda', 'apiKey')).toBe('ag-live-5678');
		expect(outcome.added.sort()).toEqual(['agoda', 'skyscanner']);
		expect(outcome.updated).toEqual([]);
		expect(outcome.warnings).toEqual([]);
		expect(outcome.error).toBeUndefined();

		// And it survives a reload too, not just the in-memory instance.
		const afterReload = new KeyStore();
		expect(afterReload.getFieldValue('skyscanner', 'apiKey')).toBe('sk-live-1234');
		expect(afterReload.getFieldValue('agoda', 'apiKey')).toBe('ag-live-5678');
	});

	it('import merges rather than replacing: fields the file does not mention survive', () => {
		const store = new KeyStore();
		store.setFieldValue('skyscanner', 'apiKey', 'sk-live-1234');
		store.setFieldValue('amadeus', 'apiKey', 'am-key');
		store.setFieldValue('amadeus', 'apiSecret', 'am-secret');

		const partialExport = {
			version: 2 as const,
			exportedAt: new Date().toISOString(),
			keys: { amadeus: { apiKey: 'am-new-key' } }
		};
		const outcome = store.importFromFile(partialExport);

		expect(store.getFieldValue('skyscanner', 'apiKey')).toBe('sk-live-1234'); // untouched
		expect(store.getValues('amadeus')).toEqual({ apiKey: 'am-new-key', apiSecret: 'am-secret' }); // one field overwritten, one survives
		expect(outcome.updated).toEqual(['amadeus']);
	});

	it('an unknown provider id in the import warns but does not discard the other keys in the file', () => {
		const store = new KeyStore();
		const raw = {
			version: 2 as const,
			exportedAt: new Date().toISOString(),
			keys: { skyscanner: { apiKey: 'sk-live-1234' }, 'future-provider': { apiKey: 'future-key' } }
		};

		const outcome = store.importFromFile(raw, ['skyscanner', 'agoda']);

		expect(store.getFieldValue('skyscanner', 'apiKey')).toBe('sk-live-1234');
		expect(store.getFieldValue('future-provider', 'apiKey')).toBe('future-key');
		expect(outcome.warnings).toHaveLength(1);
		expect(outcome.warnings[0].providerId).toBe('future-provider');
	});

	it('rejects an invalid file without touching the existing keys', () => {
		const store = new KeyStore();
		store.setFieldValue('skyscanner', 'apiKey', 'sk-live-1234');

		const outcome = store.importFromFile({ version: 999, keys: {} });

		expect(outcome.error).toBeDefined();
		expect(store.getFieldValue('skyscanner', 'apiKey')).toBe('sk-live-1234');
	});
});

describe('KeyStore search currency', () => {
	it('reads as undefined until somebody picks one', () => {
		expect(new KeyStore().currency).toBeUndefined();
	});

	it('survives a reload', () => {
		new KeyStore().setCurrency('GBP');
		expect(new KeyStore().currency).toBe('GBP');
	});

	it('ignores a code that is not a currency code, keeping the last good one', () => {
		const store = new KeyStore();
		store.setCurrency('CZK');
		store.setCurrency('nonsense');
		expect(store.currency).toBe('CZK');
	});

	it('travels in the export file and comes back on import', () => {
		const source = new KeyStore();
		source.setFieldValue('agoda', 'apiKey', 'ag-1');
		source.setCurrency('SEK');
		const envelope = source.exportEnvelope();

		// A second device: the file is all it has.
		localStorage.clear();
		const destination = new KeyStore();
		const outcome = destination.importFromFile(envelope);

		expect(outcome.currency).toBe('SEK');
		expect(destination.currency).toBe('SEK');
		// And it is saved, not merely held in memory for this page load.
		expect(new KeyStore().currency).toBe('SEK');
	});

	it('leaves a chosen currency alone when the imported file names none', () => {
		const store = new KeyStore();
		store.setCurrency('NOK');
		const outcome = store.importFromFile({ version: KEY_FILE_VERSION, keys: { agoda: { apiKey: 'ag-1' } } });

		expect(outcome.currency).toBeUndefined();
		expect(store.currency).toBe('NOK');
	});

	it('is not wiped by "remove all keys", which promises to remove keys', () => {
		const store = new KeyStore();
		store.setFieldValue('agoda', 'apiKey', 'ag-1');
		store.setCurrency('DKK');

		store.clearAll();

		expect(store.hasKey('agoda')).toBe(false);
		expect(store.currency).toBe('DKK');
	});
});
