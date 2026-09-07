/**
 * The attachment that turns a rendered `<dialog>` into an open modal, and puts focus back
 * where it came from when it goes.
 *
 * `MapDialog.svelte` established this for issue #280 and `PhotoLightbox.svelte` is the
 * second surface to need it (#441). Shared rather than copied, for the reason MapDialog's
 * own header gives about the three map dialogs: the details that get dropped in a copy are
 * the ones nobody notices until a page scrolls under an open dialog or focus lands on the
 * document body.
 *
 * `showModal()` is what supplies the focus trap, `aria-modal`, the top layer and the inert
 * background, per the ARIA authoring practices modal pattern. Escape is then the platform's
 * own `cancel` event and needs no key handler.
 *
 * Existing is being open. The parent renders the dialog to open it and stops rendering it
 * to close it, so there is no `open` prop and no second source of truth to drift.
 */
export function openAsModal(element: HTMLDialogElement) {
	const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
	const previousOverflow = document.body.style.overflow;

	element.showModal();
	document.body.style.overflow = 'hidden';

	return () => {
		document.body.style.overflow = previousOverflow;
		// `isConnected` because a trigger inside a card the results stream replaced while the
		// dialog was open is gone, and focusing a detached node silently sends focus to the
		// document body instead of leaving it where the browser put it.
		if (trigger?.isConnected) trigger.focus();
	};
}
