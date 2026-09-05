<script lang="ts">
	/**
	 * Issue #16: "The waiting-time control must allow the brief's tiered rules, not just
	 * one number: sort flight or small airport 2h, long flight or large airport 3h, plus
	 * landing-to-transport of 15 or 30 minutes by airport size. A single number is the
	 * fallback, not the whole feature."
	 *
	 * Row 0 is always the base rule (no matchers - "every airport, every flight" -
	 * mirroring the first entry of `DEFAULT_WAITING_TIME_RULES` /
	 * `DEFAULT_LANDING_TO_TRANSPORT_RULES`), so there is always a value that applies
	 * when nothing more specific matches. With only that one row present, the control
	 * *is* "a single number" - the fallback the brief describes. Extra rows layer size
	 * (and, for waiting time, flight-length) tiers on top; each is independently
	 * removable, so undoing every tier gets back to the single-number case.
	 *
	 * Works on the normalised `TieredRuleRow[]` from `tiered-rules.ts` rather than
	 * `WaitingTimeRule[]`/`LandingToTransportRule[]` directly, so this one component
	 * serves both of the brief's tiered controls - the parent converts at the edges.
	 */
	import { Icon } from '$lib/components';
	import type { AirportSizeClass, FlightLengthClass } from '$lib/domain';
	import { createRow, type TieredRuleRow } from './tiered-rules';

	interface Props {
		label: string;
		hint?: string;
		rows?: TieredRuleRow[];
		/** Waiting time varies by flight length as well as airport size; landing-to-transport
		 * only varies by airport size. */
		showFlightLength?: boolean;
		class?: string;
	}

	let {
		label,
		hint,
		rows = $bindable([]),
		showFlightLength = false,
		class: className
	}: Props = $props();

	const uid = $props.id();
	const hintId = `${uid}-hint`;

	const AIRPORT_SIZE_OPTIONS: { value: AirportSizeClass | ''; label: string }[] = [
		{ value: '', label: 'Any size' },
		{ value: 'small', label: 'Small airport' },
		{ value: 'medium', label: 'Medium airport' },
		{ value: 'large', label: 'Large airport' }
	];

	const FLIGHT_LENGTH_OPTIONS: { value: FlightLengthClass | ''; label: string }[] = [
		{ value: '', label: 'Any length' },
		{ value: 'short', label: 'Short flight' },
		{ value: 'long', label: 'Long flight' }
	];

	function addRow() {
		const base = rows[0]?.minutes ?? 0;
		rows = [
			...rows,
			createRow({
				airportSize: 'large',
				flightLength: showFlightLength ? 'long' : undefined,
				minutes: base
			})
		];
	}

	function removeRow(id: number) {
		rows = rows.filter((row) => row.id !== id);
	}

	function setAirportSize(row: TieredRuleRow, raw: string) {
		row.airportSize = (raw || undefined) as AirportSizeClass | undefined;
	}

	function setFlightLength(row: TieredRuleRow, raw: string) {
		row.flightLength = (raw || undefined) as FlightLengthClass | undefined;
	}

	function setMinutes(row: TieredRuleRow, raw: string) {
		const parsed = Number(raw);
		row.minutes = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
	}
</script>

<div class={['tiered-field', className]}>
	<span id={`${uid}-label`} class="tiered-label">{label}</span>
	<ul class="tiered-rows" aria-labelledby={`${uid}-label`} aria-describedby={hint ? hintId : undefined}>
		{#each rows as row, index (row.id)}
			<li class="tiered-row">
				{#if index === 0}
					<span class="tiered-badge">All airports</span>
					{#if showFlightLength}
						<span class="tiered-badge">Any flight length</span>
					{/if}
				{:else}
					<label class="visually-hidden" for={`${uid}-size-${row.id}`}>Airport size for this rule</label>
					<select
						id={`${uid}-size-${row.id}`}
						class="tiered-select"
						value={row.airportSize ?? ''}
						onchange={(event) => setAirportSize(row, event.currentTarget.value)}
					>
						{#each AIRPORT_SIZE_OPTIONS as option (option.value)}
							<option value={option.value}>{option.label}</option>
						{/each}
					</select>
					{#if showFlightLength}
						<label class="visually-hidden" for={`${uid}-length-${row.id}`}>Flight length for this rule</label>
						<select
							id={`${uid}-length-${row.id}`}
							class="tiered-select"
							value={row.flightLength ?? ''}
							onchange={(event) => setFlightLength(row, event.currentTarget.value)}
						>
							{#each FLIGHT_LENGTH_OPTIONS as option (option.value)}
								<option value={option.value}>{option.label}</option>
							{/each}
						</select>
					{/if}
				{/if}

				<label class="visually-hidden" for={`${uid}-minutes-${row.id}`}>Minutes for this rule</label>
				<span class="tiered-minutes">
					<input
						id={`${uid}-minutes-${row.id}`}
						type="number"
						inputmode="numeric"
						min="0"
						step="5"
						value={row.minutes}
						oninput={(event) => setMinutes(row, event.currentTarget.value)}
					/>
					<span aria-hidden="true">min</span>
				</span>

				{#if index > 0}
					<button
						type="button"
						class="tiered-remove"
						aria-label="Remove this rule"
						onclick={() => removeRow(row.id)}
					>
						<Icon name="x" />
					</button>
				{/if}
			</li>
		{/each}
	</ul>
	<button type="button" class="tiered-add" onclick={addRow}>
		+ Add a rule for a specific {showFlightLength ? 'airport size or flight length' : 'airport size'}
	</button>
	{#if hint}
		<p id={hintId} class="tiered-hint">{hint}</p>
	{/if}
</div>

<style>
	.tiered-field {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		width: 100%;
	}

	.tiered-label {
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-medium);
		color: var(--color-text-muted);
	}

	.tiered-rows {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.tiered-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-2);
		background: var(--color-bg-inset);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
	}

	.tiered-badge {
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius-full);
		background: var(--color-accent-muted);
		color: var(--color-accent);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
		white-space: nowrap;
	}

	.tiered-select {
		min-height: 2.5rem;
		padding: var(--space-2) var(--space-3);
		background: var(--color-surface);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-md);
		color: var(--color-text);
		font-size: var(--font-size-sm);
	}

	.tiered-select:focus-visible {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.tiered-minutes {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		margin-left: auto;
	}

	.tiered-minutes input {
		width: 4.5rem;
		min-height: 2.5rem;
		padding: var(--space-2) var(--space-3);
		background: var(--color-surface);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-md);
		color: var(--color-text);
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		text-align: right;
	}

	.tiered-minutes input:focus-visible {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.tiered-minutes span[aria-hidden] {
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	.tiered-remove {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		/* 44px minimum touch target (WCAG 2.5.5): each rule row has its own line with
		   room to spare, unlike a wrapped chip list, so this can just grow for real
		   rather than reaching for an invisible hit area. */
		width: 2.75rem;
		height: 2.75rem;
		flex-shrink: 0;
		border-radius: var(--radius-full);
		color: var(--color-text-faint);
	}

	.tiered-remove:hover {
		background: var(--color-surface-hover);
		color: var(--color-danger);
	}

	.tiered-remove :global(svg) {
		width: 0.875rem;
		height: 0.875rem;
	}

	.tiered-add {
		align-self: flex-start;
		min-height: 2.75rem;
		padding: var(--space-2) var(--space-3);
		border: 1px dashed var(--color-border-strong);
		border-radius: var(--radius-md);
		color: var(--color-accent);
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-medium);
	}

	.tiered-add:hover {
		background: var(--color-accent-muted);
	}

	.tiered-hint {
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}
</style>
