<script lang="ts">
	/**
	 * Brief lines 29 & 32: "Origin location (optional)" / "Destination location
	 * (optional)" - the traveller's actual starting or ending point, priced only for the
	 * first/last transfer leg (see `Location`'s own comment in the domain model).
	 *
	 * There is no geocoding provider merged yet (no issue owns turning free-text into
	 * coordinates, and this app makes every provider call from the browser with the
	 * user's own key - AGENTS.md rule 1), so a typed address alone cannot become a
	 * `Location`, which requires coordinates. The one coordinate source available
	 * without a backend is the browser's own Geolocation API, so that is what this
	 * field offers: a label the user can name freely, plus an explicit "use my
	 * location" action that is the only way to actually attach coordinates. Typing a
	 * label alone is kept (never discarded) but does not produce a value until
	 * coordinates exist - the hint says so, rather than silently guessing a point.
	 */
	import type { Coordinates, Location } from '$lib/domain';

	interface Props {
		label: string;
		id?: string;
		value?: Location;
		hint?: string;
		class?: string;
	}

	let { label, id, value = $bindable(undefined), hint, class: className }: Props = $props();

	const uid = $props.id();
	const inputId = $derived(id ?? `location-${uid}`);
	const hintId = $derived(`${inputId}-hint`);

	let labelDraft = $state(value?.label ?? '');
	let coordinates = $state<Coordinates | undefined>(value?.coordinates);
	let geoStatus = $state<'idle' | 'locating' | 'error'>('idle');
	let geoError = $state<string | undefined>(undefined);

	$effect(() => {
		const trimmed = labelDraft.trim();
		value = trimmed && coordinates ? { label: trimmed, coordinates } : undefined;
	});

	function useCurrentLocation() {
		if (!('geolocation' in navigator)) {
			geoStatus = 'error';
			geoError = 'This browser cannot share your location.';
			return;
		}
		geoStatus = 'locating';
		geoError = undefined;
		navigator.geolocation.getCurrentPosition(
			(position) => {
				coordinates = { latitude: position.coords.latitude, longitude: position.coords.longitude };
				if (!labelDraft.trim()) labelDraft = 'Current location';
				geoStatus = 'idle';
			},
			(err) => {
				geoStatus = 'error';
				geoError =
					err.code === err.PERMISSION_DENIED
						? 'Location access was denied.'
						: 'Could not get your location just now.';
			},
			{ enableHighAccuracy: false, timeout: 10_000 }
		);
	}

	function clearCoordinates() {
		coordinates = undefined;
	}
</script>

<div class={['field', className]}>
	<label for={inputId} class="field-label">
		<span>{label}</span>
		<span class="field-label-suffix">(optional)</span>
	</label>
	<div class="location-row">
		<input
			id={inputId}
			type="text"
			bind:value={labelDraft}
			placeholder="e.g. home address or neighbourhood"
			aria-describedby={hintId}
			class="field-input"
		/>
		<button type="button" class="location-btn" onclick={useCurrentLocation} disabled={geoStatus === 'locating'}>
			{#if geoStatus === 'locating'}
				Locating…
			{:else if coordinates}
				Update
			{:else}
				Use my location
			{/if}
		</button>
	</div>
	<p id={hintId} class="field-hint">
		{#if coordinates}
			Using this device's current coordinates for this point.
			<button type="button" class="link-btn" onclick={clearCoordinates}>Clear</button>
		{:else if labelDraft.trim()}
			Not included in the search yet - there's no address lookup, so tap "Use my location" to attach real
			coordinates to this point.
		{:else}
			{hint ?? "Used only to price the transfer to the airport. There's no address lookup yet, so this needs your device's current location."}
		{/if}
	</p>
	{#if geoError}
		<p class="field-error" role="alert">{geoError}</p>
	{/if}
</div>

<style>
	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		width: 100%;
	}

	.field-label {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-medium);
		color: var(--color-text-muted);
	}

	.field-label-suffix {
		font-weight: var(--font-weight-regular);
		color: var(--color-text-faint);
	}

	.location-row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.field-input {
		flex: 1 1 12rem;
		min-height: 2.75rem;
		padding: var(--space-3) var(--space-4);
		background: var(--color-surface);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-md);
		color: var(--color-text);
		font-size: var(--font-size-base);
	}

	.field-input:focus-visible {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.location-btn {
		flex: 0 0 auto;
		min-height: 2.75rem;
		padding: var(--space-2) var(--space-4);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-md);
		background: var(--color-surface);
		color: var(--color-text);
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-medium);
		white-space: nowrap;
	}

	.location-btn:hover:not(:disabled) {
		background: var(--color-surface-hover);
		border-color: var(--color-accent);
	}

	.location-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.field-hint {
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	.link-btn {
		color: var(--color-accent);
		text-decoration: underline;
		font-size: inherit;
	}

	.field-error {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
		color: var(--color-danger);
	}
</style>
