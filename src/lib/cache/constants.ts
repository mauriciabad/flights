// 5MB is generous for JSON responses from flight, hotel and transit providers,
// and small enough that a phone on a metered connection never notices it. It is
// a shared budget across every provider's cache; per-provider limits would mean
// guessing in advance how much of a phone's storage each API deserves.
export const DEFAULT_MAX_SIZE_BYTES = 5 * 1024 * 1024;
