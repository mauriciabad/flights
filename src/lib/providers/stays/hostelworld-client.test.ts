/**
 * Issue #203: when the keyless bed source fails, its own sentence and status code are what
 * the stopover note has to carry. This is the file that has to produce them.
 *
 * Every 4xx body below was measured against `api.m.hostelworld.com` on 2026-09-05, from a
 * real page origin in an own Chromium, which costs nothing and belongs to nobody: this host
 * has no key, no account and no quota (see hostelworld-client.ts's header).
 */
import { describe, expect, it } from 'vitest';
import { fetchCityProperties } from './hostelworld-client';

function fakeFetch(response: Response): typeof fetch {
	return (async () => response) as typeof fetch;
}

const params = {
	cityId: 3,
	currency: 'EUR',
	dateStart: '2026-10-06',
	numNights: 1,
	guests: 1,
	perPage: 2
};

function call(response: Response) {
	return fetchCityProperties(params, {
		signal: new AbortController().signal,
		fetchImpl: fakeFetch(response)
	});
}

describe('hostelworld-client failures', () => {
	// Measured: `currency=CVE` answers exactly this.
	it("quotes Hostelworld's own complaint with the status it came with", async () => {
		const result = await call(
			new Response(
				JSON.stringify({
					description: [{ code: '90593', message: 'please pass valid currency three letter code' }]
				}),
				{ status: 400 }
			)
		);
		expect(result).toEqual({
			ok: false,
			error: {
				code: 'http-error',
				message: 'Hostelworld returned HTTP 400: please pass valid currency three letter code',
				status: 400
			}
		});
	});

	// Measured: `currency=CVE&show-rooms=0` answers with both complaints in one body.
	// Keeping only the first would be us editing the provider's answer down to the half we
	// happened to read.
	it('keeps every complaint when one request is wrong in two ways', async () => {
		const result = await call(
			new Response(
				JSON.stringify({
					description: [
						{ code: '90597', message: 'show-rooms should be positive integer' },
						{ code: '90593', message: 'please pass valid currency three letter code' }
					]
				}),
				{ status: 400 }
			)
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toBe(
				'Hostelworld returned HTTP 400: show-rooms should be positive integer; please pass valid currency three letter code'
			);
		}
	});

	// The case the old private helper could not report at all: it parsed with
	// `response.json()`, which throws on HTML, so a gateway between us and Hostelworld
	// arrived as a bare "Hostelworld returned HTTP 502" with the page thrown away.
	it('quotes an HTML error page instead of dropping it', async () => {
		const result = await call(
			new Response('<html>\n  <body>\n    <h1>502 Bad Gateway</h1>\n  </body>\n</html>', { status: 502 })
		);
		expect(result).toEqual({
			ok: false,
			error: {
				code: 'http-error',
				message: 'Hostelworld returned HTTP 502 with body: <html> <body> <h1>502 Bad Gateway</h1> </body> </html>',
				status: 502
			}
		});
	});

	// This branch used to write `Hostelworld rate-limited this request (HTTP 429)` without
	// reading anything at all.
	it('maps a 429 to rate-limited, quoting the body and reading Retry-After', async () => {
		const result = await call(
			new Response('slow down', { status: 429, headers: { 'retry-after': '45' } })
		);
		expect(result).toEqual({
			ok: false,
			error: {
				code: 'rate-limited',
				message: 'Hostelworld returned HTTP 429 with body: slow down',
				retryAfterSeconds: 45
			}
		});
	});

	it('says the body was empty rather than implying it read one', async () => {
		const result = await call(new Response(null, { status: 503 }));
		expect(result).toEqual({
			ok: false,
			error: {
				code: 'http-error',
				message: 'Hostelworld returned HTTP 503 with an empty body',
				status: 503
			}
		});
	});
});
