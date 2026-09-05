/**
 * Reads a failed provider response so the app can repeat what the provider said instead of
 * paraphrasing it.
 *
 * AGENTS.md, "Show the error you got, never the one you assumed": surface the provider's own
 * message and status code verbatim, and put our classification on top of that, never in
 * place of it. Issue #171 is the search path failing to do this. Two clients branched on
 * `response.status` and wrote a sentence of their own without ever reading the body, so
 * `402 {"error":{"code":"402","message":"Payment required"}}` with `x-vercel-error:
 * DEPLOYMENT_DISABLED` reached the traveller as "Kiwi returned HTTP 402" and reached the
 * next developer as nothing at all.
 *
 * The body is read as text first and parsed second, on purpose. `response.json()` throws on
 * an HTML error page and leaves nothing to quote, which is the case where quoting matters
 * most: a gateway returning a 502 HTML page is a different problem from one returning a
 * JSON `{"message":"..."}`, and the excerpt is what tells them apart.
 */

/** Long enough for any provider error sentence measured so far (RapidAPI's longest, the
 * MONTHLY quota one, is 137 characters) and short enough that an HTML error page does not
 * fill an error badge. The excerpt is a quote, not an archive. The parsed body travels on
 * `ProviderError.cause` for anyone who needs the whole thing. */
const MAX_BODY_CHARS = 300;

/** Matches `x-vercel-error`, the header that named the real cause of Kiwi's 402 (a Vercel
 * deployment its owner had taken offline) while our own message said only "HTTP 402".
 * Matched by shape rather than from a fixed list, the same discipline
 * `budget/rate-limit-headers.ts` applies to `x-ratelimit-*`, so a gateway spelling its own
 * error header differently is still quoted rather than dropped.
 *
 * A browser only sees a cross-origin response header the server names in
 * `Access-Control-Expose-Headers`, so an empty result here means "nothing was exposed to
 * us", never "the provider sent nothing". */
const ERROR_HEADER_PATTERN = /-error$/;

/** What a provider actually sent, with nothing invented and nothing dropped. */
export interface ProviderResponseEvidence {
	status: number;
	/** The provider's own sentence, verbatim, when the body carried one in a shape
	 * `messageFrom` recognises. Never a sentence of ours. */
	message?: string;
	/** The body exactly as it arrived, whitespace collapsed and truncated. Empty string when
	 * the response had no body or the stream could not be read. */
	bodyText: string;
	/** The parsed body when it was JSON, `undefined` when it was not. */
	body?: unknown;
	/** Every readable response header whose name ends in `-error`, lowercased. */
	errorHeaders: Record<string, string>;
}

async function safeReadText(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		// A body that cannot be read is one more thing we do not know, not a crash: the
		// status code alone is still worth reporting.
		return '';
	}
}

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return undefined;
	}
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
	const value = record[field];
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Hostelworld reports one failed request as a LIST of complaints, so all of them are
 * joined rather than the first one taken. Measured 2026-09-05 from a real page origin: one
 * request wrong in two ways answers `400 {"description":[{"code":"90597","message":
 * "show-rooms should be positive integer"},{"code":"90593","message":"please pass valid
 * currency three letter code"}]}`. Taking the first would be us editing the provider's
 * answer down to the half we happened to read. */
function describedMessages(description: unknown): string | undefined {
	if (!Array.isArray(description)) return undefined;
	const messages = description
		.map((entry) => (entry as { message?: unknown } | null)?.message)
		.filter((text): text is string => typeof text === 'string' && text.trim().length > 0);
	return messages.length > 0 ? messages.join('; ') : undefined;
}

/**
 * Pulls the provider's own sentence out of a parsed body, trying every error shape this
 * repo has actually measured, in the order it measured them:
 *
 * - `{"message":"You are not subscribed to this API."}`, RapidAPI's gateway, on all five
 *   hosts docs/PROVIDERS.md profiled, and the same field Agoda and Booking use for their
 *   `200`-with-`status:false` application errors.
 * - `{"error":{"code":"402","message":"Payment required"}}`, the live Kiwi.com listing,
 *   the exact shape issue #171 says we were discarding.
 * - `{"error":"..."}`, the flatter variant of the same.
 * - `{"errors":...}`, Flights Sky's `price-calendar` validation failures, as a string or
 *   an object keyed by field name (flights-sky-client.ts found both).
 * - `{"description":[{"code":"90593","message":"..."}]}`, Hostelworld's own 4xx shape,
 *   re-measured against `api.m.hostelworld.com` on 2026-09-05 by asking for `currency=CVE`:
 *   `400 {"description":[{"code":"90593","message":"please pass valid currency three letter
 *   code"}]}`. It used to be read by a private helper in hostelworld-client.ts that parsed
 *   the body with `response.json()`, so an HTML error page from anything between us and
 *   that host left nothing to quote at all.
 *
 * Anything else returns `undefined`, and the caller quotes `bodyText` instead. Guessing at
 * an unmeasured field would be inventing a message again, one layer down.
 */
function messageFrom(body: unknown): string | undefined {
	if (body === null || typeof body !== 'object') return undefined;
	const record = body as Record<string, unknown>;

	const message = stringField(record, 'message');
	if (message !== undefined) return message;

	const described = describedMessages(record.description);
	if (described !== undefined) return described;

	const { error } = record;
	if (typeof error === 'string' && error.trim().length > 0) return error;
	if (error !== null && typeof error === 'object') {
		const nested = stringField(error as Record<string, unknown>, 'message');
		if (nested !== undefined) return nested;
	}

	const errors = stringField(record, 'errors');
	if (errors !== undefined) return errors;
	if (record.errors !== null && typeof record.errors === 'object') {
		try {
			return JSON.stringify(record.errors);
		} catch {
			return undefined;
		}
	}

	return undefined;
}

/** Collapses the runs of whitespace an HTML error page is mostly made of, so 300 characters
 * carry 300 characters of information rather than 300 characters of indentation. */
function excerpt(raw: string): string {
	const collapsed = raw.replace(/\s+/g, ' ').trim();
	return collapsed.length <= MAX_BODY_CHARS ? collapsed : `${collapsed.slice(0, MAX_BODY_CHARS)}…`;
}

function errorHeadersFrom(headers: Headers): Record<string, string> {
	const found: Record<string, string> = {};
	headers.forEach((value, name) => {
		const lowered = name.toLowerCase();
		if (ERROR_HEADER_PATTERN.test(lowered)) found[lowered] = value;
	});
	return found;
}

/**
 * Consumes the response body and returns everything worth quoting about it. Call this once
 * per failed response. The body is a stream and a second read gets nothing.
 */
export async function readProviderResponse(response: Response): Promise<ProviderResponseEvidence> {
	const raw = await safeReadText(response);
	const body = parseJson(raw);
	return {
		status: response.status,
		message: messageFrom(body),
		bodyText: excerpt(raw),
		body,
		errorHeaders: errorHeadersFrom(response.headers)
	};
}

/**
 * The one sentence a `ProviderError.message` should carry for a failed HTTP response: who
 * was asked, what status came back, and what they said about it, in their words.
 *
 * The owner's own example of the shape he wanted, from AGENTS.md: "Agoda returned 200 with:
 * The location cannot be empty". The status is always there because `403` versus
 * `200`-with-an-error-body is the exact distinction that went missing in issue #122.
 */
export function describeProviderResponse(label: string, evidence: ProviderResponseEvidence): string {
	const headers = Object.entries(evidence.errorHeaders)
		.map(([name, value]) => `; ${name}: ${value}`)
		.join('');

	if (evidence.message !== undefined) {
		return `${label} returned HTTP ${evidence.status}: ${evidence.message}${headers}`;
	}
	if (evidence.bodyText.length > 0) {
		return `${label} returned HTTP ${evidence.status} with body: ${evidence.bodyText}${headers}`;
	}
	return `${label} returned HTTP ${evidence.status} with an empty body${headers}`;
}

/**
 * Seconds from a `Retry-After` header, when it is a plain count of seconds.
 *
 * The header's other legal form is an HTTP date, which nothing here has ever received and
 * which is deliberately not parsed: an unparsed hint reads as "the provider said nothing",
 * and `budget/call-with-budget.ts` responds to that by not retrying, which is the direction
 * that cannot cost the owner requests he does not have.
 */
export function readRetryAfterSeconds(headers: Headers): number | undefined {
	const raw = headers.get('retry-after')?.trim();
	if (raw === undefined || raw.length === 0) return undefined;
	const seconds = Number(raw);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}
