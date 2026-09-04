import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearKeysFromStorage, loadKeysFromStorage, saveKeysToStorage } from './storage';

beforeEach(() => {
	localStorage.clear();
});

describe('loadKeysFromStorage / saveKeysToStorage', () => {
	it('round-trips through localStorage', () => {
		saveKeysToStorage({ skyscanner: 'sk-live-1234' });
		expect(loadKeysFromStorage()).toEqual({ skyscanner: 'sk-live-1234' });
	});

	it('reads as empty when nothing has been saved yet', () => {
		expect(loadKeysFromStorage()).toEqual({});
	});

	it('reads as empty rather than throwing on corrupted JSON', () => {
		localStorage.setItem('flights.byokKeys.v1', 'not json{{{');
		expect(loadKeysFromStorage()).toEqual({});
	});

	it('drops non-string values instead of returning something the rest of the app cannot use', () => {
		localStorage.setItem('flights.byokKeys.v1', JSON.stringify({ skyscanner: 'ok', broken: 42 }));
		expect(loadKeysFromStorage()).toEqual({ skyscanner: 'ok' });
	});

	it('reads as empty when the stored value is an array or primitive, not an object', () => {
		localStorage.setItem('flights.byokKeys.v1', JSON.stringify(['not', 'an', 'object']));
		expect(loadKeysFromStorage()).toEqual({});
	});
});

describe('clearKeysFromStorage', () => {
	it('removes everything that was saved', () => {
		saveKeysToStorage({ skyscanner: 'sk-live-1234' });
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
		expect(() => saveKeysToStorage({ skyscanner: 'sk-live-1234' })).not.toThrow();
		expect(saveKeysToStorage({ skyscanner: 'sk-live-1234' })).toBe(false);
	});

	it('clearKeysFromStorage does not throw', () => {
		vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
			throw new DOMException('SecurityError');
		});
		expect(() => clearKeysFromStorage()).not.toThrow();
	});
});
