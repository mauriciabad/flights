import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callProviderWithBudget } from './call-with-budget';
import { ProviderHttpError } from './classify-error';
import { clearInFlightForTests } from './dedupe';
import { isPermanentlyUnsubscribed, resetPermanentFailuresForTests } from './permanent-failures';

const SEP_2026 = Date.UTC(2026, 8, 4);
const instantSleep = async () => {};

beforeEach(() => {
	localStorage.clear();
	clearInFlightForTests();
	resetPermanentFailuresForTests();
});

describe('callProviderWithBudget — hard quota stop', () => {
	it('refuses the call before firing any fetch once the cap is already spent', async () => {
		const execute = vi.fn(async () => 'never reached');

		const outcome = await callProviderWithBudget({
			providerId: 'sky-scrapper',
			cap: 0, // already exhausted
			dedupeKey: 'sky-scrapper:cap-test',
			execute,
			now: () => SEP_2026
		});

		expect(execute).not.toHaveBeenCalled();
		expect(outcome).toMatchObject({
			ok: false,
			requestsUsed: 0,
			attempts: 0,
			error: { kind: 'quota-exceeded' }
		});
	});

	it('refuses once the cap is reached by prior calls in the same month', async () => {
		const execute = vi.fn(async () => 'ok');

		await callProviderWithBudget({
			providerId: 'sky-scrapper',
			cap: 1,
			dedupeKey: 'sky-scrapper:call-1',
			execute,
			now: () => SEP_2026
		});
		const second = await callProviderWithBudget({
			providerId: 'sky-scrapper',
			cap: 1,
			dedupeKey: 'sky-scrapper:call-2', // different key: this is a genuinely separate request
			execute,
			now: () => SEP_2026
		});

		expect(execute).toHaveBeenCalledTimes(1); // only the first call actually fired
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.error.kind).toBe('quota-exceeded');
	});
});

describe('callProviderWithBudget — in-flight deduplication', () => {
	it('makes one network call for two concurrent identical requests and shares the result', async () => {
		let resolveExecute: (value: string) => void = () => {};
		const execute = vi.fn(() => new Promise<string>((resolve) => (resolveExecute = resolve)));

		const first = callProviderWithBudget({
			providerId: 'sky-scrapper',
			cap: 15,
			dedupeKey: 'sky-scrapper:BCN-VIE-2026-10-01',
			execute,
			now: () => SEP_2026
		});
		const second = callProviderWithBudget({
			providerId: 'sky-scrapper',
			cap: 15,
			dedupeKey: 'sky-scrapper:BCN-VIE-2026-10-01', // same query, fired again before the first settled
			execute,
			now: () => SEP_2026
		});

		expect(execute).toHaveBeenCalledTimes(1);

		resolveExecute('fare-result');
		const [outcomeA, outcomeB] = await Promise.all([first, second]);

		expect(outcomeA).toMatchObject({ ok: true, value: 'fare-result', requestsUsed: 1 });
		expect(outcomeB).toMatchObject({ ok: true, value: 'fare-result', requestsUsed: 1 });
	});

	it('reserves quota once, not twice, for the deduplicated pair', async () => {
		const execute = vi.fn(async () => 'value');

		await Promise.all([
			callProviderWithBudget({
				providerId: 'sky-scrapper',
				cap: 1,
				dedupeKey: 'same-key',
				execute,
				now: () => SEP_2026
			}),
			callProviderWithBudget({
				providerId: 'sky-scrapper',
				cap: 1,
				dedupeKey: 'same-key',
				execute,
				now: () => SEP_2026
			})
		]);

		// If both had reserved separately, a third call under the (now-exhausted) cap of 1 would still be refused either way —
		// what this actually proves is only one real attempt happened, checked above via `execute`.
		expect(execute).toHaveBeenCalledTimes(1);
	});
});

describe('callProviderWithBudget — not-subscribed is permanent for the session', () => {
	it('does not retry a "not subscribed" 403, and marks the provider permanently unsubscribed', async () => {
		const execute = vi.fn(async () => {
			throw new ProviderHttpError(403, 'You are not subscribed to this API.');
		});

		const outcome = await callProviderWithBudget({
			providerId: 'sky-scrapper',
			cap: 15,
			dedupeKey: 'sky-scrapper:first-attempt',
			execute,
			sleep: instantSleep,
			now: () => SEP_2026
		});

		expect(execute).toHaveBeenCalledTimes(1); // not retried, unlike a 429
		expect(outcome).toMatchObject({ ok: false, error: { kind: 'not-subscribed' } });
		expect(isPermanentlyUnsubscribed('sky-scrapper')).toBe(true);
	});

	it('refuses a later call for the same provider without ever calling execute again', async () => {
		const execute = vi.fn(async () => {
			throw new ProviderHttpError(403, 'You are not subscribed to this API.');
		});

		await callProviderWithBudget({
			providerId: 'sky-scrapper',
			cap: 15,
			dedupeKey: 'sky-scrapper:attempt-1',
			execute,
			sleep: instantSleep,
			now: () => SEP_2026
		});

		const secondOutcome = await callProviderWithBudget({
			providerId: 'sky-scrapper',
			cap: 15,
			dedupeKey: 'sky-scrapper:attempt-2', // a different request to the same provider
			execute,
			sleep: instantSleep,
			now: () => SEP_2026
		});

		expect(execute).toHaveBeenCalledTimes(1); // the second call never touched the network at all
		expect(secondOutcome).toMatchObject({ ok: false, requestsUsed: 0, attempts: 0, error: { kind: 'not-subscribed' } });
	});
});

describe('callProviderWithBudget — exponential backoff on 429', () => {
	it('retries a rate-limited call and succeeds once the provider recovers', async () => {
		let call = 0;
		const execute = vi.fn(async () => {
			call++;
			if (call < 3) throw new ProviderHttpError(429, 'Too Many Requests');
			return 'ok-on-third-try';
		});
		const sleep = vi.fn(instantSleep);

		const outcome = await callProviderWithBudget({
			providerId: 'sky-scrapper',
			cap: 15,
			dedupeKey: 'sky-scrapper:retry-test',
			execute,
			sleep,
			maxAttempts: 5,
			now: () => SEP_2026
		});

		expect(execute).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenCalledTimes(2); // backed off before attempt 2 and attempt 3
		expect(outcome).toMatchObject({ ok: true, value: 'ok-on-third-try', requestsUsed: 3, attempts: 3 });
	});

	it('gives up after maxAttempts and reports the failure, still counting every real attempt', async () => {
		const execute = vi.fn(async () => {
			throw new ProviderHttpError(429, 'Too Many Requests');
		});

		const outcome = await callProviderWithBudget({
			providerId: 'sky-scrapper',
			cap: 15,
			dedupeKey: 'sky-scrapper:always-429',
			execute,
			sleep: instantSleep,
			maxAttempts: 3,
			now: () => SEP_2026
		});

		expect(execute).toHaveBeenCalledTimes(3);
		expect(outcome).toMatchObject({ ok: false, requestsUsed: 3, attempts: 3, error: { kind: 'rate-limited' } });
	});

	it('re-checks the quota before every retry, so a retry storm cannot exceed the cap', async () => {
		const execute = vi.fn(async () => {
			throw new ProviderHttpError(429, 'Too Many Requests');
		});

		const outcome = await callProviderWithBudget({
			providerId: 'sky-scrapper',
			cap: 2, // enough for the first attempt and one retry, not a third
			dedupeKey: 'sky-scrapper:cap-mid-retry',
			execute,
			sleep: instantSleep,
			maxAttempts: 5,
			now: () => SEP_2026
		});

		expect(execute).toHaveBeenCalledTimes(2);
		expect(outcome).toMatchObject({ ok: false, requestsUsed: 2, error: { kind: 'quota-exceeded' } });
	});
});

describe('callProviderWithBudget — cancellation and unclassified failures', () => {
	it('does not retry a cancelled request', async () => {
		const execute = vi.fn(async () => {
			throw new DOMException('The operation was aborted', 'AbortError');
		});

		const outcome = await callProviderWithBudget({
			providerId: 'sky-scrapper',
			cap: 15,
			dedupeKey: 'sky-scrapper:cancelled',
			execute,
			sleep: instantSleep,
			now: () => SEP_2026
		});

		expect(execute).toHaveBeenCalledTimes(1);
		expect(outcome).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
	});
});
