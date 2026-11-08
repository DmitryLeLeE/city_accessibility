# Конфиденциальность и внешние запросы / Privacy and external requests

**RU.** City Accessibility — статическое приложение: у проекта нет своего сервера, аналитики, cookies и учётных записей. Все расчёты выполняются в вашем браузере (или в настольной версии). Но для работы приложение обращается к сторонним сервисам, и они видят ваш IP-адрес и содержимое запроса:

| Сервис | Когда | Что передаётся |
|---|---|---|
| Зеркала Overpass API: `overpass-api.de`, `lz4.overpass-api.de`, `overpass.kumi.systems`, `overpass.private.coffee`, `maps.mail.ru` | при расчёте | границы просматриваемой области (прямоугольники), запрос данных OSM |
| Плитки `tile.openstreetmap.org` | при показе карты | положение и масштаб карты |
| Плитки `server.arcgisonline.com` (Esri) | если выбрана подложка «Светлая (Esri)» | положение и масштаб карты |
| Геокодеры `nominatim.openstreetmap.org`, затем `photon.komoot.io` | при поиске по названию/адресу | текст запроса |

* Геолокация браузера запрашивается **только** по кнопке «Моё местоположение»; координаты используются для расчёта и в виде границ области уходят в Overpass.
* Загруженные вами GeoJSON-файлы (свои объекты, население) **не отправляются никуда** — читаются локально.
* В браузере сохраняются: параметры модели и язык (`localStorage`), сохранённые расчёты для сравнения (`localStorage`), кэш данных OSM на 7 дней (`IndexedDB`). Очистить можно в настройках сайта браузера; сохранённые расчёты — кнопкой «Очистить список».
* Ссылка «Скопировать ссылку» содержит координаты и параметры расчёта; делитесь ею осознанно.
* Данные карты © участники OpenStreetMap (ODbL). Политики использования сервисов: [Overpass](https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances), [Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/), [Nominatim Usage Policy](https://operations.osmfoundation.org/policies/nominatim/).
* Настольная версия (Electron) делает те же запросы, добавляя User-Agent приложения и Referer, как того требуют политики OSM.

**EN.** City Accessibility is a static app: the project has no server, analytics, cookies or accounts. All computation runs in your browser (or the desktop app). To work, it contacts third-party services that see your IP address and the request content:

| Service | When | What is sent |
|---|---|---|
| Overpass API mirrors: `overpass-api.de`, `lz4.overpass-api.de`, `overpass.kumi.systems`, `overpass.private.coffee`, `maps.mail.ru` | during calculation | bounding boxes of the viewed area, OSM data query |
| Tiles `tile.openstreetmap.org` | when the map is shown | map position and zoom |
| Tiles `server.arcgisonline.com` (Esri) | if the "Light (Esri)" basemap is chosen | map position and zoom |
| Geocoders `nominatim.openstreetmap.org`, then `photon.komoot.io` | when searching by name/address | the search text |

* Browser geolocation is requested **only** when you press the location button; the coordinates are used for the calculation and reach Overpass as an area bounding box.
* GeoJSON files you upload (custom facilities, population) are **never sent anywhere** — they are read locally.
* Stored in your browser: model parameters and language (`localStorage`), saved calculations (`localStorage`), a 7-day OSM data cache (`IndexedDB`). Clear them in the browser's site settings; saved calculations via "Clear list".
* The "Copy link" URL contains coordinates and calculation settings; share it deliberately.
* Map data © OpenStreetMap contributors (ODbL).
* The desktop (Electron) build makes the same requests, adding an app User-Agent and Referer as OSM policies require.
