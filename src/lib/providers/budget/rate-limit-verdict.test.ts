import { describe, expect, it } from 'vitest';
import { classifyRateLimit, describeRateLimit, secondsUntilReset } from './rate-limit-verdict';
import type { ReportedProviderQuota } from './reported-quota';

const SEP_2026 = Date.UTC(2026, 8, 4);
const OCT_2026 = Date.UTC(2026, 9, 1);

/** The real one, from an exhausted 50-a-month BASIC plan (issue #157, seen live). */
const MONTHLY_429 =
	'You have exceeded the MONTHLY quota for Requests on your current plan, BASIC. Upgrade your plan at https://rapidapi.com/ntd119/api/flights-sky';

function reading(overrides: Partial<ReportedProviderQuota> = {}): ReportedProviderQuota {
	return {
		monthKey: '2026-09',
		limit: 50,
		remaining: 0,
		observedAt: SEP_2026,
		resetsAt: OCT_2026,
		scope: 'requests',
		headerNames: ['x-ratelimit-requests-limit', 'x-ratelimit-requests-remaining', 'x-ratelimit-requests-reset'],
		...overrides
	};
}

describe('classifyRateLimit', () => {
	it('believes the quota headers first, whatever the message says', () => {
		const verdict = classifyRateLimit({
			message: 'Too Many Requests',
			retryAfterSeconds: 30,
			reported: reading(),
			nowMs: SEP_2026
		});

		expect(verdict).toMatchObject({ kind: 'quota-exhausted', retryable: false, resetsAt: OCT_2026 });
		expect(verdict.evidence).toContain('x-ratelimit-requests-remaining');
		expect(verdict.evidence).toContain('0 of 50 requests left');
	});

	it('falls back to the wording when no headers ever arrived', () => {
		const verdict = classifyRateLimit({ message: MONTHLY_429, nowMs: SEP_2026 });

		expect(verdict).toMatchObject({ kind: 'quota-exhausted', retryable: false });
		expect(verdict.evidence).toBe('the response said "exceeded the MONTHLY quota"');
		// Nobody stated a reset instant, so this is the one inference the file allows: a
		// quota the provider itself called monthly resets with the UTC calendar month, which
		// is the same assumption a locally refused call already reports (month-key.ts).
		expect(verdict.resetsAt).toBe(OCT_2026);
	});

	it('dates the monthly reset on the month boundary, not a rounded count from now', () => {
		const midMonth = Date.UTC(2026, 8, 4, 12, 34, 56, 504);
		const verdict = classifyRateLimit({ message: MONTHLY_429, nowMs: midMonth });

		expect(new Date(verdict.resetsAt ?? 0).toISOString()).toBe('2026-10-01T00:00:00.000Z');
	});

	it('does not date a period it was not given a reset for', () => {
		const verdict = classifyRateLimit({
			message: 'You have exceeded the DAILY quota for Requests',
			nowMs: SEP_2026
		});

		expect(verdict).toMatchObject({ kind: 'quota-exhausted', retryable: false, resetsAt: undefined });
	});

	it('prefers a reported reset over calendar arithmetic', () => {
		const verdict = classifyRateLimit({
			message: MONTHLY_429,
			reported: reading({ remaining: 3, resetsAt: SEP_2026 + 86_400_000 }),
			nowMs: SEP_2026
		});

		expect(verdict.resetsAt).toBe(SEP_2026 + 86_400_000);
	});

	it('calls a short Retry-After a burst limit, which is worth retrying', () => {
		expect(classifyRateLimit({ message: 'Too Many Requests', retryAfterSeconds: 5, nowMs: SEP_2026 })).toEqual({
			kind: 'burst',
			retryable: true,
			evidence: 'Retry-After: 5'
		});
	});

	it('treats an hour-long Retry-After as a closed window rather than a pause', () => {
		const verdict = classifyRateLimit({
			message: 'Too Many Requests',
			retryAfterSeconds: 3_600,
			nowMs: SEP_2026
		});

		expect(verdict).toMatchObject({
			kind: 'quota-exhausted',
			retryable: false,
			resetsAt: SEP_2026 + 3_600_000
		});
	});

	/**
	 * A reading saying requests remain is not permission to retry. It may have been taken by
	 * an earlier call: "the last response we saw had headers" is a different claim from "this
	 * response does", and only one of them is evidence about this 429.
	 */
	it('does not retry on a positive reading alone', () => {
		const verdict = classifyRateLimit({
			message: 'Too Many Requests',
			reported: reading({ remaining: 12 }),
			nowMs: SEP_2026
		});

		expect(verdict).toMatchObject({ kind: 'unclassified', retryable: false });
	});

	it('says it could not tell, when the response said nothing at all', () => {
		const verdict = classifyRateLimit({ message: 'Too Many Requests', nowMs: SEP_2026 });

		expect(verdict).toEqual({
			kind: 'unclassified',
			retryable: false,
			evidence: 'no Retry-After header and no quota reading from this key'
		});
	});
});

describe('describeRateLimit', () => {
	it('leads with the sentence the provider sent, then the reset instant', () => {
		const verdict = classifyRateLimit({ message: MONTHLY_429, nowMs: SEP_2026 });

		const message = describeRateLimit(MONTHLY_429, verdict);
		expect(message.startsWith(MONTHLY_429)).toBe(true);
		expect(message).toContain('2026-10-01T00:00:00.000Z');
		expect(message).toContain('nothing was retried');
	});

	it('says the reset is unknown rather than picking a date', () => {
		const verdict = classifyRateLimit({
			message: 'You have exceeded the DAILY quota for Requests',
			nowMs: SEP_2026
		});

		expect(describeRateLimit('You have exceeded the DAILY quota for Requests', verdict)).toContain(
			'did not say when it resets'
		);
	});

	it('names what was missing for an unclassified 429', () => {
		const verdict = classifyRateLimit({ message: 'Too Many Requests', nowMs: SEP_2026 });

		expect(describeRateLimit('Too Many Requests', verdict)).toContain(
			'no Retry-After header and no quota reading'
		);
	});
});

describe('secondsUntilReset', () => {
	it('counts from now to the stated reset', () => {
		const verdict = classifyRateLimit({ message: MONTHLY_429, nowMs: SEP_2026 });
		expect(secondsUntilReset(verdict, SEP_2026)).toBe((OCT_2026 - SEP_2026) / 1000);
	});

	it('is undefined when no reset was ever stated', () => {
		const verdict = classifyRateLimit({ message: 'Too Many Requests', nowMs: SEP_2026 });
		expect(secondsUntilReset(verdict, SEP_2026)).toBeUndefined();
	});

	it('never counts backwards once the reset has passed', () => {
		const verdict = classifyRateLimit({ message: MONTHLY_429, nowMs: SEP_2026 });
		expect(secondsUntilReset(verdict, OCT_2026 + 60_000)).toBe(0);
	});
});
