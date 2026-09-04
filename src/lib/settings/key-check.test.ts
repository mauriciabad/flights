import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_ISSUE_COPY } from '$lib/components';
import { clearInFlightForTests, resetPermanentFailuresForTests } from '$lib/providers/budget';
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
		// Agoda's declared quota is generous (docs/PROVIDERS.md: 500/month) but this
		// provider id isn't one `providers/budget/caps.ts` recognises yet (that module's
		// cap table still keys on RapidAPI's host slugs, e.g. "agoda-com", rather than the
		// brand-style ids this catalog and the real Skyscanner adapter use — filed as
		// issue #69), so it falls back to `FALLBACK_PROVIDER_CAP` (10) today. Ten cheap,
		// successful checks exhausts it.
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { status: true }));
		for (let i = 0; i < 10; i++) {
			const outcome = await checkProviderKey(agoda, 'sk-1', new AbortController().signal, fetchImpl);
			expect(outcome.ok).toBe(true);
		}
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
