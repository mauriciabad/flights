import { chromium } from '@playwright/test';

const origin = process.env.LAYOVER_ORIGIN ?? 'https://flights.mauri.app';
const query = process.argv[2] ?? 'Paris';

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });

const field = page.getByRole('combobox').first();
await field.waitFor({ timeout: 20000 });
const t0 = Date.now();
await field.fill(query);
console.log(`typed "${query}" at +${Date.now() - t0}ms after the field appeared`);

for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(250);
  const listbox = page.getByRole('listbox').first();
  const visible = await listbox.isVisible().catch(() => false);
  const opts = visible ? await listbox.getByRole('option').allInnerTexts() : [];
  const body = await page.evaluate(() => document.body.innerText);
  const hint = (body.match(/no (?:airports?|matches|results)[^\n]*/i) || [])[0];
  console.log(
    `+${String((i + 1) * 250).padStart(4)}ms  listbox:${visible ? 'open' : 'closed'}  options:${opts.length}` +
      (hint ? `  message:"${hint}"` : '') +
      (opts.length ? `  first:"${opts[0].replace(/\s+/g, ' ').trim()}"` : '')
  );
  if (opts.length) break;
}
await browser.close();
