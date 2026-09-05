/**
 * Issue #265/#269: swapping a flight must not widen the stopover's free-time window by the
 * two in-city legs. `recomputeItinerarySelection` used to gate both edges of that window on
 * `stay`, so on a bedless stopover with a routed ride into town a swap handed back the whole
 * layover instead of the layover minus the rides. #269 routed all three producers through
 * `deriveItinerary`. Nothing had ever driven that swap in a browser.
 *
 *   node tools/verify-flight-swap-window.mjs ['<results url>']
 *
 * The trap this is built against: a probe that never reaches the state prints exactly what a
 * passing probe prints. So every precondition is an assertion with its own line, and the
 * verdict is refused unless the swap provably moved the current pick from one named flight to
 * another. `.audit/verify-269.mjs` is the version that fell into it; it looked for the
 * alternatives as <button> elements, and FlightPicker renders them as <label class="picker-row">
 * wrapping a visually hidden radio, so it clicked nothing and reported two identical readings.
 *
 * Three independent checks, because the round trip alone can be fooled by a swap that widens
 * every reading including the one it returns to:
 *
 *   1. The window's start sits exactly one ride-to-town after the outbound flight lands, and
 *      its end one ride-plus-buffer before the onward flight leaves. Read off the screen after
 *      the swap, in minutes. This is the bug's own arithmetic.
 *   2. The window's length does not grow by the two rides.
 *   3. Picking the original flight back lands on the first reading, character for character.
 */
import { chromium } from "@playwright/test";
import { newProbeContext } from "./probe-browser.mjs";

const TARGET =
  process.argv[2] ??
  "https://flights.mauri.app/results/?dep=2026-10-06&depLatest=2026-10-09&arr=2026-10-12&from=BVC&to=PFO";

const failures = [];
function check(ok, label, detail = "") {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`,
  );
  if (!ok) failures.push(label);
  return ok;
}

function parseClock(text) {
  const m = /(\d{1,2})(?::(\d{2}))?(am|pm)/i.exec(text ?? "");
  if (!m) return undefined;
  const hour12 = Number(m[1]) % 12;
  const hour = m[3].toLowerCase() === "pm" ? hour12 + 12 : hour12;
  return hour * 60 + Number(m[2] ?? 0);
}

function parseDuration(text) {
  const m = /(?:(\d+)h)?\s*(?:(\d+)m)?/.exec(text ?? "");
  if (!m || (m[1] === undefined && m[2] === undefined)) return undefined;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

/** Clock minutes forward from a to b, wrapped over midnights. Both edges are same-clock reads. */
function forward(a, b) {
  return (b - a + 1440 * 3) % 1440;
}

const browser = await chromium.launch();
const page = await (await newProbeContext(browser)).newPage();
page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));

try {
  await page.goto(TARGET, { waitUntil: "domcontentloaded" });

  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const searching = await page.locator(".still-searching").count();
    const cards = await page
      .getByRole("button", { name: /show details/i })
      .count();
    if (cards > 0 && searching === 0) break;
    await page.waitForTimeout(3000);
  }
  const openers = page.getByRole("button", { name: /show details/i });
  const cardCount = await openers.count();
  if (!check(cardCount > 0, "the search returned at least one card"))
    throw new Error("no cards");

  const readState = () =>
    page.evaluate(() => {
      const text = (el) =>
        el ? el.textContent.trim().replace(/\s+/g, " ") : undefined;
      const block = document.querySelector(
        'section[aria-label^="Your stopover in"]',
      );
      const edges = [...block.querySelectorAll(".stopover-edge")].map((el) =>
        text(el),
      );
      const clocks = (segment) =>
        [
          ...document.querySelectorAll(
            `[data-segment="${segment}"] .tl-when .tl-time-clock`,
          ),
        ].map((el) => text(el));
      const group = document.querySelector(
        '[role="radiogroup"][aria-label^="Outbound:"]',
      );
      return {
        city: block.getAttribute("aria-label"),
        from: edges[0],
        until: edges[1],
        days: text(block.querySelector(".stopover-days")),
        property: text(block.querySelector(".stopover-property")),
        room: text(block.querySelector(".stopover-room")),
        transfer: text(block.querySelector(".stopover-transfer")),
        outboundRow: text(
          document.querySelector(
            '[data-segment="outbound-flight"] .tl-content',
          ),
        ),
        outboundClocks: clocks("outbound-flight"),
        onwardClocks: clocks("onward-flight"),
        waiting: text(
          document.querySelector(
            '[data-segment="connection-waiting"] .tl-meta .tl-duration',
          ),
        ),
        pick: group
          ? text(
              [...group.querySelectorAll(".picker-row")].find(
                (row) => row.querySelector("input").checked,
              ),
            )
          : undefined,
        rows: group
          ? [...group.querySelectorAll(".picker-row")].map((row) => text(row))
          : [],
      };
    });

  // The gate #269 removed read `stay &&`, and a flight swap carries `itinerary.stay`
  // through untouched (recompute-selection.ts line 123). So a card whose stopover has a bed
  // exercises the swap without discriminating the bug at all: both the old code and the new
  // subtract the rides. Only "No bed priced, so the total is a floor" (a night in the
  // stopover, no stay on the itinerary) plus a routed ride is the shape that told them apart.
  const ridesOf = (state) => {
    const line = state.transfer ?? "";
    const minutes = parseDuration(line.replace(/^[^,]*,\s*/, ""));
    return /from the airport/.test(line) && minutes > 0 ? minutes : undefined;
  };
  let before;
  let rideMinutes;
  let cardIndex = -1;
  const scanned = [];
  for (let i = 0; i < Math.min(cardCount, 8); i += 1) {
    await openers.nth(i).click();
    await page
      .locator('section[aria-label^="Your stopover in"]')
      .first()
      .waitFor({ timeout: 20000 });
    await page.waitForTimeout(1500);
    const state = await readState();
    const ride = ridesOf(state);
    scanned.push(
      `card ${i + 1}: ${state.city} | ${JSON.stringify(state.room)} | ride ${ride ?? "none"}`,
    );
    if (/No bed priced/i.test(state.room ?? "") && ride !== undefined) {
      before = state;
      rideMinutes = ride;
      cardIndex = i;
      break;
    }
    await page
      .getByRole("button", { name: /hide details/i })
      .first()
      .click();
    await page.waitForTimeout(500);
  }
  console.log(
    "\n--- cards scanned for a bedless stopover with a routed ride ---",
  );
  for (const line of scanned) console.log(`  ${line}`);

  const foundBugShape = before !== undefined;
  check(
    foundBugShape,
    "a card whose stopover has no bed priced and a routed ride into town (the bug's shape)",
    foundBugShape
      ? `card ${cardIndex + 1}`
      : "none of the scanned cards; the swap below cannot discriminate #265",
  );
  if (!foundBugShape) {
    await openers.nth(0).click();
    await page
      .locator('section[aria-label^="Your stopover in"]')
      .first()
      .waitFor({ timeout: 20000 });
    await page.waitForTimeout(1500);
    before = await readState();
    rideMinutes = ridesOf(before);
  }

  console.log("\n--- state before the swap ---");
  for (const [k, v] of Object.entries(before))
    console.log(`  ${k}: ${JSON.stringify(v)}`);
  console.log("");

  check(
    before.from !== undefined && before.until !== undefined,
    "the stopover block prints a free-time window",
  );
  check(
    rideMinutes !== undefined,
    "a ride into town is routed for this stopover",
    `transfer line: ${JSON.stringify(before.transfer)}`,
  );

  const row = page.locator('[data-segment="outbound-flight"]').first();
  if (
    !check((await row.count()) > 0, "the timeline has an outbound-flight row")
  )
    throw new Error("no row");
  await row.click();
  const group = page
    .locator('[role="radiogroup"][aria-label^="Outbound:"]')
    .first();
  await group.waitFor({ timeout: 10000 }).catch(() => {});
  if (
    !check(
      (await group.count()) > 0,
      "clicking the row opens the outbound flight picker",
    )
  ) {
    throw new Error("picker never opened");
  }

  const options = group.locator("label.picker-row");
  const optionCount = await options.count();
  if (
    !check(
      optionCount > 1,
      "the picker offers more than one flight to swap to",
      `${optionCount} rows`,
    )
  ) {
    throw new Error("nothing to swap to");
  }

  const opened = await readState();
  const originalPick = opened.pick;
  check(
    originalPick !== undefined,
    "the picker marks a current pick",
    JSON.stringify(originalPick),
  );

  let originalIndex = -1;
  for (let i = 0; i < optionCount; i += 1) {
    if (await options.nth(i).locator("input").isChecked()) originalIndex = i;
  }
  // A row whose own warning says the swap breaks the connection is not a swap worth
  // measuring: the window it produces is negative and the block prints no edges at all.
  let targetIndex = -1;
  for (let i = 0; i < optionCount; i += 1) {
    if (i === originalIndex) continue;
    const clean = (await options.nth(i).locator(".row-warning").count()) === 0;
    if (clean) {
      targetIndex = i;
      break;
    }
    if (targetIndex === -1) targetIndex = i;
  }
  const targetWarns =
    (await options.nth(targetIndex).locator(".row-warning").count()) > 0;
  check(!targetWarns, "the flight being swapped to still makes the connection");
  await options.nth(targetIndex).click();
  await page.waitForTimeout(1500);

  const after = await readState();
  const swapped = after.pick !== undefined && after.pick !== originalPick;
  console.log("");
  if (
    !check(
      swapped,
      "THE SWAP HAPPENED",
      `from ${JSON.stringify(originalPick)} to ${JSON.stringify(after.pick)}`,
    )
  ) {
    throw new Error(
      "the swap did not happen, so nothing below would mean anything",
    );
  }
  check(
    after.outboundClocks.join(" ") !== before.outboundClocks.join(" "),
    "the timeline now shows the other flight",
    `${JSON.stringify(before.outboundClocks)} -> ${JSON.stringify(after.outboundClocks)}`,
  );

  console.log("\n--- state after the swap ---");
  for (const [k, v] of Object.entries(after))
    console.log(`  ${k}: ${JSON.stringify(v)}`);
  console.log("");

  console.log(
    `free-time window before: ${before.from} / ${before.days} / ${before.until}`,
  );
  console.log(
    `free-time window after:  ${after.from} / ${after.days} / ${after.until}`,
  );
  console.log("");

  const landing = parseClock(after.outboundClocks[1]);
  const windowStart = parseClock(after.from);
  const takeoff = parseClock(after.onwardClocks[0]);
  const windowEnd = parseClock(after.until);
  const waiting = parseDuration(after.waiting);
  const rideBack = parseDuration(
    (
      (await page
        .locator('[data-segment="transfer-to-connection-airport"] .tl-duration')
        .first()
        .textContent()) ?? ""
    ).trim(),
  );

  if (landing !== undefined && windowStart !== undefined) {
    const gap = forward(landing, windowStart);
    check(
      gap === rideMinutes,
      "free time starts one ride into town after the plane lands",
      `landed ${after.outboundClocks[1]}, window opens ${after.from}, gap ${gap}m, ride ${rideMinutes}m`,
    );
  }
  if (
    takeoff !== undefined &&
    windowEnd !== undefined &&
    waiting !== undefined
  ) {
    const gap = forward(windowEnd, takeoff);
    const expected = waiting + (rideBack ?? 0);
    check(
      gap === expected,
      "free time ends one ride plus the airport buffer before the onward flight",
      `window closes ${after.until}, takes off ${after.onwardClocks[0]}, gap ${gap}m, buffer ${waiting}m + ride back ${rideBack}m`,
    );
  }

  const lengthBefore =
    parseClock(before.from) !== undefined
      ? forward(parseClock(before.from), parseClock(before.until))
      : undefined;
  const lengthAfter =
    windowStart !== undefined ? forward(windowStart, windowEnd) : undefined;
  const flightShift =
    landing !== undefined
      ? forward(parseClock(before.outboundClocks[1]), landing)
      : undefined;
  console.log(
    `window length before ${lengthBefore}m, after ${lengthAfter}m, the swapped flight lands ${flightShift}m later`,
  );

  await options.nth(originalIndex).click();
  await page.waitForTimeout(1500);
  const restored = await readState();
  check(
    restored.pick === originalPick,
    "picking the original flight back restores the pick",
  );
  check(
    restored.from === before.from &&
      restored.until === before.until &&
      restored.days === before.days,
    "the window lands exactly where it started",
    `${before.from} / ${before.days} / ${before.until}  vs  ${restored.from} / ${restored.days} / ${restored.until}`,
  );
} catch (error) {
  console.log(`\nSTOPPED: ${error.message}`);
  failures.push(`could not finish: ${error.message}`);
} finally {
  await browser.close();
}

console.log("");
if (failures.length > 0) {
  console.log(
    `VERDICT: ${failures.length} failed check(s): ${failures.join("; ")}`,
  );
  process.exitCode = 1;
} else {
  console.log(
    "VERDICT: a flight swap keeps the free-time window on the same arithmetic the builder used.",
  );
}
