import { recordRateLimitHeaders } from '../budget';
import type { ProviderError, ProviderId } from '../types';

/** `sky-scrapper.p.rapidapi.com` is the only host this adapter is built and verified
 * against (issue #5's brief; docs/PROVIDERS.md). */
const PROVIDER_ID: ProviderId = 'skyscanner';
const HOST = 'sky-scrapper.p.rapidapi.com';
const BASE_URL = `https://${HOST}`;

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
			return { ok: false, error: { code: 'cancelled', message: 'Sky Scrapper request was aborted' } };
		}
		return {
			ok: false,
			error: {
				code: 'network-error',
				message: 'Network request to Sky Scrapper failed',
				cause
			}
		};
	}

	// Before any status branching: RapidAPI sends its quota headers on a 429 and a 403 too,
	// and those are exactly the responses where the real remaining count matters (#146).
	recordRateLimitHeaders(PROVIDER_ID, response.headers);

	if (response.status === 403) {
		const body = await safeReadJson(response);
		const message = messageFrom(body);
		if (/not subscribed/i.test(message ?? '')) {
			return {
				ok: false,
				error: {
					code: 'not-subscribed',
					message: message ?? 'You are not subscribed to this API.',
					status: 403
				}
			};
		}
		return {
			ok: false,
			error: { code: 'unknown', message: message ?? 'Sky Scrapper returned 403', cause: body }
		};
	}

	if (response.status === 429) {
		const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'));
		return {
			ok: false,
			error: {
				code: 'quota-exceeded',
				message: 'Sky Scrapper rate limit or monthly quota reached',
				status: 429,
				retryAfterSeconds
			}
		};
	}

	if (!response.ok) {
		return {
			ok: false,
			error: { code: 'unknown', message: `Sky Scrapper responded with HTTP ${response.status}` }
		};
	}

	const body = await safeReadJson(response);
	if (body === undefined) {
		return {
			ok: false,
			error: { code: 'malformed-response', message: 'Sky Scrapper response body was not valid JSON' }
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

function messageFrom(body: unknown): string | undefined {
	if (body !== null && typeof body === 'object' && 'message' in body) {
		const { message } = body as { message: unknown };
		return typeof message === 'string' ? message : undefined;
	}
	return undefined;
}

function parseRetryAfter(header: string | null): number | undefined {
	if (header === null) return undefined;
	const seconds = Number(header);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}
