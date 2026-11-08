// Картинка для соцсетей img/og.png (1200×630) из docs/img/isochrones.png: npm run og
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shot = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'docs/img/isochrones.png')).toString('base64');
const html = `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;display:flex;background:#fcfcfb;font-family:Inter,"Helvetica Neue",Arial,sans-serif;color:#0b0b0b;overflow:hidden}
.t{width:520px;padding:64px 48px;display:flex;flex-direction:column;justify-content:space-between}
h1{font-size:54px;line-height:1.05;letter-spacing:-.02em}
p{font-size:26px;line-height:1.3;color:#52514e;margin-top:20px}
.chips{display:flex;gap:10px}.chips span{padding:8px 16px;border-radius:999px;font-size:22px;font-weight:600;color:#fff}
small{font-size:20px;color:#66655f}
.m{flex:1;background:url(${shot}) -540px -150px/1440px auto no-repeat;border-left:1px solid #e4e3df}
</style><div class="t"><div><h1>City Accessibility</h1><p>Пешая доступность города: изохроны, больницы, школы, парки, проблемные зоны</p></div>
<div><div class="chips"><span style="background:#1c4f9c">5 мин</span><span style="background:#2f6fc0">10 мин</span><span style="background:#5b97e0">15 мин</span></div>
<small style="display:block;margin-top:18px">OpenStreetMap · в браузере, без регистрации</small></div></div><div class="m"></div>`;
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
const pg = await b.newPage({ viewport: { width: 1200, height: 630 } });
await pg.setContent(html);
await pg.screenshot({ path: path.join(ROOT, 'img/og.png') });
await b.close();
