import { describe, expect, it } from 'vitest';
import { raceToCompletion } from './race';

/** Deferred promise a test can resolve on demand, to control settlement order without
 * relying on wall-clock timing (`setTimeout` durations aren't a reliable way to prove
 * completion-order behaviour, and fake timers add ceremony this doesn't need). */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe('raceToCompletion', () => {
	it('yields in completion order, not launch order', async () => {
		const slow = deferred<string>();
		const fast = deferred<string>();

		const iterator = raceToCompletion([slow.promise, fast.promise]);
		const seen: string[] = [];
		const done = (async () => {
			for await (const value of iterator) seen.push(value);
		})();

		// Resolve the SECOND-launched promise first: a launch-order implementation
		// (e.g. `for (const p of promises) yield await p`) would report "slow" first
		// regardless, since it would still be awaiting `slow` when `fast` resolves.
		fast.resolve('fast');
		await Promise.resolve(); // let the microtask queue settle the first yield
		slow.resolve('slow');
		await done;

		expect(seen).toEqual(['fast', 'slow']);
	});

	it('yields every value exactly once', async () => {
		const promises = [Promise.resolve('a'), Promise.resolve('b'), Promise.resolve('c')];
		const seen: string[] = [];
		for await (const value of raceToCompletion(promises)) seen.push(value);
		expect(seen.sort()).toEqual(['a', 'b', 'c']);
	});

	it('produces nothing for an empty input without hanging', async () => {
		const seen: number[] = [];
		for await (const value of raceToCompletion<number>([])) seen.push(value);
		expect(seen).toEqual([]);
	});
});
