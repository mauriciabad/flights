/**
 * The arithmetic behind the lightbox's zoom, issue #441, with no DOM in it.
 *
 * `PhotoLightbox.svelte` reads pointers and wheels and this decides where the photograph
 * ends up. Split out because zoom is the part that is wrong in a way a screenshot does not
 * show: an anchor that drifts by a few pixels a step looks like nothing until you have
 * scrolled ten times, and it is exactly the kind of thing a test pins in one line.
 *
 * ## Zooming to the pointer, not to the middle
 *
 * The owner asked to "zoom with trackpad and scrollwhel". Zooming about the centre of the
 * image while the reader is looking at a corner is what makes these feel broken: the thing
 * under the cursor slides away from it. So the image point under the pointer is the fixed
 * point of every zoom.
 *
 * One coordinate system throughout, and it is worth stating once. A point is measured in
 * CSS pixels from the CENTRE of the viewport box, because that is where a
 * `transform: translate(...) scale(...)` with the default `transform-origin` puts its own
 * origin. A rendered point `p` comes from an image point `q` as `p = pan + scale * q`, so
 * holding `q` still across a scale change is `pan' = p - scale' * (p - pan) / scale`.
 *
 * ## Why the pan is clamped against the drawn size and not the box
 *
 * The photograph is drawn `object-fit: contain`, so at rest it touches two sides of the box
 * and leaves bars on the other two. Clamping against the box would let a portrait
 * photograph be dragged until only the bar was on screen. Clamping against the drawn
 * rectangle keeps at least the whole shorter axis in view and, at scale 1, pins the
 * photograph exactly where the layout put it.
 */

/** Rest. Every escape from a zoomed state lands back on this exact object, so "is it
 * zoomed" is one comparison rather than three. */
export const NO_ZOOM: Pan = { scale: 1, x: 0, y: 0 };

/** Where a double-tap takes an unzoomed photograph. Enough that the reader can read a room
 * sign or a bunk ladder, not so much that the next tap has nowhere to go. */
export const TAP_ZOOM_SCALE = 2.5;

const MIN_SCALE = 1;
/** Past this a card-sized photograph is showing its own pixels, and the lightbox swaps in
 * the publisher's original well before here. Six is where a 800px-wide delivery reaches
 * roughly the 4800px of the stored frame. */
const MAX_SCALE = 6;

export interface Pan {
	scale: number;
	/** CSS pixels, from the centre of the viewport box. */
	x: number;
	y: number;
}

export interface Point {
	x: number;
	y: number;
}

/** The viewport the photograph is drawn into, and the rectangle it actually occupies there
 * at scale 1. Both in CSS pixels. A zero content size means nothing has decoded yet, and
 * every function below then leaves the pan alone rather than dividing by it. */
export interface ZoomBox {
	width: number;
	height: number;
	contentWidth: number;
	contentHeight: number;
}

function clamp(value: number, limit: number): number {
	const clamped = Math.min(limit, Math.max(-limit, value));
	// Clamping a negative against a limit of zero gives -0, which draws and compares the
	// same as 0 and reads as a defect in a test failure and in a devtools panel.
	return clamped === 0 ? 0 : clamped;
}

/** How far the photograph may be dragged before its own edge crosses the box's. Zero when
 * the drawn image is smaller than the box on that axis, which is what pins an unzoomed
 * photograph in place instead of letting it float. */
function panLimit(drawn: number, box: number): number {
	return Math.max(0, (drawn - box) / 2);
}

export function clampPan(pan: Pan, box: ZoomBox): Pan {
	const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, pan.scale));
	return {
		scale,
		x: clamp(pan.x, panLimit(box.contentWidth * scale, box.width)),
		y: clamp(pan.y, panLimit(box.contentHeight * scale, box.height))
	};
}

/**
 * The pan after multiplying the scale by `factor`, with the image point under `pointer`
 * left where it was.
 *
 * The clamp runs at the end rather than on the way in, so a zoom that would have pushed an
 * edge past the box is corrected once instead of anchoring to a point the clamp then moves.
 */
export function zoomAt(pan: Pan, box: ZoomBox, pointer: Point, factor: number): Pan {
	if (!Number.isFinite(factor) || factor <= 0) return pan;
	const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, pan.scale * factor));
	// Nothing to anchor to when the scale did not move, and dividing by a scale of zero is
	// the only way this produces NaN.
	if (scale === pan.scale || pan.scale === 0) return clampPan({ ...pan, scale }, box);
	const ratio = scale / pan.scale;
	return clampPan(
		{
			scale,
			x: pointer.x - ratio * (pointer.x - pan.x),
			y: pointer.y - ratio * (pointer.y - pan.y)
		},
		box
	);
}

export function panBy(pan: Pan, box: ZoomBox, dx: number, dy: number): Pan {
	return clampPan({ scale: pan.scale, x: pan.x + dx, y: pan.y + dy }, box);
}

/**
 * What a double-tap or double-click does: all the way out if the photograph is zoomed at
 * all, otherwise in, to the point that was tapped.
 *
 * Out rather than further in, because a reader who has zoomed and panned around wants one
 * gesture back to the whole picture, and the wheel is right there for another step in.
 */
export function toggleZoom(pan: Pan, box: ZoomBox, pointer: Point): Pan {
	if (pan.scale > MIN_SCALE) return NO_ZOOM;
	return zoomAt(pan, box, pointer, TAP_ZOOM_SCALE);
}

/** A wheel notch in lines or pages, in CSS pixels. The line height is Firefox's own default
 * and the page figure is a screenful; neither has to be exact, because both only set how
 * far one notch of a mouse wheel zooms. */
const DELTA_MODE_PIXELS = [1, 16, 400];

/**
 * The scale factor one wheel event asks for.
 *
 * A trackpad pinch reaches a page as a `wheel` event with `ctrlKey` set and a small delta,
 * which is a browser convention rather than a real control key, and it needs a much steeper
 * response than a mouse wheel or a pinch feels dead. The two constants are the ratio
 * between them and nothing more.
 *
 * Exponential rather than additive, so zooming in by n notches and back out by n lands
 * exactly where it started instead of drifting.
 */
export function wheelZoomFactor(event: { deltaY: number; deltaMode?: number; ctrlKey?: boolean }): number {
	const unit = DELTA_MODE_PIXELS[event.deltaMode ?? 0] ?? 1;
	const pixels = event.deltaY * unit;
	if (!Number.isFinite(pixels)) return 1;
	return Math.exp(-pixels * (event.ctrlKey ? 0.01 : 0.002));
}
