import { describe, expect, it } from 'vitest';
import { describeProviderResponse, readProviderResponse, readRetryAfterSeconds } from './response-evidence';

/**
 * Issue #171. Every shape below is one this repo has actually received, not a guess at what
 * a provider might send: docs/PROVIDERS.md and the adapters' own header comments are where
 * each came from. A shape nobody has measured deliberately returns no message, so the caller
 * quotes the raw body instead of matching a field that may not mean what we assume.
 */
describe('readProviderResponse', () => {
	it('reads the `message` field RapidAPI sends', async () => {
		const evidence = await readProviderResponse(
			new Response(JSON.stringify({ message: 'You are not subscribed to this API.' }), { status: 403 })
		);

		expect(evidence.status).toBe(403);
		expect(evidence.message).toBe('You are not subscribed to this API.');
	});

	it('reads the nested `error.message` the live Kiwi listing sends', async () => {
		const evidence = await readProviderResponse(
			new Response(JSON.stringify({ error: { code: '402', message: 'Payment required' } }), { status: 402 })
		);

		expect(evidence.message).toBe('Payment required');
	});

	it('reads the `errors` object a Flights Sky price-calendar failure sends instead', async () => {
		const evidence = await readProviderResponse(
			new Response(JSON.stringify({ errors: { departDate: 'The departDate field is required.' } }), {
				status: 400
			})
		);

		expect(evidence.message).toBe('{"departDate":"The departDate field is required."}');
	});

	// Issue #203. Measured against `api.m.hostelworld.com` on 2026-09-05 from a real page
	// origin: `currency=CVE` answers with exactly this body and this status.
	it("reads the `description` list Hostelworld sends with a 4xx", async () => {
		const evidence = await readProviderResponse(
			new Response(
				JSON.stringify({
					description: [{ code: '90593', message: 'please pass valid currency three letter code' }]
				}),
				{ status: 400 }
			)
		);

		expect(evidence.status).toBe(400);
		expect(evidence.message).toBe('please pass valid currency three letter code');
	});

	// Same measurement, `currency=CVE&show-rooms=0`: one request wrong in two ways gets two
	// entries back. Taking the first would report half of what the provider said.
	it('joins every complaint in that list rather than taking the first', async () => {
		const evidence = await readProviderResponse(
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

		expect(evidence.message).toBe(
			'show-rooms should be positive integer; please pass valid currency three letter code'
		);
	});

	it('collects the `*-error` headers that name a cause our own message never could', async () => {
		const evidence = await readProviderResponse(
			new Response('{}', { status: 402, headers: { 'X-Vercel-Error': 'DEPLOYMENT_DISABLED' } })
		);

		expect(evidence.errorHeaders).toEqual({ 'x-vercel-error': 'DEPLOYMENT_DISABLED' });
	});

	it('keeps a non-JSON body as a one-line excerpt, since that is all there is to quote', async () => {
		const evidence = await readProviderResponse(
			new Response('<html>\n  <body>502 Bad Gateway</body>\n</html>', { status: 502 })
		);

		expect(evidence.message).toBeUndefined();
		expect(evidence.bodyText).toBe('<html> <body>502 Bad Gateway</body> </html>');
		expect(evidence.body).toBeUndefined();
	});

	it('truncates a body too long to be a quote', async () => {
		const evidence = await readProviderResponse(new Response('x'.repeat(1_000), { status: 500 }));

		expect(evidence.bodyText).toHaveLength(301);
		expect(evidence.bodyText.endsWith('…')).toBe(true);
	});

	it('reports an empty body as empty rather than as nothing', async () => {
		const evidence = await readProviderResponse(new Response(null, { status: 503 }));

		expect(evidence.message).toBeUndefined();
		expect(evidence.bodyText).toBe('');
	});

	it('ignores a `message` that is not a usable string', async () => {
		const evidence = await readProviderResponse(
			new Response(JSON.stringify({ message: '   ', status: false }), { status: 200 })
		);

		expect(evidence.message).toBeUndefined();
	});
});

describe('describeProviderResponse', () => {
	it('puts the status and the sentence the provider sent in one line', async () => {
		const evidence = await readProviderResponse(
			new Response(JSON.stringify({ status: false, message: 'The location cannot be empty' }), { status: 200 })
		);

		// AGENTS.md's own example of the shape the owner asked for, after a 200 carrying an
		// error body was read as a plain success for hours.
		expect(describeProviderResponse('Agoda', evidence)).toBe(
			'Agoda returned HTTP 200: The location cannot be empty'
		);
	});

	it('appends the error headers, which is where the real Kiwi cause was hiding', async () => {
		const evidence = await readProviderResponse(
			new Response(JSON.stringify({ error: { message: 'Payment required' } }), {
				status: 402,
				headers: { 'x-vercel-error': 'DEPLOYMENT_DISABLED' }
			})
		);

		expect(describeProviderResponse('Kiwi.com (RapidAPI)', evidence)).toBe(
			'Kiwi.com (RapidAPI) returned HTTP 402: Payment required; x-vercel-error: DEPLOYMENT_DISABLED'
		);
	});

	it('quotes the body when there is no message field to quote', async () => {
		const evidence = await readProviderResponse(new Response('Service Unavailable', { status: 503 }));

		expect(describeProviderResponse('Booking', evidence)).toBe(
			'Booking returned HTTP 503 with body: Service Unavailable'
		);
	});

	it('says the body was empty rather than inventing a reason for the status', async () => {
		const evidence = await readProviderResponse(new Response(null, { status: 429 }));

		expect(describeProviderResponse('Sky Scrapper', evidence)).toBe(
			'Sky Scrapper returned HTTP 429 with an empty body'
		);
	});
});

describe('readRetryAfterSeconds', () => {
	it('reads a plain second count', () => {
		expect(readRetryAfterSeconds(new Headers({ 'retry-after': '30' }))).toBe(30);
	});

	it('is undefined with no header at all', () => {
		expect(readRetryAfterSeconds(new Headers())).toBeUndefined();
	});

	// An HTTP-date `Retry-After` is legal and nothing here has ever received one. Reading it
	// as "the provider said nothing" makes `call-with-budget.ts` decline to retry, which is
	// the direction that cannot spend requests the owner's account does not have.
	it('is undefined for the HTTP-date form, and for anything else unparseable', () => {
		expect(readRetryAfterSeconds(new Headers({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }))).toBeUndefined();
		expect(readRetryAfterSeconds(new Headers({ 'retry-after': '' }))).toBeUndefined();
		expect(readRetryAfterSeconds(new Headers({ 'retry-after': '-5' }))).toBeUndefined();
	});
});
