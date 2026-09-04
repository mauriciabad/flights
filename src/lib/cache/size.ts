/**
 * Approximate serialised size of a value, in UTF-16 code units. Close enough to
 * bytes for the purpose it serves here: deciding which entries to evict first,
 * not billing anyone. A value that cannot be serialised (a circular structure,
 * say) is treated as free — it only skews eviction order, never correctness.
 */
export function estimateByteSize(value: unknown): number {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return 0;
	}
}
