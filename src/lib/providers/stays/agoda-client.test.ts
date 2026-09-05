/**
 * Issue #191, and the one wrinkle this client has that its siblings do not: `getJson` here
 * serves two unrelated hosts, the metered Agoda listing and keyless Nominatim. So the
 * failure message has to name the host that was actually asked, or a Nominatim outage
 * arrives labelled "Agoda" and sends the next reader to the wrong file.
 */
import { describe, expect, it } from 'vitest';
import { fetchOvernightStaysSearch, fetchReverseGeocode } from './agoda-client';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers });
}

function fakeFetch(response: Response): typeof fetch {
	return (async () => response) as typeof fetch;
}

const search = { location: 'London', checkinDate: '2026-10-06', checkoutDate: '2026-10-09' };

function agodaDeps(response: Response) {
	return { signal: new AbortController().signal, apiKey: 'k', fetchImpl: fakeFetch(response) };
}

describe('agoda-client failures', () => {
	it('maps the recorded 403 body to not-subscribed and quotes it with its status', async () => {
		const result = await fetchOvernightStaysSearch(
			search,
			agodaDeps(jsonResponse(403, { message: 'You are not subscribed to this API.' }))
		);
		expect(result).toEqual({
			ok: false,
			error: {
				code: 'not-subscribed',
				message: 'Agoda returned HTTP 403: You are not subscribed to this API.',
				status: 403
			}
		});
	});

	// `not-subscribed` is permanent for the session (budget/permanent-failures.ts). Handing
	// it to every 403 is how a rate limit at the gateway became "your account is not
	// subscribed" in AGENTS.md's issue #122 story.
	it('does not call an unrelated 403 not-subscribed, and still says what came back', async () => {
		const result = await fetchOvernightStaysSearch(
			search,
			agodaDeps(jsonResponse(403, { message: 'Too many requests from this IP' }))
		);
		expect(result).toEqual({
			ok: false,
			error: {
				code: 'http-error',
				message: 'Agoda returned HTTP 403: Too many requests from this IP',
				status: 403
			}
		});
	});

	it('maps a 429 to rate-limited, keeping the quota sentence and Retry-After', async () => {
		const result = await fetchOvernightStaysSearch(
			search,
			agodaDeps(jsonResponse(429, { message: 'Too Many Requests' }, { 'retry-after': '30' }))
		);
		expect(result).toEqual({
			ok: false,
			error: {
				code: 'rate-limited',
				message: 'Agoda returned HTTP 429: Too Many Requests',
				status: 429,
				retryAfterSeconds: 30
			}
		});
	});

	// Nominatim's usage policy says it may hand back a 403 to an unidentified client. That
	// is not an Agoda failure and must not read as one — nor as a missing subscription,
	// since there is nothing to subscribe to.
	it("names Nominatim, not Agoda, when the geocoder is the host that failed", async () => {
		const result = await fetchReverseGeocode(
			{ latitude: 48.11, longitude: 16.57 },
			{
				signal: new AbortController().signal,
				fetchImpl: fakeFetch(new Response('Access blocked', { status: 403 }))
			}
		);
		expect(result).toEqual({
			ok: false,
			error: {
				code: 'http-error',
				message: 'Nominatim returned HTTP 403 with body: Access blocked',
				status: 403
			}
		});
	});

	// AGENTS.md's own example of the shape the owner asked for: "Agoda returned 200 with:
	// The location cannot be empty". Measured live 2026-09-04 against this exact endpoint.
	it('keeps the status code on the 200 that carries an error body', async () => {
		const result = await fetchOvernightStaysSearch(
			search,
			agodaDeps(jsonResponse(200, { status: false, message: 'The location cannot be empty' }))
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain('HTTP 200');
			expect(result.error.message).toContain('The location cannot be empty');
		}
	});
});
