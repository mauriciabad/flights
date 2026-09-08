/**
 * The three stay adapters' own ids, in a module that imports nothing but the union they
 * belong to.
 *
 * They were declared in the adapter files, which is where a reader looks for them and
 * where they stay re-exported from. Issue #450 gave the mappers a reason to name their own
 * provider too, which is `Stay.source.provider`, and a mapper importing its adapter is a cycle,
 * since every adapter imports its mapper. One leaf module breaks it without moving the
 * names anywhere a caller can see.
 */
import type { ProviderId } from '../../domain';

/** Also the id `../budget/caps.ts`'s `DEFAULT_PROVIDER_CAPS` is keyed by, though this
 * adapter deliberately has no entry there, because it is not metered. */
export const HOSTELWORLD_PROVIDER_ID: ProviderId = 'hostelworld';

export const BOOKING_PROVIDER_ID: ProviderId = 'booking';

export const AGODA_PROVIDER_ID: ProviderId = 'agoda';
