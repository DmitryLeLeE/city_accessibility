// Десктопная оболочка: то же веб-приложение, отдаётся через собственный протокол app://
// (нужен для ES-модулей и IndexedDB). Все расчёты — локально, данные — из OpenStreetMap.
const { app, BrowserWindow, Menu, protocol, net, shell, session } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const SERVE = ['index.html', 'css', 'js', 'vendor']; // только эти пути доступны через app://
const UA = `CityAccessibility/${app.getVersion()} (https://github.com/DmitryLeLeE/city_accessibility)`;

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

function resolveAppUrl(requestUrl) {
  const u = new URL(requestUrl);
  let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
  const top = rel.split('/')[0];
  if (!SERVE.includes(top)) return null;
  const full = path.normalize(path.join(ROOT, rel));
  if (!full.startsWith(ROOT + path.sep)) return null; // защита от ../
  return pathToFileURL(full).toString();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    title: 'City Accessibility',
    backgroundColor: '#fcfcfb',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadURL('app://local/index.html');
  // внешние ссылки — в системном браузере
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  return win;
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const tpl = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'Файл', submenu: [isMac ? { role: 'close' } : { role: 'quit', label: 'Выход' }] },
    { label: 'Правка', submenu: [{ role: 'copy', label: 'Копировать' }, { role: 'paste', label: 'Вставить' }, { role: 'selectAll', label: 'Выделить всё' }] },
    { label: 'Вид', submenu: [
      { role: 'reload', label: 'Перезагрузить' }, { role: 'togglefullscreen', label: 'Полный экран' },
      { role: 'zoomIn', label: 'Увеличить' }, { role: 'zoomOut', label: 'Уменьшить' }, { role: 'resetZoom', label: 'Масштаб 100%' },
      { type: 'separator' }, { role: 'toggleDevTools', label: 'Инструменты разработчика' },
    ] },
    { label: 'Справка', submenu: [
      { label: 'Исходный код и методика на GitHub', click: () => shell.openExternal('https://github.com/DmitryLeLeE/city_accessibility') },
      { label: 'Данные © OpenStreetMap contributors', click: () => shell.openExternal('https://www.openstreetmap.org/copyright') },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

app.whenReady().then(() => {
  protocol.handle('app', req => {
    const target = resolveAppUrl(req.url);
    return target ? net.fetch(target) : new Response('Not found', { status: 404 });
  });
  // Политики OSM (тайлы, Nominatim) требуют идентифицирующий User-Agent и Referer.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://tile.openstreetmap.org/*', 'https://nominatim.openstreetmap.org/*', 'https://*.openstreetmap.org/*'] },
    (details, cb) => { details.requestHeaders['User-Agent'] = UA; details.requestHeaders['Referer'] = 'https://github.com/DmitryLeLeE/city_accessibility'; cb({ requestHeaders: details.requestHeaders }); });
  buildMenu();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
