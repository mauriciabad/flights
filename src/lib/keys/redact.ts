/**
 * Redacts a key to its last 4 characters for display, per the hard security
 * rule: a saved key is never shown in full again. Keys of 4 characters or
 * fewer are fully masked rather than shown whole, since "the last 4" would
 * otherwise mean "all of it".
 *
 * This is the only form a key may take in the UI, in a log line, or in an
 * error message — never the raw value, not even in dev.
 */
export function redactKey(key: string): string {
	if (key.length <= 4) return '••••';
	return `••••${key.slice(-4)}`;
}
