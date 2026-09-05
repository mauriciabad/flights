/**
 * How the vendored land outline is written down (issue #346).
 *
 * Shared by `scripts/prepare-coastline.mjs`, which writes it, and `land.ts`, which reads
 * it back. One file, so the two can never drift into disagreeing about a byte.
 *
 * The scheme is Google's polyline encoding applied to a fixed degree grid: each
 * coordinate becomes an integer number of grid steps, each step is stored as a difference
 * from the one before, and each difference is zigzagged and written five bits at a time in
 * printable ASCII. A coastline moves a step or two at a time, so almost every difference
 * fits in one character.
 *
 * Plain decimal text was the first attempt and cost 2.1x as many bytes gzipped, because a
 * comma and a minus sign per number is most of a small number.
 */

/** Rings are separated by this character, which the payload alphabet never uses. */
export const RING_SEPARATOR = ' ';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$';

const VALUES = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) VALUES[ALPHABET.charCodeAt(i)] = i;

/** Zigzag, so a small negative difference costs the same as a small positive one. */
function zigzag(value: number): number {
	return value < 0 ? -value * 2 - 1 : value * 2;
}

function unzigzag(value: number): number {
	return value % 2 === 1 ? -(value + 1) / 2 : value / 2;
}

export function encodeSigned(value: number): string {
	let remaining = zigzag(value);
	let out = '';
	// The high bit of each character says "another one follows", which is why the alphabet
	// is 64 wide but only 32 values are payload.
	while (remaining >= 32) {
		out += ALPHABET[(remaining & 31) | 32];
		remaining = Math.floor(remaining / 32);
	}
	return out + ALPHABET[remaining];
}

/** One ring's `[x, y]` grid coordinates, as differences. */
export function encodeRing(steps: readonly (readonly [number, number])[]): string {
	let previousX = 0;
	let previousY = 0;
	let out = '';
	for (const [x, y] of steps) {
		out += encodeSigned(x - previousX);
		out += encodeSigned(y - previousY);
		previousX = x;
		previousY = y;
	}
	return out;
}

/**
 * Reads one ring back into a flat `[x0, y0, x1, y1, ...]` run of grid coordinates.
 *
 * Flat rather than an array of pairs: there is one of these per ring and they are walked
 * once per preview, so a few thousand two-element arrays would be allocation this app
 * pays for on every card it draws.
 */
export function decodeRing(encoded: string): Int32Array {
	const out: number[] = [];
	let x = 0;
	let y = 0;
	let index = 0;
	while (index < encoded.length) {
		let value = 0;
		let shift = 1;
		for (;;) {
			const digit = VALUES[encoded.charCodeAt(index++)];
			if (digit < 0) throw new Error(`coastline: unexpected character at ${index - 1}`);
			value += (digit & 31) * shift;
			if ((digit & 32) === 0) break;
			shift *= 32;
		}
		x += unzigzag(value);

		value = 0;
		shift = 1;
		for (;;) {
			const digit = VALUES[encoded.charCodeAt(index++)];
			if (digit < 0) throw new Error(`coastline: unexpected character at ${index - 1}`);
			value += (digit & 31) * shift;
			if ((digit & 32) === 0) break;
			shift *= 32;
		}
		y += unzigzag(value);

		out.push(x, y);
	}
	return Int32Array.from(out);
}
