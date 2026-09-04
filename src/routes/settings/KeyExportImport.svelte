<script lang="ts">
	/**
	 * Export-all / import-one for the BYOK key store (issue #29's "convenience share").
	 * Both directions stay entirely client-side: `downloadKeysFile` builds the file with
	 * `URL.createObjectURL` and an in-memory anchor click, and import reads the chosen
	 * `File` with `File.text()` — no network request either way, matching AGENTS.md's "no
	 * backend, none" rule as much as any other part of this app.
	 */
	import { downloadKeysFile, keyStore } from '$lib/keys';
	import type { ImportOutcome } from '$lib/keys';
	import { Button, Card, ErrorState } from '$lib/components';
	import { SETTINGS_PROVIDER_IDS } from '$lib/settings/provider-catalog';

	let fileInput = $state<HTMLInputElement | undefined>(undefined);
	let importOutcome = $state<ImportOutcome | undefined>(undefined);
	let importing = $state(false);

	const hasAnyKey = $derived(keyStore.providerIds.length > 0);

	function exportKeys() {
		downloadKeysFile(keyStore.exportEnvelope());
	}

	function pickImportFile() {
		importOutcome = undefined;
		fileInput?.click();
	}

	async function handleFileChosen(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		// Cleared immediately so choosing the exact same file again still fires `change`.
		input.value = '';
		if (!file) return;

		importing = true;
		try {
			const text = await file.text();
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				importOutcome = {
					added: [],
					updated: [],
					unchanged: [],
					warnings: [],
					error: 'That file is not valid JSON.'
				};
				return;
			}
			importOutcome = keyStore.importFromFile(parsed, SETTINGS_PROVIDER_IDS);
		} finally {
			importing = false;
		}
	}
</script>

<Card class="export-import-card">
	<h2 class="export-import-heading">Export and import</h2>

	<p class="export-import-blurb">
		Move your keys to another device, or restore a saved set, as a plain JSON file — never sent
		anywhere, only written and read in this browser.
	</p>

	<div class="export-import-actions">
		<Button type="button" variant="secondary" onclick={exportKeys} disabled={!hasAnyKey}>
			Export keys as JSON
		</Button>
		<Button type="button" variant="secondary" loading={importing} onclick={pickImportFile}>
			Import keys from JSON
		</Button>
		<input
			bind:this={fileInput}
			type="file"
			accept="application/json"
			class="visually-hidden"
			onchange={handleFileChosen}
			aria-label="Choose a keys JSON file to import"
		/>
	</div>

	{#if !hasAnyKey}
		<p class="export-import-hint">No keys saved yet, so there is nothing to export.</p>
	{/if}

	{#if importOutcome !== undefined}
		{#if importOutcome.error !== undefined}
			<ErrorState severity="error" title="Import failed" message={importOutcome.error} />
		{:else}
			<p class="export-import-summary" role="status">
				Added {importOutcome.added.length}, updated {importOutcome.updated.length}, left {importOutcome
					.unchanged.length} unchanged.
			</p>
			{#if importOutcome.warnings.length > 0}
				<ul class="export-import-warnings">
					{#each importOutcome.warnings as warning (warning.providerId + warning.message)}
						<li><strong>{warning.providerId}</strong>: {warning.message}</li>
					{/each}
				</ul>
			{/if}
		{/if}
	{/if}
</Card>

<style>
	/* This card now sits above the provider list (issue #123), specifically so it doesn't
	   push the keys people actually came here to see below the fold on a phone — trimmed
	   to a compact utility bar rather than the same full-height card a provider gets. */
	:global(.export-import-card.card-padded > .card-body) {
		padding: var(--space-4) var(--space-5);
	}

	.export-import-heading {
		margin: 0 0 var(--space-2);
		font-size: var(--font-size-base);
	}

	.export-import-blurb {
		margin: 0 0 var(--space-3);
		color: var(--color-text-muted);
		font-size: var(--font-size-xs);
	}

	.export-import-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
	}

	.export-import-hint {
		margin: var(--space-3) 0 0;
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	.export-import-summary {
		margin: var(--space-4) 0 0;
		font-size: var(--font-size-sm);
		color: var(--color-text);
	}

	.export-import-warnings {
		margin: var(--space-2) 0 0;
		padding-left: var(--space-5);
		list-style: disc;
		font-size: var(--font-size-xs);
		color: var(--color-warning);
	}
</style>
