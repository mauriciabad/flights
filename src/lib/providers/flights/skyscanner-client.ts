import { recordRateLimitHeaders } from '../budget';
import { describeProviderResponse, readProviderResponse, readRetryAfterSeconds } from '../response-evidence';
import type { ProviderError, ProviderId } from '../types';

/** `sky-scrapper.p.rapidapi.com` is the only host this adapter is built and verified
 * against (issue #5's brief; docs/PROVIDERS.md). */
const PROVIDER_ID: ProviderId = 'skyscanner';
const HOST = 'sky-scrapper.p.rapidapi.com';
const BASE_URL = `https://${HOST}`;
/** How every message out of this file names the host, so a traveller reading an error badge
 * and a developer reading a console see the same provider named the same way. */
const LABEL = 'Sky Scrapper';

export type SkyscannerClientResult<T> = { ok: true; data: T } | { ok: false; error: ProviderError };

export interface SkyscannerClientOptions {
	apiKey: string;
	signal: AbortSignal;
	/** Injected in tests so no test ever reaches the network. Production code never
	 * passes this, and the default is the real global `fetch`. */
	fetchImpl?: typeof fetch;
}

/**
 * One HTTP call to Sky Scrapper, turned into a `ProviderResult`-shaped outcome rather than
 * a thrown error. `types.ts` requires adapters to resolve, never reject, so every failure
 * mode this host actually exhibits gets classified here, once, rather than re-derived at
 * every call site in skyscanner.ts.
 *
 * docs/PROVIDERS.md measured five RapidAPI hosts, this one included, all answering an
 * unsubscribed key with exactly `403 {"message":"You are not subscribed to this API."}`.
 * That specific shape is what `not-subscribed` below is matched against, not a bare 403,
 * because a 403 with a different message is a different, unmodelled failure and should not
 * be told apart from "add your key" the way `not-subscribed` is (it maps to `unknown`
 * instead, so it is at least visible rather than silently mis-explained).
 *
 * Issue #171: every non-2xx branch reads the body first and quotes what came back. The two
 * branches that used to skip that step wrote `'Sky Scrapper rate limit or monthly quota
 * reached'` over a 429 and `'Sky Scrapper responded with HTTP 500'` over everything else,
 * which is our guess standing where the host's own sentence should be. See
 * ../response-evidence.ts.
 */
export async function callSkyscanner<T>(
	path: string,
	params: Readonly<Record<string, string>>,
	options: SkyscannerClientOptions
): Promise<SkyscannerClientResult<T>> {
	const url = new URL(BASE_URL + path);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}

	const doFetch = options.fetchImpl ?? fetch;
	let response: Response;
	try {
		response = await doFetch(url.toString(), {
			headers: {
				'x-rapidapi-key': options.apiKey,
				'x-rapidapi-host': HOST
			},
			signal: options.signal
		});
	} catch (cause) {
		// The signal is the source of truth for "was this a cancellation" rather than
		// sniffing the thrown error's name, since it is the same AbortSignal the caller
		// gave us either way and every environment respects it.
		if (options.signal.aborted) {
			return { ok: false, error: { code: 'cancelled', message: `${LABEL} request was aborted` } };
		}
		return {
			ok: false,
			error: {
				code: 'network-error',
				message: `Network request to ${LABEL} failed`,
				cause
			}
		};
	}

	// Before any status branching: RapidAPI sends its quota headers on a 429 and a 403 too,
	// and those are exactly the responses where the real remaining count matters (#146).
	recordRateLimitHeaders(PROVIDER_ID, response.headers);

	// Every failure branch below reads the body before deciding anything, so the message the
	// traveller and the next developer see is the host's own sentence with its status code
	// attached (issue #171). The classification sits on top of that, never in place of it.
	if (!response.ok) {
		const evidence = await readProviderResponse(response);
		const message = describeProviderResponse(LABEL, evidence);

		if (response.status === 403) {
			// Only RapidAPI's literal wording earns `not-subscribed`. It is permanent for the
			// session (budget/permanent-failures.ts), so a 403 that says something else must
			// not be told apart from "add your key" the way this one is.
			if (/not subscribed/i.test(evidence.message ?? '')) {
				return { ok: false, error: { code: 'not-subscribed', message, status: 403 } };
			}
			return { ok: false, error: { code: 'unknown', message, cause: evidence } };
		}

		if (response.status === 429) {
			return {
				ok: false,
				error: {
					code: 'quota-exceeded',
					message,
					status: 429,
					retryAfterSeconds: readRetryAfterSeconds(response.headers)
				}
			};
		}

		return { ok: false, error: { code: 'unknown', message, cause: evidence } };
	}

	const body = await safeReadJson(response);
	if (body === undefined) {
		return {
			ok: false,
			error: { code: 'malformed-response', message: `${LABEL} response body was not valid JSON` }
		};
	}
	return { ok: true, data: body as T };
}

async function safeReadJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return undefined;
	}
}
