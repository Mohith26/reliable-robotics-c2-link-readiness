// Local geometry around Hollister Municipal (KCVH). Flat-earth ENU is accurate to <0.1% over the 30 km window.
// Runway/approach geometry is APPROXIMATE (straight-in finals on true runway headings), not charted procedures.

export const ORIGIN = { lat: 36.8932, lon: -121.4103, elev_m: 70 }; // KCVH ARP (approx.)
const R_E = 6378137;
const M_PER_DEG_LAT = Math.PI * R_E / 180;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos(ORIGIN.lat * Math.PI / 180);
export const NM = 1852;
export const FT = 0.3048;

export function latLonToEnu(lat, lon) {
  return { e: (lon - ORIGIN.lon) * M_PER_DEG_LON, n: (lat - ORIGIN.lat) * M_PER_DEG_LAT };
}
export function enuToLatLon(e, n) {
  return { lat: ORIGIN.lat + n / M_PER_DEG_LAT, lon: ORIGIN.lon + e / M_PER_DEG_LON };
}

const rad = d => d * Math.PI / 180;
const along = (p, hdg, d) => ({ e: p.e + Math.sin(rad(hdg)) * d, n: p.n + Math.cos(rad(hdg)) * d });

// C-Band ground radio station (GRS) on the field, mast height above ground.
export const GRS = { e: 250, n: 180, mast_m: 12, label: 'KCVH GRS' };
export const SAN_MARTIN = { ...latLonToEnu(37.0817, -121.5967), label: 'E16' };

const ARP = { e: 0, n: 0 };
// True headings (magnetic 130/060 + ~13 deg E variation). Half-lengths from the published runway lengths.
const RWY = {
  '13': { hdg: 143, thr: along(ARP, 143, -968) },
  '31': { hdg: 323, thr: along(ARP, 143, 968) },
  '06': { hdg: 73, thr: along(ARP, 73, -480) },
  '24': { hdg: 253, thr: along(ARP, 73, 480) },
};

export const APPROACHES = {
  'RNAV 13': { rwy: '13', flown: true },
  'RNAV 31': { rwy: '31', flown: true },
  'RNAV 06': { rwy: '06', flown: true },
  'RNAV 24': { rwy: '24', flown: false, notional: true },
};

/**
 * Per-second samples of one approach run: 10 NM straight-in final on a 3 deg path (capped at 4,000 ft MSL),
 * then a missed approach straight ahead climbing at 250 ft/NM to 3,000 ft for 5 NM.
 * Returns [{e, n, alt_m, seg}] with alt in metres MSL. jitter(rng) adds lateral wander for flown runs.
 */
export function approachPath(name, { gs_mps = 51.4, finalNm = 10, missedNm = 5, rng = null } = {}) {
  const r = RWY[APPROACHES[name].rwy];
  const pts = [];
  const finalLen = finalNm * NM, missedLen = missedNm * NM;
  let lat = 0, latV = 0;
  const step = () => { if (!rng) return 0; latV = 0.92 * latV + rng.normal() * 2.2; lat = 0.985 * lat + latV; return lat; };
  for (let d = finalLen; d >= 0; d -= gs_mps) {
    const p = along(r.thr, r.hdg, -d); const off = step();
    const q = along(p, r.hdg + 90, off);
    const alt = Math.min(ORIGIN.elev_m + 15 + d * Math.tan(rad(3)), 4000 * FT);
    pts.push({ e: q.e, n: q.n, alt_m: alt, seg: 'final', dthr_nm: d / NM });
  }
  for (let d = gs_mps; d <= missedLen; d += gs_mps * 1.1) {
    const p = along(r.thr, r.hdg, d); const off = step();
    const q = along(p, r.hdg + 90, off);
    const alt = Math.min(ORIGIN.elev_m + 60 + (d / NM) * 250 * FT, 3000 * FT);
    pts.push({ e: q.e, n: q.n, alt_m: alt, seg: 'missed', dthr_nm: -d / NM });
  }
  return pts;
}

/** Transit leg (straight line, constant altitude) sampled each second. */
export function transitPath(a, b, { gs_mps = 61.7, alt_m = 4000 * FT, rng = null } = {}) {
  const L = Math.hypot(b.e - a.e, b.n - a.n); const pts = [];
  let w = 0;
  for (let d = 0; d <= L; d += gs_mps) {
    const t = d / L; if (rng) w = 0.97 * w + rng.normal() * 6;
    const ux = (b.e - a.e) / L, uy = (b.n - a.n) / L;
    pts.push({ e: a.e + t * (b.e - a.e) - uy * w, n: a.n + t * (b.n - a.n) + ux * w, alt_m, seg: 'transit' });
  }
  return pts;
}

/** Start point of an approach (10 NM fix) and end of missed approach, for building transits. */
export function approachEnds(name, finalNm = 10, missedNm = 5) {
  const r = RWY[APPROACHES[name].rwy];
  return { start: along(r.thr, r.hdg, -finalNm * NM), end: along(r.thr, r.hdg, missedNm * NM), hdg: r.hdg };
}

export function runwayLines() {
  return [['13', '31'], ['06', '24']].map(([a, b]) => [RWY[a].thr, RWY[b].thr]);
}

// Square analysis cells.
export const CELL_M = 900;
export const cellKey = (e, n) => `${Math.floor(e / CELL_M)},${Math.floor(n / CELL_M)}`;
export const cellCenter = key => { const [i, j] = key.split(',').map(Number); return { e: (i + 0.5) * CELL_M, n: (j + 0.5) * CELL_M }; };
