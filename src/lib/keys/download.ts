import type { KeyFileEnvelope } from './types';

/**
 * Triggers a browser download of the given envelope as a JSON file. This is
 * the only DOM-touching function in this module — everything else here is
 * pure data handling and testable without a browser.
 */
export function downloadKeysFile(envelope: KeyFileEnvelope, filename = 'flights-api-keys.json'): void {
	const json = JSON.stringify(envelope, null, 2);
	const blob = new Blob([json], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	try {
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = filename;
		anchor.click();
	} finally {
		// The click above is synchronous, so the browser has already queued the
		// download by the time this runs — revoke right away instead of leaking
		// the blob URL for the rest of the page's life.
		URL.revokeObjectURL(url);
	}
}
