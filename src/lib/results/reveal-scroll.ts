/**
 * Moving the page as little as possible to bring something into view. Issue #308.
 *
 * The owner: "When i click a segment in timeline preview to open cutmize panel, it updates
 * my scroll and is anoying." He did not ask to move; he asked to see the controls for that
 * segment.
 *
 * The scrolling was #278's, and it was added for a real reason: on a phone the customise
 * panel is a sheet at the foot of the screen, and a reader who taps a transfer seam and
 * gets a panel sitting on top of it has lost the context that made the tap mean anything.
 * So the fix is not to delete it. `scroll-margin-bottom` inflated the strip's box by the
 * sheet's whole height for scrolling purposes, which made `block: 'nearest'` treat an
 * already-visible strip as one that did not fit, so every tap scrolled whether or not
 * anything was covering anything.
 *
 * What replaces it is the same intent stated as arithmetic: work out the part of the
 * viewport nothing is covering, and scroll by the smallest amount that puts the target
 * inside it. On a wide screen the panel is a sidebar, nothing is covering anything, and a
 * target already on screen produces a delta of exactly zero.
 */

/** A vertical span in viewport coordinates, which is what `getBoundingClientRect` gives. */
export interface VerticalSpan {
	top: number;
	bottom: number;
}

/**
 * How far to scroll so `target` sits inside `viewport`, and no further. Positive moves the
 * content up, the sign `scrollBy` takes.
 *
 * Zero whenever the target is already inside, which is the whole point of the issue.
 *
 * A target taller than the space available is aligned to the top of it rather than scrolled
 * past: `available` is how far the target's own top may travel before it leaves, so it is
 * the ceiling on the move. Without that clamp, revealing the bottom of a tall block would
 * push its top off screen, which is a worse answer than showing the top and letting the
 * rest run under the sheet.
 */
export function minimalScrollDelta(target: VerticalSpan, viewport: VerticalSpan): number {
	if (target.bottom > viewport.bottom) {
		const needed = target.bottom - viewport.bottom;
		const available = target.top - viewport.top;
		// `available` is negative when the target already starts above the viewport. Scrolling
		// down would then hide the top to reveal a bottom that cannot fit anyway.
		return Math.max(0, Math.min(needed, available));
	}
	if (target.top < viewport.top) return target.top - viewport.top;
	return 0;
}

/**
 * The nearest ancestor that actually scrolls, or the document's own scroller.
 *
 * This app scrolls inside `.app-content` rather than the document (issue #177), so
 * `window.scrollBy` is a no-op on the results page and reading `window.scrollY` measures
 * something that never moves. Found by walking rather than by naming that class, because a
 * component several levels down should not have to know the shell's markup.
 */
export function scrollableAncestor(element: Element): Element {
	let node: Element | null = element.parentElement;
	while (node) {
		const overflowY = getComputedStyle(node).overflowY;
		if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
		node = node.parentElement;
	}
	return document.scrollingElement ?? document.documentElement;
}

/**
 * The attribute a fixed panel sets to declare that it covers the bottom of the screen.
 *
 * A declared contract rather than a class name this module goes looking for: the results
 * page owns the sheet and says so, and anything else that ever covers the foot of the
 * viewport says so the same way and is accounted for without this file changing.
 */
export const BOTTOM_SHEET_ATTRIBUTE = 'data-bottom-sheet';

/** How many pixels at the foot of the viewport are covered by a bottom sheet right now. */
export function bottomObstructionPx(root: ParentNode = document): number {
	let covered = 0;
	for (const sheet of root.querySelectorAll(`[${BOTTOM_SHEET_ATTRIBUTE}]`)) {
		const box = sheet.getBoundingClientRect();
		if (box.height === 0) continue;
		covered = Math.max(covered, window.innerHeight - box.top);
	}
	return Math.max(0, covered);
}

/**
 * Scrolls `target` into the uncovered part of the viewport, by the minimum that does it,
 * and returns how far it moved. Zero means nothing was in the way and nothing happened.
 *
 * `scrollIntoView` cannot express this. Its `block: 'nearest'` is the right intent and it
 * has no notion of something covering the viewport, which is why #278 had to lie to it with
 * a scroll margin and why every tap then scrolled.
 */
export function revealMinimally(target: Element): number {
	const scroller = scrollableAncestor(target);
	const scrollerBox =
		scroller === document.scrollingElement || scroller === document.documentElement
			? { top: 0, bottom: window.innerHeight }
			: scroller.getBoundingClientRect();
	const viewport = {
		top: scrollerBox.top,
		bottom: scrollerBox.bottom - bottomObstructionPx()
	};
	const delta = minimalScrollDelta(target.getBoundingClientRect(), viewport);
	if (delta === 0) return 0;
	// `scrollIntoView` takes no notice of `prefers-reduced-motion` on its own, unlike the CSS
	// transitions app.css already flattens, and neither does this. A reader who has asked for
	// less motion gets the same final position without the travel.
	const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	scroller.scrollBy({ top: delta, behavior: still ? 'auto' : 'smooth' });
	return delta;
}
