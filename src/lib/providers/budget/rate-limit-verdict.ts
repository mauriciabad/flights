/**
 * Tells RapidAPI's two completely different 429s apart.
 *
 * One is a burst limit. Waiting a second and asking again is exactly right, and the gateway
 * says so with a `Retry-After`. The other is the subscribed plan's allowance being gone for
 * the month:
 *
 * ```
 * 429: "You have exceeded the MONTHLY quota for Requests on your current plan, BASIC.
 *       Upgrade your plan at https://rapidapi.com/ntd119/api/flights-sky"
 * ```
 *
 * That one cannot succeed again until the quota resets, so retrying it three times spends
 * three requests to rediscover an empty account. Issue #159 watched it happen live on the
 * owner's Flights Sky key, and AGENTS.md is blunt about whose money that is.
 *
 * ## What decides it, in order
 *
 * The provider's own numbers first, its prose second, and our own inference last. Issue
 * #159's words: "Prefer the headers over string-matching where both are available, since the
 * wording is theirs to change."
 *
 * 1. **The quota window says zero.** `reported-quota.ts` stores what the last response's
 *    `x-ratelimit-requests-*` headers said, and every metered client in this repo records
 *    them before it branches on the status, including on the 429 itself. A stored reading of
 *    `remaining: 0` that still applies this month is the account stating its own position,
 *    and its `-reset` says when that changes.
 * 2. **The message names the exhausted period.** RapidAPI's own wording, matched loosely
 *    enough to survive a rephrasing of everything around the two words that carry it.
 * 3. **A `Retry-After` that asks for an hour or more.** Whatever that is, it is not a pause a
 *    search the user is watching can sit through, and `backoff.ts` caps every wait at eight
 *    seconds anyway, so "retrying" it would just mean failing again eight seconds later.
 * 4. **A short `Retry-After`.** The provider naming a wait it expects to be enough is the
 *    clearest burst-limit signal there is.
 *
 * ## Why silence stops rather than retries
 *
 * A 429 carrying none of the above is `'unclassified'`, and `call-with-budget.ts` does not
 * retry it. The two mistakes are not symmetric. Failing to retry a burst limit costs one
 * search result; retrying an exhausted plan costs requests that do not exist, on an account
 * that gets no more until the 1st. A stored reading saying requests *remain* is deliberately
 * not treated as permission to retry either: it may have been taken by an earlier call, and
 * "the last response we saw had headers" is not the same claim as "this response does".
 */

import { startOfNextMonthUtc } from './month-key';
import type { ReportedProviderQuota } from './reported-quota';

/** A wait this long is a closed window, not a rate limit to ride out. Matches
 * `rate-limit-headers.ts`'s own boundary between a burst window and a plan quota, so both
 * files draw the line in the same place. */
const LONG_WAIT_SECONDS = 3600;

/** RapidAPI's wording for an exhausted plan, matched on the two words that carry the
 * meaning so the sentence around them can change without this going blind. The captured
 * group is the period the provider named (`MONTHLY` on the one response we have). */
const EXHAUSTED_QUOTA_PATTERN = /exceeded the ([A-Za-z]+) quota/i;

export type RateLimitKind =
	/** A short window. Wait it out and ask again. */
	| 'burst'
	/** The plan's allowance is spent. Nothing before `resetsAt` can succeed. */
	| 'quota-exhausted'
	/** The response said nothing that tells the two apart. Treated as not worth retrying,
	 * see this file's header on why the two mistakes are not symmetric. */
	| 'unclassified';

export interface RateLimitVerdict {
	kind: RateLimitKind;
	/** Only `'burst'` is ever true. Kept as its own field so the retry loop reads a decision
	 * rather than re-deriving one from the kind. */
	retryable: boolean;
	/** Epoch millis the window reopens, when something in the response actually said so.
	 * Absent means nobody told us, which is reported as not knowing rather than guessed at. */
	resetsAt?: number;
	/** What decided this, in terms of what was actually read. Goes into the user-facing
	 * message, so it names header values and quotes provider text rather than asserting a
	 * cause nobody observed (AGENTS.md, "Show the error you got"). */
	evidence: string;
}

export interface RateLimitInput {
	/** The 429's own message, already carrying the provider's sentence (the clients build it
	 * with `describeProviderResponse`). */
	message: string;
	/** From a `Retry-After` header, when the provider sent a parseable one. */
	retryAfterSeconds?: number;
	/** The provider's last statement about its own quota, from `getReportedProviderQuota`.
	 * Absent whenever no response has ever carried readable `x-ratelimit-*` headers, which
	 * is the expected case until someone measures one from a browser. */
	reported?: ReportedProviderQuota;
	nowMs: number;
}

export function classifyRateLimit(input: RateLimitInput): RateLimitVerdict {
	const { message, retryAfterSeconds, reported, nowMs } = input;

	if (reported !== undefined && reported.remaining === 0) {
		const plan = reported.limit === undefined ? '' : ` of ${reported.limit}`;
		return {
			kind: 'quota-exhausted',
			retryable: false,
			resetsAt: reported.resetsAt,
			evidence: `${reported.headerNames.join(', ')} reported 0${plan} requests left on this key`
		};
	}

	const exhausted = EXHAUSTED_QUOTA_PATTERN.exec(message);
	if (exhausted !== null) {
		return {
			kind: 'quota-exhausted',
			retryable: false,
			// The provider's own `-reset` beats our calendar arithmetic when we have it. We
			// only fall back to the start of the next UTC month for a quota the provider
			// itself called monthly, which is the same assumption `month-key.ts` already
			// makes about a locally refused call. Any other period stays unknown rather than
			// becoming a date nobody stated.
			resetsAt: reported?.resetsAt ?? monthlyResetOf(exhausted[1], nowMs),
			evidence: `the response said "${exhausted[0]}"`
		};
	}

	if (retryAfterSeconds !== undefined && retryAfterSeconds >= LONG_WAIT_SECONDS) {
		return {
			kind: 'quota-exhausted',
			retryable: false,
			resetsAt: nowMs + retryAfterSeconds * 1000,
			evidence: `Retry-After asked for ${retryAfterSeconds} seconds`
		};
	}

	if (retryAfterSeconds !== undefined) {
		return { kind: 'burst', retryable: true, evidence: `Retry-After: ${retryAfterSeconds}` };
	}

	return {
		kind: 'unclassified',
		retryable: false,
		evidence: 'no Retry-After header and no quota reading from this key'
	};
}

function monthlyResetOf(period: string, nowMs: number): number | undefined {
	if (period.toUpperCase() !== 'MONTHLY') return undefined;
	return startOfNextMonthUtc(nowMs);
}

/**
 * The message a 429 that will not be retried carries: the provider's own words first, then
 * what we read into them and what it means for the user.
 *
 * Our half opens with "That 429" rather than a bare "That". The provider's sentence is
 * printed exactly as it arrived, which for RapidAPI means it ends in a bare URL with no full
 * stop, and a following word has to look like the start of a new sentence on its own.
 * Punctuating their text to make ours fit would be editing the evidence.
 *
 * A `'burst'` verdict never reaches here, because a burst 429 is either retried or reported
 * on its last attempt with nothing to add.
 */
export function describeRateLimit(providerMessage: string, verdict: RateLimitVerdict): string {
	if (verdict.kind === 'quota-exhausted') {
		const reset =
			verdict.resetsAt === undefined
				? 'The response did not say when it resets.'
				: `It resets ${new Date(verdict.resetsAt).toISOString()}.`;
		return `${providerMessage} That 429 is the plan's allowance, not a short rate limit (${verdict.evidence}), so nothing was retried. ${reset}`;
	}
	return `${providerMessage} That 429 was not retried, because there was ${verdict.evidence}, and a spent monthly quota looks exactly like a short rate limit without one.`;
}

/** Seconds from now until the window reopens, for `ProviderError.quota-exceeded`'s
 * `retryAfterSeconds`. Only ever derived from a reset instant something in the response
 * actually stated. */
export function secondsUntilReset(verdict: RateLimitVerdict, nowMs: number): number | undefined {
	if (verdict.resetsAt === undefined) return undefined;
	return Math.max(0, Math.round((verdict.resetsAt - nowMs) / 1000));
}
