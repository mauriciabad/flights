import { describe, expect, it, vi } from 'vitest';
import { clearInFlightForTests, dedupeInFlight } from './dedupe';

describe('dedupeInFlight', () => {
	it('makes one call for two concurrent requests sharing a key, and both share the result', async () => {
		let resolveRun: (value: string) => void = () => {};
		const run = vi.fn(() => new Promise<string>((resolve) => (resolveRun = resolve)));

		const first = dedupeInFlight('same-key', run);
		const second = dedupeInFlight('same-key', run);

		expect(run).toHaveBeenCalledTimes(1);

		resolveRun('fare-result');
		await expect(first).resolves.toBe('fare-result');
		await expect(second).resolves.toBe('fare-result');
	});

	it('does not deduplicate calls under different keys', async () => {
		const run = vi.fn(async () => 'value');

		await Promise.all([dedupeInFlight('key-a', run), dedupeInFlight('key-b', run)]);

		expect(run).toHaveBeenCalledTimes(2);
	});

	it('runs again for a later, non-concurrent call with the same key once the first has settled', async () => {
		const run = vi.fn(async () => 'value');

		await dedupeInFlight('same-key', run);
		await dedupeInFlight('same-key', run);

		expect(run).toHaveBeenCalledTimes(2);
	});

	it('shares a rejection the same way it shares a resolution', async () => {
		const run = vi.fn(async () => {
			throw new Error('boom');
		});

		const first = dedupeInFlight('same-key', run);
		const second = dedupeInFlight('same-key', run);

		await expect(first).rejects.toThrow('boom');
		await expect(second).rejects.toThrow('boom');
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('clearInFlightForTests forgets tracked calls so a fresh run fires again', async () => {
		const run = vi.fn(() => new Promise<string>(() => {})); // never settles

		void dedupeInFlight('same-key', run);
		clearInFlightForTests();
		void dedupeInFlight('same-key', run);

		expect(run).toHaveBeenCalledTimes(2);
	});
});
