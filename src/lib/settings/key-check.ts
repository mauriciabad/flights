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
 */
export type KeyCheckOutcome =
	| { ok: true; message: string; requestUrl: string }
	| {
			ok: false;
			reason: ProviderIssueReason;
			message: string;
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

function parseRetryAfter(header: string | null): number | undefined {
	if (header === null) return undefined;
	const seconds = Number(header);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * The `execute` half of `callProviderWithBudget`: makes the one real request and throws a
 * `ProviderHttpError` (carrying the exact status and body message) on anything but a 2xx,
 * so the budget module's shared `defaultClassifyError` can match on the status code
 * instead of re-parsing a response it never saw. Resolves with nothing — a settings health
 * check only needs to know the request was accepted, unlike a real search adapter, which
 * would also parse the body into a domain type here.
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
	if (response.ok) return;

	const body = await safeReadJson(response);
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

	if (reason === 'invalid-key') {
		return {
			ok: false,
			reason,
			message: `${descriptor.label} rejected this key as invalid. Double-check you copied the whole RapidAPI key, with nothing added or missing.`,
			requestUrl
		};
	}
	if (reason === 'not-subscribed') {
		return {
			ok: false,
			reason,
			message: `Your RapidAPI account has not subscribed to ${descriptor.label} yet.`,
			requestUrl
		};
	}

	// Every other reason (quota-exceeded, down, unknown) already carries a specific,
	// well-formed message from the shared budget module or `performCheck` above — reusing
	// it rather than re-templating keeps the exact used/cap numbers a local quota refusal
	// reports intact.
	return { ok: false, reason, message: error.message, requestUrl, retryAfterSeconds };
}
