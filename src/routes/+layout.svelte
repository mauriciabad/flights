<script lang="ts">
	import '../app.css';
	import { afterNavigate } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { Icon } from '$lib/components';
	import { registerServiceWorker } from '$lib/pwa/register-sw';
	import { onMount, type Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();

	// onMount, not module scope: this file is also the SSR entry that prerenders every
	// page, where `navigator` does not exist.
	onMount(registerServiceWorker);

	let contentEl = $state<HTMLElement | undefined>();

	/**
	 * Since #177 the page that scrolls is `.app-content`, not the document, and SvelteKit
	 * only ever resets the document. So a navigation kept the previous page's scroll
	 * position: submitting the search form from its own submit button, two screens down,
	 * arrived on the results already scrolled past the first result. Measured at 115px on
	 * a 375px viewport before this.
	 *
	 * A hash is the one case to leave alone: `/settings/#agoda` (issue #117) is a link
	 * that means "put me at that card", and scrolling to the top would undo it.
	 */
	afterNavigate((navigation) => {
		if (navigation.to?.url.hash) return;
		contentEl?.scrollTo(0, 0);
	});

	// Served from `static/icons/`, not `$lib` — those files ship as-is to
	// the build root, so the base path has to be prefixed by hand here.
	const iconSrc = `${base}/icons/icon.svg`;
	const appleTouchIconSrc = `${base}/icons/apple-touch-icon.png`;
	// @vite-pwa/sveltekit writes this next to index.html but never links it
	// (issue #30: its build plugin only emits sw.js and manifest.webmanifest,
	// it doesn't touch app.html), so the <link> lives here instead, where
	// `base` is already in scope for the same reason iconSrc needs it above.
	const manifestHref = `${base}/manifest.webmanifest`;

	/** Settings is the only place that is not the search itself, so it is one control in
	 * the header rather than a tab bar. The brand is the way back to the search, which is
	 * what a logo already means everywhere else.
	 *
	 * The tab model this replaced carried an `alsoOwns` list, so that `/results/` and
	 * `/results/when/` (#71) kept the Search tab lit rather than reading as separate
	 * places. With no tab to light there is nothing left to own: every route except
	 * settings is the search, and the brand goes back to it from all of them. Both of
	 * those routes reach their own entry points from the results page.
	 */
	const settingsHref = '/settings/';

	function fullHref(href: string): string {
		return `${base}${href}`;
	}

	const onSettings = $derived(page.url.pathname === `${base}${settingsHref}`);

	/**
	 * Issue #311: the one control in the chrome closes what it opened.
	 *
	 * The owner: "the lav button should be a toggle, so it becomes a close button for
	 * settings." Opening settings was one tap and leaving it was the browser's back button,
	 * which he is explicit is not an answer: he asked for a visible way out.
	 *
	 * A control whose meaning changes has to say so in every channel, not only in its
	 * drawing (MDN on `aria-expanded`: the accessible name of the controlling object should
	 * reflect the change). So the icon becomes a cross, the accessible name becomes "Close
	 * settings", and `aria-expanded` flips, which is what stops a screen reader announcing
	 * "Settings" on the control that leaves settings.
	 *
	 * Where it goes back to is the previous entry when there is one, so a traveller returns
	 * to the results they were reading rather than to a fresh search, and their history stops
	 * growing a settings entry every time they check a key. With nothing behind them (a
	 * bookmark, a shared link, a cold PWA launch) the `href` is the search, which is the one
	 * place every route in this app can start from.
	 */
	let cameFromInApp = $state(false);
	let navEl = $state<HTMLAnchorElement>();
	/** Set by an activation of the control below, cleared by the navigation it caused. Plain
	 * bookkeeping: nothing renders from it. */
	let returnFocusToNav = false;

	afterNavigate((navigation) => {
		cameFromInApp = navigation.from !== null;
		if (!returnFocusToNav) return;
		returnFocusToNav = false;
		// SvelteKit resets focus to the document after a client-side navigation, so a screen
		// reader announces the new page. That is right for a link that takes you somewhere and
		// wrong for a toggle: this control is in the shell, so it is still on screen and still
		// under the finger that pressed it, and #283 is what happens when a control moves out
		// from under a keyboard reader. `preventScroll` because the header never leaves the
		// viewport, so there is nothing to scroll to.
		navEl?.focus({ preventScroll: true });
	});

	const navHref = $derived(onSettings ? fullHref('/') : fullHref(settingsHref));
	const navLabel = $derived(onSettings ? 'Close settings' : 'Settings');

	function onNavClick(event: MouseEvent) {
		// Every gesture that means "open this somewhere else" stays the browser's, and takes
		// the focus question with it.
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
		returnFocusToNav = true;
		if (!onSettings || !cameFromInApp) return;
		event.preventDefault();
		history.back();
	}
</script>

<svelte:head>
	<link rel="icon" href={iconSrc} />
	<!-- Fallback only. A page announced by screen readers on navigation
	     needs its own descriptive <title>; route owners should set one. -->
	<title>Layover</title>

	<!-- Chrome/Edge/Firefox read this for installability; iOS Safari ignores it
	     entirely (see the apple-* tags below) and Android falls back to
	     theme_color from here for the browser chrome even before install. -->
	<link rel="manifest" href={manifestHref} />
	<meta name="theme-color" content="#0b1020" />

	<!-- iOS Safari never reads the manifest for any of this — no display mode,
	     no icon, no name. Each needs its own tag (issue #30). -->
	<link rel="apple-touch-icon" href={appleTouchIconSrc} />
	<meta name="mobile-web-app-capable" content="yes" />
	<meta name="apple-mobile-web-app-capable" content="yes" />
	<!-- Not "black-translucent": that overlays the status bar on the header,
	     which would need env(safe-area-inset-top) padding added to .app-header
	     to avoid the clock/battery icons sitting on top of the brand mark. -->
	<meta name="apple-mobile-web-app-status-bar-style" content="black" />
	<meta name="apple-mobile-web-app-title" content="Layover" />
</svelte:head>

<a class="skip-link" href="#main-content">Skip to content</a>

<div class="app-shell">
	<header class="app-header">
		<a class="app-brand" href={fullHref('/')} aria-label="Layover, search">
			<img src={iconSrc} alt="" width="24" height="24" />
			<span>Layover</span>
		</a>

		<a
			bind:this={navEl}
			class="app-settings"
			href={navHref}
			aria-current={onSettings ? 'page' : undefined}
			aria-expanded={onSettings}
			aria-label={navLabel}
			onclick={onNavClick}
		>
			<!-- Issue #311: the icon changes with the name, because a control whose meaning
			     changes has to say so in every channel a person reads. -->
			<Icon name={onSettings ? 'x' : 'settings'} />
			<span class="app-settings-label">{navLabel}</span>
		</a>
	</header>

	<main bind:this={contentEl} id="main-content" class="app-content" tabindex="-1">
		{@render children()}
	</main>
</div>

<style>
	.skip-link {
		position: fixed;
		top: -3rem;
		left: var(--space-3);
		z-index: var(--z-skip-link);
		padding: var(--space-2) var(--space-4);
		background: var(--color-accent);
		color: var(--color-accent-text);
		border-radius: var(--radius-md);
		text-decoration: none;
		font-weight: var(--font-weight-semibold);
		transition: top var(--transition-fast);
	}

	.skip-link:focus-visible {
		top: var(--space-3);
	}

	/* Mobile-first shell: header on top, content in the middle scrolling
	   on its own, a thumb-reachable tab bar pinned to the bottom. Grid
	   areas (not DOM order) move the nav from "own row at the bottom" to
	   "beside the brand" at the desktop breakpoint, so there is exactly
	   one <nav>, not a mobile copy and a desktop copy. */
	/* `height`, not `min-height` (issue #119): a grid container's block size has to be
	   DEFINITE for `1fr` to mean "whatever is left after the other rows," per the CSS
	   Grid sizing algorithm. `min-height: 100dvh` only sets a floor — the container's
	   real size is still "auto," so with no definite size to divide up, the `main` row
	   stretches to fit its own content instead of stopping at the viewport edge. That
	   silently turns off `.app-content`'s `overflow-y: auto` (there is nothing left
	   for it to overflow) and hands scrolling to the whole document instead, taking
	   this header and nav along for the ride rather than leaving them pinned. Results
	   is the one page long enough to ever scroll past a phone screen, which is why the
	   bug only ever showed up there: scroll (or jump to a control below the fold, e.g.
	   "Show details") and the header was gone, not merely stuck. */
	.app-shell {
		display: grid;
		grid-template-columns: 1fr;
		grid-template-rows: auto 1fr;
		grid-template-areas:
			'header'
			'main';
		height: 100dvh;
		background: var(--color-bg);
	}

	.app-header {
		grid-area: header;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		/* Tight vertically on purpose: the gear carries its own >=44px tap target, so
		   padding here would only add height to the one bar that is always on screen.
		   Measured at 375px: `var(--space-3)` made this 69px tall against 49px before the
		   gear existed, which gave back less than half of what dropping the tab bar
		   returned. */
		padding: var(--space-1) var(--space-4);
		background: var(--color-bg-elevated);
		border-bottom: 1px solid var(--color-border);
	}

	.app-brand {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-weight: var(--font-weight-bold);
		font-size: var(--font-size-xl);
		letter-spacing: var(--tracking-tight);
		color: var(--color-text);
		text-decoration: none;
	}

	.app-content {
		grid-area: main;
		overflow-y: auto;
		overflow-x: hidden;
		min-width: 0;
		/* Both minimums, not just the horizontal one (issue #119). A grid item's automatic
		   minimum size is its content, so a `1fr` row grows past its track to fit whatever
		   is inside it and `overflow-y: auto` never engages: the document scrolls instead
		   of this box, and the header and nav scroll away with it. Making `.app-shell`
		   `height: 100dvh` is necessary but not sufficient — measured on a 390x844 phone,
		   the shell was correctly 844px while the document was still 4359px tall, and
		   `window.scrollTo(0, 3000)` put the header at -3000. */
		min-height: 0;
		padding: var(--space-4);
		/* The tab bar used to hold this gap open. Nothing does now, so the last result
		   would sit under the home bar on a notched phone. */
		padding-bottom: calc(var(--space-4) + env(safe-area-inset-bottom));
	}

	.app-content:focus-visible {
		outline: none;
	}

	.app-settings {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		/* >=44px tap target, per WCAG 2.5.5, for someone using this one-handed. This is now
		   the only control in the chrome, so it cannot be the fiddly one. */
		min-height: 2.75rem;
		min-width: 2.75rem;
		justify-content: center;
		padding: 0 var(--space-2);
		border-radius: var(--radius-md);
		color: var(--color-text-muted);
		text-decoration: none;
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-medium);
		transition:
			color var(--transition-fast),
			background-color var(--transition-fast);
	}

	.app-settings :global(svg) {
		width: 1.25rem;
		height: 1.25rem;
	}

	/* The label is for the pointer, where there is room to say what the gear does. On a
	   phone the gear stands alone, which is the whole reason the tab bar could go. */
	.app-settings-label {
		display: none;
	}

	@media (min-width: 48rem) {
		.app-settings-label {
			display: inline;
		}
	}

	.app-settings:hover {
		color: var(--color-text);
		background: var(--color-bg-subtle, var(--color-accent-muted));
	}

	.app-settings[aria-current='page'] {
		color: var(--color-accent);
		background: var(--color-accent-muted);
	}

	.app-settings:active {
		transform: scale(0.96);
	}

</style>
