/**
 * Reads a provider's own count of what the account has left out of the response headers it
 * already sent us.
 *
 * Issue #146: the owner lost 85% of his Booking.com month while the settings card read "0
 * of 40 requests spent". Both numbers were right. `quota-storage.ts` counts in one
 * browser's `localStorage`; the allowance belongs to the RapidAPI key. A second device, a
 * private window, cleared site data or a fresh agent Chromium each start again at zero
 * believing they have the whole month. The provider's number is the only one that is true
 * across all of those, and it arrives free with data we already receive.
 *
 * ## What is known, and what is not
 *
 * **No captured response in this repo carries these headers.** Every committed fixture
 * under the adapters' own `fixtures` directories and `tests/e2e/fixtures` is a response body;
 * none records a `Headers` object. docs/PROVIDERS.md's per-API quotas were read off
 * RapidAPI's dashboard, not off a response. So the names below come from RapidAPI's own
 * documentation, unverified against a real call, and the owner's quota is not ours to
 * spend proving them.
 *
 * Two things follow, and they shape every decision in this file:
 *
 * 1. **Absence is the expected case, not a failure.** A cross-origin `fetch` can only read
 *    a response header the server names in `Access-Control-Expose-Headers`, and whether
 *    RapidAPI's gateway exposes `x-ratelimit-*` to a browser has never been measured here.
 *    No headers means "we learned nothing this call" — never "zero remaining" and never
 *    "the tally is fine".
 * 2. **The names are matched by shape, not by a hardcoded list.** Anything spelled
 *    `x-ratelimit-<scope>-limit` / `-remaining` / `-reset` is collected, whatever `<scope>`
 *    turns out to be, and every reading records the header names it actually came from
 *    (`headerNames`) so a report can quote what was observed instead of what we hoped for.
 *    If RapidAPI spells its quota differently than its docs say, this still sees it.
 *
 * RapidAPI documents two different windows and they are easy to confuse, which is the one
 * mistake here that would make things worse rather than better:
 *
 * - `x-ratelimit-requests-limit` / `-remaining` / `-reset` — the subscribed plan's quota,
 *   the number this app's monthly cap is about.
 * - `x-ratelimit-limit` / `-remaining` — a short burst window (documented as 60 seconds).
 *
 * Reading the burst window as the plan quota would be a disaster: "5 of 1000 left" in a
 * minute would be recorded as 995 requests spent this month, and the app would refuse to
 * search for the rest of the month over nothing. `pickQuotaWindow` below refuses to guess
 * rather than risk that.
 */

/** RapidAPI's documented scope for the subscribed plan's quota, as it spells it in
 * `x-ratelimit-requests-remaining`. Unverified against a live response — see this file's
 * header — which is why it is a preference, not a requirement. */
export const RAPIDAPI_QUOTA_SCOPE = 'requests';

/**
 * A window that resets within the hour is a burst-rate limit; a plan's quota resets daily
 * or monthly. This is what lets an unrecognised scope name still be classified correctly,
 * from the provider's own `-reset` value rather than from a name we assumed.
 */
const MIN_QUOTA_RESET_SECONDS = 3600;

const HEADER_PATTERN = /^x-ratelimit-(?:(.+)-)?(limit|remaining|reset)$/;

/** One rate-limit window a provider reported, exactly as it reported it. */
export interface RateLimitWindow {
	/** The middle segment of the header name, verbatim — `requests` for RapidAPI's
	 * documented plan quota, an empty string for the bare `x-ratelimit-limit` burst
	 * window. Kept as the provider spelled it so an unexpected scope is visible in a
	 * report rather than silently mapped onto one we already knew about. */
	scope: string;
	/** How many requests the window allows in total. Absent when the provider sent a
	 * `-remaining` without a matching `-limit`, which is enough to stop on but not enough
	 * to derive how many have been spent. */
	limit?: number;
	remaining: number;
	/** Seconds until this window resets, as reported. */
	resetSeconds?: number;
	/** The exact header names this window was built from. */
	headerNames: string[];
}

/** Rejects anything that is not a whole, non-negative count. A provider sending `unknown`,
 * an empty string or a float is telling us nothing usable, and a `NaN` reaching the stored
 * tally would poison every later comparison against it. */
function parseCount(raw: string): number | undefined {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return undefined;
	const value = Number(trimmed);
	if (!Number.isInteger(value) || value < 0) return undefined;
	return value;
}

interface WindowDraft {
	limit?: number;
	remaining?: number;
	resetSeconds?: number;
	headerNames: string[];
}

/**
 * Collects every `x-ratelimit-*` window a response carried. Returns an empty array when
 * the response carried none, which is the expected outcome until someone measures a real
 * RapidAPI response from a browser.
 */
export function parseRateLimitWindows(headers: Headers): RateLimitWindow[] {
	const drafts = new Map<string, WindowDraft>();

	headers.forEach((value, name) => {
		const match = HEADER_PATTERN.exec(name.toLowerCase());
		if (match === null) return;
		const count = parseCount(value);
		if (count === undefined) return;

		const scope = match[1] ?? '';
		const draft = drafts.get(scope) ?? { headerNames: [] };
		if (match[2] === 'limit') draft.limit = count;
		if (match[2] === 'remaining') draft.remaining = count;
		if (match[2] === 'reset') draft.resetSeconds = count;
		draft.headerNames.push(name.toLowerCase());
		drafts.set(scope, draft);
	});

	const windows: RateLimitWindow[] = [];
	for (const [scope, draft] of drafts) {
		// A window with no `remaining` is not actionable: a bare limit says what the plan
		// allows, never how much of it is left, and this whole file exists to answer the
		// second question.
		if (draft.remaining === undefined) continue;
		windows.push({
			scope,
			limit: draft.limit,
			remaining: draft.remaining,
			resetSeconds: draft.resetSeconds,
			headerNames: [...draft.headerNames].sort()
		});
	}
	return windows;
}

/**
 * Picks the window that describes the subscribed plan's quota, or nothing when no window
 * can be shown to be one.
 *
 * Order matters. RapidAPI's documented name wins outright when present. Otherwise the
 * decision falls back to the provider's own `-reset` value: a window that runs for an hour
 * or more is a quota, and among several the longest is the plan's. Everything else returns
 * `undefined` on purpose — see this file's header on why misreading a burst window as the
 * month's allowance is worse than learning nothing.
 */
export function pickQuotaWindow(windows: readonly RateLimitWindow[]): RateLimitWindow | undefined {
	const documented = windows.find((window) => window.scope === RAPIDAPI_QUOTA_SCOPE);
	if (documented !== undefined) return documented;

	const [longest] = windows
		.filter((window) => (window.resetSeconds ?? 0) >= MIN_QUOTA_RESET_SECONDS)
		.sort((a, b) => (b.resetSeconds ?? 0) - (a.resetSeconds ?? 0));
	return longest;
}
