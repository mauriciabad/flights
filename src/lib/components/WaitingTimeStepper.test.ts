import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import WaitingTimeStepper from './WaitingTimeStepper.svelte';

/**
 * The airport-buffer control's own behaviour, read off the DOM.
 *
 * These assertions used to live in `ItineraryTimeline.test.ts`, driving the copy of this
 * stepper that sat inline in a wait row. Issue #313 removed that copy, because the
 * customise panel already had one and two controls editing one number is worse than
 * either alone. The behaviour is still worth pinning, so it moved here, to the component
 * that owns it, where it is also testable without mounting a whole timeline.
 *
 * The stepper owns nothing but the arithmetic: minutes in, a clamped changed value out.
 * What the caller does with that value (`recomputeItineraryWaitingTimes`, so nights, bed
 * and totals rebuild rather than get patched) is pinned in `algorithm/build.test.ts`.
 */

let target: HTMLElement | undefined;
let component: Record<string, unknown> | undefined;

function render(props: { minutes: number; max: number }) {
	const changes: number[] = [];
	target = document.createElement('div');
	document.body.appendChild(target);
	component = mount(WaitingTimeStepper, {
		target,
		props: {
			label: 'Waiting time at London Gatwick',
			inputId: 'test-wait',
			minutes: props.minutes,
			max: props.max,
			onChange: (minutes: number) => changes.push(minutes)
		}
	});
	flushSync();
	const [decrement, increment] = Array.from(target.querySelectorAll('button'));
	return {
		changes,
		decrement: decrement!,
		increment: increment!,
		input: target.querySelector<HTMLInputElement>('input')!
	};
}

afterEach(() => {
	if (component) unmount(component);
	target?.remove();
	component = undefined;
	target = undefined;
});

describe('WaitingTimeStepper', () => {
	it('moves the value by 15 minutes in each direction', () => {
		const { changes, decrement, increment } = render({ minutes: 120, max: 720 });

		increment.click();
		flushSync();
		expect(changes).toEqual([135]);

		decrement.click();
		flushSync();
		expect(changes).toEqual([135, 105]);
	});

	it('shows the minutes it was handed, and never a value of its own', () => {
		// It owns nothing: the caller re-renders it with the recomputed trip's own buffer,
		// so a stepper that kept its own count could disagree with the itinerary it edits.
		const { input, increment, changes } = render({ minutes: 120, max: 720 });

		increment.click();
		flushSync();
		expect(input.value).toBe('120');
		expect(changes).toEqual([135]);
	});

	it('clamps at the ceiling the caller set rather than emitting past it', () => {
		// The connection's ceiling is real domain arithmetic: a buffer cannot eat past the
		// flight it waits for. Emitting a value above it would hand the caller a trip that
		// `recomputeItineraryWaitingTimes` has to reject after the fact.
		const { changes, increment } = render({ minutes: 700, max: 705 });

		increment.click();
		flushSync();
		expect(changes).toEqual([705]);
	});

	it('clamps at zero, and disables the control that would go below it', () => {
		const { changes, decrement } = render({ minutes: 10, max: 720 });

		decrement.click();
		flushSync();
		expect(changes).toEqual([0]);

		const atZero = render({ minutes: 0, max: 720 });
		expect(atZero.decrement.disabled).toBe(true);
	});

	it('takes a typed number and clamps that too', () => {
		const { changes, input } = render({ minutes: 120, max: 300 });

		input.value = '9999';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(changes).toEqual([300]);
	});

	it('ignores an emptied field rather than reading it as zero', () => {
		// `valueAsNumber` is NaN for an empty number input, and a traveller mid-edit has not
		// asked for a zero-minute buffer.
		const { changes, input } = render({ minutes: 120, max: 300 });

		input.value = '';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(changes).toEqual([]);
	});
});
