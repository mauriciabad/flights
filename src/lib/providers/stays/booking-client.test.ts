/**
 * Issue #191: every failed response out of this client quotes Booking's own sentence and
 * its status code. The two branches that did not used to write `Request to <the whole
 * RapidAPI URL> returned HTTP 403`, which puts a query string in an error badge and leaves
 * out the only part of the answer a reader could act on.
 *
 * Every body below is a shape this repo has recorded rather than one invented here:
 * `403 {"message":"You are not subscribed to this API."}` is docs/prompts/003-conventions.md
 * (five RapidAPI hosts, all identical), the 429 wording is the gateway's own quota
 * sentence, and `{"status":false,"message":"…"}` is the `200`-with-an-error-body shape
 * AGENTS.md is written from.
 */
import { describe, expect, it } from 'vitest';
import { fetchGetRoomList, fetchSearchHotelsByCoordinates } from './booking-client';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers });
}

function fakeFetch(response: Response): typeof fetch {
	return (async () => response) as typeof fetch;
}

const search = {
	latitude: 51.15,
	longitude: -0.18,
	radiusKm: 12,
	checkinDate: '2026-10-06',
	checkoutDate: '2026-10-09'
};

function deps(response: Response) {
	return { signal: new AbortController().signal, apiKey: 'k', fetchImpl: fakeFetch(response) };
}

describe('booking-client failures', () => {
	it('maps the recorded 403 body to not-subscribed and quotes it with its status', async () => {
		const result = await fetchSearchHotelsByCoordinates(
			search,
			deps(jsonResponse(403, { message: 'You are not subscribed to this API.' }))
		);
		expect(result).toEqual({
			ok: false,
			error: {
				code: 'not-subscribed',
				message: 'Booking.com returned HTTP 403: You are not subscribed to this API.',
				status: 403
			}
		});
	});

	// The defect behind AGENTS.md's issue #122 story, in the one place it could still
	// happen. `not-subscribed` is permanent for the session, so a 403 that means something
	// else used to kill the provider for good AND tell the owner his account was
	// unsubscribed when it was not.
	it('does not call an unrelated 403 not-subscribed, and still says what came back', async () => {
		const result = await fetchSearchHotelsByCoordinates(
			search,
			deps(jsonResponse(403, { message: 'Request blocked by the gateway' }))
		);
		expect(result).toEqual({
			ok: false,
			error: {
				code: 'http-error',
				message: 'Booking.com returned HTTP 403: Request blocked by the gateway',
				status: 403
			}
		});
	});

	it('maps a 429 to rate-limited, keeping the quota sentence and Retry-After', async () => {
		const result = await fetchGetRoomList(
			{ hotelId: 1, checkinDate: '2026-10-06', checkoutDate: '2026-10-09', adults: 1 },
			deps(
				jsonResponse(
					429,
					{ message: 'You have exceeded the MONTHLY quota for Requests on your current plan, BASIC.' },
					{ 'retry-after': '60' }
				)
			)
		);
		expect(result).toEqual({
			ok: false,
			error: {
				code: 'rate-limited',
				message:
					'Booking.com returned HTTP 429: You have exceeded the MONTHLY quota for Requests on your current plan, BASIC.',
				status: 429,
				retryAfterSeconds: 60
			}
		});
	});

	// The excerpt is what tells a gateway's HTML page apart from the API answering in JSON,
	// and `response.json()` would have thrown here and left nothing to quote.
	it('quotes a non-JSON body rather than reporting only the status', async () => {
		const result = await fetchSearchHotelsByCoordinates(
			search,
			deps(new Response('<html><body>  502 Bad   Gateway </body></html>', { status: 502 }))
		);
		expect(result).toEqual({
			ok: false,
			error: {
				code: 'http-error',
				message: 'Booking.com returned HTTP 502 with body: <html><body> 502 Bad Gateway </body></html>',
				status: 502
			}
		});
	});

	// The exact reading that went missing in issue #122: a `200` carrying an error body is
	// a malformed request of ours, and a message that omits the status looks identical to a
	// 4xx from the provider.
	it('keeps the status code on a 200 that carries an error body', async () => {
		const result = await fetchSearchHotelsByCoordinates(
			search,
			deps(jsonResponse(200, { status: false, message: 'The location cannot be empty' }))
		);
		expect(result).toEqual({
			ok: false,
			error: {
				code: 'malformed-response',
				message: 'Booking.com returned HTTP 200 rejecting the request: The location cannot be empty'
			}
		});
	});
});
