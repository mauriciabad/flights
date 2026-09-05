/**
 * Issue #191, and this is the client that costs something today: it is the keyless default
 * flight source, so it runs for every visitor with no keys configured. `Kiwi returned HTTP
 * 403` was our sentence over a response nobody had read, which left the bot-wall 403 this
 * adapter's header documents looking identical to every other 403 the host can send.
 *
 * Reading the body does not diagnose that wall and is not meant to. It stops us throwing
 * away the only thing that could.
 */
import { describe, expect, it } from 'vitest';
import { fetchOneWayDirect } from './kiwi-public-client';

function fakeFetch(response: Response): typeof fetch {
	return (async () => response) as typeof fetch;
}

function call(response: Response) {
	return fetchOneWayDirect('query Q {}', {}, {
		signal: new AbortController().signal,
		fetchImpl: fakeFetch(response)
	});
}

describe('kiwi-public-client failures', () => {
	// `api.skypicker.com` answers a headless User-Agent with a 403 and no CORS headers
	// (measured 2026-09-04, this client's own header). A browser never reaches the body of
	// a CORS-blocked response, so what lands here is whatever a 403 with readable headers
	// carries — and whatever that is, it now travels instead of being replaced.
	it('quotes a 403 body instead of writing our own sentence over it', async () => {
		const result = await call(new Response('Forbidden', { status: 403 }));
		expect(result).toEqual({
			ok: false,
			error: {
				code: 'http-error',
				message: 'Kiwi.com (no key required) returned HTTP 403 with body: Forbidden',
				status: 403
			}
		});
	});

	it('says the body was empty rather than implying it read one', async () => {
		const result = await call(new Response(null, { status: 403 }));
		expect(result).toEqual({
			ok: false,
			error: {
				code: 'http-error',
				message: 'Kiwi.com (no key required) returned HTTP 403 with an empty body',
				status: 403
			}
		});
	});

	it('maps a 429 to rate-limited, quoting the body and reading Retry-After', async () => {
		const result = await call(
			new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), {
				status: 429,
				headers: { 'retry-after': '12' }
			})
		);
		expect(result).toEqual({
			ok: false,
			error: {
				code: 'rate-limited',
				message: 'Kiwi.com (no key required) returned HTTP 429: Rate limit exceeded',
				retryAfterSeconds: 12
			}
		});
	});

	// The shape issue #171 was opened over, on the sibling client: the sentence and the
	// `-error` header both used to be discarded, and the header was the only thing that
	// named the real cause.
	it('carries an -error response header alongside the sentence', async () => {
		const result = await call(
			new Response(JSON.stringify({ error: { code: '402', message: 'Payment required' } }), {
				status: 402,
				headers: { 'x-vercel-error': 'DEPLOYMENT_DISABLED' }
			})
		);
		expect(result).toEqual({
			ok: false,
			error: {
				code: 'http-error',
				message:
					'Kiwi.com (no key required) returned HTTP 402: Payment required; x-vercel-error: DEPLOYMENT_DISABLED',
				status: 402
			}
		});
	});

	// GraphQL's own failure mode: HTTP 200 with an `errors` array. The status belongs in
	// the message here for the same reason it does everywhere else — `200` carrying an
	// error is a different problem from a 4xx, and it is our own request that is wrong.
	it('keeps the status code on a 200 carrying a GraphQL error', async () => {
		const result = await call(
			new Response(JSON.stringify({ errors: [{ message: 'Cannot query field "nope"' }] }), { status: 200 })
		);
		expect(result).toEqual({
			ok: false,
			error: {
				code: 'malformed-response',
				message:
					'Kiwi.com (no key required) returned HTTP 200 with a GraphQL error: Cannot query field "nope"'
			}
		});
	});
});
