<script lang="ts">
	/**
	 * The airport-buffer control, brief lines 39 and 69 ("airport waiting times can be
	 * edited afterwards", said twice).
	 *
	 * It lived inside `ItineraryTimeline`'s wait row until issue #278 gave the customise
	 * rail a panel per segment, at which point a selected wait needed the same control in
	 * a second place. Two copies of a stepper that writes the same minutes is the shape
	 * this repo keeps paying for, so there is one, here, and both callers render it.
	 *
	 * It owns nothing. The minutes come in, a changed value goes out, and the caller runs
	 * it through `recomputeItineraryWaitingTimes` so the nights, the bed and the totals are
	 * rebuilt from it rather than patched (issue #250).
	 */
	interface Props {
		/** Spoken name of the buffer, e.g. "Waiting time at London Gatwick". Used for the
		 * input's own label, which is visually hidden: the row or panel around this
		 * already prints where the wait happens, and printing it twice is noise to read
		 * and noise to hear. */
		label: string;
		minutes: number;
		/** Upper bound. At the connection this is real domain arithmetic (a buffer cannot
		 * eat past the flight it waits for); at the origin it is only a sane ceiling. */
		max: number;
		/** Distinguishes this instance's input from the other one on the page. */
		inputId: string;
		onChange: (minutes: number) => void;
	}

	let { label, minutes, max, inputId, onChange }: Props = $props();

	const STEP_MINUTES = 15;

	function clamp(value: number): number {
		return Math.min(Math.max(value, 0), max);
	}

	function adjust(delta: number) {
		onChange(clamp(minutes + delta));
	}

	function onInput(event: Event & { currentTarget: HTMLInputElement }) {
		const typed = event.currentTarget.valueAsNumber;
		if (!Number.isFinite(typed)) return;
		onChange(clamp(typed));
	}
</script>

<div class="waiting-stepper">
	<label class="visually-hidden" for={inputId}>{label}, in minutes</label>
	<button
		type="button"
		class="waiting-stepper-btn"
		onclick={() => adjust(-STEP_MINUTES)}
		disabled={minutes <= 0}
		aria-label="Decrease waiting time by 15 minutes"
	>
		&minus;
	</button>
	<input
		id={inputId}
		type="number"
		inputmode="numeric"
		class="waiting-stepper-input font-mono tabular-nums"
		min="0"
		{max}
		step="5"
		value={minutes}
		oninput={onInput}
	/>
	<button
		type="button"
		class="waiting-stepper-btn"
		onclick={() => adjust(STEP_MINUTES)}
		disabled={minutes >= max}
		aria-label="Increase waiting time by 15 minutes"
	>
		&plus;
	</button>
</div>

<style>
	.waiting-stepper {
		display: flex;
		align-items: center;
		gap: var(--space-1);
	}

	.waiting-stepper-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		/* 44px square, matching Button.svelte's own md size: WCAG 2.5.5, and this app is
		   meant to be used one-handed. The row around it is dense; the control inside it is
		   not, which is the correct place to spend the pixels. Shrinking the height to
		   36px did save two rows a few pixels each and it was the wrong trade. */
		width: 2.75rem;
		height: 2.75rem;
		flex-shrink: 0;
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-md);
		background: var(--color-surface);
		color: var(--color-text);
		font-size: var(--font-size-lg);
		line-height: 1;
		transition:
			background-color var(--transition-fast),
			border-color var(--transition-fast);
	}

	.waiting-stepper-btn:hover:not(:disabled) {
		background: var(--color-surface-hover);
		border-color: var(--color-accent);
	}

	/* Tactile press feedback, matching Button.svelte's own convention. Reduced-motion users
	   still get the instant state change, just without the tween (handled globally in
	   app.css, which sets every transition-duration to near-zero under that preference). */
	.waiting-stepper-btn:not(:disabled):active {
		transform: translateY(1px);
	}

	.waiting-stepper-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.waiting-stepper-btn:focus-visible,
	.waiting-stepper-input:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	.waiting-stepper-input {
		width: 3.25rem;
		height: 2.75rem;
		padding: 0 var(--space-1);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-md);
		background: var(--color-surface);
		color: var(--color-text);
		font-size: var(--font-size-sm);
		text-align: center;
	}

	.waiting-stepper-input:focus-visible {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}
</style>
