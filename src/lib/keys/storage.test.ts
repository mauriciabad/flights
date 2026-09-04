import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearKeysFromStorage, loadKeysFromStorage, saveKeysToStorage } from './storage';

beforeEach(() => {
	localStorage.clear();
});

describe('loadKeysFromStorage / saveKeysToStorage', () => {
	it('round-trips through localStorage', () => {
		saveKeysToStorage({ skyscanner: { apiKey: 'sk-live-1234' } });
		expect(loadKeysFromStorage()).toEqual({ skyscanner: { apiKey: 'sk-live-1234' } });
	});

	it('round-trips a provider with more than one field', () => {
		saveKeysToStorage({ amadeus: { apiKey: 'am-key', apiSecret: 'am-secret' } });
		expect(loadKeysFromStorage()).toEqual({ amadeus: { apiKey: 'am-key', apiSecret: 'am-secret' } });
	});

	it('reads as empty when nothing has been saved yet', () => {
		expect(loadKeysFromStorage()).toEqual({});
	});

	it('reads as empty rather than throwing on corrupted JSON', () => {
		localStorage.setItem('flights.byokKeys.v1', 'not json{{{');
		expect(loadKeysFromStorage()).toEqual({});
	});

	it('drops a provider entry that is a bare string instead of a field map', () => {
		// The pre-issue-#49 shape stored one string per provider directly; an entry in
		// that old shape reads as corrupt now, the same as any other unreadable entry.
		localStorage.setItem(
			'flights.byokKeys.v1',
			JSON.stringify({ skyscanner: { apiKey: 'ok' }, broken: 'a-bare-string' })
		);
		expect(loadKeysFromStorage()).toEqual({ skyscanner: { apiKey: 'ok' } });
	});

	it('drops non-string field values instead of returning something the rest of the app cannot use', () => {
		localStorage.setItem(
			'flights.byokKeys.v1',
			JSON.stringify({ skyscanner: { apiKey: 'ok', broken: 42 } })
		);
		expect(loadKeysFromStorage()).toEqual({ skyscanner: { apiKey: 'ok' } });
	});

	it('drops a provider entry left with no fields once the bad ones are removed', () => {
		localStorage.setItem('flights.byokKeys.v1', JSON.stringify({ broken: { onlyField: 42 } }));
		expect(loadKeysFromStorage()).toEqual({});
	});

	it('reads as empty when the stored value is an array or primitive, not an object', () => {
		localStorage.setItem('flights.byokKeys.v1', JSON.stringify(['not', 'an', 'object']));
		expect(loadKeysFromStorage()).toEqual({});
	});
});

describe('clearKeysFromStorage', () => {
	it('removes everything that was saved', () => {
		saveKeysToStorage({ skyscanner: { apiKey: 'sk-live-1234' } });
		clearKeysFromStorage();
		expect(loadKeysFromStorage()).toEqual({});
	});
});

// Safari private mode and some embedded webviews throw on every localStorage
// call, not just on quota. The app has to keep working with keys simply
// absent rather than crashing.
describe('when localStorage throws', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('loadKeysFromStorage reads as empty instead of throwing', () => {
		vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new DOMException('SecurityError');
		});
		expect(() => loadKeysFromStorage()).not.toThrow();
		expect(loadKeysFromStorage()).toEqual({});
	});

	it('saveKeysToStorage reports failure instead of throwing', () => {
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new DOMException('QuotaExceededError');
		});
		expect(() => saveKeysToStorage({ skyscanner: { apiKey: 'sk-live-1234' } })).not.toThrow();
		expect(saveKeysToStorage({ skyscanner: { apiKey: 'sk-live-1234' } })).toBe(false);
	});

	it('clearKeysFromStorage does not throw', () => {
		vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
			throw new DOMException('SecurityError');
		});
		expect(() => clearKeysFromStorage()).not.toThrow();
	});
});
