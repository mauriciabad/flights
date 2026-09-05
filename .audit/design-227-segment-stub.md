# Design package for #227, the segment stub

Produced 02:4x on 2026-09-05 by a design subagent, which finished just before the session
limit hit. The agent that commissioned it died before it could implement any of this. It is
saved here so the work is not paid for twice. Treat it as a proposal with strong reasoning,
not as law: the implementer should still verify each measured claim.

## Findings it grounded first

- The strip's cells are size containers with `overflow: hidden`, so a panel inside one is
  clipped and trapped.
- The app shell scrolls inside `.app-content`, not the document.
- Times print through `formatClockTime` as padded 24h today (#229 is open and changes this).
- Segments in `trip-strip.ts` carry minutes but not their start and end readings.

A doc nit found on the way: the header comment in `trip-strip.ts` gives the reference
flights as 7h 50m and 6h 40m, which is the wall-clock difference. The elapsed times are
5h 50m and 4h 40m, and `FlightOffer.duration` is computed with offsets. Correct the comment
so nobody tests against it.

## The one idea

The panel is the segment's own ticket stub, torn off the strip. Top half is the stub, tinted
in the segment's own colour, carrying eyebrow, title and two clocks. Bottom half is the
counterfoil, plain surface, carrying the facts. Between them a perforation and two die-cut
notches. A tail points at the cell. Whatever you hovered, tapped or arrowed to gets the
app's one accent ring and nothing else, so hover, focus and tap look identical.

## Anatomy

```
 +--------------------------------------------+
 | [key] FLIGHT                    Tue, 6 Oct |   eyebrow: 10px mono caps, muted
 | TUI Airways BY625                          |   title: 16px sans semibold
 |                                            |
 | 12:40pm  ---------- 5h 50m ---------  8:30pm  clocks: 20px mono semibold
 | BVC Boa Vista                    LGW London|   stamps: 11px, code in mono
 | Clocks are local. London (UTC+1) is 2h     |   footnote, only when offsets differ
 | ahead of Boa Vista (UTC-1).                |
 (- - - - - - - - - - - - - - - - - - - - - -)   perforation, notched at both ends
 | Fare          EUR 129.00                   |   facts: 12px, label muted, value text
 | Bags          1 cabin, 1 checked           |
 | Aircraft      Boeing 787-8                 |
 +--------------------v-----------------------+   tail, 12px, on the cell's centre
```

Hierarchy loudest first: the two clocks, then the title, then the facts, then the eyebrow.
That is a departure board's order. The clocks are the biggest thing because the strip is a
picture of time and the panel is where the picture becomes numbers.

Width 21rem on desktop, centred on the segment, clamped inside the card. On a 375px phone it
takes the card's content width, 343px, and the tail slides along the bottom to the segment.

## The notches come free

Two boxes touch. Round the adjacent corners of each and the four quarter-circles leave a
die-cut pinch at both sides, at any content height, with nothing measured. Shadow the
wrapper with `filter: drop-shadow` rather than `box-shadow` so the shadow follows the
pinched silhouette and the tail.

```css
/* One panel per strip. `left`/`top` stay 0; position is a translate, so a move
   from one segment to the next glides, and the entry can start 4px nearer the
   segment it belongs to. Popover UA styles are reset on the same line. */
.stub {
	--stub-bg: var(--color-surface-hover);
	--stub-tint: var(--color-bg-inset);
	--stub-rail: var(--color-border-strong);
	--stub-rail-style: solid;
	--tail-x: 50%;
	--enter-dy: 4px;
	position: fixed;
	inset: 0 auto auto 0;
	margin: 0;
	padding: 0;
	border: 0;
	background: none;
	overflow: visible;
	width: var(--stub-w, 21rem);
	translate: var(--x) var(--y);
	color: var(--color-text);
	font-family: var(--font-sans);
	font-size: var(--font-size-xs);
	line-height: var(--line-height-xs);
	filter: drop-shadow(0 12px 28px rgb(3 5 14 / 55%)) drop-shadow(0 1px 1px rgb(3 5 14 / 45%));
}

.stub-flight   { --stub-tint: var(--color-accent-muted); --stub-rail: var(--color-accent); }
.stub-free     { --stub-tint: var(--color-stopover-bg);  --stub-rail: var(--color-stopover); --stub-rail-style: dashed; }
.stub-wait,
.stub-transfer { --stub-tint: var(--color-bg-inset); }

/* Avoided airline: the tint steps back exactly as the strip's cells do. The text
   does not. The traveller asked to read this panel; greying what they asked for
   is the opposite of quiet. */
.is-quiet.stub-flight,
.is-quiet.stub-free { --stub-tint: var(--color-bg-inset); --stub-rail: var(--color-border-strong); }

@media (prefers-color-scheme: light) {
	.stub {
		--stub-bg: var(--color-surface);
		filter: drop-shadow(0 10px 24px rgb(19 24 41 / 16%)) drop-shadow(0 1px 1px rgb(19 24 41 / 10%));
	}
}

.stub-top,
.stub-bottom {
	position: relative;
	border: 1px solid var(--color-border-strong);
	padding: var(--space-3) var(--space-4);
}

.stub-top {
	background: var(--stub-tint);
	border-bottom: 0;
	border-radius: var(--radius-md) var(--radius-md) 7px 7px;
}

.stub-bottom {
	background: var(--stub-bg);
	border-top: 2px dashed var(--color-border-strong);
	border-radius: 7px 7px var(--radius-md) var(--radius-md);
}

/* Painted after its box, so it covers the border where it joins. `left` is a plain
   transition, so the tail glides when the panel moves from one segment to the next. */
.stub-tail {
	position: absolute;
	left: var(--tail-x);
	bottom: -7px;
	width: 12px;
	height: 12px;
	background: var(--stub-bg);
	border: 1px solid var(--color-border-strong);
	border-width: 0 1px 1px 0;
	rotate: 45deg;
	translate: -50% 0;
	transition: left 160ms cubic-bezier(0.16, 1, 0.3, 1);
}

.is-below .stub-tail {
	top: -7px;
	bottom: auto;
	background: var(--stub-tint);
	border-width: 1px 0 0 1px;
}
```

The tail lives in `.stub-bottom` when the panel sits above the strip and in `.stub-top` when
below, so it is always the colour of the box it hangs from.

## Eyebrow, key, title

10px JetBrains Mono, uppercase, tracked 0.08em, `--color-text-muted`. Left the kind, right
the date the segment starts on. In front of the kind, a 14x8px key repeating the strip
cell's own paint, hatch and dashes included, so the key still says "wait" or "free" when the
colour has gone quiet.

```css
.stub-eyebrow {
	display: flex;
	justify-content: space-between;
	align-items: center;
	gap: var(--space-2);
	font-family: var(--font-mono);
	font-size: 0.625rem;
	font-weight: var(--font-weight-semibold);
	letter-spacing: 0.08em;
	text-transform: uppercase;
	color: var(--color-text-muted);
}

.stub-key {
	display: inline-block;
	width: 14px;
	height: 8px;
	margin-right: var(--space-1);
	border-radius: 2px;
	vertical-align: -1px;
}

.stub-flight   .stub-key { background: var(--color-accent-muted); box-shadow: inset 0 0 0 1px var(--color-accent); }
.stub-free     .stub-key { background: var(--color-stopover-bg); border: 1px dashed var(--color-stopover); }
.stub-wait     .stub-key { background: repeating-linear-gradient(135deg, var(--color-border-strong) 0 1px, transparent 1px 3px), var(--color-bg-inset); box-shadow: inset 0 0 0 1px var(--color-border); }
.stub-transfer .stub-key { background: var(--color-border-strong); }
```

Eyebrow words: FLIGHT, AIRPORT WAIT, TRANSPORT, STOPOVER. "Transport" over the price line's
"Ground" because the owner says transport and "ground" is an odd word for a walk. That
inconsistency in the price line is a separate follow-up, not this issue.

Title: 16px Bricolage Grotesque semibold, tight tracking, `text-wrap: balance`. The stopover
title in `--color-stopover`; everything else `--color-text`. On the avoided-airline card the
title stays `--color-text` and only the tint goes quiet.

## The time row

```css
.stub-times {
	display: grid;
	grid-template-columns: auto minmax(3rem, 1fr) auto;
	column-gap: var(--space-2);
	margin-top: var(--space-2);
}

.stub-clock {
	font-family: var(--font-mono);
	font-variant-numeric: tabular-nums;
	font-size: var(--font-size-xl);
	line-height: 1.1;
	font-weight: var(--font-weight-semibold);
	letter-spacing: var(--tracking-tight);
	white-space: nowrap;
}

.stub-clock-end { text-align: right; }

.stub-rail {
	align-self: start;
	margin-top: 0.7rem;
	height: 0;
	border-top: 1px var(--stub-rail-style) var(--stub-rail);
	text-align: center;
}

.stub-rail > span {
	position: relative;
	top: -0.55rem;
	padding: 0 var(--space-2);
	background: var(--stub-tint);
	font-family: var(--font-mono);
	font-variant-numeric: tabular-nums;
	color: var(--color-text-muted);
	white-space: nowrap;
}

.stub-stamp {
	font-size: 0.6875rem;
	line-height: 1.2;
	color: var(--color-text-muted);
}

.stub-stamp b {
	font-family: var(--font-mono);
	font-weight: var(--font-weight-semibold);
	letter-spacing: var(--tracking-wide);
	color: var(--color-text);
}
```

What prints under a clock, in the spirit of `TimeCell`'s "print only what the neighbour has
not established":

- The start clock always gets its code and place.
- The end clock gets a code and place only when they differ from the start. A wait, a
  transfer or the stopover has one place, so its end clock stands alone.
- The date lives in the eyebrow corner. When the end falls on a later calendar day, the end
  clock gets a date line beneath it and the `+1` stamp beside it, reusing `.tl-note-plusday`
  unchanged. A lost night is the one thing this app must never let a reader miss.
- The stopover is the exception: it always spans days and the nights are its headline, so it
  gets a date under each clock and no stamp.

```
 11:50pm  ---------- 6h 20m ---------  6:10am [+1]
 LGW London                          PFO Pafos
                                     Wed, 7 Oct
```

## The second timezone

The place under the clock is the zone. When the two ends have different UTC offsets, one
footnote line says the rest in the words a traveller uses:

> Clocks are local. London (UTC+1) is 2h ahead of Boa Vista (UTC-1).

Derived from the two stored `utcOffsetMinutes`, never from the IANA names, so it is exact
for those two instants, DST included. It also explains what otherwise looks like a bug:
12:40pm to 8:30pm reads as 7h 50m on the clocks while the rail says 5h 50m.

## Facts

```css
.stub-facts {
	display: grid;
	grid-template-columns: 6rem minmax(0, 1fr);
	row-gap: var(--space-1);
	column-gap: var(--space-3);
}

.stub-facts dt { color: var(--color-text-muted); }
.stub-facts dd { margin: 0; overflow-wrap: anywhere; }
.stub-facts .font-mono { font-variant-numeric: tabular-nums; }

/* A number nobody gave us. Muted so it does not read as a value, never blank,
   never zero. "No fare" is NOT this class: walking being free is a known fact
   and prints in the ordinary text colour. */
.stub-facts .is-unknown { color: var(--color-text-muted); }
```

Two greys, not three. `--color-text-faint` measures about 4.1:1 on `--color-surface-hover`,
which fails AA at 12px, so the panel does not use it.

## The active segment

The hit area gets the app's focus ring, `2px solid var(--color-focus-ring)`, offset 1px, the
same ring for hover, keyboard focus and tap, so there is one thing to learn. Accent gold on
every card including the avoided-airline one, because it is an interaction colour, not a
content colour. Nothing else on the strip changes; dimming neighbours would fight both the
comparison the strip exists for and the deprioritised treatment.

## The copy, in DOM order

Reference trip. BVC to PFO, 1 traveller, three nights in London. Outbound TUI Airways BY625,
12:40pm Tue 6 Oct BVC (UTC-1) to 8:30pm LGW (UTC+1). Onward easyJet U28965, 3:20pm Fri 9 Oct
LGW to 10:00pm PFO (UTC+3). Bed at Gainsborough Lodge in Horley, 28 minute walk, private
room, EUR 44.00 a night. Landing-to-transport 30m at Gatwick, buffer 2h.

### Flight

```
[key] FLIGHT                                  Tue, 6 Oct
TUI Airways BY625
12:40pm  ------------- 5h 50m -------------  8:30pm
BVC Boa Vista                              LGW London
Clocks are local. London (UTC+1) is 2h ahead of Boa Vista (UTC-1).
- - - - - - - - - - - - - - - - - - - - - - - - - - - -
Fare        EUR 129.00
Bags        1 cabin, 1 checked
Aircraft    Boeing 787-8
```

- Two or more travellers: `Fare  EUR 258.00 for 2`. Print `outboundFlight.price`, which
  `build.ts` has already scaled by that offer's `priceScope`. Never multiply again.
- Fare brand where the provider gave one: `Fare  EUR 131.00, Standard`.
- No bags: `Bags  none included`. Cabin only: `Bags  1 cabin, no checked bag`.
- Aircraft row only when present. An absent fact is an absent row, never "unknown".
- A technical stop is a line under the title in the warning-tinted stamp style, because it
  changes what the duration means: `Stops in SID for 55m, everyone stays on board.` That
  string is `technicalStopDetail` verbatim.
- On an avoided-airline card, a muted line under the title: `An airline you asked to avoid.`

### Airport wait

```
[key] AIRPORT WAIT                            Fri, 9 Oct
London Gatwick LGW
1:20pm  --------------- 2h ---------------  3:20pm
LGW London
Your buffer before boarding. 2h is your setting for every flight, not a measured queue. Change it under Show details.
- - - - - - - - - - - - - - - - - - - - - - - - - - - -
Before      easyJet U28965 to Pafos, 3:20pm
```

The wait is a preference and the panel says so, which is the honest form under AGENTS.md's
rule against presenting an estimate as a fact.

### Transport

A walk. "No fare" is a fact this app knows, in ordinary text colour.

```
[key] TRANSPORT                               Tue, 6 Oct
Walk to Gainsborough Lodge
9:00pm  --------------- 28m --------------  9:28pm
LGW London
- - - - - - - - - - - - - - - - - - - - - - - - - - - -
Fare        No fare
Distance    2.1 km
```

A ride nobody priced. "Price not available" is an admission, muted.

```
[key] TRANSPORT                               Fri, 9 Oct
Bus to Kato Paphos
10:40pm  -------------- 25m --------------  11:05pm
PFO Pafos
- - - - - - - - - - - - - - - - - - - - - - - - - - - -
Route          612 to Kato Paphos harbour
Fare           Price not available
Distance       11 km straight line
If you miss it Nothing later tonight
```

- Title is `transferDetailLine` plus the destination. `your destination` only when the query
  gave no name.
- `Route` joins the legs' `description` strings with `, then`, omitted when there are none.
- `Distance` is road distance from `path` where OSRM gave one, and the great-circle figure
  labelled `straight line` where it did not. Never a bare number for a straight line.
- `If you miss it` is the transit schedule's `following` list, or `Nothing later tonight`.
  The domain calls missing the last bus a first-class outcome; this is where it gets said.
- "each way" does not appear on a single leg. It belongs in the stopover panel where the two
  legs are summarised as a pair.

### Stopover, bed priced

```
[key] STOPOVER                                Tue, 6 Oct
3 nights in London
9:28pm  - - - - - - 2d 15h free - - - - - -  12:52pm
LGW London                                 Fri, 9 Oct
- - - - - - - - - - - - - - - - - - - - - - - - - - - -
Bed         Gainsborough Lodge, private room
Rate        EUR 44.00/night, EUR 132.00 for 3 nights
Nights      1 required by the flights, 2 you added
From LGW    2.1 km, a 28m walk each way
From centre 41 km to central London

Tue 6       2h 32m, from 9:28pm
Wed 7       all day
Thu 8       all day
Fri 9       12h 52m, until 12:52pm
```

- `Stay.pricePerNight` is one flat figure for the party, so do not divide it per person. For
  a party of two it says `EUR 44.00/night for 2`. Inventing a per-person split from a
  per-room rate would be a number nobody gave us. (This bears directly on #206.)
- `Nights` is #225's split. At the minimum length: `1, required by the flights`. A same-day
  connection has no nights row and the title is `Day stopover in London`.
- `From LGW` is #219's missing distance, and `each way` is its honest home: the walk happens
  twice. Say `each way` only when both legs match.
- The per-day rows are the midnight split the strip already draws, and the reason a single
  "2d 15h" is not enough. (This bears directly on #228.)

### Stopover, no bed priced

```
[key] STOPOVER                                Tue, 6 Oct
3 nights in London
9:28pm  - - - - - - 2d 15h free - - - - - -  12:52pm
LGW London                                 Fri, 9 Oct
- - - - - - - - - - - - - - - - - - - - - - - - - - - -
Bed         Not priced, so the total is a floor
Nights      1 required by the flights, 2 you added

Tue 6       2h 32m, from 9:28pm
...
```

`Not priced` is muted, agreeing with the price line's `Bed  not priced` chip. No "yet":
#140 ruled that word out for a state nothing is about to change. No cause and no "add a
key"; `StayKeyNotice` owns that once per page. (This bears directly on #185 and #203.)

## The interaction

One panel element per strip, a `popover="auto"` in the top layer, rendered as a sibling of
the track inside `.trip-strip`, never inside a cell. The cells are `container-type:
inline-size` with `overflow: hidden`, so anything inside one is clipped, and where size
containment still implies layout containment the cell is also the containing block for
`position: fixed`. The top layer escapes the card, `.app-content`'s `overflow-y: auto`, and
any transform an ancestor may one day gain. It gives Escape and click-outside for free, and
opening one auto popover closes every other, so hovering card two's strip closes card one's
panel with no bookkeeping. Positioning is about twenty lines of `getBoundingClientRect`
written into `--x`, `--y`, `--tail-x` and `--stub-w`. CSS anchor positioning would replace
them, but Firefox in the field is not certain and the measurement is.

The strip stops being `role="img"` and becomes `role="group"` with the same `aria-label`.
Over the cells sits a row of transparent buttons on the same grid row, one per flight, wait
and transfer, and one spanning the whole run of free-day cells. They are siblings of the
cells, so the cell keeps its entire visual and the button carries only hit area, ring and
semantics.

```css
.trip-strip-hit {
	grid-row: 2;
	position: relative;
	min-width: 0;
	padding: 0;
	border: 0;
	border-radius: var(--radius-sm);
	background: none;
	cursor: pointer;
	touch-action: manipulation;
	-webkit-tap-highlight-color: transparent;
}

/* 44px tall from a 28px cell, never narrower than 24px, centred on the cell it
   stands for. The cell keeps its true width: widening it would lie about time,
   which is the one thing this strip exists to tell the truth about. */
.trip-strip-hit::before {
	content: '';
	position: absolute;
	top: -8px;
	bottom: -8px;
	left: 50%;
	width: max(100%, 24px);
	translate: -50% 0;
}

/* A 3px seam beside a 35px day: the thin one wins the overlap. */
.trip-strip-hit-transfer,
.trip-strip-hit-wait { z-index: 1; }

.trip-strip-hit.is-active,
.trip-strip-hit:focus-visible {
	outline: 2px solid var(--color-focus-ring);
	outline-offset: 1px;
}
```

On a 375px phone the targets come out around 44x140 for a three-night run, 44x60 for a
flight, 44x31 for a wait and 44x24 for a transfer. The transfer is under the 44x44 guideline
and the design says so rather than hiding it: widening the cell lies, and a mis-tap lands on
a neighbour whose panel names itself in its first line, so the correction is one tap.

Accessibility. Each button has a short `aria-label` (`Flight, TUI Airways BY625, 5h 50m`),
`aria-expanded`, and while active an `aria-describedby` pointing at the panel, which is
`role="tooltip"`. Focus reads the whole stub in DOM order, which is why the copy above is
written in that order. One tab stop per strip with roving `tabindex`; Left/Right move
between segments, Home/End jump, and the panel follows focus. Without this a page of twenty
cards is two hundred tab stops.

Hover: 100ms open delay so the strip does not flicker as a pointer crosses it; leaving the
union of target and panel starts a 150ms grace. Moving A to B while open swaps content
immediately, moves the ring instantly, glides panel and tail. Focus: opens on
`focus-visible`, closes on blur, no delay, Escape closes and leaves focus on the segment.
Touch: tap toggles, tap elsewhere swaps, outside dismisses, scroll closes rather than
repositions, because a top-layer panel does not travel with its card.

Placement above the strip by default, 8px clear so the tail tip touches the cell; the codes
row underneath is covered and nothing is lost because the codes are on the panel. Above is
also right for a thumb, which is below the strip when it taps. Flip below when there is no
room; if neither side fits, take the larger and cap the counterfoil with its own scroll.

State in Svelte 5: `active`, `pinned`, `placement` and four measured numbers, all `$state`;
one `$effect` that reads `active`, measures synchronously, writes the custom properties and
calls `showPopover`/`hidePopover`. Nothing in it is async, so the trap that took the search
down does not apply. The hover timer sets `active` from a `setTimeout` callback, which the
effect does not track.

## Prework the implementer needs

- `trip-strip.ts` segments must carry `start` and `end` as `LocalDateTime`, derived in that
  pure module by walking the schedule from the two flights. A transfer into the city ends at
  `freeTime.start`; a wait ends at its flight's departure. Each segment also needs a
  reference to the offer, transfer or stay it stands for.
- `formatClockTime` must become #229's unpadded am/pm form, with 12:15am and 12:15pm handled,
  before this panel prints a clock.
- The card must pass the connection airport's name down so the wait panel can say Gatwick.

## Motion

Enter 120ms opacity and 160ms translate on `cubic-bezier(0.16, 1, 0.3, 1)`, starting 4px
nearer the segment. Exit 120ms opacity only. Moving between segments transitions `translate`
on the panel and `left` on the tail over 160ms; the height snaps, and because the tail edge
is anchored it is the far edge that jumps, where nobody is looking. The ring has no
transition: feedback inside 100ms is the rule and a ring that fades in reads as lag.

```css
.stub {
	opacity: 0;
	transition:
		opacity 120ms ease,
		translate 160ms cubic-bezier(0.16, 1, 0.3, 1),
		display 120ms allow-discrete,
		overlay 120ms allow-discrete;
}

.stub:popover-open { opacity: 1; }

@starting-style {
	.stub:popover-open {
		opacity: 0;
		translate: var(--x) calc(var(--y) + var(--enter-dy));
	}
}
```

`app.css` already forces every transition to 0.001ms under `prefers-reduced-motion`, so no
override is needed. Nothing here is conveyed by motion alone.

## Rejected, with reasons

- **`title=` on the cells**, the current implementation. Invisible on touch, unreachable by
  keyboard, truncates, cannot show a second timezone or a per-day list.
- **Scrolling the expanded timeline into view instead of a panel.** The strip is the glance;
  answering a glance by opening a 600px panel and scrolling is disorienting on a phone, and
  it is not available at all on the collapsed card where the strip lives. A footer link in
  the stub that opens the matching timeline row is a good second step for the wait and
  transport panels. Deferred, not rejected.
- **One tooltip per day cell.** The bed is one booking; eleven copies of it is not
  information.
- **Widening thin cells to make tap targets.** The strip's contract is that width is time.
  The 24px floor lives on the transparent hit area and the seam stays 3px.
- **A bottom sheet on mobile.** Heavier, a second component, and it hides the strip it
  describes.
- **Inline expansion below the strip.** Adds height to a card already at 549px against the
  462px #197 won. Overlay was a hard constraint and it is the right one.
- **UTC offsets as the zone signal.** `UTC+1` under a clock is how the app stores time, not
  how a traveller reads it.
- **Frosted glass.** `backdrop-filter` over a card full of logos, hatching and dashes turns
  to mud, costs on mobile, and a ticket is opaque paper.
- **A barcode strip on the counterfoil.** It would read as scannable and say nothing.
  Decoration that claims meaning is the worst tell.
- **Animating the panel's height between segments.** Layout animation on every hover, for a
  change the eye does not follow.
- **Dimming the other segments.** Removes the comparison the strip exists for and collides
  with the greyed-out treatment, which is colour-only by rule.
- **`role="dialog"` with focus moved into the panel.** The panel has no controls; moving
  focus would strand keyboard users two levels deep for a tooltip.
- **`left`/`top` plus `box-shadow`.** Translate glides on the compositor, and `drop-shadow`
  follows the notched silhouette and the tail.
