const inFlight = new Map<string, Promise<unknown>>();

/**
 * Collapses concurrent calls that share a key into a single execution, both
 * sharing its outcome. With a 20-request monthly budget this is not a
 * micro-optimisation: two components mounting at once and firing the same
 * fare search is 10% of a whole month gone before the user has done
 * anything. `run` is invoked at most once per key while a call is in flight;
 * once it settles, the next call with that key starts a fresh execution.
 */
export function dedupeInFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
	const existing = inFlight.get(key) as Promise<T> | undefined;
	if (existing) return existing;

	// `run` is invoked synchronously, right here, rather than deferred onto a
	// microtask: a second call arriving on the very same tick (the common
	// case — two components mounting at once) must see `inFlight` already
	// populated, or it would slip through and fire its own request.
	let started: Promise<T>;
	try {
		started = Promise.resolve(run());
	} catch (syncError) {
		started = Promise.reject(syncError as unknown);
	}

	const tracked = started.finally(() => inFlight.delete(key));
	inFlight.set(key, tracked);
	return tracked;
}

/** Test-only: forgets every tracked in-flight call without waiting for it to settle. */
export function clearInFlightForTests(): void {
	inFlight.clear();
}
