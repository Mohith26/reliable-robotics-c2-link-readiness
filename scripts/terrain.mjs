// Builds data/terrain.json: a 200 m elevation grid around Hollister (KCVH) from the public
// AWS Terrain Tiles (Mapzen terrarium encoding, zoom 11). Run once: node scripts/terrain.mjs
// Tiles are fetched from https://s3.amazonaws.com/elevation-tiles-prod/terrarium/11/{x}/{y}.png
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { ORIGIN, enuToLatLon } from '../core/geo.js';

const Z = 11;
const here = path.dirname(new URL(import.meta.url).pathname);
const cacheDir = process.env.TILE_CACHE || '/tmp/rr/tiles';

function decodePNG(buf) {
  // Minimal PNG decoder: 8-bit RGB/RGBA, non-interlaced (what terrarium tiles use).
  let p = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') break;
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3; const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * bpp); const stride = w * bpp;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]; const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0; const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0; let v = row[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * stride + x] = v & 255;
    }
  }
  return { w, h, bpp, px: out };
}

async function tile(x, y) {
  const f = path.join(cacheDir, `t_${x}_${y}.png`);
  if (!fs.existsSync(f)) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${x}/${y}.png`);
    fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  }
  return decodePNG(fs.readFileSync(f));
}

const cache = new Map();
async function elevation(lat, lon) {
  const n = 2 ** Z; const fx = (lon + 180) / 360 * n; const r = lat * Math.PI / 180;
  const fy = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
  const tx = Math.floor(fx), ty = Math.floor(fy); const key = tx + ',' + ty;
  if (!cache.has(key)) cache.set(key, await tile(tx, ty));
  const t = cache.get(key); const px = Math.min(255, Math.floor((fx - tx) * 256)), py = Math.min(255, Math.floor((fy - ty) * 256));
  const i = (py * t.w + px) * t.bpp;
  return t.px[i] * 256 + t.px[i + 1] + t.px[i + 2] / 256 - 32768;
}

const RES = 200, HALF_E = 30000, HALF_N = 30000; // 60 x 60 km window centred on KCVH
const nx = Math.round(2 * HALF_E / RES) + 1, ny = Math.round(2 * HALF_N / RES) + 1;
const elev = [];
for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
  const { lat, lon } = enuToLatLon(-HALF_E + i * RES, -HALF_N + j * RES);
  elev.push(Math.round(await elevation(lat, lon)));
}
fs.writeFileSync(path.join(here, '..', 'data', 'terrain.json'), JSON.stringify({
  source: 'AWS Terrain Tiles (terrarium, z11), https://registry.opendata.aws/terrain-tiles/', origin: ORIGIN,
  res_m: RES, e0: -HALF_E, n0: -HALF_N, nx, ny, elev_m: elev,
}));
console.log('terrain grid', nx, 'x', ny, 'min', Math.min(...elev), 'max', Math.max(...elev));
