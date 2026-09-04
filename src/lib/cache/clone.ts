/**
 * IndexedDB stores and returns values via structured clone, so a caller can
 * mutate an object after handing it to `set()`, or mutate what `get()` handed
 * back, without touching what is actually stored. `MemoryCacheStore` keeps
 * plain JS references instead, so without this it would alias: two backends
 * that are supposed to be interchangeable would behave differently the
 * moment a caller (or a private-browsing fallback) mutated a cached object.
 * Falls back to the original reference if a value cannot be cloned (a
 * function, say) rather than failing the whole read or write over it.
 */
export function cloneValue<T>(value: T): T {
	try {
		return structuredClone(value);
	} catch {
		return value;
	}
}
