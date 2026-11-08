// Скриншоты для README на синтетическом городе (мок Overpass): npm run screenshots
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { overpass } from './mock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'docs/img');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/$/, '/index.html'));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }).end(fs.readFileSync(p));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });

async function page(lang, opts = {}) {
  const ctx = await browser.newContext({ locale: lang === 'en' ? 'en-US' : 'ru-RU', viewport: { width: 1440, height: 860 }, ...opts });
  const pg = await ctx.newPage();
  await pg.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith(BASE)) return r.continue();
    if (u.includes('interpreter')) return r.fulfill({ body: JSON.stringify(overpass(new URLSearchParams(r.request().postData()).get('data'))), contentType: 'application/json' });
    return r.abort(); // плитки недоступны: фон карты остаётся пустым светлым
  });
  await pg.addInitScript(l => localStorage.setItem('cityacc.lang', l), lang);
  await pg.goto(BASE + 'index.html');
  await pg.waitForSelector('.leaflet-container');
  await pg.addStyleTag({ content: '#map{background:#eef0f2}' });
  return pg;
}
const click = async (pg, dx = 0, dy = 0) => { const b = await pg.locator('#map').boundingBox(); await pg.mouse.click(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy); };

for (const lang of ['ru', 'en']) {
  const sfx = lang === 'en' ? '-en' : '';
  const pg = await page(lang);
  await click(pg);
  await pg.waitForSelector('#iso-result table', { timeout: 120000 });
  await pg.waitForTimeout(500);
  await pg.screenshot({ path: `${OUT}/isochrones${sfx}.png` });
  await pg.click('#iso-result details summary');
  await pg.click('#iso-result button[data-route]');
  await pg.waitForSelector('#route-box .route');
  await pg.waitForTimeout(400);
  await pg.screenshot({ path: `${OUT}/route${sfx}.png` });
  await pg.click('#t-area');
  await pg.click('.leaflet-control-zoom-out');
  await pg.waitForTimeout(500);
  await pg.selectOption('#district-mode', 'auto');
  await pg.click('#run-area');
  await pg.waitForSelector('#area-result .tiles', { timeout: 240000 });
  await pg.waitForTimeout(800);
  await pg.screenshot({ path: `${OUT}/area${sfx}.png` });
  await pg.click('#wi-arm');
  await click(pg, -300, 180);
  await pg.waitForSelector('.wi-tiles', { timeout: 60000 });
  await pg.locator('.whatif').scrollIntoViewIfNeeded();
  await pg.waitForTimeout(400);
  await pg.screenshot({ path: `${OUT}/whatif${sfx}.png` });
  await pg.click('#open-method');
  await pg.waitForSelector('#method[open]');
  await pg.waitForTimeout(300);
  await pg.screenshot({ path: `${OUT}/method${sfx}.png` });
  await pg.context().close();
}
await browser.close();
server.close();
