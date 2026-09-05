import { describe, expect, it, vi } from 'vitest';
import { onRevalidationSettled, revalidationSettled } from './revalidation';

describe('revalidationSettled', () => {
	it('names the provider whose answer was replaced', () => {
		const heard = vi.fn();
		const stop = onRevalidationSettled(heard);
		try {
			revalidationSettled('ryanair');
			expect(heard).toHaveBeenCalledWith('ryanair');
		} finally {
			stop();
		}
	});

	it('says nothing to a listener that has stopped', () => {
		const heard = vi.fn();
		onRevalidationSettled(heard)();
		revalidationSettled('ryanair');
		expect(heard).not.toHaveBeenCalled();
	});

	it('still reaches the listeners after one that unsubscribes itself', () => {
		// The results page unsubscribes when its effect tears down, and what a listener does
		// can provoke that. Iterating the live set instead of a copy would skip whoever came
		// after it.
		let stopFirst = () => {};
		stopFirst = onRevalidationSettled(() => stopFirst());
		const later = vi.fn();
		const stopLater = onRevalidationSettled(later);
		try {
			revalidationSettled('kiwi-public');
			expect(later).toHaveBeenCalledWith('kiwi-public');
		} finally {
			stopFirst();
			stopLater();
		}
	});
});
