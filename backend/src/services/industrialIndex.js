// Industrial proximity lookup service.
//
// Loads the static `industrial_sites` layer (populated once by
// scripts/fetch-industrial.js) into an in-memory KD-tree per category at boot.
// Runtime lookups are pure in-memory nearest-neighbor searches + haversine —
// zero network calls, zero disk I/O in the request path.
//
//   getIndustrialContext(lat, lon)
//     -> { refinery: {dist_km, name}|null, power_plant: {...}, mining: {...},
//         flare: {...}, oil_gas: {...}, steel: {...}, other_industrial: {...},
//         nearest: {category, dist_km, name}|null }
import { db } from '../db/geoCache.js';

// Earth radius for haversine (km).
const R = 6371;

// Category set recognized by the layer.
export const INDUSTRIAL_CATEGORIES = [
  'refinery',
  'power_plant',
  'steel',
  'mining',
  'flare',
  'oil_gas',
  'other_industrial',
];

// Load a KD-tree from a flat array of records. Build is recursive on the
// median so depth is O(log n) — safe for ~100k points.
class KDNode {
  constructor(point, left = null, right = null) {
    this.point = point;
    this.left = left;
    this.right = right;
  }
}

function kdBuild(pts, depth) {
  if (pts.length === 0) return null;
  const axis = depth % 2 === 0 ? 'lat' : 'lon';
  const axisIdx = axis === 'lat' ? 0 : 1;
  const sorted = [...pts];
  sorted.sort((a, b) => a.coord[axisIdx] - b.coord[axisIdx]);
  const mid = sorted.length >> 1;
  while (mid < sorted.length - 1 && sorted[mid + 1].coord[axisIdx] === sorted[mid].coord[axisIdx]) {
    // avoid split on duplicate axis values colliding with left subtree
    break;
  }
  return new KDNode(
    sorted[mid],
    kdBuild(sorted.slice(0, mid), depth + 1),
    kdBuild(sorted.slice(mid + 1), depth + 1),
  );
}

function sqDistLatLon(aLat, aLon, bLat, bLon) {
  const dLat = aLat - bLat;
  const dLon = aLon - bLon;
  return dLat * dLat + dLon * dLon;
}

// k-nearest-neighbour search on the KD-tree, returning up to `k` nodes sorted
// by squared latlon distance. Uses a simple branch-and-bound.
function kdKnn(searchLat, searchLon, k, node, depth) {
  if (!node) return [];
  const axis = depth % 2 === 0 ? 'lat' : 'lon';
  const sCoord = axis === 'lat' ? searchLat : searchLon;
  const nCoord = axis === 'lat' ? node.point.lat : node.point.lon;

  const nearestNode = sCoord < nCoord ? node.left : node.right;
  const farNode = nearestNode === node.left ? node.right : node.left;
  let best = kdKnn(searchLat, searchLon, k, nearestNode, depth + 1);

  const dist = sqDistLatLon(searchLat, searchLon, node.point.lat, node.point.lon);
  best.push({ node, dist });
  best.sort((a, b) => a.dist - b.dist);
  if (best.length > k) best.length = k;

  // If the splitting plane is closer than the kth best, the far subtree can
  // still contain better points.
  const planeDelta = sCoord - nCoord;
  const planeDistSq = planeDelta * planeDelta;
  const farthest = best[best.length - 1]?.dist ?? Infinity;
  if (farNode && planeDistSq < farthest) {
    const farBest = kdKnn(searchLat, searchLon, k, farNode, depth + 1);
    best = best.concat(farBest).sort((a, b) => a.dist - b.dist);
    if (best.length > k) best.length = k;
  }
  return best;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

class IndustrialIndex {
  constructor() {
    this.trees = {}; // category -> { root, size }
    this.built = false;
  }

  build() {
    const rows = db
      .prepare('SELECT lat, lon, category, name FROM industrial_sites')
      .all();
    const byCat = {};
    for (const r of rows) {
      (byCat[r.category] ||= []).push({
        lat: r.lat,
        lon: r.lon,
        name: r.name,
        coord: [r.lat, r.lon],
      });
    }
    for (const cat of INDUSTRIAL_CATEGORIES) {
      const pts = byCat[cat] || [];
      this.trees[cat] = { root: kdBuild(pts, 0), size: pts.length };
    }
    this.built = true;
    return { total: rows.length, byCategory: Object.fromEntries(INDUSTRIAL_CATEGORIES.map((c) => [c, this.trees[c].size])) };
  }

  // Nearest site of a single category within maxKm. Returns
  // { dist_km, name } or null.
  nearestInCategory(lat, lon, category, maxKm = 50) {
    const tree = this.trees[category];
    if (!tree || !tree.root) return null;
    const k = 5; // check a handful in case the first are coincident duplicates
    const hits = kdKnn(lat, lon, k, tree.root, 0);
    for (const h of hits) {
      const p = h.node.point;
      const d = haversineKm(lat, lon, p.lat, p.lon);
      if (d <= maxKm) {
        return { dist_km: Math.round(d * 100) / 100, name: p.name || null };
      }
    }
    return null;
  }

  // Full per-category context for a location.
  getIndustrialContext(lat, lon, maxKm = 50) {
    if (!this.built) this.build();
    const out = {};
    for (const cat of INDUSTRIAL_CATEGORIES) {
      out[cat] = this.nearestInCategory(lat, lon, cat, maxKm);
    }
    let nearest = null;
    for (const cat of INDUSTRIAL_CATEGORIES) {
      const hit = out[cat];
      if (hit && (!nearest || hit.dist_km < nearest.dist_km)) {
        nearest = { category: cat, dist_km: hit.dist_km, name: hit.name };
      }
    }
    out.nearest = nearest;
    return out;
  }
}

// Singleton shared across the process.
let _instance = null;
export function getIndustrialIndex() {
  if (!_instance) {
    _instance = new IndustrialIndex();
    _instance.build();
  }
  return _instance;
}
