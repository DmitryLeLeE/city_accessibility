// Мок Overpass: синтетический город — сетка улиц ~100 м, школы, поликлиники, аптеки, парки, здания, районы.
const DLAT = 0.0009, DLON = 0.0014;
const pos = (ix, iy) => ({ lat: iy * DLAT, lon: ix * DLON });
const nid = (ix, iy) => 1_000_000 + (ix + 10000) * 20000 + (iy + 10000);

function bboxOf(q) {
  const m = [...q.matchAll(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/g)].pop();
  return m.slice(1, 5).map(Number); // s, w, n, e
}

export function overpass(q) {
  const [s, w, n, e] = bboxOf(q);
  const ix0 = Math.floor(w / DLON) - 1, ix1 = Math.ceil(e / DLON) + 1, iy0 = Math.floor(s / DLAT) - 1, iy1 = Math.ceil(n / DLAT) + 1;
  const els = [];
  const inside = p => s <= p.lat && p.lat <= n && w <= p.lon && p.lon <= e;
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  if (q.includes('way["highway"]')) {
    for (const iy of range(iy0, iy1)) {
      els.push({ type: 'way', id: 2_000_000 + iy * 100000 + ix0, nodes: range(ix0, ix1).map(ix => nid(ix, iy)), tags: { highway: 'residential' }, geometry: range(ix0, ix1).map(ix => pos(ix, iy)) });
    }
    for (const ix of range(ix0, ix1)) {
      els.push({ type: 'way', id: 3_000_000 + ix * 100000 + iy0, nodes: range(iy0, iy1).map(iy => nid(ix, iy)), tags: { highway: ix % 7 === 0 ? 'footway' : 'residential' }, geometry: range(iy0, iy1).map(iy => pos(ix, iy)) });
    }
    return { elements: els };
  }
  if (q.includes('node["highway"~')) {
    for (const ix of range(ix0, ix1)) for (const iy of range(iy0, iy1)) {
      if (inside(pos(ix, iy)) && ix % 5 === 0 && iy % 5 === 0) els.push({ type: 'node', id: nid(ix, iy), tags: { highway: 'traffic_signals' } });
    }
    return { elements: els };
  }
  if (q.includes('way["building"]')) {
    for (const ix of range(ix0, ix1 - 1)) for (const iy of range(iy0, iy1 - 1)) {
      const p = pos(ix + 0.5, iy + 0.5);
      if (inside(p)) els.push({ type: 'way', id: 4_000_000 + (ix + 10000) * 20000 + (iy + 10000), center: p, tags: { building: (ix + iy) % 5 === 0 ? 'apartments' : 'yes', 'building:levels': String(1 + (((ix * 3 + iy) % 9) + 9) % 9) } });
    }
    return { elements: els };
  }
  if (q.includes('out tags center') && q.includes('amenity')) {
    const mod = (a, b) => ((a % b) + b) % b;
    for (const ix of range(ix0, ix1)) for (const iy of range(iy0, iy1)) {
      const p = pos(ix, iy);
      if (!inside(p)) continue;
      if (mod(ix, 20) === 3 && mod(iy, 20) === 5) els.push({ type: 'node', id: 5_000_000 + nid(ix, iy) % 999999, ...p, tags: { amenity: 'school', name: `Школа ${ix}-${iy}` } });
      if (mod(ix, 47) === 10 && mod(iy, 41) === 7) els.push({ type: 'node', id: 6_000_000 + nid(ix, iy) % 999999, ...p, tags: { amenity: 'clinic', name: `Поликлиника ${ix}` } });
      if (mod(ix, 33) === 5 && mod(iy, 29) === 9) els.push({ type: 'node', id: 7_000_000 + nid(ix, iy) % 999999, ...p, tags: { amenity: 'pharmacy' } });
      if (mod(ix, 30) === 12 && mod(iy, 30) === 12) {
        const ring = [pos(ix, iy), pos(ix + 4, iy), pos(ix + 4, iy + 4), pos(ix, iy + 4), pos(ix, iy)];
        els.push({ type: 'way', id: 8_000_000 + nid(ix, iy) % 999999, nodes: [1, 2, 3, 4, 1], tags: { leisure: 'park', name: `Парк ${ix}` }, geometry: ring });
      }
    }
    return { elements: els };
  }
  if (q.includes('out tags bb')) {
    for (let k = 0; k < 4; k++) {
      els.push({ type: 'relation', id: 900 + k, tags: { admin_level: '9', name: `Район ${k}` }, bounds: { minlat: s + Math.floor(k / 2) * (n - s) / 2, maxlat: s + (Math.floor(k / 2) + 1) * (n - s) / 2, minlon: w + (k % 2) * (e - w) / 2, maxlon: w + ((k % 2) + 1) * (e - w) / 2 } });
    }
    return { elements: els };
  }
  if (q.includes('admin_level"="')) {
    for (let k = 0; k < 4; k++) {
      const a = s + Math.floor(k / 2) * (n - s) / 2, b = s + (Math.floor(k / 2) + 1) * (n - s) / 2, c = w + (k % 2) * (e - w) / 2, d = w + ((k % 2) + 1) * (e - w) / 2;
      const ring = [{ lat: a, lon: c }, { lat: a, lon: d }, { lat: b, lon: d }, { lat: b, lon: c }, { lat: a, lon: c }];
      els.push({ type: 'relation', id: 900 + k, tags: { type: 'boundary', boundary: 'administrative', admin_level: '9', name: `Район ${k + 1}` }, members: [{ type: 'way', ref: 950 + k, role: 'outer', geometry: ring }] });
    }
    return { elements: els };
  }
  return { elements: [] };
}
