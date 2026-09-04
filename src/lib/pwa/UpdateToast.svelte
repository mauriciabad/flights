<script lang="ts">
	import { base } from '$app/paths';
	import { onMount } from 'svelte';
	import Button from '$lib/components/Button.svelte';

	/**
	 * Registers the service worker and surfaces the "prompt" flow
	 * `registerType: 'prompt'` in vite.config.ts asks for (issue #30): a new deploy
	 * installs quietly in the background, and this banner is the only thing that
	 * ever reloads the tab, on the user's say-so rather than out from under them.
	 *
	 * This calls `navigator.serviceWorker.register()` directly rather than going
	 * through `virtual:pwa-register/svelte` (the usual vite-plugin-pwa helper,
	 * which wraps workbox-window). That virtual module's generated code contains a
	 * dynamic `import("workbox-window")`, and this project prerenders every route,
	 * so this component's <script> is also part of the SvelteKit SSR build that
	 * generates the static HTML — a build Vite 8's Rolldown bundler cannot resolve
	 * that import for (`[vite]: Rolldown failed to resolve import "workbox-window"`),
	 * failing `pnpm build` outright. `navigator.serviceWorker` is a plain browser
	 * global with nothing to import, so registering by hand sidesteps the problem
	 * rather than working around a bundler bug. tests/e2e/pwa.spec.ts's own comment
	 * names this as an accepted alternative to the virtual-module hook.
	 */
	let needRefresh = $state(false);
	let registration: ServiceWorkerRegistration | undefined;

	onMount(() => {
		if (!('serviceWorker' in navigator)) return;

		const swUrl = `${base}/sw.js`;
		const scope = `${base}/`;

		navigator.serviceWorker
			.register(swUrl, { scope })
			.then((reg) => {
				registration = reg;

				// A worker is already sat waiting the moment this page loads — e.g. a
				// second tab opened after a deploy landed while the first tab was still
				// open. `controller` being set (rather than this being the very first
				// ever install) is what makes it an update worth prompting about.
				if (reg.waiting && navigator.serviceWorker.controller) {
					needRefresh = true;
				}

				reg.addEventListener('updatefound', () => {
					const installing = reg.installing;
					installing?.addEventListener('statechange', () => {
						if (installing.state === 'installed' && navigator.serviceWorker.controller) {
							needRefresh = true;
						}
					});
				});
			})
			.catch(() => {
				// Nothing to prompt about if registration itself failed. The app still
				// works online; it just doesn't get offline support or an install
				// prompt for this session.
			});

		// vite.config.ts's `registerType: 'prompt'` (workbox-build's default when
		// `skipWaiting` isn't forced true) bakes a `message` listener into sw.js that
		// calls `self.skipWaiting()` on exactly this message shape — see reload()
		// below. Once the new worker takes over, every open tab reloads once, not on
		// a loop: `reloading` latches after the first `controllerchange`.
		let reloading = false;
		navigator.serviceWorker.addEventListener('controllerchange', () => {
			if (reloading) return;
			reloading = true;
			window.location.reload();
		});
	});

	let dismissed = $state(false);

	function reload() {
		registration?.waiting?.postMessage({ type: 'SKIP_WAITING' });
	}
</script>

{#if needRefresh && !dismissed}
	<div class="update-toast" role="status">
		<span class="update-toast-icon" aria-hidden="true">
			<svg viewBox="0 0 24 24" fill="none">
				<path
					d="M4 12a8 8 0 0 1 13.66-5.66M20 12a8 8 0 0 1-13.66 5.66"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
				/>
				<path
					d="M17 3v4.5h-4.5M7 21v-4.5h4.5"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			</svg>
		</span>
		<p>A new version of Layover is ready.</p>
		<div class="update-toast-actions">
			<Button size="sm" variant="ghost" onclick={() => (dismissed = true)}>Later</Button>
			<Button size="sm" variant="primary" onclick={reload}>Reload</Button>
		</div>
	</div>
{/if}

<style>
	.update-toast {
		position: fixed;
		left: var(--space-4);
		right: var(--space-4);
		/* Clears the bottom tab bar (3.5rem tall, see +layout.svelte's .app-nav a)
		   plus its own safe-area padding, so the toast sits above it rather than
		   under it on a notched phone. */
		bottom: calc(3.5rem + env(safe-area-inset-bottom) + var(--space-3));
		z-index: var(--z-toast);
		display: flex;
		align-items: center;
		gap: var(--space-3);
		max-width: 26rem;
		margin-inline: auto;
		padding: var(--space-3) var(--space-4);
		background: var(--color-surface);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg);
		color: var(--color-text);
	}

	.update-toast-icon {
		flex-shrink: 0;
		width: 1.5rem;
		height: 1.5rem;
		color: var(--color-accent);
	}

	.update-toast-icon svg {
		width: 100%;
		height: 100%;
	}

	.update-toast p {
		flex: 1;
		min-width: 0;
		font-size: var(--font-size-sm);
	}

	.update-toast-actions {
		display: flex;
		gap: var(--space-2);
		flex-shrink: 0;
	}

	/* The desktop nav moves beside the header instead of pinning to the bottom
	   (see +layout.svelte's media query at 48rem), so nothing to clear there. */
	@media (min-width: 48rem) {
		.update-toast {
			left: auto;
			bottom: calc(var(--space-4) + env(safe-area-inset-bottom));
		}
	}
</style>
