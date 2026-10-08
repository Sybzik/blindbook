// Screenshots of the real app for the README (docs/assets/screens), taken in headless Chrome
// against the development stack: `cargo run -p blindbook-api --features embedded-signer
// --example devserver` and `pnpm dev`. Usage: CHROME_PATH=... node scripts/screens.mjs
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'assets', 'screens');
mkdirSync(out, { recursive: true });
const origin = process.env.APP ?? 'http://127.0.0.1:5173';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

async function page(width, height, mobile = false) {
  const p = await browser.newPage();
  await p.setViewport({ width, height, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  return p;
}
const click = (p, text, sel = 'button, [role=tab], [role=menuitem], .bb-dicon') =>
  p.evaluate(
    (t, s) => {
      const el = [...document.querySelectorAll(s)].find((x) => x.textContent.replace(/\s+/g, ' ').includes(t));
      el?.click();
      return !!el;
    },
    text,
    sel,
  );
const shot = async (p, name) => {
  await p.screenshot({ path: join(out, name), type: 'jpeg', quality: 86 });
  console.log(name);
};

// Desktop.
const d = await page(1440, 900);
await d.goto(origin, { waitUntil: 'load' });
await wait(7000);
await shot(d, 'booth.jpg');
await click(d, 'STEP INSIDE');
await wait(7000);
await click(d, 'look around first');
await wait(800);
await click(d, 'MARKETS', '.bb-dicon');
await wait(1200);
await shot(d, 'markets.jpg');
await d.evaluate(() => [...document.querySelectorAll('.tk-row')].find((r) => /vs/.test(r.textContent))?.click());
await wait(2500);
await shot(d, 'market.jpg');
await click(d, 'VERIFY', '.bb-dicon');
await wait(800);
await click(d, 'RUN VERIFIER');
await wait(6000);
await shot(d, 'verify.jpg');
await click(d, 'NULLIFIER SNAKE', '.bb-dicon');
await wait(800);
await shot(d, 'backroom.jpg');

// Phone.
const m = await page(390, 844, true);
await m.goto(origin, { waitUntil: 'load' });
await wait(6000);
await click(m, 'STEP INSIDE');
await wait(7000);
await click(m, 'look around first');
await wait(800);
await m.evaluate(() => [...document.querySelectorAll('.tk-row')].find((r) => /vs/.test(r.textContent))?.click());
await wait(2500);
await shot(m, 'pager-market.jpg');
await click(m, 'MENU');
await wait(800);
await shot(m, 'pager-menu.jpg');

await browser.close();
