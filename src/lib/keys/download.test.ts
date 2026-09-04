import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadKeysFile } from './download';
import { buildExportEnvelope } from './codec';

// jsdom does not implement createObjectURL, and its anchor's `click()` does
// a real (if inert) navigation attempt, so both are replaced with a plain
// stub anchor here — this test is about what downloadKeysFile does with the
// DOM, not about jsdom's own DOM feature coverage.
describe('downloadKeysFile', () => {
	let createObjectURL: ReturnType<typeof vi.fn>;
	let revokeObjectURL: ReturnType<typeof vi.fn>;
	let click: ReturnType<typeof vi.fn>;
	let anchor: HTMLAnchorElement;

	beforeEach(() => {
		createObjectURL = vi.fn(() => 'blob:mock-url');
		revokeObjectURL = vi.fn();
		vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

		click = vi.fn();
		anchor = { href: '', download: '', click } as unknown as HTMLAnchorElement;
		vi.spyOn(document, 'createElement').mockReturnValue(anchor);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('builds the anchor with the given filename and revokes the blob URL afterwards', () => {
		const envelope = buildExportEnvelope({ skyscanner: 'sk-live-1234' });
		downloadKeysFile(envelope, 'my-keys.json');

		expect(createObjectURL).toHaveBeenCalledTimes(1);
		const [blob] = createObjectURL.mock.calls[0] as [Blob];
		expect(blob.type).toBe('application/json');
		expect(anchor.href).toBe('blob:mock-url');
		expect(anchor.download).toBe('my-keys.json');
		expect(click).toHaveBeenCalledTimes(1);
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
	});
});
