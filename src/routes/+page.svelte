<script lang="ts">
	/**
	 * Issue #16: the search form, replacing the placeholder landing page. Every field
	 * from the brief's Input list (docs/prompts/001-initial-brief.md, lines 24-39), with
	 * its documented cross-field defaults implemented as live derivations rather than
	 * copies (see `$lib/search-form/model.ts`). The search itself does not run yet -
	 * producing a valid `SearchQuery` and putting it in the URL is this issue's whole
	 * deliverable; wiring it to a provider is the results issue's job.
	 */
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Button, Card, DateField, ErrorState, Input } from '$lib/components';
	import { DEFAULT_LANDING_TO_TRANSPORT_RULES, DEFAULT_WAITING_TIME_RULES } from '$lib/domain';
	import AirportField from '$lib/search-form/AirportField.svelte';
	import ChipListField from '$lib/search-form/ChipListField.svelte';
	import LocationField from '$lib/search-form/LocationField.svelte';
	import {
		buildSearchQuery,
		createDefaultFormFields,
		resolveLatestDeparture,
		resolveSoonestArrival,
		type SearchFormFields
	} from '$lib/search-form/model';
	import TieredDurationField from '$lib/search-form/TieredDurationField.svelte';
	import {
		landingToTransportRulesToRows,
		rowsToLandingToTransportRules,
		rowsToWaitingTimeRules,
		waitingTimeRulesToRows,
		type TieredRuleRow
	} from '$lib/search-form/tiered-rules';
	import { fieldsToSearchParams, searchParamsToFields } from '$lib/search-form/url-codec';

	// Seeded once from whatever the browser's URL already carries, so visiting a shared
	// link reloads the exact same search (issue #16: "so a search can be shared and
	// reloaded"). SvelteKit keeps this component instance alive across the in-place
	// navigation `handleSubmit` does below, so this only ever runs on first load.
	//
	// `url.searchParams` throws on a prerendered page (there is no request to read a
	// query string from at build time), so the prerendered build starts blank; the
	// real params take over the moment this hydrates in an actual browser.
	let fields = $state<SearchFormFields>(
		browser ? searchParamsToFields(page.url.searchParams) : createDefaultFormFields()
	);

	// The two cross-field date defaults, recomputed on every read from the *current*
	// live values - never stored back into `fields` - which is what keeps them from
	// silently going stale when the source field changes (see model.ts's own comment).
	const resolvedLatestDeparture = $derived(resolveLatestDeparture(fields));
	const resolvedSoonestArrival = $derived(resolveSoonestArrival(fields));

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

	// Number inputs go through a raw string buffer rather than binding `fields.*`
	// directly: an in-progress "" (cleared field) has to stay distinct from "0", and a
	// plain `bind:value` on a numeric prop can't tell those apart. The parsed number
	// only exists on `effectiveFields` below, computed rather than written back into
	// `fields` itself, so nothing here fights Svelte over who owns `fields.travellers`.
	let travellersRaw = $state(fields.travellers !== undefined ? String(fields.travellers) : '');
	let femalesRaw = $state(fields.females !== undefined ? String(fields.females) : '');
	let minLayoverRaw = $state(fields.minLayoverTime !== undefined ? String(fields.minLayoverTime) : '');

	function parsedOrUndefined(raw: string, min: number): number | undefined {
		const n = Number(raw.trim());
		return raw.trim() && Number.isFinite(n) ? Math.max(min, Math.round(n)) : undefined;
	}

	// The tiered waiting-time / landing-to-transport editors work on this normalised
	// row shape (tiered-rules.ts) and start pre-filled with the brief's documented
	// defaults - the tiered rules are the feature, a single flat number is what you get
	// by deleting every extra row, not the starting point (issue #16: "a single number
	// is the fallback, not the whole feature").
	let waitingRows = $state<TieredRuleRow[]>(
		waitingTimeRulesToRows(fields.waitingTimeRules ?? DEFAULT_WAITING_TIME_RULES)
	);
	let transportRows = $state<TieredRuleRow[]>(
		landingToTransportRulesToRows(fields.landingToTransportRules ?? DEFAULT_LANDING_TO_TRANSPORT_RULES)
	);

	// `fields` plus everything the raw buffers and row editors above resolve to -
	// computed, not written back into `fields` itself (see the comment on
	// `travellersRaw`), so this is the one object every consumer below reads from.
	const effectiveFields = $derived<SearchFormFields>({
		...fields,
		travellers: parsedOrUndefined(travellersRaw, 1),
		females: parsedOrUndefined(femalesRaw, 0),
		minLayoverTime: parsedOrUndefined(minLayoverRaw, 0),
		waitingTimeRules: rowsToWaitingTimeRules(waitingRows),
		landingToTransportRules: rowsToLandingToTransportRules(transportRows)
	});

	// Today's date, computed once per page load (not reactive - a search form doesn't
	// need to notice midnight ticking over while it's open). Only used as a soft `min`
	// guard on the date pickers, so a mismatch between the prerendered build date and
	// the visitor's real date costs nothing.
	const todayIso = new Date().toISOString().slice(0, 10);

	// Validation only appears after a submit attempt, not on every keystroke (per
	// web-design-guidelines: validate on blur/submit, not keystroke) - `errors` then
	// stays live so a field clears its own error the moment it's fixed.
	let attempted = $state(false);
	const errors = $derived.by(() => {
		if (!attempted) return {} as Record<string, string>;
		const e: Record<string, string> = {};
		if (!fields.soonestDeparture.trim()) e.soonestDeparture = 'Pick the earliest date you could leave.';
		if (!fields.latestArrival.trim()) e.latestArrival = 'Pick the latest date you need to have arrived by.';
		if (!fields.originAirport.trim()) e.originAirport = 'Choose a departure airport.';
		if (!fields.destinationAirport.trim()) e.destinationAirport = 'Choose a destination airport.';
		return e;
	});
	const hasErrors = $derived(Object.keys(errors).length > 0);

	const FIRST_INVALID_FIELD_ID: [key: keyof SearchFormFields, id: string][] = [
		['soonestDeparture', 'soonest-departure'],
		['latestArrival', 'latest-arrival'],
		['originAirport', 'origin-airport'],
		['destinationAirport', 'destination-airport']
	];

	function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		attempted = true;
		const query = buildSearchQuery(effectiveFields);
		if (!query) {
			const firstInvalid = FIRST_INVALID_FIELD_ID.find(([key]) => !String(fields[key] ?? '').trim());
			if (firstInvalid) document.getElementById(firstInvalid[1])?.focus();
			return;
		}
		const params = fieldsToSearchParams(effectiveFields);
		goto(`?${params.toString()}`, { keepFocus: true, noScroll: true });
	}

	// The last search actually saved to the URL, re-derived from `page.url` itself
	// rather than local submit state - so a reload of a shared link shows the same
	// confirmation a fresh submit would, and editing the form without resubmitting
	// leaves this alone. `null` at prerender time for the same reason `fields` above
	// starts blank there.
	const urlQuery = $derived.by(() =>
		browser ? buildSearchQuery(searchParamsToFields(page.url.searchParams)) : null
	);

	// Issue #23 reads the same PARAM encoding this page already writes, so this is
	// just handing it the current URL's own query string rather than re-deriving one.
	const resultsHref = $derived(browser ? `/results/?${page.url.searchParams.toString()}` : '/results/');
</script>

<svelte:head>
	<title>Search - Layover</title>
	<meta
		name="description"
		content="Set your dates, airports and layover rules, then share the search."
	/>
</svelte:head>

<div class="page">
	<header class="page-intro">
		<h1>Search a layover trip</h1>
		<p>Set your dates and airports below. Everything here becomes a link you can save or send on.</p>
	</header>

	<form novalidate onsubmit={handleSubmit}>
		<Card variant="ticket" class="section">
			{#snippet header()}Route{/snippet}
			<div class="field-grid">
				<AirportField
					label="Origin airport"
					id="origin-airport"
					required
					bind:value={fields.originAirport}
					error={errors.originAirport}
				/>
				<AirportField
					label="Destination airport"
					id="destination-airport"
					required
					bind:value={fields.destinationAirport}
					error={errors.destinationAirport}
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
					id="soonest-departure"
					required
					min={todayIso}
					bind:value={fields.soonestDeparture}
					error={errors.soonestDeparture}
				/>
				<DateField
					label="Latest arrival"
					id="latest-arrival"
					required
					min={fields.soonestDeparture || todayIso}
					bind:value={fields.latestArrival}
					error={errors.latestArrival}
				/>
			</div>
			<details class="disclosure">
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
							id="latest-departure-override"
							min={fields.soonestDeparture || todayIso}
							max={fields.latestArrival || undefined}
							bind:value={fields.latestDepartureOverride}
						/>
					{:else}
						<p class="derived-note">
							Defaults to your latest arrival date{#if resolvedLatestDeparture}: <strong
								class="font-mono">{resolvedLatestDeparture}</strong
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
							id="soonest-arrival-override"
							min={todayIso}
							max={fields.soonestDeparture || undefined}
							bind:value={fields.soonestArrivalOverride}
						/>
					{:else}
						<p class="derived-note">
							Defaults to your soonest departure date{#if resolvedSoonestArrival}: <strong
								class="font-mono">{resolvedSoonestArrival}</strong
							>{/if}.
						</p>
					{/if}
				</div>
			</details>
		</Card>

		<Card class="section">
			{#snippet header()}Who's travelling{/snippet}
			<div class="field-grid">
				<Input
					label="Number of people"
					id="travellers"
					type="number"
					inputmode="numeric"
					min="1"
					placeholder="1"
					hint="Defaults to 1 traveller."
					bind:value={travellersRaw}
				/>
				<Input
					label="Female travellers"
					id="females"
					type="number"
					inputmode="numeric"
					min="0"
					placeholder="Not specified"
					hint="Only used to check whether female-only hostel dorms are available for your group. It never affects pricing or anything else."
					bind:value={femalesRaw}
				/>
			</div>
		</Card>

		<Card class="section">
			{#snippet header()}Connections{/snippet}
			<Input
				label="Minimum layover time"
				id="min-layover"
				type="number"
				inputmode="numeric"
				min="0"
				step="5"
				placeholder="30"
				hint="Minutes between flights. Defaults to 30 minutes if left blank."
				bind:value={minLayoverRaw}
			/>
			<ChipListField
				label="Only search these connection airports"
				hint="IATA codes, e.g. VIE. Leave empty to allow any connection airport."
				placeholder="Add an airport code and press enter"
				bind:values={fields.allowedConnectionAirports}
			/>
			<ChipListField
				label="Avoid these connection airports"
				hint="IATA codes to rule out entirely, e.g. a country you'd rather not transit through by airport."
				placeholder="Add an airport code and press enter"
				bind:values={fields.forbiddenConnectionAirports}
			/>
			<ChipListField
				label="Avoid these connection countries"
				hint="ISO country codes, e.g. RU."
				placeholder="Add a country code and press enter"
				bind:values={fields.forbiddenConnectionCountries}
			/>
			<ChipListField
				label="Airlines to avoid"
				hint="IATA airline codes, e.g. FR for Ryanair. Still fetched and shown, just greyed out and scored down - never dropped from results."
				placeholder="Add an airline code and press enter"
				bind:values={fields.airlinesToAvoid}
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

		{#if hasErrors}
			<ErrorState
				severity="error"
				title="A few required fields are missing"
				message="Fill in the departure airport, destination airport, soonest departure date and latest arrival date."
			/>
		{/if}

		<Button type="submit" size="lg" fullWidth>Save this search</Button>
	</form>

	{#if urlQuery}
		<Card variant="ticket" elevated class="section summary-card">
			{#snippet header()}Search ready{/snippet}
			<dl class="summary-grid">
				<div class="summary-item">
					<dt>Route</dt>
					<dd class="font-mono tabular-nums">{urlQuery.originAirport} &rarr; {urlQuery.destinationAirport}</dd>
				</div>
				<div class="summary-item">
					<dt>Depart between</dt>
					<dd class="font-mono tabular-nums">{urlQuery.soonestDeparture} and {urlQuery.latestDeparture}</dd>
				</div>
				<div class="summary-item">
					<dt>Arrive between</dt>
					<dd class="font-mono tabular-nums">{urlQuery.soonestArrival} and {urlQuery.latestArrival}</dd>
				</div>
				<div class="summary-item">
					<dt>Travellers</dt>
					<dd>{urlQuery.travellers}</dd>
				</div>
			</dl>
			{#snippet footer()}
				<p class="summary-note">This page's link now carries this search and will reload it exactly.</p>
				<Button href={resultsHref} variant="secondary">View results</Button>
			{/snippet}
		</Card>
	{/if}

	<footer class="page-footer">
		<p>Transit data by <a href="https://transitous.org">Transitous</a>.</p>
	</footer>
</div>

<style>
	.page {
		max-width: var(--layout-max-width);
		margin-inline: auto;
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
	}

	.page-intro h1 {
		font-size: var(--font-size-2xl);
		margin-bottom: var(--space-2);
	}

	.page-intro p {
		color: var(--color-text-muted);
		max-width: 40rem;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}

	/* Svelte scopes styles by element, but `class` passed into <Card> lands on an
	   element rendered by that component, so it needs :global here to reach it. */
	form :global(.section) {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.field-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: var(--space-4);
	}

	@media (min-width: 30rem) {
		.field-grid {
			grid-template-columns: 1fr 1fr;
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

	.summary-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: var(--space-3);
	}

	@media (min-width: 30rem) {
		.summary-grid {
			grid-template-columns: 1fr 1fr;
		}
	}

	.summary-item dt {
		font-size: var(--font-size-xs);
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-faint);
	}

	.summary-item dd {
		margin: 0;
		font-size: var(--font-size-lg);
		color: var(--color-stopover);
	}

	.summary-note {
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	.page-footer {
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
		padding-top: var(--space-4);
		border-top: 1px solid var(--color-border);
	}
</style>
