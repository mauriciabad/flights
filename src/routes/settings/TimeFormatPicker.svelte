<script lang="ts">
	/**
	 * Whether every clock in the app reads `9:05am` or `09:05`. Issue #229, the owner:
	 * "i want am/pm not 24h format, this can be a setting (separate issue)".
	 *
	 * The same shape as the currency picker next door, and for the same three reasons: two
	 * options fit on one screen so there is nothing to hide behind a dropdown, arrow-key
	 * navigation and the "one of these" announcement come free from `<fieldset>` plus
	 * `input[type=radio]`, and a tile is a bigger target than a dropdown row on a phone.
	 * The inputs are clipped rather than `display: none`, so they keep their focus and
	 * their semantics. Selection carries a check mark as well as colour (WCAG 1.4.1).
	 *
	 * Each tile previews itself. Reading `9:05am` on the tile you are about to press is a
	 * better answer to "what does this do" than any sentence under it, and it costs a
	 * label rather than a paragraph.
	 *
	 * No `hydrated` gate, for the reason the currency picker gives: `timeFormat.chosen` is
	 * `undefined` on the prerendered server, `current` falls back to `12h`, and that is
	 * exactly what a browser with nothing saved renders. The store hydrates synchronously
	 * when its module first runs in the browser, so a saved 24-hour choice is already right
	 * on the first paint.
	 */
	import { Card, Icon } from '$lib/components';
	import { timeFormat, type TimeFormat } from '$lib/settings/time-format.svelte';

	const uid = $props.id();
	const headingId = `${uid}-heading`;

	const OPTIONS: readonly { value: TimeFormat; name: string; sample: string }[] = [
		{ value: '12h', name: 'am/pm', sample: '9:05am' },
		{ value: '24h', name: '24-hour', sample: '09:05' }
	];

	const selected = $derived(timeFormat.current);
</script>

<Card class="time-format-card">
	<h2 id={headingId} class="time-format-heading">Clock</h2>

	<!-- A real heading outside the fieldset, and the fieldset named from it: the page
	     outline gets a section it can list, and the radio group still announces its own
	     name. A <legend> would give one of those, not both. -->
	<fieldset class="time-format-fieldset" aria-labelledby={headingId}>
		<p class="time-format-blurb">
			How every time in the app is written. Each one is the clock at the airport it
			belongs to, whatever time it is where you are reading this.
		</p>

		<div class="time-format-grid">
			{#each OPTIONS as option (option.value)}
				<label class="time-format-tile">
					<input
						class="time-format-input"
						type="radio"
						name="time-format"
						value={option.value}
						checked={option.value === selected}
						onchange={() => timeFormat.set(option.value)}
					/>
					<span class="time-format-body">
						<span class="time-format-sample font-mono tabular-nums">{option.sample}</span>
						<span class="time-format-name">{option.name}</span>
						<Icon name="check" class="time-format-check" />
					</span>
				</label>
			{/each}
		</div>
	</fieldset>
</Card>

<style>
	/* The compact padding the currency card and the export bar use: a one-decision
	   utility, not something anyone reads twice. */
	:global(.time-format-card.card-padded > .card-body) {
		padding: var(--space-4) var(--space-5);
	}

	.time-format-fieldset {
		border: 0;
		margin: 0;
		padding: 0;
		min-width: 0;
	}

	.time-format-heading {
		margin: 0 0 var(--space-2);
		font-size: var(--font-size-base);
	}

	.time-format-blurb {
		margin: 0 0 var(--space-4);
		max-width: 60ch;
		color: var(--color-text-muted);
		font-size: var(--font-size-xs);
	}

	/* Two tiles, capped rather than stretched across the page's full 72rem: a pair of
	   half-page buttons for a two-way choice reads as a banner, not as a setting. */
	.time-format-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-2);
		max-width: 22rem;
	}

	.time-format-tile {
		position: relative;
		display: block;
		min-width: 0;
		cursor: pointer;
	}

	/* Clipped to nothing rather than `display: none` or `visibility: hidden`, both of
	   which take the input out of the tab order and out of the accessibility tree with
	   it. Positioned against its own tile, so focusing it with the keyboard scrolls that
	   tile into view rather than somewhere up the page. */
	.time-format-input {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.time-format-body {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-1);
		/* Past the 44px minimum target (WCAG 2.5.5) in both dimensions, since the whole
		   tile is the target. */
		min-height: 4.75rem;
		padding: var(--space-3) var(--space-2);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-bg-inset);
		color: var(--color-text);
		text-align: center;
		transition:
			background-color var(--transition-fast),
			border-color var(--transition-fast),
			color var(--transition-fast);
	}

	.time-format-tile:hover .time-format-body {
		border-color: var(--color-border-strong);
		background: var(--color-surface-hover);
	}

	.time-format-tile:active .time-format-body {
		transform: scale(0.98);
	}

	/* The app's own focus ring (app.css), moved onto the tile: the real input is clipped
	   to nothing, so its outline is clipped away with it. Sitting outside the tile's
	   border is what keeps it visible on the CHECKED tile too, where an inset ring in the
	   accent colour would disappear into the accent border it already has. */
	.time-format-input:focus-visible + .time-format-body {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	.time-format-input:checked + .time-format-body {
		border-color: var(--color-accent);
		background: var(--color-accent-muted);
		color: var(--color-accent);
	}

	.time-format-sample {
		font-size: var(--font-size-lg);
		font-weight: var(--font-weight-semibold);
		line-height: 1;
	}

	.time-format-name {
		max-width: 100%;
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-muted);
	}

	.time-format-input:checked + .time-format-body .time-format-name {
		color: inherit;
	}

	/* The redundant, non-colour signal for the chosen tile. */
	.time-format-body :global(.time-format-check) {
		position: absolute;
		top: var(--space-2);
		right: var(--space-2);
		width: 0.875rem;
		height: 0.875rem;
		opacity: 0;
		color: var(--color-accent);
	}

	.time-format-input:checked + .time-format-body :global(.time-format-check) {
		opacity: 1;
	}

	@media (prefers-reduced-motion: reduce) {
		.time-format-body {
			transition: none;
		}

		.time-format-tile:active .time-format-body {
			transform: none;
		}
	}
</style>
