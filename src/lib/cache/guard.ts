// The user's API keys live in localStorage (see the key store), never in this
// cache. This file is the enforcement of that boundary rather than a comment
// asking provider adapters to be careful: it refuses to store a value whose
// shape looks like it carries credentials, instead of trusting every future
// caller to remember not to pass one through.

export class CacheSecretLeakageError extends Error {
	constructor(readonly fieldName: string) {
		super(
			`Refusing to cache a value with a field named "${fieldName}": it looks like it ` +
				'carries an API key or a token derived from one. Map provider responses to a ' +
				'plain domain shape before caching them.'
		);
		this.name = 'CacheSecretLeakageError';
	}
}

// Exact field names, not a substring match: a substring test would also reject
// harmless fields like a hotel search's `pageToken` or a flight count named
// `tokenCount`. Names are normalised (lower-cased, punctuation stripped) before
// comparison so `api_key`, `apiKey` and `API-KEY` all match the same entry.
const DENYLISTED_FIELD_NAMES = new Set([
	'apikey',
	'rapidapikey',
	'xrapidapikey',
	'secret',
	'secretkey',
	'clientsecret',
	'password',
	'authorization',
	'bearer',
	'accesstoken',
	'refreshtoken',
	'sessiontoken',
	'credential',
	'credentials'
]);

function normalise(fieldName: string): string {
	return fieldName.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Throws if `value` contains, at any depth, an object field whose name matches
 * a known credential shape. Only field *names* are inspected, not values: the
 * cache has no way to recognise an arbitrary provider's key format, but every
 * provider adapter controls the field names of what it hands to the cache.
 */
export function assertNoSecretLeakage(value: unknown): void {
	const seen = new WeakSet<object>();

	const walk = (node: unknown, depth: number): void => {
		if (depth > 8 || node === null || typeof node !== 'object') return;
		if (seen.has(node)) return; // guards against circular references
		seen.add(node);

		if (Array.isArray(node)) {
			for (const item of node) walk(item, depth + 1);
			return;
		}

		for (const [fieldName, fieldValue] of Object.entries(node as Record<string, unknown>)) {
			if (DENYLISTED_FIELD_NAMES.has(normalise(fieldName))) {
				throw new CacheSecretLeakageError(fieldName);
			}
			walk(fieldValue, depth + 1);
		}
	};

	walk(value, 0);
}
