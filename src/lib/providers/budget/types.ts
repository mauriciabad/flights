import type { ProviderId } from '$lib/keys';

// Re-exported rather than redefined: `src/lib/keys/types.ts` already treats a
// provider id as a plain string on purpose, so the eventual registry (issue
// #2) has room to define the canonical list without every module that came
// before it needing a rewrite. This module follows the same rule.
export type { ProviderId };

/**
 * Why a call was refused or failed, coarse enough for a caller to decide what
 * to do next without parsing a message string:
 * - `quota-exceeded`: refused locally, before any network request — the
 *   monthly cap is already spent.
 * - `not-subscribed`: the RapidAPI account has no plan for this provider.
 *   Permanent for the session; see `permanent-failures.ts`.
 * - `rate-limited`: HTTP 429, the provider's short hourly window is full.
 *   Worth retrying after a backoff.
 * - `network-error`: the request never reached the provider (offline, CORS,
 *   DNS). Worth a limited retry.
 * - `cancelled`: the caller's own `AbortSignal` fired. Never retried.
 * - `unknown`: anything else. Not retried, since retrying a failure this
 *   layer does not understand risks spending quota on repeats of the same
 *   mistake.
 */
export type ProviderFailureKind =
	| 'quota-exceeded'
	| 'not-subscribed'
	| 'rate-limited'
	| 'network-error'
	| 'cancelled'
	| 'unknown';

export interface ProviderCallError {
	kind: ProviderFailureKind;
	providerId: ProviderId;
	/** Human-readable, safe to show in the UI — never the raw provider response. */
	message: string;
	/** Set only for `quota-exceeded`, so a caller can show "12 of 15 used" without re-deriving it. */
	quota?: { cap: number; used: number; monthKey: string };
	/** The original thrown value, kept for logging. Never rendered directly — it may echo request details. */
	cause?: unknown;
}

export interface ProviderCallSuccess<T> {
	ok: true;
	providerId: ProviderId;
	value: T;
	/** Real network attempts spent, retries included. */
	requestsUsed: number;
	attempts: number;
}

export interface ProviderCallFailure {
	ok: false;
	providerId: ProviderId;
	error: ProviderCallError;
	/** 0 when refused before any fetch (quota-exceeded, or already known not-subscribed). */
	requestsUsed: number;
	attempts: number;
}

/**
 * Never a thrown exception for the failure cases this module already
 * understands — a search pipeline fanning out across a dozen providers needs
 * one bad provider to produce a value it can inspect, not a rejected promise
 * that takes `Promise.all` down with it.
 */
export type ProviderCallOutcome<T> = ProviderCallSuccess<T> | ProviderCallFailure;
