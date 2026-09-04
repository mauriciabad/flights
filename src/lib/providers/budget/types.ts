// Issue #2's provider interface (../types.ts) is the merged contract every
// adapter and every caller programs against: providers never throw, they
// resolve a ProviderResult carrying a ProviderError from a fixed, exhaustive
// code union. This module used to define its own parallel vocabulary before
// that interface merged (AGENTS.md "main moves while you work") — it now
// reuses the real thing instead, so an adapter never has to translate
// between "the budget module's opinion of an error" and "the interface's
// opinion of an error."
import type { ProviderError } from '../types';

export type { ProviderError, ProviderId, ProviderResult, ProviderSource } from '../types';

/**
 * Just the `code` field of `ProviderError`, extracted rather than
 * hand-copied, so this module's classifier and retry logic stay in lockstep
 * with whatever codes the provider interface defines — a new code added
 * there shows up here as a type error at every `switch` that isn't updated
 * to handle it, instead of silently falling through.
 */
export type ProviderErrorCode = ProviderError['code'];
