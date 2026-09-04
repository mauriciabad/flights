import { beforeEach, describe, expect, it } from 'vitest';
import { KeyStore } from './store.svelte';

beforeEach(() => {
	localStorage.clear();
});

describe('KeyStore persistence', () => {
	it('set a key, then survives a reload', () => {
		const before = new KeyStore();
		before.setKey('skyscanner', 'sk-live-1234');

		// Simulate a reload: a fresh instance reads whatever the first one
		// wrote to localStorage, exactly like a new page load re-running this
		// module from scratch.
		const afterReload = new KeyStore();
		expect(afterReload.getKey('skyscanner')).toBe('sk-live-1234');
		expect(afterReload.hasKey('skyscanner')).toBe(true);
	});

	it('a cleared key does not come back after a reload', () => {
		const before = new KeyStore();
		before.setKey('skyscanner', 'sk-live-1234');
		before.clearKey('skyscanner');

		const afterReload = new KeyStore();
		expect(afterReload.hasKey('skyscanner')).toBe(false);
		expect(afterReload.getKey('skyscanner')).toBeUndefined();
	});

	it('setting a key to a blank value clears it instead of storing an empty string', () => {
		const store = new KeyStore();
		store.setKey('skyscanner', 'sk-live-1234');
		store.setKey('skyscanner', '   ');
		expect(store.hasKey('skyscanner')).toBe(false);
	});

	it('trims the key before storing it', () => {
		const store = new KeyStore();
		store.setKey('skyscanner', '  sk-live-1234  ');
		expect(store.getKey('skyscanner')).toBe('sk-live-1234');
	});
});

describe('KeyStore.getRedactedKey', () => {
	it('never returns the raw key', () => {
		const store = new KeyStore();
		store.setKey('skyscanner', 'sk-live-1234');
		expect(store.getRedactedKey('skyscanner')).toBe('••••1234');
	});

	it('is undefined for a provider with no key', () => {
		const store = new KeyStore();
		expect(store.getRedactedKey('skyscanner')).toBeUndefined();
	});
});

describe('KeyStore export / import round trip', () => {
	it('export, clear, import: the keys come back identical', () => {
		const store = new KeyStore();
		store.setKey('skyscanner', 'sk-live-1234');
		store.setKey('agoda', 'ag-live-5678');

		const envelope = store.exportEnvelope();

		store.clearAll();
		expect(store.providerIds).toEqual([]);

		const outcome = store.importFromFile(envelope);

		expect(store.getKey('skyscanner')).toBe('sk-live-1234');
		expect(store.getKey('agoda')).toBe('ag-live-5678');
		expect(outcome.added.sort()).toEqual(['agoda', 'skyscanner']);
		expect(outcome.updated).toEqual([]);
		expect(outcome.warnings).toEqual([]);
		expect(outcome.error).toBeUndefined();

		// And it survives a reload too, not just the in-memory instance.
		const afterReload = new KeyStore();
		expect(afterReload.getKey('skyscanner')).toBe('sk-live-1234');
		expect(afterReload.getKey('agoda')).toBe('ag-live-5678');
	});

	it('import merges rather than replacing: keys the file does not mention survive', () => {
		const store = new KeyStore();
		store.setKey('skyscanner', 'sk-live-1234');
		store.setKey('agoda', 'ag-live-5678');

		const partialExport = { version: 1 as const, exportedAt: new Date().toISOString(), keys: { agoda: 'ag-new-key' } };
		const outcome = store.importFromFile(partialExport);

		expect(store.getKey('skyscanner')).toBe('sk-live-1234'); // untouched
		expect(store.getKey('agoda')).toBe('ag-new-key'); // overwritten
		expect(outcome.updated).toEqual(['agoda']);
	});

	it('an unknown provider id in the import warns but does not discard the other keys in the file', () => {
		const store = new KeyStore();
		const raw = {
			version: 1 as const,
			exportedAt: new Date().toISOString(),
			keys: { skyscanner: 'sk-live-1234', 'future-provider': 'future-key' }
		};

		const outcome = store.importFromFile(raw, ['skyscanner', 'agoda']);

		expect(store.getKey('skyscanner')).toBe('sk-live-1234');
		expect(store.getKey('future-provider')).toBe('future-key');
		expect(outcome.warnings).toHaveLength(1);
		expect(outcome.warnings[0].providerId).toBe('future-provider');
	});

	it('rejects an invalid file without touching the existing keys', () => {
		const store = new KeyStore();
		store.setKey('skyscanner', 'sk-live-1234');

		const outcome = store.importFromFile({ version: 999, keys: {} });

		expect(outcome.error).toBeDefined();
		expect(store.getKey('skyscanner')).toBe('sk-live-1234');
	});
});
