// Геометрические утилиты без зависимостей (работают и в браузере, и в Node).

const R = 6371008.8;
const RAD = Math.PI / 180;

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Локальная равнопромежуточная проекция (метры) вокруг точки. */
export function makeProjector(lat0, lon0) {
  const ky = R * RAD, kx = R * RAD * Math.cos(lat0 * RAD);
  return {
    toXY: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLL: (x, y) => [lat0 + y / ky, lon0 + x / kx],
  };
}

export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygonCoords(lon, lat, rings) {
  if (!pointInRing(lon, lat, rings[0])) return false;
  for (let h = 1; h < rings.length; h++) if (pointInRing(lon, lat, rings[h])) return false;
  return true;
}

export function pointInGeometry(lon, lat, geom) {
  if (geom.type === 'Polygon') return pointInPolygonCoords(lon, lat, geom.coordinates);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some(p => pointInPolygonCoords(lon, lat, p));
  return false;
}

export function ringAreaSigned(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return s / 2;
}

/** [west, south, east, north] */
export function geometryBBox(geom) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) for (const [x, y] of poly[0]) {
    if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
  }
  return [w, s, e, n];
}

/** Площадь (Polygon/MultiPolygon, lon/lat) в м². */
export function geometryAreaM2(geom) {
  const [w, s, e, n] = geometryBBox(geom);
  const p = makeProjector((s + n) / 2, (w + e) / 2);
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  let total = 0;
  for (const poly of polys) {
    poly.forEach((ring, i) => {
      const a = Math.abs(ringAreaSigned(ring.map(([lo, la]) => p.toXY(la, lo))));
      total += i === 0 ? a : -a;
    });
  }
  return total;
}

/** Точки вдоль кольца [lon,lat] с шагом ~stepM (включая вершины). */
export function sampleRing(ring, stepM) {
  const out = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
    const d = haversine(y1, x1, y2, x2);
    const k = Math.max(1, Math.round(d / stepM));
    for (let j = 0; j < k; j++) out.push([x1 + ((x2 - x1) * j) / k, y1 + ((y2 - y1) * j) / k]);
  }
  return out;
}

export function bboxAround(lat, lon, radiusM) {
  const dLat = radiusM / (R * RAD);
  const dLon = radiusM / (R * RAD * Math.cos(lat * RAD));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

export function expandBBox([w, s, e, n], meters) {
  const lat = (s + n) / 2;
  const dLat = meters / (R * RAD);
  const dLon = meters / (R * RAD * Math.cos(lat * RAD));
  return [w - dLon, s - dLat, e + dLon, n + dLat];
}

export function bboxSpanKm([w, s, e, n]) {
  const lat = (s + n) / 2;
  return [haversine(lat, w, lat, e) / 1000, haversine(s, w, n, w) / 1000];
}
