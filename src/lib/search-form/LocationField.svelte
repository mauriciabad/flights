<script lang="ts">
	/**
	 * Brief lines 29 & 32: "Origin location (optional)" / "Destination location
	 * (optional)" - the traveller's actual starting or ending point, priced only for the
	 * first/last transfer leg (see `Location`'s own comment in the domain model).
	 *
	 * Issue #64 replaces this field's original geolocation-only path (no geocoding
	 * provider existed when issue #16 shipped it) with a Transitous-backed free-text
	 * search: typing a few words now offers real, disambiguated candidates the same way
	 * `AirportField` offers airports, and picking one attaches its coordinates. "Use my
	 * location" stays as the one-tap shortcut it always was - useful exactly when a
	 * person is standing at the point in question and typing its name would be slower
	 * than just sharing where they already are. Typing a label with no coordinates
	 * attached (nothing picked, geolocation never used) is still kept rather than
	 * discarded, and still does not produce a value - the hint says so.
	 */
	import { searchLocations } from '$lib/providers/geocode/transitous';
	import type { GeocodeCandidate } from '$lib/providers/geocode/types';
	import type { Coordinates, Location } from '$lib/domain';
	import { describeGeocodeCandidate } from './geocode-candidate-label';

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
	const listboxId = $derived(`${inputId}-listbox`);
	const hintId = $derived(`${inputId}-hint`);

	// A courtesy to a free, volunteer-run service (docs/PROVIDERS.md), not a UX nicety:
	// without this, every keystroke would fire its own request rather than one per pause
	// in typing. `searchLocations`'s own long-TTL cache (issue #64) then means retyping
	// the same query later costs nothing further either.
	const SEARCH_DEBOUNCE_MS = 300;

	let labelDraft = $state(value?.label ?? '');
	let coordinates = $state<Coordinates | undefined>(value?.coordinates);
	let candidates = $state<GeocodeCandidate[]>([]);
	let open = $state(false);
	let activeIndex = $state(-1);
	let searchStatus = $state<'idle' | 'searching' | 'error'>('idle');
	let geoStatus = $state<'idle' | 'locating' | 'error'>('idle');
	let geoError = $state<string | undefined>(undefined);
	let inputEl: HTMLInputElement | undefined = $state();

	$effect(() => {
		const trimmed = labelDraft.trim();
		value = trimmed && coordinates ? { label: trimmed, coordinates } : undefined;
	});

	// Only searches while the dropdown is open (the user is actively editing), so
	// resolving an initial `value` passed in from outside never fires a redundant
	// search - same guard `AirportField` uses for its own typeahead.
	$effect(() => {
		if (!open) return;
		const query = labelDraft.trim();
		if (!query) {
			candidates = [];
			activeIndex = -1;
			searchStatus = 'idle';
			return;
		}

		const controller = new AbortController();
		let cancelled = false;
		const handle = setTimeout(async () => {
			searchStatus = 'searching';
			const result = await searchLocations(query, { signal: controller.signal });
			if (cancelled) return;
			if (result.ok) {
				candidates = result.data;
				activeIndex = result.data.length ? 0 : -1;
				searchStatus = 'idle';
			} else if (result.error.code !== 'cancelled') {
				candidates = [];
				activeIndex = -1;
				searchStatus = 'error';
			}
		}, SEARCH_DEBOUNCE_MS);

		return () => {
			cancelled = true;
			clearTimeout(handle);
			controller.abort();
		};
	});

	function selectCandidate(candidate: GeocodeCandidate) {
		labelDraft = describeGeocodeCandidate(candidate);
		coordinates = candidate.coordinates;
		candidates = [];
		open = false;
		activeIndex = -1;
		inputEl?.focus();
	}

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
				open = false;
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

	function onInput(event: Event) {
		labelDraft = (event.currentTarget as HTMLInputElement).value;
		open = true;
	}

	function onKeydown(event: KeyboardEvent) {
		if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
			open = true;
			return;
		}
		if (!open) return;
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				activeIndex = candidates.length ? (activeIndex + 1) % candidates.length : -1;
				break;
			case 'ArrowUp':
				event.preventDefault();
				activeIndex = candidates.length ? (activeIndex - 1 + candidates.length) % candidates.length : -1;
				break;
			case 'Enter':
				if (activeIndex >= 0 && candidates[activeIndex]) {
					event.preventDefault();
					selectCandidate(candidates[activeIndex]);
				}
				break;
			case 'Escape':
				open = false;
				activeIndex = -1;
				break;
		}
	}
</script>

<div class={['field', className]}>
	<label for={inputId} class="field-label">
		<span>{label}</span>
		<span class="field-label-suffix">(optional)</span>
	</label>
	<div class="location-row">
		<div class="combobox">
			<input
				bind:this={inputEl}
				id={inputId}
				type="text"
				role="combobox"
				aria-expanded={open && candidates.length > 0}
				aria-controls={listboxId}
				aria-autocomplete="list"
				aria-activedescendant={activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined}
				aria-describedby={hintId}
				autocomplete="off"
				spellcheck="false"
				value={labelDraft}
				placeholder="e.g. home address or neighbourhood"
				class="field-input"
				oninput={onInput}
				onfocus={() => (open = true)}
				onblur={() => (open = false)}
				onkeydown={onKeydown}
			/>
			{#if open && candidates.length > 0}
				<ul id={listboxId} role="listbox" class="combobox-list">
					{#each candidates as candidate, i (`${candidate.name}-${candidate.coordinates.latitude}-${candidate.coordinates.longitude}`)}
						<li id={`${listboxId}-opt-${i}`} role="option" aria-selected={i === activeIndex}>
							<button
								type="button"
								class={['combobox-option', { 'is-active': i === activeIndex }]}
								onmousedown={(event) => event.preventDefault()}
								onclick={() => selectCandidate(candidate)}
							>
								{describeGeocodeCandidate(candidate)}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
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
			Coordinates attached to this point.
			<button type="button" class="link-btn" onclick={clearCoordinates}>Clear</button>
		{:else if searchStatus === 'searching'}
			Searching…
		{:else if searchStatus === 'error'}
			Could not search locations right now - try "Use my location" instead.
		{:else if labelDraft.trim() && candidates.length === 0 && !open}
			No coordinates attached yet - pick a suggestion while typing, or tap "Use my location".
		{:else}
			{hint ?? 'Search by name, or tap "Use my location" for your device\'s current position.'}
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

	.combobox {
		position: relative;
		flex: 1 1 12rem;
	}

	.field-input {
		width: 100%;
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

	.combobox-list {
		position: absolute;
		z-index: 10;
		top: calc(100% + var(--space-1));
		left: 0;
		right: 0;
		max-height: 16rem;
		overflow-y: auto;
		overscroll-behavior: contain;
		background: var(--color-bg-elevated);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-lg);
	}

	.combobox-option {
		display: block;
		width: 100%;
		padding: var(--space-2) var(--space-3);
		text-align: left;
		color: var(--color-text);
		font-size: var(--font-size-sm);
	}

	.combobox-option.is-active,
	.combobox-option:hover {
		background: var(--color-surface-hover);
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
