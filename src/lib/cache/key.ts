/**
 * A namespaced, hashed cache key plus the per-entry TTL it was defined with.
 * `providerId` is kept alongside the hash (not just folded into it) so a store
 * can drop one provider's entries without having to parse `raw`.
 */
export interface CacheKey {
	/** `${providerId}:${hash of the query}` — what stores actually key on. */
	readonly raw: string;
	readonly providerId: string;
	/** How long a value stored under this key stays good enough to show instantly. */
	readonly ttlMs: number;
}

/**
 * Builds a namespaced cache key from a provider id and a query. The query
 * itself is never stored, only its hash, so a caller can safely pass any
 * JSON-serialisable request shape (origin, destination, dates, filters, ...)
 * without growing the cache key or leaking the query's contents anywhere.
 *
 * `ttlMs` travels with the key rather than living on the cache as a whole,
 * because how long a value stays trustworthy is a property of what it is
 * (an airport's coordinates outlive a flight's price by weeks), not of the
 * cache mechanism.
 */
export function defineCacheKey(providerId: string, query: unknown, ttlMs: number): CacheKey {
	if (!providerId) {
		throw new Error('defineCacheKey requires a non-empty providerId to namespace the key');
	}
	if (!(ttlMs > 0)) {
		throw new Error('defineCacheKey requires a positive ttlMs');
	}
	return { raw: `${providerId}:${hashQuery(query)}`, providerId, ttlMs };
}

function hashQuery(query: unknown): string {
	return fnv1a(stableStringify(query));
}

// Sorts object keys before stringifying so `{a, b}` and `{b, a}` hash the same
// way. Provider adapters build query objects by hand and key order is not
// something they should have to get consistent for the cache to work.
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(',')}]`;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
}

// FNV-1a, 32-bit. Not cryptographic and not meant to be: a hash collision here
// just means two different queries share a cache bucket, which self-corrects
// on the next write. Good enough for bucketing, fast, and needs no dependency.
function fnv1a(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}
