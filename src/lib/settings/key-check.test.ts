import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_ISSUE_COPY } from '$lib/components';
import {
	clearInFlightForTests,
	getProviderQuotaSnapshot,
	getReportedProviderQuota,
	resetPermanentFailuresForTests,
	setProviderCapOverride
} from '$lib/providers/budget';
import { checkProviderKey } from './key-check';
import { SETTINGS_PROVIDERS } from './provider-catalog';

const skyscanner = SETTINGS_PROVIDERS.find((p) => p.id === 'skyscanner')!;
const agoda = SETTINGS_PROVIDERS.find((p) => p.id === 'agoda')!;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers });
}

// This module now routes every check through issue #22's shared request budget
// (`src/lib/providers/budget/`), which tracks monthly usage in `localStorage` and
// remembers a "not subscribed" verdict in an in-memory, per-session `Set` — both of
// which persist across `it()` blocks in the same file unless reset here, exactly like a
// real page reload would reset the in-memory half but not the persisted half.
beforeEach(() => {
	localStorage.clear();
	resetPermanentFailuresForTests();
	clearInFlightForTests();
});

describe('checkProviderKey', () => {
	it('reports missing-key without making a network call', async () => {
		const fetchImpl = vi.fn();
		const outcome = await checkProviderKey(skyscanner, '', new AbortController().signal, fetchImpl);
		expect(outcome).toMatchObject({ ok: false, reason: 'missing-key' });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('reports missing-key for a whitespace-only key', async () => {
		const fetchImpl = vi.fn();
		const outcome = await checkProviderKey(skyscanner, '   ', new AbortController().signal, fetchImpl);
		expect(outcome).toMatchObject({ ok: false, reason: 'missing-key' });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('sends the key and host as RapidAPI headers, never as a query string', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { status: true }));
		await checkProviderKey(skyscanner, 'sk-secret-1234', new AbortController().signal, fetchImpl);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0];
		expect(String(url)).not.toContain('sk-secret-1234');
		expect(init.headers).toMatchObject({
			'x-rapidapi-key': 'sk-secret-1234',
			'x-rapidapi-host': 'sky-scrapper.p.rapidapi.com'
		});
	});

	it('reports ok on a 2xx response', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { status: true, data: [] }));
		const outcome = await checkProviderKey(skyscanner, 'sk-1', new AbortController().signal, fetchImpl);
		expect(outcome.ok).toBe(true);
	});

	/**
	 * Issue #122: Agoda's own RapidAPI wrapper answers a malformed request with HTTP 200
	 * and `{"status":false,"message":"..."}` rather than a 4xx (confirmed live against
	 * this exact host). A blanket `response.ok` check reads that as success; nothing here
	 * ever fabricated "not subscribed" from it, but both failure modes are real and this
	 * is the regression test for the one this codebase actually had.
	 */
	it('never reports success for a 200 with an application-level status:false body', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse(200, { status: false, message: 'The location cannot be empty' }));
		const outcome = await checkProviderKey(agoda, 'sk-real-but-malformed-request', new AbortController().signal, fetchImpl);
		expect(outcome.ok).toBe(false);
	});

	it('never classifies a 200 with status:false as not-subscribed, even one that talks about subscriptions', async () => {
		// Deliberately phrased to look like the real RapidAPI wording — proving the
		// classifier keys off the HTTP status, never the message text alone.
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse(200, { status: false, message: 'This account is not subscribed to that feature.' }));
		const outcome = await checkProviderKey(agoda, 'sk-real-but-malformed-request', new AbortController().signal, fetchImpl);
		expect(outcome).toMatchObject({ ok: false, reason: 'unknown' });
	});

	it("gives a 200 with status:false its own outcome, showing the provider's exact message and status verbatim", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse(200, { status: false, message: 'The location cannot be empty' }));
		const outcome = await checkProviderKey(agoda, 'sk-real-but-malformed-request', new AbortController().signal, fetchImpl);
		if (outcome.ok) throw new Error('unreachable');
		expect(outcome.reason).toBe('unknown');
		expect(outcome.message).toBe('The location cannot be empty');
		expect(outcome.providerResponse).toEqual({ status: 200, message: 'The location cannot be empty' });
	});

	it('classifies not-subscribed only from a 403 carrying RapidAPI\'s literal message, never a 200', async () => {
		const notSubscribed403 = await checkProviderKey(
			skyscanner,
			'sk-real-but-unsubscribed',
			new AbortController().signal,
			vi.fn().mockResolvedValue(jsonResponse(403, { message: 'You are not subscribed to this API.' }))
		);
		expect(notSubscribed403).toMatchObject({ ok: false, reason: 'not-subscribed' });

		const sameWording200 = await checkProviderKey(
			agoda,
			'sk-real-but-unsubscribed',
			new AbortController().signal,
			vi.fn().mockResolvedValue(jsonResponse(200, { status: false, message: 'You are not subscribed to this API.' }))
		);
		expect(sameWording200).toMatchObject({ ok: false, reason: 'unknown' });
	});

	it('attaches the raw HTTP status and message to a not-subscribed outcome alongside its own headline', async () => {
		const outcome = await checkProviderKey(
			skyscanner,
			'sk-real-but-unsubscribed',
			new AbortController().signal,
			vi.fn().mockResolvedValue(jsonResponse(403, { message: 'You are not subscribed to this API.' }))
		);
		if (outcome.ok) throw new Error('unreachable');
		// Our own headline still leads, and still names the real fix.
		expect(outcome.message.toLowerCase()).toContain('subscribed');
		// The evidence underneath it is the provider's own words, not a paraphrase.
		expect(outcome.providerResponse).toEqual({ status: 403, message: 'You are not subscribed to this API.' });
	});

	it('carries no providerResponse when no request was ever sent (missing key, or the local quota cap)', async () => {
		const missingKey = await checkProviderKey(skyscanner, '', new AbortController().signal, vi.fn());
		if (missingKey.ok) throw new Error('unreachable');
		expect(missingKey.providerResponse).toBeUndefined();

		setProviderCapOverride('flights-sky', 0);
		const capped = await checkProviderKey(
			SETTINGS_PROVIDERS.find((p) => p.id === 'flights-sky')!,
			'sk-1',
			new AbortController().signal,
			vi.fn()
		);
		if (capped.ok) throw new Error('unreachable');
		expect(capped.reason).toBe('quota-exceeded');
		expect(capped.providerResponse).toBeUndefined();
	});

	it('classifies "You are not subscribed to this API." as not-subscribed', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse(403, { message: 'You are not subscribed to this API.' }));
		const outcome = await checkProviderKey(skyscanner, 'sk-real-but-unsubscribed', new AbortController().signal, fetchImpl);
		expect(outcome).toMatchObject({ ok: false, reason: 'not-subscribed' });
	});

	it('classifies "Invalid API key." as invalid-key, a different reason than not-subscribed', async () => {
		// A different provider than the not-subscribed test above: issue #22's budget
		// module remembers "not subscribed" per provider id for the rest of the session,
		// so reusing the same id here would short-circuit on that memory instead of
		// exercising this scenario's own fetch mock.
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403, { message: 'Invalid API key.' }));
		const outcome = await checkProviderKey(agoda, 'not-a-real-key', new AbortController().signal, fetchImpl);
		expect(outcome).toMatchObject({ ok: false, reason: 'invalid-key' });
	});

	/**
	 * The one behaviour issue #29 exists to get right: a valid-but-unsubscribed key and an
	 * outright invalid key both arrive as HTTP 403, but need different fixes (subscribe on
	 * RapidAPI vs. paste a different key) — see docs/PROVIDERS.md and the module doc on
	 * key-check.ts. This asserts the two outcomes above actually render differently, not
	 * just carry a different internal tag nobody looks at.
	 */
	it('gives "not subscribed" and "invalid key" different copy and different remediation', async () => {
		const notSubscribed = await checkProviderKey(
			skyscanner,
			'sk-real-but-unsubscribed',
			new AbortController().signal,
			vi.fn().mockResolvedValue(jsonResponse(403, { message: 'You are not subscribed to this API.' }))
		);
		const invalidKey = await checkProviderKey(
			agoda,
			'not-a-real-key',
			new AbortController().signal,
			vi.fn().mockResolvedValue(jsonResponse(403, { message: 'Invalid API key.' }))
		);

		if (notSubscribed.ok || invalidKey.ok) throw new Error('unreachable');
		expect(PROVIDER_ISSUE_COPY['not-subscribed']).not.toBe(PROVIDER_ISSUE_COPY['invalid-key']);
		expect(notSubscribed.message).not.toBe(invalidKey.message);
		// The not-subscribed fix is "go subscribe," never phrased as a key problem.
		expect(notSubscribed.message.toLowerCase()).not.toContain('invalid');
		// The invalid-key fix must not tell someone whose key is merely unsubscribed to
		// re-paste it — that would send them in exactly the wrong direction.
		expect(invalidKey.message.toLowerCase()).not.toContain('subscri');
	});

	it('classifies a bare 401 as invalid-key', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { message: 'Unauthorized' }));
		const outcome = await checkProviderKey(skyscanner, 'bad-key', new AbortController().signal, fetchImpl);
		expect(outcome).toMatchObject({ ok: false, reason: 'invalid-key' });
	});

	it('classifies an unrecognised 403 message as unknown rather than guessing', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403, { message: 'Forbidden by WAF rule 42' }));
		const outcome = await checkProviderKey(skyscanner, 'sk-1', new AbortController().signal, fetchImpl);
		expect(outcome).toMatchObject({ ok: false, reason: 'unknown' });
	});

	it('classifies an upstream 429 as quota-exceeded and carries retry-after when present', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse(429, { message: 'quota' }, { 'retry-after': '30' }));
		const outcome = await checkProviderKey(skyscanner, 'sk-1', new AbortController().signal, fetchImpl);
		expect(outcome).toMatchObject({ ok: false, reason: 'quota-exceeded', retryAfterSeconds: 30 });
	});

	it('refuses locally as quota-exceeded once the shared monthly cap for this provider is spent, without a network call', async () => {
		// Issue #69 fixed `providers/budget/caps.ts` to key `DEFAULT_PROVIDER_CAPS` by each
		// adapter's own id (`agoda`, matching this catalog and the real adapter) rather than
		// RapidAPI's host slugs, so Agoda's real tuned cap (400) is what applies by default
		// now — too many real checks to spend in a fast test. `setProviderCapOverride`
		// simulates "the shared budget is already at its cap" directly instead.
		setProviderCapOverride('agoda', 1);
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { status: true }));
		const first = await checkProviderKey(agoda, 'sk-1', new AbortController().signal, fetchImpl);
		expect(first.ok).toBe(true);
		fetchImpl.mockClear();

		const refused = await checkProviderKey(agoda, 'sk-1', new AbortController().signal, fetchImpl);
		expect(refused).toMatchObject({ ok: false, reason: 'quota-exceeded' });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('does not retry an invalid key, spending only one request', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403, { message: 'Invalid API key.' }));
		await checkProviderKey(skyscanner, 'bad-key', new AbortController().signal, fetchImpl);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('remembers "not subscribed" for the rest of the session and stops calling the network', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse(403, { message: 'You are not subscribed to this API.' }));
		await checkProviderKey(skyscanner, 'sk-1', new AbortController().signal, fetchImpl);
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		fetchImpl.mockClear();
		const second = await checkProviderKey(skyscanner, 'sk-1', new AbortController().signal, fetchImpl);
		expect(second).toMatchObject({ ok: false, reason: 'not-subscribed' });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('classifies a thrown fetch failure as down, not invalid-key', async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
		const outcome = await checkProviderKey(skyscanner, 'sk-1', new AbortController().signal, fetchImpl);
		expect(outcome).toMatchObject({ ok: false, reason: 'down' });
	});

	it('never includes the raw key in the returned message', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse(403, { message: 'You are not subscribed to this API.' }));
		const outcome = await checkProviderKey(skyscanner, 'sk-super-secret-value', new AbortController().signal, fetchImpl);
		expect(JSON.stringify(outcome)).not.toContain('sk-super-secret-value');
	});
});

/**
 * Issue #146. Pressing Test is the one moment a person deliberately asks "where does my
 * key stand", and it is also the moment this app spends one of the requests it is asking
 * about — so a check that throws away RapidAPI's own answer wastes the most informative
 * response the app ever receives.
 */
describe('checkProviderKey and the account’s own quota', () => {
	it('records the remaining quota the provider reported on the check response', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse(
				200,
				{ status: true, data: [] },
				{
					'x-ratelimit-requests-limit': '20',
					'x-ratelimit-requests-remaining': '19',
					'x-ratelimit-requests-reset': '1209600'
				}
			)
		);
		const outcome = await checkProviderKey(skyscanner, 'sk-1', new AbortController().signal, fetchImpl);

		expect(outcome.ok).toBe(true);
		expect(getReportedProviderQuota('skyscanner')).toMatchObject({ limit: 20, remaining: 19 });
	});

	it('lets a check on a fresh browser learn the month is already gone', async () => {
		// The whole point of the issue: this profile has counted nothing, so its own cap
		// would happily allow another 15 requests. Sky Scrapper says 2 of its 20 are left.
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				jsonResponse(200, { status: true }, { 'x-ratelimit-requests-limit': '20', 'x-ratelimit-requests-remaining': '2' })
			);
		await checkProviderKey(skyscanner, 'sk-1', new AbortController().signal, fetchImpl);

		const snapshot = getProviderQuotaSnapshot('skyscanner');
		expect(snapshot.locallyCounted).toBe(1);
		expect(snapshot.used).toBe(18);
		expect(snapshot.remaining).toBe(0);
	});

	it('refuses the next check once the provider has said the key is empty', async () => {
		const emptied = vi
			.fn()
			.mockResolvedValue(
				jsonResponse(200, { status: true }, { 'x-ratelimit-requests-limit': '20', 'x-ratelimit-requests-remaining': '0' })
			);
		await checkProviderKey(skyscanner, 'sk-1', new AbortController().signal, emptied);
		clearInFlightForTests();

		const secondFetch = vi.fn();
		const outcome = await checkProviderKey(skyscanner, 'sk-1', new AbortController().signal, secondFetch);

		expect(secondFetch).not.toHaveBeenCalled();
		expect(outcome).toMatchObject({ ok: false, reason: 'quota-exceeded' });
		expect(outcome.ok === false && outcome.message).toContain('itself reported 0 of 20 requests left');
	});
});
