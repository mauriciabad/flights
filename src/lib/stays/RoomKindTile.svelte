<script lang="ts">
	/**
	 * One clickable price tile for a single room kind at the currently-open property -
	 * issue #27: "Dorm and private prices side by side, per night and multiplied out for
	 * the stay." Picking a different tile is what "switching between them updates the
	 * itinerary total immediately" means in practice; StayPicker.svelte owns the actual
	 * switch, this component only renders one option and reports a click.
	 */
	import type { RoomKind } from '$lib/domain';
	import { formatMoney, stayTotalForNights } from './pricing';
	import type { StayOption } from './types';

	const ROOM_KIND_LABELS: Record<RoomKind, string> = {
		dorm: 'Dorm bed',
		private: 'Private room',
		'female-dorm': 'Female-only dorm'
	};

	interface Props {
		option: StayOption;
		nights: number;
		selected: boolean;
		/** False when this group cannot book this option at all (a female-only dorm that
		 * does not fit their gender mix - see female-dorm-fit.ts). The tile still shows
		 * its price for context, but cannot be picked. */
		selectable: boolean;
		/** Why it isn't selectable, or why it was included despite an assumption -
		 * femaleDormFitMessage's output, passed in rather than recomputed here so this
		 * component stays a pure renderer of whatever the caller decided. */
		caveat?: string;
		onselect: () => void;
	}

	let { option, nights, selected, selectable, caveat, onselect }: Props = $props();

	// A room whose dorm/private split was inferred rather than confirmed (issue #65)
	// gets said outright instead of a label implying certainty - AGENTS.md: "Say what
	// you do not know rather than guessing."
	const label = $derived(
		option.notStated === 'room-kind' ? 'Room type not stated' : ROOM_KIND_LABELS[option.stay.roomKind]
	);
	const total = $derived(stayTotalForNights(option.stay.pricePerNight, nights));
	const nightsLabel = $derived(nights === 1 ? '1 night' : `${nights} nights`);
</script>

<button
	type="button"
	class={['room-tile', { 'is-selected': selected, 'is-unavailable': !selectable }]}
	aria-pressed={selected}
	disabled={!selectable}
	onclick={onselect}
>
	<span class="room-tile-label">
		{label}
		{#if option.notStated === 'female-only'}
			<span class="room-tile-flag">(female-only status not stated)</span>
		{/if}
	</span>
	<span class="room-tile-price font-mono tabular-nums">
		{formatMoney(option.stay.pricePerNight)}<span class="room-tile-unit">/night</span>
	</span>
	<span class="room-tile-total font-mono tabular-nums">{formatMoney(total)} &middot; {nightsLabel}</span>
	{#if caveat}
		<span class="room-tile-caveat">
			<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
				<circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.4" />
				<path d="M8 7.25v3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
				<circle cx="8" cy="5.1" r="0.9" fill="currentColor" />
			</svg>
			{caveat}
		</span>
	{/if}
</button>

<style>
	.room-tile {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 9.5rem;
		min-height: 44px;
		padding: var(--space-4);
		text-align: left;
		background: var(--color-surface);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-lg);
		color: var(--color-text);
		cursor: pointer;
		transition:
			background-color var(--transition-fast),
			border-color var(--transition-fast),
			transform var(--transition-fast);
	}

	.room-tile:not(:disabled):hover {
		background: var(--color-surface-hover);
	}

	.room-tile:not(:disabled):active {
		transform: translateY(1px);
	}

	.room-tile.is-selected {
		background: var(--color-accent-muted);
		border-color: var(--color-accent);
		box-shadow: var(--shadow-accent);
	}

	.room-tile-label {
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
	}

	.room-tile.is-selected .room-tile-label {
		color: var(--color-accent);
	}

	.room-tile-flag {
		display: block;
		margin-top: var(--space-1);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-regular);
		color: var(--color-text-faint);
	}

	.room-tile-price {
		font-size: var(--font-size-xl);
		font-weight: var(--font-weight-bold);
		letter-spacing: var(--tracking-tight);
	}

	.room-tile-unit {
		margin-left: var(--space-1);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-regular);
		color: var(--color-text-muted);
	}

	.room-tile-total {
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}

	.room-tile-caveat {
		display: flex;
		align-items: flex-start;
		gap: var(--space-1);
		margin-top: var(--space-1);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-regular);
		color: var(--color-warning);
	}

	.room-tile-caveat svg {
		flex-shrink: 0;
		width: 0.9rem;
		height: 0.9rem;
		margin-top: 0.1rem;
	}

	/* Colour-only change would fail the "still readable" bar every deprioritised
	   treatment in this app has to clear (app.css .is-deprioritized) - background and
	   border move too, not just text colour. */
	.room-tile.is-unavailable {
		background: var(--color-bg-inset);
		border-color: var(--color-border);
		color: var(--color-text-deprioritized);
		cursor: not-allowed;
	}

	.room-tile.is-unavailable .room-tile-unit,
	.room-tile.is-unavailable .room-tile-total {
		color: var(--color-text-deprioritized);
	}
</style>
