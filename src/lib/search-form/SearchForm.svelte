<script lang="ts">
	/**
	 * The whole search, as one component, so the search screen and the results screen
	 * are editing the same thing rather than two forms that drift apart.
	 *
	 * It was inline in `src/routes/+page.svelte` while Search and Results were two peer
	 * tabs. The owner on that: "the UX of goig from search to result makes no fucking
	 * sense. you should get redirected [...] results should be merged with search, you
	 * first pick the search and then shows results, they are not 2 separate tabs." So
	 * this now lives in `$lib` and the results page opens it in place, above its own
	 * results, with the current query already in it.
	 *
	 * Field ids are fixed by `FIELD_INPUT_ID` (validation.ts) rather than generated,
	 * because a failed submit has to move focus to the first field that is wrong and an
	 * error summary has to link to it. One consequence: only one of these may be on a
	 * page at a time, which is the case on both screens that use it.
	 */
	import { tick, untrack } from 'svelte';
	import { Button, Card, DateField, Input } from '$lib/components';
	import { DEFAULT_LANDING_TO_TRANSPORT_RULES, DEFAULT_WAITING_TIME_RULES } from '$lib/domain';
	import AirportField from './AirportField.svelte';
	import ChipListField from './ChipListField.svelte';
	import LocationField from './LocationField.svelte';
	import type { SearchFormFields } from './model';
	import TieredDurationField from './TieredDurationField.svelte';
	import {
		landingToTransportRulesToRows,
		rowsToLandingToTransportRules,
		rowsToWaitingTimeRules,
		waitingTimeRulesToRows,
		type TieredRuleRow
	} from './tiered-rules';
	import { fieldsToSearchParams } from './url-codec';
	import {
		FIELD_INPUT_ID,
		issuesByField,
		validateSearchFields,
		type SearchFieldKey
	} from './validation';

	interface Props {
		/** Seeded once. The parent re-keys this component when the URL's search changes,
		 * rather than pushing new values in, so nothing here fights the traveller for
		 * ownership of a field they are typing in. */
		initialFields: SearchFormFields;
		/** Today's calendar date, `YYYY-MM-DD`. The parent owns the clock. */
		today: string;
		submitLabel?: string;
		/** Handed the URL params of a search that passed validation, so the caller only
		 * ever has to decide where to navigate. */
		onsearch: (params: URLSearchParams) => void;
		/** Rendered as a second button when given, for the results page's editor. */
		oncancel?: () => void;
		/** Show every problem straight away instead of waiting for a blur or a submit.
		 * Set when the form opens because the search it was given is already wrong, which
		 * is the results page arriving on a link nobody could have run. */
		revealIssues?: boolean;
	}

	let {
		initialFields,
		today,
		submitLabel = 'Search flights',
		onsearch,
		oncancel,
		revealIssues = false
	}: Props = $props();

	// `untrack` says the "seeded once" above out loud to the compiler: this deliberately
	// captures the initial value and never follows the prop afterwards.
	let fields = $state<SearchFormFields>(untrack(() => ({ ...initialFields })));

	// Number inputs go through a raw string buffer rather than binding `fields.*`
	// directly: an in-progress "" (cleared field) has to stay distinct from "0", and a
	// plain `bind:value` on a numeric prop cannot tell those apart.
	let travellersRaw = $state(fields.travellers !== undefined ? String(fields.travellers) : '');
	let femalesRaw = $state(fields.females !== undefined ? String(fields.females) : '');
	let minLayoverRaw = $state(
		fields.minLayoverTime !== undefined ? String(fields.minLayoverTime) : ''
	);

	/**
	 * `undefined` for blank, `NaN` for text that is not a number, otherwise the number
	 * exactly as typed. It used to clamp ("0 travellers" silently became 1 and "abc"
	 * silently vanished), which is the class of thing the owner asked to stop: a field
	 * that can be wrong should say so rather than quietly correct itself. `validation.ts`
	 * turns both odd values into a sentence in the field.
	 */
	function parseNumberField(raw: string): number | undefined {
		// `String(raw ?? '')` rather than `raw.trim()`: Svelte's `bind:value` checks the
		// element's type at runtime and hands back a `number` (or `null` when empty) for
		// `<input type="number">`, whatever the prop's declared type says. The old code
		// here called `.trim()` straight on it, so the first keystroke in "Number of
		// people" threw a TypeError inside the derived and the form silently stopped
		// validating anything at all.
		const trimmed = String(raw ?? '').trim();
		if (!trimmed) return undefined;
		return Number(trimmed);
	}

	let waitingRows = $state<TieredRuleRow[]>(
		waitingTimeRulesToRows(fields.waitingTimeRules ?? DEFAULT_WAITING_TIME_RULES)
	);
	let transportRows = $state<TieredRuleRow[]>(
		landingToTransportRulesToRows(
			fields.landingToTransportRules ?? DEFAULT_LANDING_TO_TRANSPORT_RULES
		)
	);

	let useLatestDepartureOverride = $state(fields.latestDepartureOverride.trim() !== '');
	let useSoonestArrivalOverride = $state(fields.soonestArrivalOverride.trim() !== '');

	function setLatestDepartureOverride(enabled: boolean) {
		useLatestDepartureOverride = enabled;
		if (!enabled) fields.latestDepartureOverride = '';
	}

	function setSoonestArrivalOverride(enabled: boolean) {
		useSoonestArrivalOverride = enabled;
		if (!enabled) fields.soonestArrivalOverride = '';
	}

	/** `fields` plus everything the raw buffers and row editors resolve to. Computed, not
	 * written back into `fields`, so nothing fights Svelte over who owns a field. */
	const effectiveFields = $derived<SearchFormFields>({
		...fields,
		travellers: parseNumberField(travellersRaw),
		females: parseNumberField(femalesRaw),
		minLayoverTime: parseNumberField(minLayoverRaw),
		waitingTimeRules: rowsToWaitingTimeRules(waitingRows),
		landingToTransportRules: rowsToLandingToTransportRules(transportRows)
	});

	const issues = $derived(validateSearchFields(effectiveFields, { today }));
	const allMessages = $derived(issuesByField(issues));

	/**
	 * A field says what is wrong with it once the traveller has left it, or once they
	 * have tried to search. Nothing shouts at a half-typed airport code.
	 */
	let attempted = $state(untrack(() => revealIssues));
	let touched = $state<Record<string, boolean>>({});
	const errors = $derived.by(() => {
		const shown: Partial<Record<SearchFieldKey, string>> = {};
		for (const [field, message] of Object.entries(allMessages) as [SearchFieldKey, string][]) {
			if (attempted || touched[field]) shown[field] = message;
		}
		return shown;
	});

	function markTouched(field: SearchFieldKey) {
		touched = { ...touched, [field]: true };
	}

	/** The summary lists only what is on screen, so it can never name an error the
	 * traveller cannot see. After a submit attempt that is everything. */
	const summaryIssues = $derived(issues.filter((issue) => errors[issue.field] === issue.message));

	let summaryEl = $state<HTMLDivElement | undefined>();

	// The two window-narrowing dates live inside a closed disclosure, so an error on one
	// of them has to open it or the summary would link to a field nobody can see.
	let datesDisclosureOpen = $state(
		untrack(
			() =>
				initialFields.latestDepartureOverride.trim() !== '' ||
				initialFields.soonestArrivalOverride.trim() !== ''
		)
	);
	const overrideHasError = $derived(
		Boolean(errors.latestDepartureOverride || errors.soonestArrivalOverride)
	);
	// `open` plus `ontoggle` rather than `bind:open` and an effect that forces it: the
	// disclosure has two owners (the traveller's click and an error that has to be
	// reachable), and this way neither one has to write state from inside a reaction.
	const datesDisclosureVisible = $derived(datesDisclosureOpen || overrideHasError);

	function focusField(field: SearchFieldKey) {
		document.getElementById(FIELD_INPUT_ID[field])?.focus();
	}

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		attempted = true;
		if (issues.length > 0) {
			// One frame for the summary to render before it is focused, otherwise the
			// screen reader is sent to an element that does not exist yet.
			await tick();
			summaryEl?.focus();
			return;
		}
		onsearch(fieldsToSearchParams(effectiveFields));
	}

	function swapAirports() {
		const from = fields.originAirport;
		fields.originAirport = fields.destinationAirport;
		fields.destinationAirport = from;
	}

	const upperCode = (length: number) => (raw: string) => {
		const token = raw.trim().toUpperCase();
		return token.length === length ? token : null;
	};
	const airportToken = upperCode(3);
	const countryToken = upperCode(2);
	const airlineToken = upperCode(2);
</script>

<form novalidate onsubmit={handleSubmit} class="search-form">
	{#if summaryIssues.length > 0}
		<!-- The pattern every accessible form uses and this one did not: one summary at
		     the top, focused on a failed submit, each line a link straight to the field
		     it is about. The old form said "A few required fields are missing" and left
		     the traveller to find out which. -->
		<div
			bind:this={summaryEl}
			class="error-summary"
			role="alert"
			tabindex="-1"
			aria-labelledby="error-summary-title"
		>
			<p id="error-summary-title" class="error-summary-title">
				{summaryIssues.length === 1
					? 'One thing to fix before this search can run'
					: `${summaryIssues.length} things to fix before this search can run`}
			</p>
			<ul>
				{#each summaryIssues as issue (issue.field + issue.message)}
					<li>
						<a
							href={`#${FIELD_INPUT_ID[issue.field]}`}
							onclick={(event) => {
								event.preventDefault();
								focusField(issue.field);
							}}
						>
							{issue.message}
						</a>
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	<Card variant="ticket" class="section">
		{#snippet header()}Route{/snippet}
		<div class="route-grid">
			<AirportField
				label="Origin airport"
				id={FIELD_INPUT_ID.originAirport}
				required
				bind:value={fields.originAirport}
				error={errors.originAirport}
				onblur={() => markTouched('originAirport')}
			/>
			<button type="button" class="swap" onclick={swapAirports}>
				<span class="swap-icon" aria-hidden="true">
					<svg viewBox="0 0 24 24" fill="none">
						<path
							d="M7 4v13M7 17l-3-3M7 17l3-3M17 20V7M17 7l-3 3M17 7l3 3"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						/>
					</svg>
				</span>
				<span class="swap-label">Swap</span>
			</button>
			<AirportField
				label="Destination airport"
				id={FIELD_INPUT_ID.destinationAirport}
				required
				bind:value={fields.destinationAirport}
				error={errors.destinationAirport}
				onblur={() => markTouched('destinationAirport')}
			/>
		</div>
		<details class="disclosure">
			<summary>Add your exact start or end point</summary>
			<div class="disclosure-body field-grid">
				<LocationField label="Origin location" bind:value={fields.originLocation} />
				<LocationField label="Destination location" bind:value={fields.destinationLocation} />
			</div>
		</details>
	</Card>

	<Card variant="ticket" class="section">
		{#snippet header()}Travel dates{/snippet}
		<div class="field-grid">
			<DateField
				label="Soonest departure"
				id={FIELD_INPUT_ID.soonestDeparture}
				required
				min={today}
				bind:value={fields.soonestDeparture}
				error={errors.soonestDeparture}
				onblur={() => markTouched('soonestDeparture')}
			/>
			<DateField
				label="Latest arrival"
				id={FIELD_INPUT_ID.latestArrival}
				required
				min={fields.soonestDeparture || today}
				bind:value={fields.latestArrival}
				error={errors.latestArrival}
				onblur={() => markTouched('latestArrival')}
			/>
		</div>
		<details
			class="disclosure"
			open={datesDisclosureVisible}
			ontoggle={(event) => (datesDisclosureOpen = event.currentTarget.open)}
		>
			<summary>Narrow the departure or arrival window further</summary>
			<div class="disclosure-body">
				<label class="checkbox-row">
					<input
						type="checkbox"
						checked={useLatestDepartureOverride}
						onchange={(event) => setLatestDepartureOverride(event.currentTarget.checked)}
					/>
					Use a different latest departure date
				</label>
				{#if useLatestDepartureOverride}
					<DateField
						label="Latest departure"
						id={FIELD_INPUT_ID.latestDepartureOverride}
						min={fields.soonestDeparture || today}
						max={fields.latestArrival || undefined}
						bind:value={fields.latestDepartureOverride}
						error={errors.latestDepartureOverride}
						onblur={() => markTouched('latestDepartureOverride')}
					/>
				{:else}
					<p class="derived-note">
						Defaults to your latest arrival date{#if fields.latestArrival}: <strong class="font-mono"
							>{fields.latestArrival}</strong
						>{/if}.
					</p>
				{/if}

				<label class="checkbox-row">
					<input
						type="checkbox"
						checked={useSoonestArrivalOverride}
						onchange={(event) => setSoonestArrivalOverride(event.currentTarget.checked)}
					/>
					Use a different soonest arrival date
				</label>
				{#if useSoonestArrivalOverride}
					<DateField
						label="Soonest arrival"
						id={FIELD_INPUT_ID.soonestArrivalOverride}
						min={fields.soonestDeparture || today}
						max={fields.latestArrival || undefined}
						bind:value={fields.soonestArrivalOverride}
						error={errors.soonestArrivalOverride}
						onblur={() => markTouched('soonestArrivalOverride')}
					/>
				{:else}
					<p class="derived-note">
						Defaults to your soonest departure date{#if fields.soonestDeparture}: <strong
							class="font-mono">{fields.soonestDeparture}</strong
						>{/if}.
					</p>
				{/if}
			</div>
		</details>
	</Card>

	<Card class="section">
		{#snippet header()}Who is travelling{/snippet}
		<div class="field-grid">
			<Input
				label="Number of people"
				id={FIELD_INPUT_ID.travellers}
				type="number"
				inputmode="numeric"
				min="1"
				placeholder="1"
				hint="Defaults to 1 traveller."
				bind:value={travellersRaw}
				error={errors.travellers}
				onblur={() => markTouched('travellers')}
			/>
			<Input
				label="Female travellers"
				id={FIELD_INPUT_ID.females}
				type="number"
				inputmode="numeric"
				min="0"
				placeholder="Not specified"
				hint="Only used to check whether female-only hostel dorms are available for your group. It never affects pricing or anything else."
				bind:value={femalesRaw}
				error={errors.females}
				onblur={() => markTouched('females')}
			/>
		</div>
	</Card>

	<Card class="section">
		{#snippet header()}Connections{/snippet}
		<Input
			label="Minimum layover time"
			id={FIELD_INPUT_ID.minLayoverTime}
			type="number"
			inputmode="numeric"
			min="0"
			step="5"
			placeholder="30"
			hint="Minutes between flights. Defaults to 30 minutes if left blank."
			bind:value={minLayoverRaw}
			error={errors.minLayoverTime}
			onblur={() => markTouched('minLayoverTime')}
		/>
		<ChipListField
			label="Only search these connection airports"
			id={FIELD_INPUT_ID.allowedConnectionAirports}
			hint="IATA codes, for example VIE. Leave empty to allow any connection airport."
			placeholder="Add an airport code and press enter"
			rejectMessage="An airport code is three letters, like VIE."
			transform={airportToken}
			bind:values={fields.allowedConnectionAirports}
			error={errors.allowedConnectionAirports}
		/>
		<ChipListField
			label="Avoid these connection airports"
			id={FIELD_INPUT_ID.forbiddenConnectionAirports}
			hint="IATA codes to rule out entirely."
			placeholder="Add an airport code and press enter"
			rejectMessage="An airport code is three letters, like VIE."
			transform={airportToken}
			bind:values={fields.forbiddenConnectionAirports}
			error={errors.forbiddenConnectionAirports}
		/>
		<ChipListField
			label="Avoid these connection countries"
			id={FIELD_INPUT_ID.forbiddenConnectionCountries}
			hint="ISO country codes, for example RU."
			placeholder="Add a country code and press enter"
			rejectMessage="A country code is two letters, like RU."
			transform={countryToken}
			bind:values={fields.forbiddenConnectionCountries}
			error={errors.forbiddenConnectionCountries}
		/>
		<ChipListField
			label="Airlines to avoid"
			id={FIELD_INPUT_ID.airlinesToAvoid}
			hint="IATA airline codes, for example FR for Ryanair. Still fetched and shown, just greyed out and scored down, never dropped from results."
			placeholder="Add an airline code and press enter"
			rejectMessage="An airline code is two characters, like FR or U2."
			transform={airlineToken}
			bind:values={fields.airlinesToAvoid}
			error={errors.airlinesToAvoid}
		/>
	</Card>

	<Card variant="ticket" class="section">
		{#snippet header()}Time at the airport{/snippet}
		<TieredDurationField
			label="Waiting time before a flight"
			hint="How long before departure you want to be at the gate. Not the same as layover time between flights."
			showFlightLength
			bind:rows={waitingRows}
		/>
		<TieredDurationField
			label="Landing to transport"
			hint="How long after landing before you can realistically catch onward transport."
			bind:rows={transportRows}
		/>
	</Card>

	<div class="actions">
		<Button type="submit" size="lg" fullWidth={!oncancel}>{submitLabel}</Button>
		{#if oncancel}
			<Button type="button" variant="ghost" size="lg" onclick={oncancel}>Cancel</Button>
		{/if}
	</div>
</form>

<style>
	.search-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}

	/* Svelte scopes styles by element, and `class` passed into <Card> lands on an
	   element rendered by that component, so it needs :global to reach it. */
	.search-form :global(.section) {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.error-summary {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-4) var(--space-5);
		background: var(--color-danger-bg);
		border: 1px solid var(--color-danger);
		border-radius: var(--radius-lg);
	}

	.error-summary:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	.error-summary-title {
		font-weight: var(--font-weight-semibold);
		color: var(--color-text);
	}

	.error-summary ul {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		padding-left: var(--space-4);
		list-style: disc;
	}

	.error-summary a {
		color: var(--color-text);
		font-size: var(--font-size-sm);
	}

	.error-summary a:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
		border-radius: var(--radius-sm);
	}

	.field-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: var(--space-4);
	}

	/* The two airports read as one control with a hinge in the middle, the way a
	   boarding pass prints them, rather than as two unrelated text boxes. */
	.route-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: var(--space-3);
	}

	.swap {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		align-self: start;
		/* 44px, per WCAG 2.5.5, since this is a thumb target on a phone. */
		min-height: 2.75rem;
		min-width: 2.75rem;
		padding-inline: var(--space-3);
		background: var(--color-surface);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-full);
		color: var(--color-text-muted);
		font-family: inherit;
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-medium);
		cursor: pointer;
		transition:
			color var(--transition-fast),
			border-color var(--transition-fast),
			background-color var(--transition-fast);
	}

	.swap:hover {
		color: var(--color-text);
		background: var(--color-surface-hover);
		border-color: var(--color-accent);
	}

	.swap:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	.swap:active {
		transform: scale(0.96);
	}

	.swap-icon svg {
		width: 1.25rem;
		height: 1.25rem;
		display: block;
	}

	@media (min-width: 30rem) {
		.field-grid {
			grid-template-columns: 1fr 1fr;
		}

		.route-grid {
			grid-template-columns: 1fr auto 1fr;
			align-items: end;
		}

		.swap {
			/* Sits on the field line, not on the label above it. */
			margin-bottom: 0.125rem;
			align-self: end;
		}

		.swap-label {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
			white-space: nowrap;
		}
	}

	.disclosure {
		border-top: 1px dashed var(--color-border);
		padding-top: var(--space-3);
	}

	.disclosure summary {
		cursor: pointer;
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-medium);
		color: var(--color-accent);
		/* A summary is a click target, so it gets a thumb-sized line box. */
		padding-block: var(--space-2);
	}

	.disclosure summary:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
		border-radius: var(--radius-sm);
	}

	.disclosure-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		margin-top: var(--space-3);
	}

	.checkbox-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--font-size-sm);
		color: var(--color-text);
		min-height: 2.75rem;
	}

	.checkbox-row input {
		width: 1.25rem;
		height: 1.25rem;
		accent-color: var(--color-accent);
	}

	.derived-note {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
	}

	.actions :global(.btn) {
		flex: 1 1 12rem;
	}
</style>
