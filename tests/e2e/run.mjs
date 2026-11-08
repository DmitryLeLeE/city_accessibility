// e2e в настоящем браузере с мок-Overpass: npm run test:e2e
// CHROME_PATH — путь к установленному Chrome/Chromium (иначе берётся браузер Playwright).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { overpass } from './mock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/$/, '/index.html'));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }).end(fs.readFileSync(p));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const errors = [];
let passed = 0, failed = 0;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1400, height: 900 }, ...opts });
  const pg = await ctx.newPage();
  pg.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  pg.on('pageerror', e => errors.push('PAGEERROR ' + e));
  await pg.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith(BASE)) return r.continue();
    if (u.includes('tile.openstreetmap') || u.includes('arcgisonline')) return r.fulfill({ body: PNG, contentType: 'image/png' });
    if (u.includes('interpreter')) {
      const q = new URLSearchParams(r.request().postData()).get('data');
      return r.fulfill({ body: JSON.stringify(overpass(q)), contentType: 'application/json' });
    }
    return r.abort();
  });
  await pg.goto(BASE + 'index.html');
  await pg.waitForSelector('.leaflet-container');
  return pg;
}

async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); } catch (e) { failed++; console.log('  ✗', name, '\n   ', e.message.split('\n')[0]); }
}
const clickMap = async (pg, dx = 0, dy = 0) => {
  const b = await pg.locator('#map').boundingBox();
  await pg.mouse.click(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy);
};
const LONG = { timeout: 120000 };

const pg = await newPage();
console.log('Изохроны и маршрут');
await t('клик по карте → изохроны, таблица, журнал', async () => {
  await clickMap(pg);
  await pg.waitForSelector('#iso-result table', LONG);
  assert.ok((await pg.textContent('#log')).includes('граф'));
});
await t('маршрут до объекта с разбором', async () => {
  await pg.click('#iso-result details summary');
  await pg.click('#iso-result button[data-route]');
  await pg.waitForSelector('#route-box .route', { timeout: 10000 });
});
await t('пресет скорости меняет ползунок', async () => {
  await pg.selectOption('#preset', '3.6');
  await pg.waitForFunction(() => document.querySelector('#speed-out').textContent.includes('3,6'));
});
await t('расчёт по координатам и ссылка', async () => {
  await pg.fill('#from-q', '51.5004, 46.0006');
  await pg.click('#from-text button');
  await pg.waitForFunction(() => location.hash.includes('lat') || location.hash.length > 5, null, LONG);
});
await t('окно «Как считается» и сброс параметров', async () => {
  await pg.click('#open-method');
  await pg.waitForSelector('#method[open]');
  await pg.fill('input[data-arr="signalCycle"][data-i="5"]', '60');
  await pg.click('#params-apply');
  await pg.waitForTimeout(1500);
  await pg.click('#params-reset');
  await pg.keyboard.press('Escape');
});

console.log('Анализ области');
await pg.click('#t-area');
await pg.selectOption('#district-mode', 'auto');
await pg.click('#run-area');
await t('анализ: плитки, зоны, таблица районов', async () => {
  await pg.waitForSelector('#area-result .tiles', { timeout: 240000 });
  assert.ok(await pg.locator('#dist-table tbody tr').count() >= 2);
});
await t('сортировка, метрика, включение категории', async () => {
  await pg.click('#dist-table th[data-sort="name"]');
  await pg.selectOption('#metric', 'median');
  await pg.check('input[data-cat="pharmacy"]');
  await pg.waitForFunction(() => document.querySelectorAll('#dist-table thead th').length >= 5);
});

console.log('Что если, сохранение, печать');
await t('сценарий: виртуальная школа меняет показатели', async () => {
  await pg.selectOption('#wi-cat', 'school');
  await pg.click('#wi-arm');
  await clickMap(pg, 250, 150);
  await pg.waitForSelector('.wi-tiles', { timeout: 60000 });
  assert.equal(await pg.locator('.wi-list li').count(), 1);
  const idx = await pg.textContent('.wi-tiles .tile b');
  assert.ok(/[+−±]/.test(idx.trim()), idx);
  await pg.click('#wi-reset');
  await pg.waitForFunction(() => !document.querySelector('.wi-tiles'));
});
await t('сохранение расчётов и сравнение, CSV', async () => {
  await pg.fill('#sv-name', 'Тест А');
  await pg.click('#sv-add');
  await pg.fill('#sv-name', 'Тест Б');
  await pg.click('#sv-add');
  assert.equal(await pg.locator('table.saved tbody tr').count(), 3);
  const [dl] = await Promise.all([pg.waitForEvent('download'), pg.click('#sv-csv')]);
  assert.equal(dl.suggestedFilename(), 'comparison.csv');
  await pg.click('[data-sv-del]');
  assert.equal(await pg.locator('table.saved tbody tr').count(), 2);
});
await t('свои данные: GeoJSON с населением и объектами', async () => {
  const pop = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { pop: 900 }, geometry: { type: 'Point', coordinates: [0.0007, 0.0004] } },
    { type: 'Feature', properties: { pop: 100 }, geometry: { type: 'Point', coordinates: [0.002, 0.001] } }] };
  const own = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'Мой центр' }, geometry: { type: 'Point', coordinates: [0.0003, 0.0002] } }] };
  await pg.evaluate(() => { document.querySelector('#own-data').open = true; });
  await pg.setInputFiles('#file-pois', { name: 'own.geojson', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(own)) });
  await pg.waitForSelector('input[data-cat="custom"]');
  await pg.waitForSelector('#area-result .tiles');
  await pg.setInputFiles('#file-pop', { name: 'pop.geojson', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(pop)) });
  await pg.waitForFunction(() => document.querySelector('#own-status').textContent.includes('900') || document.querySelector('#own-status').textContent.includes('1'));
  assert.equal(await pg.inputValue('#weight-mode'), 'custom');
  await pg.click('#own-clear');
  await pg.waitForFunction(() => !document.querySelector('input[data-cat="custom"]'));
});
await t('печать: панель управления скрыта, карта и результаты на месте', async () => {
  await pg.emulateMedia({ media: 'print' });
  assert.equal(await pg.isVisible('#search'), false);
  assert.equal(await pg.isVisible('.tabs'), false);
  assert.equal(await pg.isVisible('#map'), true);
  assert.equal(await pg.isVisible('#area-result .tiles'), true);
  await pg.emulateMedia({ media: 'screen' });
});

console.log('Доступность и мобильная вёрстка');
const axeSrc = fs.readFileSync(path.join(ROOT, 'node_modules/axe-core/axe.min.js'), 'utf8');
await t('axe: нет серьёзных нарушений (интерфейс, результаты анализа)', async () => {
  await pg.evaluate(axeSrc);
  const res = await pg.evaluate(() => axe.run(document.querySelector('#panel'), { rules: { 'color-contrast': { enabled: true } } }));
  const bad = res.violations.filter(v => ['serious', 'critical'].includes(v.impact));
  assert.equal(bad.length, 0, bad.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).slice(0, 3).join(' | ')}`).join('; '));
});
await t('мобильный экран 390px: нет горизонтальной прокрутки, карта и панель видны', async () => {
  const m = await newPage({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });
  const o = await m.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, map: document.querySelector('#map').getBoundingClientRect().height, panel: document.querySelector('#panel').getBoundingClientRect().height }));
  assert.ok(o.sw <= o.cw + 1, `scrollWidth ${o.sw} > ${o.cw}`);
  assert.ok(o.map > 150 && o.panel > 150, JSON.stringify(o));
  await m.close();
});

console.log('Английский интерфейс');
await t('English: интерфейс без кириллицы после расчёта', async () => {
  const e = await newPage();
  await e.evaluate(() => localStorage.setItem('cityacc.lang', 'en'));
  await e.goto(BASE + 'index.html?x=2');
  await e.waitForSelector('.leaflet-container');
  await clickMap(e);
  await e.waitForSelector('#iso-result table', LONG);
  const txt = await e.innerText('#panel');
  const cyr = txt.match(/[А-Яа-яЁё]+/g) || [];
  // названия объектов из мока — данные, не интерфейс
  const bad = cyr.filter(w => !/^(Школа|Поликлиника|Парк|Район)$/.test(w));
  assert.equal(bad.length, 0, bad.slice(0, 5).join(','));
  await e.close();
});

await browser.close();
server.close();
const jsErr = errors.filter(e => !/Failed to load resource|net::ERR/.test(e));
console.log(`\nОшибки консоли: ${jsErr.length}`, jsErr.slice(0, 5));
console.log(`e2e: пройдено ${passed}, провалено ${failed}`);
process.exit(failed || jsErr.length ? 1 : 0);
