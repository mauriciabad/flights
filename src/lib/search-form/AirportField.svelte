<script lang="ts">
	/**
	 * Airport typeahead for the search form (issue #16: "Airport inputs need typeahead
	 * over the airport dataset, matching IATA code, city and airport name" - issue #11's
	 * `searchAirports` already ranks exactly that way). A plain `Input` can't do this: it
	 * has nowhere to render a suggestion list, and the thing the user picks (an IATA
	 * code) is not the same string they want to read (a city and airport name), so the
	 * component tracks both: `value` is the committed code, `query` is the text in the
	 * box.
	 */
	import { getAirport, searchAirports } from '$lib/data/airports';
	import { Flag } from '$lib/components';
	import type { Airport } from '$lib/domain';

	interface Props {
		label: string;
		id?: string;
		/** The committed IATA code, or '' when nothing is selected yet. */
		value?: string;
		placeholder?: string;
		hint?: string;
		error?: string;
		required?: boolean;
		disabled?: boolean;
		class?: string;
		/** Fired after the field has resolved whatever was typed to a real selection (or
		 * reverted it), so a form can tell "left this field alone" from "tried and left
		 * it empty" and only show an error for the second. */
		onblur?: () => void;
	}

	let {
		label,
		id,
		value = $bindable(''),
		placeholder = 'City or airport',
		hint,
		error,
		required = false,
		disabled = false,
		class: className,
		onblur
	}: Props = $props();

	const uid = $props.id();
	const inputId = $derived(id ?? `airport-${uid}`);
	const listboxId = $derived(`${inputId}-listbox`);
	const hintId = $derived(hint ? `${inputId}-hint` : undefined);
	const errorId = $derived(error ? `${inputId}-error` : undefined);
	const describedBy = $derived([hintId, errorId].filter(Boolean).join(' ') || undefined);

	function formatAirport(airport: Airport): string {
		return `${airport.iataCode} - ${airport.city.name}, ${airport.country.name}`;
	}

	let query = $state('');
	let results = $state<Airport[]>([]);
	let open = $state(false);
	let activeIndex = $state(-1);
	// The airport `value` currently resolves to, kept alongside it purely to render the
	// display text - never the source of truth for `value` itself.
	let committedAirport = $state<Airport | undefined>(undefined);
	let inputEl: HTMLInputElement | undefined = $state();

	// Keeps `query` in sync when `value` changes from outside this component (the
	// initial load from a shared URL, or a parent clearing the field) - guarded by
	// `!open` so it never overwrites text the user is actively typing.
	$effect(() => {
		const code = value.trim().toUpperCase();
		if (!code) {
			committedAirport = undefined;
			if (!open) query = '';
			return;
		}
		if (committedAirport?.iataCode === code) return;
		let cancelled = false;
		getAirport(code).then((airport) => {
			if (cancelled) return;
			committedAirport = airport;
			if (!open) query = airport ? formatAirport(airport) : code;
		});
		return () => {
			cancelled = true;
		};
	});

	// Only searches while the dropdown is open (i.e. the user is actively editing),
	// so resolving the initial `value` above never fires a redundant search.
	$effect(() => {
		if (!open) return;
		const q = query.trim();
		if (!q) {
			results = [];
			activeIndex = -1;
			return;
		}
		let cancelled = false;
		searchAirports(q).then((found) => {
			if (cancelled) return;
			results = found;
			activeIndex = found.length ? 0 : -1;
		});
		return () => {
			cancelled = true;
		};
	});

	function select(airport: Airport) {
		value = airport.iataCode;
		committedAirport = airport;
		query = formatAirport(airport);
		open = false;
		activeIndex = -1;
		inputEl?.focus();
	}

	/** Resolves whatever's in the box to a real committed selection on blur, or reverts
	 * it - the field never keeps free text that merely looks chosen. */
	async function commitFromQuery() {
		const q = query.trim();
		if (!q) {
			value = '';
			committedAirport = undefined;
			return;
		}
		if (committedAirport && formatAirport(committedAirport) === q) return;

		if (/^[a-zA-Z]{3}$/.test(q)) {
			const airport = await getAirport(q);
			if (airport) {
				select(airport);
				return;
			}
		}

		const found = results.find((airport) => formatAirport(airport).toLowerCase() === q.toLowerCase());
		if (found) {
			select(found);
			return;
		}

		if (committedAirport) {
			query = formatAirport(committedAirport);
		} else {
			value = '';
			query = '';
		}
	}

	function onInput(event: Event) {
		query = (event.currentTarget as HTMLInputElement).value;
		open = true;
	}

	function onBlur() {
		open = false;
		void commitFromQuery().then(() => onblur?.());
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
				activeIndex = results.length ? (activeIndex + 1) % results.length : -1;
				break;
			case 'ArrowUp':
				event.preventDefault();
				activeIndex = results.length ? (activeIndex - 1 + results.length) % results.length : -1;
				break;
			case 'Enter':
				if (activeIndex >= 0 && results[activeIndex]) {
					event.preventDefault();
					select(results[activeIndex]);
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
		{label}{#if required}<span aria-hidden="true"> *</span>{/if}
	</label>
	<div class="combobox">
		<input
			bind:this={inputEl}
			id={inputId}
			type="text"
			role="combobox"
			aria-expanded={open}
			aria-controls={listboxId}
			aria-autocomplete="list"
			aria-activedescendant={activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined}
			aria-invalid={error ? 'true' : undefined}
			aria-describedby={describedBy}
			autocomplete="off"
			spellcheck="false"
			{placeholder}
			{required}
			{disabled}
			value={query}
			class={['field-input', { 'has-error': !!error }]}
			oninput={onInput}
			onfocus={() => (open = true)}
			onblur={onBlur}
			onkeydown={onKeydown}
		/>
		{#if open && results.length}
			<ul id={listboxId} role="listbox" class="combobox-list">
				{#each results as airport, i (airport.iataCode)}
					<!-- The click target is this `<li>` itself, not a nested `<button>`: this
					     combobox already drives keyboard selection through `aria-activedescendant`
					     on the input above (the option is never really focused), so a real
					     interactive element here only ever existed for the mouse. `role="option"`
					     forbids interactive descendants outright — axe's "nested-interactive"
					     check catches exactly a `<button>` in this spot — and putting the
					     handlers on the option directly needs no such descendant to begin with.
					     No keyboard handler belongs here either: this `<li>` never receives real
					     DOM focus (it has no tabindex), so it is never reachable by keyboard on
					     its own — Enter is handled once, on the input, in `onKeydown` above. -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<li
						id={`${listboxId}-opt-${i}`}
						role="option"
						aria-selected={i === activeIndex}
						class={['combobox-option', { 'is-active': i === activeIndex }]}
						onmousedown={(event) => event.preventDefault()}
						onclick={() => select(airport)}
					>
						<!-- Decorative: the option's second line already ends with the country
						     name, so the flag repeats it rather than adding to it. -->
						<Flag country={airport.country} size="md" decorative />
						<span class="combobox-option-text">
							<span class="combobox-option-code font-mono">{airport.iataCode}</span>
							<span class="combobox-option-place">{airport.city.name}, {airport.country.name}</span>
						</span>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
	{#if hint && !error}
		<p id={hintId} class="field-hint">{hint}</p>
	{/if}
	{#if error}
		<p id={errorId} class="field-error" role="alert">{error}</p>
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
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-medium);
		color: var(--color-text-muted);
	}

	.combobox {
		position: relative;
	}

	.field-input {
		width: 100%;
		min-height: var(--control-height);
		padding: var(--control-padding-y) var(--space-3);
		background: var(--color-surface);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-md);
		color: var(--color-text);
		font-size: var(--font-size-base);
		transition:
			border-color var(--transition-fast),
			background-color var(--transition-fast),
			box-shadow var(--transition-fast);
	}

	.field-input::placeholder {
		color: var(--color-text-faint);
	}

	.field-input:hover:not(:disabled) {
		background: var(--color-surface-hover);
	}

	.field-input:focus-visible {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.field-input:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.field-input.has-error {
		border-color: var(--color-danger);
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
		display: flex;
		align-items: center;
		gap: var(--space-3);
		width: 100%;
		padding: var(--space-2) var(--space-3);
		text-align: left;
		color: var(--color-text);
		/* This used to be a <button>'s free reset (app.css's global `button { cursor:
		   pointer }`); now that the click target is the <li> itself, it needs its own. */
		cursor: pointer;
	}

	.combobox-option.is-active,
	.combobox-option:hover {
		background: var(--color-surface-hover);
	}

	.combobox-option-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.combobox-option-code {
		font-weight: var(--font-weight-semibold);
		font-size: var(--font-size-sm);
	}

	.combobox-option-place {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}

	.field-hint {
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	.field-error {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
		color: var(--color-danger);
	}
</style>
