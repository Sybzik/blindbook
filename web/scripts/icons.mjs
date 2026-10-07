// Render the app icons (PWA manifest, iPhone home screen) from public/favicon.svg with headless
// Chrome, so the icons are the pixel eye itself and no image tool is needed. Run once after the
// logo changes: CHROME_PATH=/path/to/chrome node scripts/icons.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const svg = readFileSync(join(pub, 'favicon.svg'), 'utf8');
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
// [file, size, padding fraction]: maskable icons keep the eye inside the 80% safe zone.
for (const [file, size, pad] of [
  ['icon-192.png', 192, 0],
  ['icon-512.png', 512, 0],
  ['icon-maskable-512.png', 512, 0.12],
  ['apple-touch-icon.png', 180, 0],
]) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  const inner = Math.round(size * (1 - 2 * pad));
  await page.setContent(
    `<html><body style="margin:0;background:#5CFF9D;display:grid;place-items:center;width:${size}px;height:${size}px">${svg.replace('width="16" height="16"', `width="${inner}" height="${inner}"`)}</body></html>`,
  );
  await page.screenshot({ path: join(pub, file), omitBackground: false });
  console.log(file);
}
await browser.close();
