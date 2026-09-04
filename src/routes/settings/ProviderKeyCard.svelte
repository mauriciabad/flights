<script lang="ts">
	/**
	 * One settings-page row for one RapidAPI-metered provider (issue #29): what it
	 * unlocks, its key field(s), a redacted view once saved, and a "test" button that
	 * spends one real request to prove the key is both valid and subscribed.
	 *
	 * Renders `provider.keyFields` from data rather than assuming one field, since issue
	 * #49 made a provider's key material a field-id-to-string map specifically so a future
	 * provider needing two values (a client id and secret, say) is representable — every
	 * provider in `provider-catalog.ts` happens to declare exactly one field today, but
	 * this component does not hardcode that.
	 */
	import { keyStore } from '$lib/keys';
	import { Button, Card, ErrorState, Input } from '$lib/components';
	import type { ProviderIssueReason } from '$lib/components';
	import { getProviderQuotaSnapshot } from '$lib/providers/budget';
	import type { ProviderQuotaSnapshot } from '$lib/providers/budget';
	import { formatAge } from '$lib/results/format';
	import { checkProviderKey } from '$lib/settings/key-check';
	import type { KeyCheckOutcome } from '$lib/settings/key-check';
	import type { SettingsProviderDescriptor } from '$lib/settings/provider-catalog';

	interface Props {
		provider: SettingsProviderDescriptor;
	}

	let { provider }: Props = $props();

	// Issue #22's budget module (`$lib/providers/budget`) is the one place that tracks
	// real usage, in `localStorage`, so this reads it directly rather than keeping a
	// second counter. Not reactive to changes made elsewhere (another tab, a future search
	// screen): refreshed explicitly after this card's own `runTest` below, which is the
	// only thing on this page that can move the number. `provider` is a fixed prop for
	// this card's whole lifetime (each card is keyed by provider id in the `{#each}` in
	// +page.svelte and never receives a different one), so the one-time read below is
	// intentional, not a missed `$derived` — hence the ignore rather than restructuring
	// into an `$effect`, which would leave `quota` briefly wrong during SSR (no
	// `localStorage` there) and flash to the real value only after hydration.
	// svelte-ignore state_referenced_locally
	let quota = $state<ProviderQuotaSnapshot>(getProviderQuotaSnapshot(provider.id));

	function refreshQuota() {
		quota = getProviderQuotaSnapshot(provider.id);
	}

	const allFieldsFilled = $derived(
		provider.keyFields.every((field) => (keyStore.getFieldValue(provider.id, field.id) ?? '').length > 0)
	);

	// Issue #146. The provider's own count is the authoritative one — it belongs to the
	// RapidAPI key, so it already includes every request this browser cannot see — and the
	// card has to be able to say which number it is showing and when it last heard it.
	// `Date.now()` is read inside the `$derived` so the age re-renders whenever `quota`
	// does, which in this component means right after a Test spends a request.
	const reportedAge = $derived(
		quota.reported === undefined ? undefined : formatAge(Date.now() - quota.reported.observedAt)
	);

	let editing = $state(false);
	// Deliberately plain `value={...}` + `oninput` below rather than `bind:value` on
	// `Input`: a field never touched yet reads as `undefined` here (an absent key, not
	// an empty string), and `bind:value={draftValues[field.id]}` throws Svelte's
	// `props_invalid_value` the moment such a field's form first renders, since `Input`'s
	// `value` is `$bindable('')` and a genuinely `undefined` bound source is rejected —
	// caught against a real browser, not `pnpm check`, which is happy with the type.
	// One-way plus a manual write-back sidesteps that without needing to pre-populate
	// every field from `provider.keyFields` (which would only run once anyway, since
	// `$state`'s initializer captures a prop's value at that instant, not reactively).
	let draftValues = $state<Record<string, string>>({});
	let revealed = $state<Record<string, boolean>>({});
	let checking = $state(false);
	let result = $state<KeyCheckOutcome | undefined>(undefined);
	let inFlight: AbortController | undefined;

	// AGENTS.md: "the button has no cooldown" — pressing Test repeatedly against the SAME
	// saved value, e.g. while reading a confusing error and clicking again to see if it
	// changes, used to spend one more real request every time. `lastChecked` remembers
	// which exact key value the most recent completed check actually spent a request on;
	// `runTest` below skips the network entirely for a re-press of that same value inside
	// `TEST_COOLDOWN_MS` and just leaves the existing `result` showing. A genuinely new key
	// value (or a press after the window elapses, e.g. after fixing a RapidAPI subscription
	// and coming back to retry) still spends a fresh request — this is a guard against
	// pressing the same button on the same value, never a cache of "this key is fine".
	const TEST_COOLDOWN_MS = 30_000;
	let lastChecked: { apiKey: string; at: number } | undefined;

	const REASON_TITLE: Record<ProviderIssueReason, string> = {
		'missing-key': 'No key saved yet',
		'invalid-key': 'Key rejected',
		'not-subscribed': 'Not subscribed on RapidAPI',
		'quota-exceeded': 'Free-tier quota used up',
		'rate-limited': 'Too many requests',
		down: "Can't reach the provider",
		unknown: 'Unexpected response'
	};

	function startEditing() {
		draftValues = Object.fromEntries(provider.keyFields.map((field) => [field.id, '']));
		revealed = {};
		result = undefined;
		editing = true;
	}

	function cancelEditing() {
		editing = false;
		// Not clearing `draftValues` here: hiding the form unmounts its `Input`s in this
		// same tick, and writing to the very state their `bind:value` points at while
		// that happens throws Svelte's `props_invalid_value` (seen while testing this
		// against a real browser, not just `pnpm check`). `startEditing` already resets
		// `draftValues` to fresh empty strings the next time the form reappears, so
		// leaving the old values around here is harmless.
	}

	function save() {
		for (const field of provider.keyFields) {
			keyStore.setFieldValue(provider.id, field.id, draftValues[field.id] ?? '');
		}
		editing = false;
		result = undefined;
		// See the comment in `cancelEditing` above: `draftValues` is deliberately not
		// cleared here either.
		//
		// Used to run the same real, metered call the "Test" button spends, once, right
		// after every save ("paste a key, see it validated" — issue #29's brief). That
		// meant every re-save spent a request with no way to opt out — retyping a typo,
		// re-pasting the same key to double-check it, editing an unrelated field on the
		// same form — and a health check has no free variant to fall back to (this
		// module's own doc: RapidAPI meters this host per call regardless of path). A
		// tier as tight as Booking's 40-request safety cap does not survive many of those.
		// A saved key is now validated only when the traveller explicitly presses Test,
		// or implicitly the first time a real search actually calls the provider —
		// cheaply, or not at all, never automatically.
	}

	function removeKey() {
		const confirmed = confirm(`Remove the saved key for ${provider.label}? You can paste a new one anytime.`);
		if (!confirmed) return;
		keyStore.clearProvider(provider.id);
		result = undefined;
	}

	async function runTest() {
		const primaryField = provider.keyFields[0];
		const apiKey = keyStore.getFieldValue(provider.id, primaryField.id) ?? '';

		// A re-press of the exact same value inside the cooldown window spends nothing:
		// the outcome already on screen is still the true answer for this value, since
		// nothing about a RapidAPI key's status changes on its own from one press to the
		// next a few seconds apart. `apiKey.trim()` empty is excluded: `checkProviderKey`
		// already reports `missing-key` for that without ever touching the network, so
		// there is no real request here to guard against repeating.
		if (
			apiKey.trim().length > 0 &&
			lastChecked?.apiKey === apiKey &&
			Date.now() - lastChecked.at < TEST_COOLDOWN_MS
		) {
			return;
		}

		inFlight?.abort();
		const controller = new AbortController();
		inFlight = controller;
		checking = true;
		result = undefined;
		try {
			result = await checkProviderKey(provider, apiKey, controller.signal);
			refreshQuota();
			if (inFlight === controller && apiKey.trim().length > 0) {
				lastChecked = { apiKey, at: Date.now() };
			}
		} finally {
			if (inFlight === controller) checking = false;
		}
	}

	function toggleReveal(fieldId: string) {
		revealed = { ...revealed, [fieldId]: !revealed[fieldId] };
	}

	function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		save();
	}
</script>

<Card class="provider-card" id={provider.id}>
	{#snippet header()}
		<div class="provider-card-heading">
			<div>
				<span class="provider-card-category">{provider.category}</span>
				<!-- h3, not h2: the page now has an "API keys" h2 above this list (issue #19
				     promoted it from h3 to h2 back when the page's h1 was the only thing above it,
				     and the reason it gave was not skipping a level). -->
				<h3>{provider.label}</h3>
			</div>
			<span class="provider-card-quota font-mono tabular-nums">{quota.remaining} left</span>
		</div>
	{/snippet}

	<p class="provider-card-blurb">{provider.blurb}</p>

	{#if quota.reported !== undefined}
		<p class="provider-card-quota-reported">
			<strong>{provider.label} says</strong>
			<span class="font-mono tabular-nums">{quota.reported.remaining}</span>
			{#if quota.reported.limit !== undefined}
				of <span class="font-mono tabular-nums">{quota.reported.limit}</span>
			{/if}
			requests are left on this key, as of {reportedAge}. That count is the account's, not this
			browser's, so it already includes anything spent on another device.
		</p>
	{/if}

	<p class="provider-card-quota-note">
		{#if quota.used > quota.cap}
			<!-- Reachable only through the reported figure: this app's own counter stops at the
			     cap, the account's real spending does not. "42 of 40" would read as a bug. -->
			Already past this app's own safety cap of
			<span class="font-mono tabular-nums">{quota.cap}</span>, held below the provider's real
			<span class="font-mono tabular-nums">{provider.monthlyQuota}</span>/month free tier so a miscount
			still leaves a reserve. No search will spend here again until the 1st.
		{:else}
			<span class="font-mono tabular-nums">{quota.used} of {quota.cap}</span> requests spent this month
			against this app's own safety cap, held below the provider's real
			<span class="font-mono tabular-nums">{provider.monthlyQuota}</span>/month free tier so a miscount
			still leaves a reserve. Resets on the 1st.
		{/if}
		{#if quota.reported === undefined}
			That is this browser's own count. {provider.label} has not reported the account's figure yet,
			so another device or a cleared browser starts this tally again at zero while the key's real
			allowance keeps going down.
		{/if}
	</p>

	{#if editing || !allFieldsFilled}
		<form class="provider-card-form" onsubmit={handleSubmit}>
			{#each provider.keyFields as field (field.id)}
				<div class="provider-card-field">
					<Input
						label={field.label}
						type={revealed[field.id] ? 'text' : 'password'}
						placeholder={field.placeholder}
						value={draftValues[field.id] ?? ''}
						oninput={(event: Event) => {
							draftValues = { ...draftValues, [field.id]: (event.currentTarget as HTMLInputElement).value };
						}}
						autocomplete="one-time-code"
						data-1p-ignore="true"
						data-lpignore="true"
						data-bwignore="true"
						spellcheck="false"
						autocapitalize="off"
					>
						{#snippet labelSuffix()}
							<span class="provider-card-field-actions">
								<button type="button" class="text-button" onclick={() => toggleReveal(field.id)}>
									{revealed[field.id] ? 'Hide' : 'Show'}
								</button>
								{#if field.helpUrl}
									<a href={field.helpUrl} target="_blank" rel="noopener noreferrer">Get a key</a>
								{/if}
							</span>
						{/snippet}
					</Input>
				</div>
			{/each}
			<div class="provider-card-actions">
				<Button type="submit" size="sm">Save</Button>
				{#if allFieldsFilled}
					<Button type="button" variant="ghost" size="sm" onclick={cancelEditing}>Cancel</Button>
				{/if}
			</div>
		</form>
	{:else}
		<dl class="provider-card-values">
			{#each provider.keyFields as field (field.id)}
				<div class="provider-card-value-row">
					<dt>{field.label}</dt>
					<dd class="font-mono">{keyStore.getRedactedFieldValue(provider.id, field.id)}</dd>
				</div>
			{/each}
		</dl>
		<div class="provider-card-actions">
			<Button variant="secondary" size="sm" loading={checking} onclick={runTest}>Test</Button>
			<Button type="button" variant="ghost" size="sm" onclick={startEditing}>Change key</Button>
			<Button type="button" variant="ghost" size="sm" onclick={removeKey}>Remove</Button>
		</div>
	{/if}

	{#if result !== undefined}
		{#if result.ok}
			<p class="provider-card-success" role="status">
				<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
					<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" />
					<path
						d="M8 12.5l2.5 2.5L16 9.5"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
				{result.message}
			</p>
		{:else}
			<ErrorState
				severity={result.reason === 'quota-exceeded' ? 'warning' : 'error'}
				title={REASON_TITLE[result.reason]}
				message={result.message}
				provider={provider.label}
				providerResponse={result.providerResponse}
			>
				{#snippet action()}
					{#if result !== undefined && !result.ok && result.reason === 'not-subscribed'}
						<Button href={provider.pricingUrl} target="_blank" rel="noopener noreferrer" size="sm" variant="secondary">
							Subscribe to the free BASIC plan on RapidAPI
						</Button>
					{:else if result !== undefined && !result.ok && (result.reason === 'invalid-key' || result.reason === 'missing-key') && provider.keyFields[0]?.helpUrl}
						<Button href={provider.keyFields[0].helpUrl} target="_blank" rel="noopener noreferrer" size="sm" variant="ghost">
							Get a key
						</Button>
					{/if}
				{/snippet}
			</ErrorState>
		{/if}
	{/if}
</Card>

<style>
	/* Card.svelte's `.card-body` now wraps only what's below the heading. The
	   heading itself renders through Card's `header` snippet prop. Issue #77:
	   an earlier version of this file avoided that prop over a suspected
	   SSR/hydration bug. Four separate real-browser checks (a production build
	   and `vite dev`, static content and a deliberate server/client text
	   mismatch) never reproduced it against this project's exact toolchain.
	   The one run that did look broken traced back to a stale `.svelte-kit`
	   build cache, not to Card. */
	:global(.provider-card > .card-body) {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.provider-card-heading {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.provider-card-heading h3 {
		margin: 0;
		font-size: var(--font-size-lg);
	}

	.provider-card-category {
		display: block;
		margin-bottom: var(--space-1);
		font-family: var(--font-mono);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-regular);
		letter-spacing: var(--tracking-wide);
		text-transform: uppercase;
		color: var(--color-text-faint);
	}

	.provider-card-quota {
		flex-shrink: 0;
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius-sm);
		background: var(--color-bg-inset);
		color: var(--color-text-muted);
		font-size: var(--font-size-xs);
		/* Card's `.card-header` sets a semibold weight for the heading; this badge
		   sits in that header too now but reads better at its original regular
		   weight, so it opts back out. */
		font-weight: var(--font-weight-regular);
	}

	.provider-card-blurb {
		margin: 0;
		color: var(--color-text-muted);
		font-size: var(--font-size-sm);
	}

	.provider-card-quota-note {
		margin: 0;
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	/* Deliberately louder than `.provider-card-quota-note` below it, and the only line on
	   this card that carries an accent rule: one of these two numbers is a fact from the
	   provider and the other is this browser's guess at it, and the traveller has to be
	   able to tell which is which at a glance. */
	.provider-card-quota-reported {
		margin: 0;
		padding: var(--space-2) var(--space-3);
		border-left: 2px solid var(--color-accent);
		border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
		background: var(--color-bg-inset);
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.provider-card-quota-reported strong {
		color: var(--color-text);
		font-weight: var(--font-weight-medium);
	}

	.provider-card-form,
	.provider-card-values {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.provider-card-field-actions {
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
	}

	.text-button {
		color: var(--color-link);
		font-size: inherit;
		font-weight: var(--font-weight-medium);
		text-decoration: underline;
		cursor: pointer;
	}

	.provider-card-values {
		margin: 0;
	}

	.provider-card-value-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-3);
		background: var(--color-bg-inset);
		border-radius: var(--radius-md);
	}

	.provider-card-value-row dt {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.provider-card-value-row dd {
		margin: 0;
		letter-spacing: var(--tracking-wide);
	}

	.provider-card-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.provider-card-success {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin: 0;
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-md);
		border: 1px solid var(--color-success);
		background: var(--color-success-bg);
		color: var(--color-success);
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-medium);
	}

	.provider-card-success svg {
		width: 1.25rem;
		height: 1.25rem;
		flex-shrink: 0;
	}
</style>
