// The production build, opened in headless Chrome: every request it makes must go to its own
// origin (THREAT_MODEL N5: no CDN, fonts, analytics or Polymarket from the browser), and the
// Content-Security-Policy must not have to block anything. Walks the landing, the boot, the desk
// and every window, then fails on the first stray request or CSP violation.
//
// Usage (after `pnpm build`): CHROME_PATH=/path/to/chrome node scripts/leakcheck.mjs
// A deployed app: APP=https://example.org CHROME_PATH=… node scripts/leakcheck.mjs. A mixnet
// build may also reach the mixnet client's bootstrap (Nym's directory over HTTPS, the entry
// gateway over WebSocket; THREAT_MODEL N5), and nothing else.

import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const chrome = process.env.CHROME_PATH;
if (!chrome) {
  console.error('set CHROME_PATH to a Chrome or chrome-headless-shell binary');
  process.exit(2);
}
const PORT = 4173;
const deployed = process.env.APP?.replace(/\/$/, '');
const origin = deployed ?? `http://127.0.0.1:${PORT}`;
const preview = deployed ? null : spawn('pnpm', ['exec', 'vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { shell: process.platform === 'win32', stdio: 'ignore' });
const bootstrap = (u) => !!deployed && (u.startsWith('https://validator.nymtech.net/') || u.startsWith('wss://'));
const stop = () => {
  if (!preview) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(preview.pid), '/T', '/F'], { shell: true });
    else preview.kill('SIGTERM');
  } catch {
    /* gone */
  }
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function up() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(origin)).ok) return;
    } catch {
      /* not yet */
    }
    await wait(500);
  }
  throw new Error('vite preview did not start');
}

const requests = [];
const violations = [];
const errors = [];
let failed = false;
try {
  await up();
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('request', (r) => requests.push(r.url()));
  page.on('console', (m) => {
    if (/Refused to|violates the following Content Security Policy/i.test(m.text())) violations.push(m.text());
    // API calls fail here (no API behind the preview): only code and integrity errors count.
    else if (m.type() === 'error' && !/^Failed to load resource: the server responded with a status of/.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.evaluateOnNewDocument(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.error(`Refused to load: CSP ${e.violatedDirective} ${e.blockedURI}`));
  });
  const click = (text, sel = 'button, [role=tab], [role=menuitem]') =>
    page.evaluate(
      (t, s) => {
        const el = [...document.querySelectorAll(s)].find((x) => x.textContent.replace(/\s+/g, ' ').includes(t));
        el?.click();
        return !!el;
      },
      text,
      sel,
    );

  await page.goto(origin, { waitUntil: 'load' });
  await wait(4000);
  await click('STEP INSIDE');
  await wait(7000);
  await click('look around first');
  await wait(500);
  if (!(await page.evaluate(() => document.querySelectorAll('.bb-dicon').length))) errors.push('the desk never appeared');
  // Every page and app on the desk: the desktop icons, then the START menu for the rest.
  for (const item of ['MARKETS', 'SLIPS', 'CAGE', 'VERIFY', 'HOW', 'NULLIFIER SNAKE', 'ODDS CALC', 'REDACT-A-TRACKER', 'DEAD DROP', 'BLOCK RADIO']) {
    if (!(await click(item, '.bb-dicon'))) console.warn(`icon not found: ${item}`);
    await wait(700);
  }
  for (const item of ['BLIND DUELS', 'WHAT WE KNOW', 'NOBODY PASS']) {
    await page.evaluate(() => document.querySelector('.bb-start')?.click());
    await wait(300);
    if (!(await click(item, '.bb-start__item'))) console.warn(`menu item not found: ${item}`);
    await wait(700);
  }
  await click('RUN VERIFIER');
  await wait(3000);
  // A proof link and a duel link arrive in an open tab.
  await page.evaluate(() => (location.hash = '#d=' + '0'.repeat(64)));
  await wait(1500);
  await browser.close();

  const stray = requests.filter((u) => !u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:') && !bootstrap(u));
  console.log(`${requests.length} requests, ${new Set(requests.map((u) => new URL(u, origin).pathname)).size} distinct paths`);
  if (stray.length) {
    failed = true;
    console.error('THIRD-PARTY REQUESTS:');
    for (const u of new Set(stray)) console.error('  ' + u);
  }
  if (violations.length) {
    failed = true;
    console.error('CSP VIOLATIONS:');
    for (const v of new Set(violations)) console.error('  ' + v);
  }
  if (errors.length) {
    failed = true;
    console.error('PAGE ERRORS:');
    for (const v of new Set(errors)) console.error('  ' + v);
  }
  if (!failed) console.log('LEAK CHECK OK: only same-origin requests, no CSP violations, no page errors');
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  stop();
}
process.exit(failed ? 1 : 0);
