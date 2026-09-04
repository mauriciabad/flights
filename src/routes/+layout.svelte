<script lang="ts">
	import '../app.css';
	import { afterNavigate } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
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

	interface NavItem {
		id: 'search' | 'settings';
		label: string;
		href: string;
		/** Other routes this tab is the home of. `/results/` belongs to Search because a
		 * search and its answers are one thing, not two. */
		alsoOwns?: string[];
	}

	/**
	 * Results used to be a tab of its own, sitting next to Search, so a person filled in
	 * a form on one screen and had to work out that the answer lived on another. The
	 * owner on that: "the ux of goig from search to result makes no fucking sense [...]
	 * they are not 2 separate tabs." Submitting the form now navigates, and this tab
	 * stays lit the whole way through, because the search and its results are one place.
	 * Getting back to an earlier search is what the history on `/` is for.
	 */
	const navItems: NavItem[] = [
		{ id: 'search', label: 'Search', href: '/', alsoOwns: ['/results/'] },
		{ id: 'settings', label: 'Settings', href: '/settings/' }
	];

	function fullHref(href: string): string {
		return `${base}${href}`;
	}

	function isActive(item: NavItem): boolean {
		const here = page.url.pathname;
		return [item.href, ...(item.alsoOwns ?? [])].some((href) => here === fullHref(href));
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
		<a class="app-brand" href={fullHref('/')} aria-label="Layover, home">
			<img src={iconSrc} alt="" width="24" height="24" />
			<span>Layover</span>
		</a>
	</header>

	<nav class="app-nav" aria-label="Primary">
		<ul>
			{#each navItems as item (item.id)}
				<li>
					<a href={fullHref(item.href)} aria-current={isActive(item) ? 'page' : undefined}>
						<span class="app-nav-icon" aria-hidden="true">
							{#if item.id === 'search'}
								<svg viewBox="0 0 24 24" fill="none">
									<circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" />
									<line
										x1="21"
										y1="21"
										x2="16.65"
										y2="16.65"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
									/>
								</svg>
							{:else}
								<svg viewBox="0 0 24 24" fill="none">
									<line x1="4" y1="21" x2="4" y2="14" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
									<line x1="4" y1="10" x2="4" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
									<line x1="12" y1="21" x2="12" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
									<line x1="12" y1="8" x2="12" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
									<line x1="20" y1="21" x2="20" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
									<line x1="20" y1="12" x2="20" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
									<line x1="1" y1="14" x2="7" y2="14" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
									<line x1="9" y1="8" x2="15" y2="8" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
									<line x1="17" y1="16" x2="23" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
								</svg>
							{/if}
						</span>
						<span class="app-nav-label">{item.label}</span>
					</a>
				</li>
			{/each}
		</ul>
	</nav>

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
		grid-template-rows: auto 1fr auto;
		grid-template-areas:
			'header'
			'main'
			'nav';
		height: 100dvh;
		background: var(--color-bg);
	}

	.app-header {
		grid-area: header;
		display: flex;
		align-items: center;
		padding: var(--space-3) var(--space-4);
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
	}

	.app-content:focus-visible {
		outline: none;
	}

	.app-nav {
		grid-area: nav;
		background: var(--color-bg-elevated);
		border-top: 1px solid var(--color-border);
		/* Clears the home-bar area on notched phones without adding
		   visible space on devices that don't have one. */
		padding-bottom: env(safe-area-inset-bottom);
	}

	.app-nav ul {
		display: flex;
	}

	.app-nav li {
		flex: 1;
		min-width: 0;
	}

	.app-nav a {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-1);
		/* >=44px tap target, per WCAG 2.5.5, for someone using this
		   one-handed. */
		min-height: 3.5rem;
		padding: var(--space-2) var(--space-1);
		color: var(--color-text-muted);
		text-decoration: none;
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
		transition: color var(--transition-fast);
	}

	.app-nav a:active {
		transform: scale(0.96);
	}

	/* The current tab reads as a lit gate on a departure board: a filled
	   pill behind the icon, not just a colour swap, so it is legible at a
	   glance and not only by hue (contrast this deliberately survives
	   both themes since it is background + colour together, never colour
	   alone). */
	.app-nav-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: var(--radius-full);
		transition: background-color var(--transition-fast);
	}

	.app-nav-icon svg {
		width: 1.25rem;
		height: 1.25rem;
	}

	.app-nav a:hover {
		color: var(--color-text);
	}

	.app-nav a[aria-current='page'] {
		color: var(--color-accent);
	}

	.app-nav a[aria-current='page'] .app-nav-icon {
		background: var(--color-accent-muted);
	}

	.app-nav a[aria-current='page']:hover {
		color: var(--color-accent-hover);
	}

	@media (min-width: 48rem) {
		.app-shell {
			grid-template-columns: auto 1fr;
			grid-template-rows: auto 1fr;
			grid-template-areas:
				'header nav'
				'main main';
		}

		.app-nav {
			justify-self: end;
			align-self: stretch;
			background: var(--color-bg-elevated);
			border-top: none;
			border-bottom: 1px solid var(--color-border);
			padding-bottom: 0;
		}

		.app-nav ul {
			height: 100%;
		}

		.app-nav li {
			flex: none;
		}

		.app-nav a {
			flex-direction: row;
			min-height: auto;
			height: 100%;
			padding-inline: var(--space-4);
			font-size: var(--font-size-sm);
		}

		.app-content {
			padding: var(--space-6);
		}
	}

	/* Search, results and settings all wrap their own content at
	   --layout-max-width; the shell itself stays full-bleed so a
	   full-width control still has the whole viewport to work with. */
</style>
