/**
 * The mechanism behind "streaming, not batching" (issue #56): given several in-flight
 * promises — one per connection candidate, each doing its own flight/stay/transfer fetches
 * at its own pace — yields each one's result the moment it actually settles, in completion
 * order, not launch order. `Promise.all` would wait for the slowest candidate before handing
 * back anything; a `for` loop over `promises` with `await` inside would process them in
 * launch order even if a later one finishes first. Neither gives the caller a result as soon
 * as it exists, which is the whole point when providers "arrive over many seconds ... of
 * wildly different speed" (issue #56).
 */
export async function* raceToCompletion<T>(
	promises: readonly Promise<T>[]
): AsyncGenerator<T, void, void> {
	// Each promise is paired with its own settlement, tagged with the original promise so the
	// winner can be identified and removed from the pool — `Promise.race` alone only reports
	// the winning *value*, not which input produced it.
	const remaining = new Map<Promise<T>, Promise<{ key: Promise<T>; value: T }>>();
	for (const promise of promises) {
		remaining.set(
			promise,
			promise.then((value) => ({ key: promise, value }))
		);
	}

	while (remaining.size > 0) {
		const { key, value } = await Promise.race(remaining.values());
		remaining.delete(key);
		yield value;
	}
}
