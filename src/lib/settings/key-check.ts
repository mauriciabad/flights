import type { ProviderIssueReason } from '$lib/components';
import { callProviderWithBudget, ProviderHttpError } from '$lib/providers/budget';
import type { ProviderError } from '$lib/providers/budget';
import type { KeyCheckSpec, SettingsProviderDescriptor } from './provider-catalog';

/**
 * Validates one provider's key with a single real, cheap request — issue #29's "paste a
 * key, see it validated" and "test" button.
 *
 * Routed through `callProviderWithBudget` (issue #22's request-budget module, `src/lib/
 * providers/budget/`) rather than a bespoke fetch-and-classify of its own: that module is
 * the one place this app is meant to spend a metered request, and a settings-page health
 * check is exactly as real a request as a search-time one — it must count against the
 * same monthly cap `getProviderQuotaSnapshot` reports, respect an already-tripped "not
 * subscribed" short circuit, and never silently bypass the hard stop that exists so a
 * search doesn't find the quota already gone. Building a second, parallel budget-unaware
 * path here would be the exact "two modules disagreeing at the seam" failure mode AGENTS.md
 * warns about (the one issue #49 had to clean up after already happened once).
 *
 * Reuses `ProviderIssueReason` (`$lib/components/ErrorState.svelte`) as the failure
 * vocabulary shown in the UI, rather than a second one, so a settings-page result and a
 * future search-page failure for the same provider read identically.
 *
 * The one property this module exists to get right: RapidAPI's gateway rejects a request
 * for two genuinely different reasons that both arrive as HTTP 403, and they need
 * different fixes (docs/PROVIDERS.md, issue #29's brief).
 *
 * - "You are not subscribed to this API." — the key is real, but this RapidAPI account
 *   never subscribed to this specific API's plan (subscriptions are per-API, not
 *   per-account). Fix: open the pricing tab and subscribe to the free BASIC plan. This is
 *   the shared budget module's own `not-subscribed` code
 *   (`providers/budget/classify-error.ts` matches the identical wording).
 * - Anything else naming the key itself ("Invalid API key", or a bare 401) — the string
 *   pasted in is not a real RapidAPI key at all. Fix: get the right key and paste it again.
 *   The shared `ProviderError` union (`providers/types.ts`) has no code of its own for
 *   this — every adapter profiled so far only needed to tell "not subscribed" apart from
 *   everything else — so it arrives as the shared classifier's `unknown`, and the
 *   `toIssueReason` refinement below narrows it further using the same RapidAPI wording
 *   `classify-error.ts` already keys off, purely for this settings screen's display. It
 *   does not change what code a search-time caller sees.
 *
 * Issue #122: this screen once told the owner his working, subscribed Agoda key was
 * "not subscribed," because a wrapped RapidAPI host (Agoda's here, but the same shape hit
 * Sky Scrapper in issue #68) answers a malformed request with HTTP 200 and its own
 * `{"status":false,"message":"..."}` body rather than a 4xx. This module's `response.ok`
 * check used to treat that as a plain success; nothing anywhere invented "not subscribed"
 * from it, but the fix is the same discipline either way: `not-subscribed` must only ever
 * be produced by a real 403 carrying RapidAPI's own literal sentence (enforced below by
 * routing everything through the shared classifier, never guessed locally), and a 200 that
 * is not really a success must never be read as one. `performCheck` now catches that shape
 * before the ok/not-ok branch, and `KeyCheckOutcome.providerResponse` (below) carries the
 * exact status and message every such response sends, verbatim, so this screen's own
 * headline can sit alongside the evidence for it instead of replacing it.
 */
export type KeyCheckOutcome =
	| { ok: true; message: string; requestUrl: string }
	| {
			ok: false;
			reason: ProviderIssueReason;
			message: string;
			/** The exact HTTP status and message text the provider sent, when a real
			 * response was ever received — shown verbatim in the UI beneath this outcome's
			 * own `message`, never instead of it (issue #122: "we should show the actual
			 * errors received, not invent our own"). `undefined` only when no response
			 * exists to show: `missing-key` (no request sent), `cancelled`, a network
			 * failure that never reached a server, or this session's own local pre-flight
			 * quota refusal (`providers/budget/call-with-budget.ts`'s cap check, which
			 * also never sends a request — its own message already says so). */
			providerResponse?: { status: number; message: string };
			requestUrl: string;
			retryAfterSeconds?: number;
	  };

function buildUrl(check: KeyCheckSpec): string {
	const url = new URL(`https://${check.host}${check.path}`);
	for (const [key, value] of Object.entries(check.params())) {
		url.searchParams.set(key, value);
	}
	return url.toString();
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

/** The shape Agoda's and Booking's RapidAPI wrappers answer a malformed request with —
 * HTTP 200, `status: false`, and their own message — instead of a 4xx (confirmed live
 * 2026-09-04, `agoda-client.ts`'s header; the identical shape hit Sky Scrapper in issue
 * #68). A response this looks like is not a success no matter what its HTTP status says. */
function isApplicationError(body: unknown): boolean {
	return typeof body === 'object' && body !== null && (body as { status?: unknown }).status === false;
}

function parseRetryAfter(header: string | null): number | undefined {
	if (header === null) return undefined;
	const seconds = Number(header);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * The `execute` half of `callProviderWithBudget`: makes the one real request and throws a
 * `ProviderHttpError` (carrying the exact status and body message) on anything but a
 * genuine 2xx success, so the budget module's shared `defaultClassifyError` can match on
 * the status code instead of re-parsing a response it never saw. Resolves with nothing —
 * a settings health check only needs to know the request was accepted, unlike a real
 * search adapter, which would also parse the body into a domain type here.
 *
 * The body is read before branching on `response.ok`, not after, specifically so a 2xx
 * carrying `isApplicationError`'s shape (issue #122) is caught before it ever reaches the
 * "this looked fine" branch — a `response.ok` check alone cannot see it, because the HTTP
 * layer genuinely did succeed; only the JSON body says otherwise.
 */
async function performCheck(
	descriptor: SettingsProviderDescriptor,
	apiKey: string,
	signal: AbortSignal,
	fetchImpl: typeof fetch
): Promise<void> {
	const response = await fetchImpl(buildUrl(descriptor.check), {
		headers: {
			'x-rapidapi-key': apiKey,
			'x-rapidapi-host': descriptor.check.host
		},
		signal
	});
	const body = await safeReadJson(response);

	if (isApplicationError(body)) {
		// Deliberately the generic `messageFrom` fallback, never a sentence of this
		// module's own invention: the whole point is that the provider's own text (here,
		// Agoda's "The location cannot be empty") already names the real problem, and
		// inventing something else in its place is exactly the failure issue #122 was
		// filed over. `response.status` is almost always 200 for this shape, but it is
		// carried through rather than hardcoded in case a provider ever pairs it with a
		// different 2xx.
		throw new ProviderHttpError(response.status, messageFrom(body) ?? JSON.stringify(body));
	}

	if (response.ok) return;

	const message = messageFrom(body) ?? `${descriptor.label} responded with HTTP ${response.status}.`;
	throw new ProviderHttpError(
		response.status,
		message,
		response.status === 429 ? parseRetryAfter(response.headers.get('retry-after')) : undefined
	);
}

/** True for a 401, or a 403/other body whose text names the key as the problem. Checked
 * against `error.cause` (the original thrown `ProviderHttpError`, preserved by the shared
 * `toProviderError`'s `unknown` branch in `providers/budget/call-with-budget.ts`) rather
 * than the message alone, since a provider can send an empty or generic body on a 401. */
function looksLikeInvalidKey(error: Extract<ProviderError, { code: 'unknown' }>): boolean {
	if (error.cause instanceof ProviderHttpError && error.cause.status === 401) return true;
	return /invalid.*(api.?)?key/i.test(error.message);
}

/**
 * Narrows the shared `ProviderError` (`providers/budget/types.ts`, the same union
 * `providers/types.ts` defines) into this settings screen's richer display vocabulary. See
 * the module doc above for why `unknown` gets a further look rather than a code of its own
 * living in the shared type — that type is a chokepoint several adapters build against in
 * parallel, so it stays exactly what issue #2 defined it as.
 */
function toIssueReason(error: ProviderError): ProviderIssueReason {
	switch (error.code) {
		case 'missing-key':
			return 'missing-key';
		case 'not-subscribed':
			return 'not-subscribed';
		case 'quota-exceeded':
			return 'quota-exceeded';
		case 'network-error':
			return 'down';
		case 'cancelled':
		case 'malformed-response':
			return 'unknown';
		case 'unknown':
			return looksLikeInvalidKey(error) ? 'invalid-key' : 'unknown';
	}
}

/**
 * Pulls the exact status and message text of a real HTTP response back out of a
 * `ProviderError`, when one genuinely happened — the evidence issue #122 asks this screen
 * to show verbatim underneath its own headline, never in place of it.
 *
 * `not-subscribed` always carries a real 403 (the type itself says so: `status: 403` is
 * the only value it can hold, because `defaultClassifyError` only ever produces this code
 * from a `ProviderHttpError` whose status was actually 403). `unknown` — which is also
 * where `invalid-key` and the `isApplicationError` 200-with-`status:false` case both land,
 * see `toIssueReason` and `performCheck` above — carries a real status only when its
 * `cause` is the `ProviderHttpError` `performCheck` threw; `undefined` otherwise (a
 * `SyntaxError`, an aborted fetch, or anything else that never got as far as a response).
 * `quota-exceeded` is deliberately excluded: a local pre-flight refusal (this session's
 * own cap already spent, `../budget/call-with-budget.ts`) reports `status: 429` too, but
 * never sent a request at all, and its message already says exactly that — labelling it
 * "HTTP 429" would wrongly imply the provider was ever asked.
 */
function providerResponseOf(error: ProviderError): { status: number; message: string } | undefined {
	if (error.code === 'not-subscribed') return { status: error.status, message: error.message };
	if (error.code === 'unknown' && error.cause instanceof ProviderHttpError) {
		return { status: error.cause.status, message: error.message };
	}
	return undefined;
}

/**
 * Runs one provider's cheap real call, through the shared request budget, and classifies
 * the result for display.
 *
 * @param apiKey The value of this provider's `apiKey` field (`SettingsProviderDescriptor
 *   .keyFields[0].id`). Every provider in this catalog declares exactly that one field
 *   today; a provider that ever needed a second field for something other than RapidAPI
 *   auth would need its own check function, not a change here.
 * @param fetchImpl Overridable for tests, mirroring every real adapter's own convention,
 *   so a test never touches the network by relying on a global mock.
 */
export async function checkProviderKey(
	descriptor: SettingsProviderDescriptor,
	apiKey: string,
	signal: AbortSignal,
	fetchImpl: typeof fetch = fetch
): Promise<KeyCheckOutcome> {
	const requestUrl = buildUrl(descriptor.check);

	if (apiKey.trim().length === 0) {
		return {
			ok: false,
			reason: 'missing-key',
			message: `No key saved for ${descriptor.label} yet.`,
			requestUrl
		};
	}

	const result = await callProviderWithBudget({
		providerId: descriptor.id,
		dedupeKey: `settings-key-check:${descriptor.id}`,
		execute: () => performCheck(descriptor, apiKey, signal, fetchImpl),
		// A manual "Test" click should give one definitive answer, not silently retry
		// (with backoff, taking several seconds) behind a spinner — the budget module's
		// default of 3 attempts is right for a search adapter's own transient-429 case,
		// not for a health check whose whole job is reporting the first real answer.
		maxAttempts: 1
	});

	if (result.ok) {
		return { ok: true, message: `${descriptor.label} accepted the key.`, requestUrl };
	}

	const { error } = result;
	const reason = toIssueReason(error);
	const retryAfterSeconds = error.code === 'quota-exceeded' ? error.retryAfterSeconds : undefined;
	// Computed once, attached to every failing outcome below: issue #122's fix generalises
	// past "not-subscribed" specifically — anywhere this function's own classification
	// stands in front of a real response, the response itself must still reach the UI.
	const providerResponse = providerResponseOf(error);

	if (reason === 'invalid-key') {
		return {
			ok: false,
			reason,
			message: `${descriptor.label} rejected this key as invalid. Double-check you copied the whole RapidAPI key, with nothing added or missing.`,
			providerResponse,
			requestUrl
		};
	}
	if (reason === 'not-subscribed') {
		return {
			ok: false,
			reason,
			message: `Your RapidAPI account has not subscribed to ${descriptor.label} yet.`,
			providerResponse,
			requestUrl
		};
	}

	// Every other reason (quota-exceeded, down, unknown) already carries a specific,
	// well-formed message from the shared budget module or `performCheck` above — reusing
	// it rather than re-templating keeps the exact used/cap numbers a local quota refusal
	// reports intact.
	return { ok: false, reason, message: error.message, providerResponse, requestUrl, retryAfterSeconds };
}
