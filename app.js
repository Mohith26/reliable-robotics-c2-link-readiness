// C2 Link Readiness report. Every number on the page is computed here from data/campaign.json (packet logs)
// and data/terrain.json by the model in core/readiness.js.
import * as R from './core/readiness.js';
import { APPROACHES, approachPath, GRS, SAN_MARTIN, enuToLatLon, latLonToEnu, runwayLines, CELL_M } from './core/geo.js';
import { makeTerrain, diffractionDb } from './core/rf.js';
import { makeRng } from './core/rng.js';

const $ = s => document.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';
const pct = (v, d = 1) => (100 * v).toFixed(d) + '%';
const APPS = Object.keys(APPROACHES);
const MPL = { blue: '#1f77b4', orange: '#ff7f0e', green: '#2ca02c', red: '#d62728', purple: '#9467bd', gray: '#7f7f7f', cyan: '#17becf' };
const APP_COLOR = { 'RNAV 13': MPL.blue, 'RNAV 31': MPL.orange, 'RNAV 06': MPL.green, 'RNAV 24': MPL.purple };

const state = { req: 0.982, T: 3, approach: 'RNAV 13', layer: 'post' };
let camp, terrain, model, draws, zs, planned, designs, obs, upd, bt, preds, plans, terrainCheck, cellRates;

// ---------- report header (repeated on each page, as in the PDF reports) ----------
function headers(dateStr) {
  document.querySelectorAll('.head').forEach(h => {
    const n = $('#head-tpl').content.cloneNode(true);
    n.querySelector('.t-title').textContent = h.dataset.approach ? `C2 Link Readiness, ${state.approach}` : h.dataset.title;
    n.querySelector('.t-date').textContent = dateStr;
    h.replaceChildren(n);
  });
}

// ---------- small matplotlib-style SVG kit ----------
function el(tag, attrs = {}, parent) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
function niceTicks(lo, hi, n = 6) {
  const span = hi - lo, step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0) || 10 * mag;
  const out = []; for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}
function axes(svg, { x, y, w, h, xlim, ylim, xticks, yticks, xlabel, ylabel, xfmt = v => v, yfmt = v => v, ylog = false, grid = true, yticklabelsRight = false }) {
  const sx = v => x + (v - xlim[0]) / (xlim[1] - xlim[0]) * w;
  const ly = v => ylog ? Math.log10(v) : v;
  const sy = v => y + h - (ly(v) - ly(ylim[0])) / (ly(ylim[1]) - ly(ylim[0])) * h;
  const g = el('g', {}, svg);
  if (grid) {
    for (const t of xticks) el('line', { x1: sx(t), x2: sx(t), y1: y, y2: y + h, stroke: '#b0b0b0', 'stroke-opacity': 0.35, 'stroke-width': 0.8 }, g);
    for (const t of yticks) el('line', { x1: x, x2: x + w, y1: sy(t), y2: sy(t), stroke: '#b0b0b0', 'stroke-opacity': 0.35, 'stroke-width': 0.8 }, g);
  }
  const front = el('g', {}, svg);
  el('rect', { x, y, width: w, height: h, fill: 'none', stroke: '#000', 'stroke-width': 0.9 }, front);
  for (const t of xticks) { el('line', { x1: sx(t), x2: sx(t), y1: y + h, y2: y + h + 4, stroke: '#000', 'stroke-width': 0.9 }, front); const tx = el('text', { x: sx(t), y: y + h + 17, 'text-anchor': 'middle', 'font-size': 11.5 }, front); tx.textContent = xfmt(t); }
  for (const t of yticks) { el('line', { x1: x - 4, x2: x, y1: sy(t), y2: sy(t), stroke: '#000', 'stroke-width': 0.9 }, front); const ty = el('text', { x: x - 7, y: sy(t) + 4, 'text-anchor': 'end', 'font-size': 11.5 }, front); ty.textContent = yfmt(t); }
  if (xlabel) { const t = el('text', { x: x + w / 2, y: y + h + 36, 'text-anchor': 'middle', 'font-size': 13 }, front); t.textContent = xlabel; }
  if (ylabel) { const t = el('text', { x: 0, y: 0, 'text-anchor': 'middle', 'font-size': 12.5, transform: `translate(${x - 52},${y + h / 2}) rotate(-90)` }, front); t.textContent = ylabel; }
  return { sx, sy, g, front };
}
function legend(target, items, rows = 2) {
  const box = document.createElement('div'); box.className = 'box'; box.style.setProperty('--rows', rows);
  for (const it of items) {
    const d = document.createElement('div'); d.className = 'it';
    let sw = '';
    if (it.type === 'line') sw = `<svg viewBox="0 0 28 12"><line x1="1" y1="6" x2="27" y2="6" stroke="${it.color}" stroke-width="${it.width || 2}" ${it.dash ? `stroke-dasharray="${it.dash}"` : ''}/></svg>`;
    if (it.type === 'patch') sw = `<svg viewBox="0 0 28 12"><rect x="3" y="1" width="22" height="10" fill="${it.color}" fill-opacity="${it.alpha ?? 1}" stroke="${it.stroke || 'none'}"/></svg>`;
    if (it.type === 'dot') sw = `<svg viewBox="0 0 28 12"><circle cx="14" cy="6" r="3.3" fill="${it.color}"/></svg>`;
    if (it.type === 'marker') sw = `<svg viewBox="0 0 28 12">${it.svg}</svg>`;
    if (it.type === 'err') sw = `<svg viewBox="0 0 28 12"><line x1="3" y1="6" x2="25" y2="6" stroke="${it.color}" stroke-width="1.6"/><line x1="3" y1="2" x2="3" y2="10" stroke="${it.color}" stroke-width="1.6"/><line x1="25" y1="2" x2="25" y2="10" stroke="${it.color}" stroke-width="1.6"/><circle cx="14" cy="6" r="3" fill="${it.dotColor || it.color}"/></svg>`;
    d.innerHTML = sw + `<span>${it.label}</span>`; box.appendChild(d);
  }
  $(target).replaceChildren(box);
}
// matplotlib YlOrRd (9-class)
const YLORRD = ['#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#bd0026', '#800026'];
const PURPLES = ['#fcfbfd', '#efedf5', '#dadaeb', '#bcbddc', '#9e9ac8', '#807dba', '#6a51a3', '#54278f', '#3f007d'];
function cmap(stops, t) {
  t = Math.max(0, Math.min(1, t)) * (stops.length - 1); const i = Math.min(stops.length - 2, Math.floor(t)), f = t - i;
  const a = stops[i], b = stops[i + 1]; const c = k => Math.round(parseInt(a.slice(1 + 2 * k, 3 + 2 * k), 16) * (1 - f) + parseInt(b.slice(1 + 2 * k, 3 + 2 * k), 16) * f);
  return `rgb(${c(0)},${c(1)},${c(2)})`;
}

// ---------- computation ----------
function computeAll() {
  planned = Object.fromEntries(APPS.map(a => [a, approachPath(a)]));
  model = R.buildModel(camp, planned);
  zs = R.makeZ(model.fit.P, 400, makeRng(1));
  draws = R.drawFromZ(model.fit.theta, model.fit.L, model.fit.P, zs);
  designs = Object.fromEntries(APPS.map(a => [a, R.pathDesign(planned[a], model.cells)]));
  upd = R.updateEffect(model);
  // observed
  const pps = camp.packets_per_s;
  const dayC = camp.days.map(d => R.continuity(d.samples, pps));
  const runs = camp.days.flatMap(d => d.runs.map(r => ({ ...r, date: d.date, post: d.post, cont: R.continuity(d.samples, pps, r.i0, r.i1) })));
  const secs = camp.days.reduce((a, d) => a + d.samples.length, 0);
  obs = { dayC, runs, secs, meanDays: dayC.reduce((a, b) => a + b, 0) / dayC.length, last3: dayC.slice(-3).reduce((a, b) => a + b, 0) / 3 };
  // terrain line-of-sight check on all finals
  const elevAt = makeTerrain(terrain); const gElev = elevAt(GRS.e, GRS.n); let worst = 0, worstV = -Infinity;
  for (const a of APPS) for (const p of planned[a]) { const db = diffractionDb(elevAt, GRS, gElev, p); worst = Math.max(worst, db); }
  terrainCheck = { worstDb: worst };
  // per-cell typical-day rates for the map
  const D = model.fit.D;
  cellRates = model.cells.list.map((k, ci) => {
    const c = model.cells.centers[ci]; const xr = R.logRange(c.e, c.n);
    const q = era => { const v = draws.map(t => 60 * Math.exp(t[0] + t[1] * xr + t[2] * (era === 'post' ? 1 : 0) + t[3 + D + ci])); return { med: R.quant(v, 0.5), lo: R.quant(v, 0.05), hi: R.quant(v, 0.95) }; };
    let E = 0, N = 0; for (const u of model.data.units) if (u.c === ci) { E += u.E; N += u.N; }
    return { ci, c, post: q('post'), pre: q('pre'), E, N };
  });
  bt = R.backtest(camp, planned, model);
  computePredictions();
}
function computePredictions() {
  preds = Object.fromEntries(APPS.map((a, i) => [a, R.predictPath(model, designs[a], { post: true, req: state.req, outageT: state.T, draws, seed: 100 + i })]));
  plans = Object.fromEntries(APPS.map(a => [a, R.characterizationPlan(model, designs[a], { req: state.req, zs })]));
}

// ---------- page 1 ----------
function renderMetrics() {
  const fit = model.fit; const anomalies = camp.days.map((d, i) => ({ d, w: R.dayWeight(fit.theta[3 + i], fit.sigmaDay), g: fit.theta[3 + i] })).filter(x => x.w < 0.5);
  const btCov = bt.filter(b => b.covered).length; const anomDates = new Set(anomalies.map(a => a.d.date));
  const btClean = bt.filter(b => !anomDates.has(b.date)); const btCleanCov = btClean.filter(b => b.covered).length;
  const rows = [
    ['Data Source', 'Synthetic packet logs, 2 packets/s <span class="sub">(seeded)</span>'],
    ['Ground Station', 'KCVH C-Band GRS <span class="sub">(single station)</span>'],
    ['Test Days', `${camp.days.length} <span class="sub">(radio software update after ${camp.update_after})</span>`],
    ['Flight Time / Packets', `${(obs.secs / 3600).toFixed(1)} h / ${(obs.secs * camp.packets_per_s).toLocaleString()} / ${obs.runs.length} runs`],
    ['Observed Continuity (mean of days)', pct(obs.meanDays)],
    ['Observed Continuity (final three days)', pct(obs.last3)],
    ['Continuity Requirement (derived)', `<input class="ctl" id="req" type="number" step="0.1" min="90" max="99.9" value="${(state.req * 100).toFixed(1)}"> %`],
    ['Outage Threshold (traffic drops off display)', `<select class="ctl" id="thr">${[1, 2, 3, 5].map(t => `<option value="${t}" ${t === state.T ? 'selected' : ''}>${t} s</option>`).join('')}</select>`],
    ['Update Effect on Dropout Rate', `${upd.ratio.toFixed(2)}x <span class="sub">(90% CI ${upd.lo.toFixed(2)} to ${upd.hi.toFixed(2)}; naive ${upd.naiveRatio.toFixed(2)}x)</span>`],
    ['Anomalous Days (down-weighted)', anomalies.length ? anomalies.map(a => `${a.d.date} <span class="sub">(weight ${a.w.toFixed(2)})</span>`).join(', ') : 'None'],
    ['Terrain Clearance on Finals', terrainCheck.worstDb === 0 ? `Line of sight <span class="sub">(0.0 dB knife-edge loss, all finals)</span>` : `${terrainCheck.worstDb.toFixed(1)} dB worst-case diffraction`],
    ['Approach Verdicts, RNAV (post-update)', APPS.map(a => `<span class="${vcls(preds[a].verdict)}">${a.slice(5)} ${preds[a].verdict}</span>`).join(' &middot; ')],
    ['Backtest (leave one day out, 90%)', `${btCov}/${bt.length} runs covered <span class="sub">(${btCleanCov}/${btClean.length} excl. anomalous day)</span>`],
  ];
  $('#metrics').innerHTML = '<tbody>' + rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('') + '</tbody>';
  $('#req').addEventListener('change', e => { const v = parseFloat(e.target.value); if (v > 80 && v < 100) { state.req = v / 100; refresh(); } });
  $('#thr').addEventListener('change', e => { state.T = +e.target.value; refresh(); });
}
const vcls = v => v === 'Ready' ? 'v-ready' : v === 'Not ready' ? 'v-not' : 'v-inc';

// map projection (web mercator), axes in lon/lat like the report's 2D Top-Down Plot
const MAP = { W: 938, H: 880, ax: { x: 70, y: 8, w: 785, h: 820 } };
const ext = (() => { const a = enuToLatLon(-21000, -19000), b = enuToLatLon(19500, 23000); return { lon0: a.lon, lon1: b.lon, lat0: a.lat, lat1: b.lat }; })();
const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
function proj(lat, lon) {
  const { x, y, w, h } = MAP.ax;
  return { X: x + (lon - ext.lon0) / (ext.lon1 - ext.lon0) * w, Y: y + h - (mercY(lat) - mercY(ext.lat0)) / (mercY(ext.lat1) - mercY(ext.lat0)) * h };
}
const projE = (e, n) => { const ll = enuToLatLon(e, n); return proj(ll.lat, ll.lon); };
let mapCanvas, mapCtx, tiles = [];
function setupMap() {
  const host = $('#map'); const dpr = window.devicePixelRatio || 1;
  mapCanvas = document.createElement('canvas'); mapCanvas.width = MAP.W * dpr; mapCanvas.height = MAP.H * dpr; mapCanvas.style.width = MAP.W + 'px'; mapCanvas.style.height = MAP.H + 'px';
  host.prepend(mapCanvas); mapCtx = mapCanvas.getContext('2d'); mapCtx.scale(dpr, dpr);
  const z = 12, n = 2 ** z;
  const tx = lon => (lon + 180) / 360 * n, ty = lat => (1 - mercY(lat) / Math.PI) / 2 * n;
  for (let x = Math.floor(tx(ext.lon0)); x <= Math.floor(tx(ext.lon1)); x++) for (let y = Math.floor(ty(ext.lat1)); y <= Math.floor(ty(ext.lat0)); y++) {
    const lon = v => v / n * 360 - 180, lat = v => Math.atan(Math.sinh(Math.PI * (1 - 2 * v / n))) * 180 / Math.PI;
    for (const layer of ['World_Light_Gray_Base', 'World_Light_Gray_Reference']) {
      const img = new Image(); img.src = `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${layer}/MapServer/tile/${z}/${y}/${x}`;
      const t = { img, a: proj(lat(y), lon(x)), b: proj(lat(y + 1), lon(x + 1)), ok: false, ref: layer.endsWith('Reference') };
      img.onload = () => { t.ok = true; drawMap(); };
      tiles.push(t);
    }
  }
  host.addEventListener('mousemove', mapHover); host.addEventListener('mouseleave', () => { $('#tip').style.display = 'none'; });
}
function drawMap() {
  const c = mapCtx; const { x, y, w, h } = MAP.ax;
  c.clearRect(0, 0, MAP.W, MAP.H); c.fillStyle = '#fff'; c.fillRect(0, 0, MAP.W, MAP.H);
  c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip();
  c.fillStyle = '#eff6ef'; c.fillRect(x, y, w, h); c.globalAlpha = 0.5; for (const t of tiles) if (t.ok && !t.ref) c.drawImage(t.img, t.a.X, t.a.Y, t.b.X - t.a.X + 0.5, t.b.Y - t.a.Y + 0.5); c.globalAlpha = 1;
  // gridlines (seaborn-whitegrid look)
  c.strokeStyle = 'rgba(160,160,160,0.45)'; c.lineWidth = 0.8;
  for (const lon of lonTicks()) { const p = proj(ext.lat0, lon); c.beginPath(); c.moveTo(p.X, y); c.lineTo(p.X, y + h); c.stroke(); }
  for (const lat of latTicks()) { const p = proj(lat, ext.lon0); c.beginPath(); c.moveTo(x, p.Y); c.lineTo(x + w, p.Y); c.stroke(); }
  // cell layer
  if (state.layer !== 'none') {
    const vals = cellRates.map(r => state.layer === 'unc' ? r.post.hi / r.post.lo : r[state.layer].med);
    const [vmin, vmax] = layerRange();
    cellRates.forEach((r, i) => {
      const k = model.cells.list[r.ci].split(',').map(Number);
      const a = projE(k[0] * CELL_M, (k[1] + 1) * CELL_M), b = projE((k[0] + 1) * CELL_M, k[1] * CELL_M);
      const tval = state.layer === 'unc' ? Math.log(vals[i] / vmin) / Math.log(vmax / vmin) : Math.log(vals[i] / vmin) / Math.log(vmax / vmin);
      c.fillStyle = cmap(state.layer === 'unc' ? PURPLES : YLORRD, tval); c.globalAlpha = r.E > 0 ? 0.62 : 0.4;
      c.fillRect(a.X, a.Y, b.X - a.X, b.Y - a.Y);
    });
    c.globalAlpha = 1;
  }
  for (const t of tiles) if (t.ok && t.ref) c.drawImage(t.img, t.a.X, t.a.Y, t.b.X - t.a.X + 0.5, t.b.Y - t.a.Y + 0.5);
  // packet status (every flown second)
  for (const pass of [0, 1]) {
    for (const d of camp.days) for (const s of d.samples) {
      const lost = (s[3] & 1) + ((s[3] >> 1) & 1); if ((lost > 0) !== (pass === 1)) continue;
      const p = projE(s[0], s[1]); c.fillStyle = pass ? 'rgba(220,20,60,0.85)' : 'rgba(46,139,87,0.32)';
      c.beginPath(); c.arc(p.X, p.Y, pass ? 1.6 : 1.05, 0, 6.283); c.fill();
    }
  }
  // planned approach centerlines and labels
  for (const a of APPS) {
    const pts = planned[a]; c.strokeStyle = APP_COLOR[a]; c.lineWidth = 1.6; c.setLineDash(APPROACHES[a].notional ? [6, 4] : []);
    c.beginPath(); pts.forEach((p, i) => { const q = projE(p.e, p.n); i ? c.lineTo(q.X, q.Y) : c.moveTo(q.X, q.Y); }); c.stroke(); c.setLineDash([]);
    const s = projE(pts[0].e, pts[0].n); c.fillStyle = '#000'; c.font = '11px "DejaVu Sans"'; c.textAlign = s.X > MAP.ax.x + MAP.ax.w - 80 ? 'right' : 'center';
    c.fillText(a + (APPROACHES[a].notional ? ' (notional)' : ''), s.X, s.Y - 9);
    c.fillStyle = APP_COLOR[a]; c.beginPath(); c.moveTo(s.X, s.Y - 5); c.lineTo(s.X - 5, s.Y + 4); c.lineTo(s.X + 5, s.Y + 4); c.closePath(); c.fill(); c.strokeStyle = '#333'; c.lineWidth = 0.7; c.stroke();
  }
  // runways, GRS, E16
  c.strokeStyle = '#222'; c.lineWidth = 3; for (const [p1, p2] of runwayLines()) { const a = projE(p1.e, p1.n), b = projE(p2.e, p2.n); c.beginPath(); c.moveTo(a.X, a.Y); c.lineTo(b.X, b.Y); c.stroke(); }
  const g = projE(GRS.e, GRS.n); c.fillStyle = '#000'; c.beginPath(); c.moveTo(g.X, g.Y - 7); c.lineTo(g.X - 6, g.Y + 4); c.lineTo(g.X + 6, g.Y + 4); c.closePath(); c.fill();
  c.font = '11px "DejaVu Sans"'; c.textAlign = 'left'; c.fillText('KCVH GRS', g.X + 9, g.Y + 4);
  const m = projE(SAN_MARTIN.e, SAN_MARTIN.n); c.strokeStyle = '#000'; c.lineWidth = 1.6; c.beginPath(); c.moveTo(m.X - 5, m.Y - 5); c.lineTo(m.X + 5, m.Y + 5); c.moveTo(m.X + 5, m.Y - 5); c.lineTo(m.X - 5, m.Y + 5); c.stroke();
  c.fillText('E16', m.X + 8, m.Y + 4);
  c.font = '9px "DejaVu Sans"'; c.fillStyle = '#555'; c.fillText('Basemap: Esri, HERE, Garmin, (C) OpenStreetMap contributors', x + 5, y + h - 6);
  c.restore();
  // axes frame + ticks
  c.strokeStyle = '#000'; c.lineWidth = 0.9; c.strokeRect(x, y, w, h); c.fillStyle = '#000'; c.font = '11.5px "DejaVu Sans"';
  c.textAlign = 'center'; for (const lon of lonTicks()) { const p = proj(ext.lat0, lon); c.beginPath(); c.moveTo(p.X, y + h); c.lineTo(p.X, y + h + 4); c.stroke(); c.fillText(lon.toFixed(2).replace('-', '\u2212'), p.X, y + h + 17); }
  c.textAlign = 'right'; for (const lat of latTicks()) { const p = proj(lat, ext.lon0); c.beginPath(); c.moveTo(x - 4, p.Y); c.lineTo(x, p.Y); c.stroke(); c.fillText(lat.toFixed(2), x - 7, p.Y + 4); }
  c.font = '13px "DejaVu Sans"'; c.textAlign = 'center'; c.fillText('Longitude', x + w / 2, y + h + 36);
  c.save(); c.translate(x - 54, y + h / 2); c.rotate(-Math.PI / 2); c.fillText('Latitude', 0, 0); c.restore();
  drawColorbar();
}
function layerRange() {
  if (state.layer === 'unc') { const v = cellRates.map(r => r.post.hi / r.post.lo); return [Math.max(1.01, Math.min(...v)), Math.max(...v)]; }
  const v = cellRates.flatMap(r => [r.post.med, r.pre.med]); return [Math.min(...v), Math.max(...v)];
}
function drawColorbar() {
  if (state.layer === 'none') return;
  const c = mapCtx; const x = MAP.ax.x + MAP.ax.w + 14, y = MAP.ax.y + 150, w = 16, h = 600; const [vmin, vmax] = layerRange();
  for (let i = 0; i < h; i++) { c.fillStyle = cmap(state.layer === 'unc' ? PURPLES : YLORRD, 1 - i / h); c.fillRect(x, y + i, w, 1.2); }
  c.strokeStyle = '#000'; c.lineWidth = 0.8; c.strokeRect(x, y, w, h);
  c.fillStyle = '#000'; c.font = '10.5px "DejaVu Sans"'; c.textAlign = 'left';
  const ticks = []; for (let e = Math.floor(Math.log10(vmin)); e <= Math.ceil(Math.log10(vmax)); e++) for (const m of [1, 2, 5]) { const v = m * 10 ** e; if (v >= vmin && v <= vmax) ticks.push(v); }
  for (const v of ticks) { const yy = y + h - Math.log(v / vmin) / Math.log(vmax / vmin) * h; c.beginPath(); c.moveTo(x + w, yy); c.lineTo(x + w + 3, yy); c.stroke(); c.fillText(v >= 1 ? v.toFixed(0) : v.toPrecision(1), x + w + 5, yy + 3.5); }
  c.save(); c.translate(x + w + 46, y + h / 2); c.rotate(-Math.PI / 2); c.textAlign = 'center'; c.font = '11.5px "DejaVu Sans"';
  c.fillText(state.layer === 'unc' ? '90% interval ratio (high / low)' : 'Dropout onsets per minute (typical day)', 0, 0); c.restore();
}
const lonTicks = () => niceTicks(ext.lon0, ext.lon1, 6).filter(v => v > ext.lon0 && v < ext.lon1);
const latTicks = () => niceTicks(ext.lat0, ext.lat1, 7).filter(v => v > ext.lat0 && v < ext.lat1);
function mapHover(ev) {
  const r = mapCanvas.getBoundingClientRect(); const X = ev.clientX - r.left, Y = ev.clientY - r.top; const tip = $('#tip');
  const best = cellRates.find(cr => { const k = model.cells.list[cr.ci].split(',').map(Number); const a = projE(k[0] * CELL_M, (k[1] + 1) * CELL_M), b = projE((k[0] + 1) * CELL_M, k[1] * CELL_M); return X >= a.X && X <= b.X && Y >= a.Y && Y <= b.Y; });
  if (!best || state.layer === 'none') { tip.style.display = 'none'; return; }
  const ll = enuToLatLon(best.c.e, best.c.n);
  tip.innerHTML = `Cell ${ll.lat.toFixed(3)}, ${ll.lon.toFixed(3)}<br>Post-update: ${best.post.med.toFixed(2)}/min (90% ${best.post.lo.toFixed(2)} to ${best.post.hi.toFixed(2)})<br>Pre-update: ${best.pre.med.toFixed(2)}/min<br>Flown: ${best.E.toLocaleString()} s, ${best.N} dropout onsets`;
  tip.style.display = 'block'; tip.style.left = Math.min(X + 14, MAP.W - 320) + 'px'; tip.style.top = (Y + 14) + 'px';
}
function mapLegend() {
  legend('#map-legend', [
    { type: 'dot', color: 'rgba(46,139,87,0.75)', label: 'Packet Received' },
    { type: 'dot', color: '#dc143c', label: 'Packet Lost' },
    { type: 'line', color: MPL.blue, label: 'RNAV 13 final + missed (planned)' },
    { type: 'line', color: MPL.orange, label: 'RNAV 31 final + missed (planned)' },
    { type: 'line', color: MPL.green, label: 'RNAV 06 final + missed (planned)' },
    { type: 'line', color: MPL.purple, dash: '5,3', label: 'RNAV 24 (notional, never flown)' },
    { type: 'patch', color: '#fd8d3c', alpha: 0.62, label: `Analysis cell (${CELL_M} m), flown` },
    { type: 'patch', color: '#fd8d3c', alpha: 0.35, label: 'Analysis cell, planned only' },
    { type: 'marker', svg: '<path d="M14 1 L8 11 L20 11 Z" fill="#000"/>', label: 'C-Band ground station' },
    { type: 'marker', svg: '<path d="M9 1 L19 11 M19 1 L9 11" stroke="#000" stroke-width="1.6"/>', label: 'San Martin (E16)' },
  ], 3);
}

// ---------- page 2 ----------
function renderApproachTable() {
  const rows = APPS.map(a => {
    const p = preds[a]; const rs = obs.runs.filter(r => r.approach === a); const pre = rs.filter(r => !r.post), post = rs.filter(r => r.post);
    const m = arr => arr.length ? pct(arr.reduce((s, r) => s + r.cont, 0) / arr.length) : '–';
    return `<tr data-a="${a}" class="${a === state.approach ? 'sel' : ''}"><td>${a}${APPROACHES[a].notional ? '*' : ''}</td><td class="num">${pre.length} / ${post.length}</td><td class="num">${m(pre)} / ${m(post)}</td><td class="num">${pct(p.median)}</td><td class="num">${pct(p.lo)} to ${pct(p.hi)}</td><td class="num">${pct(p.pMeet, 0)}</td><td class="num">${pct(p.runMeet, 0)}</td><td class="num">${pct(p.runLongOutage, 0)}</td><td class="${vcls(p.verdict)}">${p.verdict}</td></tr>`;
  }).join('');
  $('#approach-table').innerHTML = `<thead><tr><th>Approach</th><th class="num">Runs Flown<br>pre / post</th><th class="num">Observed<br>pre / post</th><th class="num">Predicted<br>Continuity</th><th class="num">90%<br>Interval</th><th class="num">P(meets<br>${pct(state.req)})</th><th class="num">Single Run<br>P(meets)</th><th class="num">Single Run<br>P(outage ≥ ${state.T} s)</th><th>Verdict</th></tr></thead><tbody>${rows}</tbody>`;
  $('#approach-table').insertAdjacentHTML('beforeend', ''); $('#approach-table').querySelectorAll('tbody tr').forEach(tr => tr.addEventListener('click', () => { state.approach = tr.dataset.a; refresh(false); }));
}
function renderCiPlot() {
  const host = $('#ci-plot'); host.replaceChildren(); const W = 938, H = 230;
  const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` }); host.appendChild(svg);
  const lo = Math.min(...APPS.map(a => preds[a].lo), state.req) - 0.004, hi = Math.min(1, Math.max(...APPS.map(a => preds[a].hi)) + 0.003);
  const xt = niceTicks(lo * 100, hi * 100, 8);
  const A = axes(svg, { x: 110, y: 8, w: 800, h: 180, xlim: [lo * 100, hi * 100], ylim: [0, APPS.length], xticks: xt, yticks: [], xlabel: 'Predicted Packet Continuity, typical post-update day (%)', xfmt: v => v.toFixed(1) });
  el('line', { x1: A.sx(state.req * 100), x2: A.sx(state.req * 100), y1: 8, y2: 188, stroke: MPL.red, 'stroke-dasharray': '6,4', 'stroke-width': 1.4 }, A.front);
  APPS.forEach((a, i) => {
    const p = preds[a]; const yy = A.sy(APPS.length - i - 0.5); const col = APP_COLOR[a];
    el('line', { x1: A.sx(p.lo * 100), x2: A.sx(p.hi * 100), y1: yy, y2: yy, stroke: col, 'stroke-width': 2 }, A.front);
    for (const v of [p.lo, p.hi]) el('line', { x1: A.sx(v * 100), x2: A.sx(v * 100), y1: yy - 7, y2: yy + 7, stroke: col, 'stroke-width': 2 }, A.front);
    el('circle', { cx: A.sx(p.median * 100), cy: yy, r: 5, fill: col, stroke: '#000', 'stroke-width': 0.6 }, A.front);
    const rs = obs.runs.filter(r => r.approach === a && r.post);
    for (const r of rs) if (r.cont * 100 >= lo * 100 && r.cont * 100 <= hi * 100) el('path', { d: `M${A.sx(r.cont * 100)} ${yy - 14} l-3.5 -6 h7 z`, fill: '#555' }, A.front);
    const t = el('text', { x: 102, y: yy + 4, 'text-anchor': 'end', 'font-size': 12 }, A.front); t.textContent = a;
  });
  legend('#ci-legend', [
    { type: 'err', color: '#444', label: 'Median and 90% interval (parameter uncertainty)' },
    { type: 'marker', svg: '<path d="M14 9 l-4 -7 h8 z" fill="#555"/>', label: 'Observed post-update runs' },
    { type: 'line', color: MPL.red, dash: '6,4', label: `Derived requirement (${pct(state.req)})` },
  ]);
}
function renderAlong() {
  const a = state.approach; const des = designs[a]; const path = planned[a]; const host = $('#along-plot'); host.replaceChildren();
  $('#along-label').textContent = `${a}: distance to threshold, final then missed approach`;
  document.querySelectorAll('#p2 .t-title').forEach(t => t.textContent = `C2 Link Readiness, ${a}`);
  const prof = R.hazardProfile(model, des, draws, true), profPre = R.hazardProfile(model, des, draws, false);
  const xs = path.map(p => p.dthr_nm);
  const runs = obs.runs.filter(r => r.approach === a);
  const W = 938, H1 = 250, rowH = 13, H2 = Math.max(60, runs.length * rowH + 16), gap = 22;
  const svg = el('svg', { width: W, height: H1 + gap + H2 + 50 }); host.appendChild(svg);
  const xlim = [10.2, -5.2], xt = [10, 8, 6, 4, 2, 0, -2, -4];
  const ymax = Math.max(...profPre.map(p => p.hi), ...prof.map(p => p.hi)) * 1.1;
  const yl = [0.01, Math.max(1, 10 ** Math.ceil(Math.log10(ymax)))];
  const yt = []; for (let e = -2; 10 ** e <= yl[1]; e++) yt.push(10 ** e);
  const A = axes(svg, { x: 90, y: 6, w: 830, h: H1, xlim, ylim: yl, xticks: xt, yticks: yt, ylog: true, ylabel: 'Dropouts per minute', yfmt: v => v >= 1 ? v.toFixed(0) : String(v) });
  const clamp = v => Math.max(yl[0], Math.min(yl[1], v));
  const band = (pr, col, op) => { let d = ''; pr.forEach((p, i) => d += (i ? 'L' : 'M') + A.sx(xs[i]) + ' ' + A.sy(clamp(p.hi))); for (let i = pr.length - 1; i >= 0; i--) d += 'L' + A.sx(xs[i]) + ' ' + A.sy(clamp(pr[i].lo)); el('path', { d: d + 'Z', fill: col, 'fill-opacity': op, stroke: 'none' }, A.g); };
  band(profPre, '#7f7f7f', 0.18); band(prof, MPL.blue, 0.25);
  const line = (pr, col, dash, w) => el('path', { d: pr.map((p, i) => (i ? 'L' : 'M') + A.sx(xs[i]) + ' ' + A.sy(clamp(p.med))).join(''), fill: 'none', stroke: col, 'stroke-width': w, 'stroke-dasharray': dash || '' }, A.front);
  line(profPre, '#555', '5,4', 1.4); line(prof, MPL.blue, '', 1.8);
  // requirement-equivalent hazard: constant rate that would give exactly the requirement over this run
  const Hreq = R.hazardForContinuity(state.req, model.nuis.meanDur.post, des.length, model.nuis.r.post, model.nuis.qOut.post) / des.length * 60;
  el('line', { x1: A.sx(xlim[0]), x2: A.sx(xlim[1]), y1: A.sy(Hreq), y2: A.sy(Hreq), stroke: MPL.red, 'stroke-dasharray': '6,4', 'stroke-width': 1.3 }, A.front);
  el('line', { x1: A.sx(0), x2: A.sx(0), y1: 6, y2: 6 + H1 + gap + H2, stroke: MPL.cyan, 'stroke-dasharray': '5,4', 'stroke-width': 1.3 }, svg);
  // packet status per flown run
  const y2 = 6 + H1 + gap;
  const B = axes(svg, { x: 90, y: y2, w: 830, h: H2, xlim, ylim: [0, Math.max(1, runs.length)], xticks: xt, yticks: [], xlabel: 'Distance to Threshold (NM)', xfmt: v => v.toFixed(0) });
  const t = el('text', { x: 0, y: 0, 'text-anchor': 'middle', 'font-size': 12.5, transform: `translate(${90 - 60},${y2 + H2 / 2}) rotate(-90)` }, B.front); t.textContent = 'Flown Runs (date)';
  if (!runs.length) { const tt = el('text', { x: 90 + 415, y: y2 + H2 / 2 + 4, 'text-anchor': 'middle', 'font-size': 12, fill: '#555' }, B.front); tt.textContent = 'Never flown: prediction comes from spatial smoothing and the range term only'; }
  runs.forEach((r, k) => {
    const d = camp.days.find(dd => dd.date === r.date); const yy = B.sy(runs.length - k - 0.5);
    for (let i = r.i0; i < r.i1; i++) {
      const j = i - r.i0; if (j >= xs.length) break; const lost = (d.samples[i][3] & 1) + ((d.samples[i][3] >> 1) & 1);
      el('rect', { x: A.sx(xs[j]) - 0.9, y: yy - 4, width: 1.8, height: 8, fill: lost ? '#dc143c' : 'rgba(46,139,87,0.45)' }, B.g);
    }
    const lab = el('text', { x: 90 - 6, y: yy + 3.5, 'text-anchor': 'end', 'font-size': 9.5, fill: '#333' }, B.front); lab.textContent = r.date.slice(5);
  });
  legend('#along-legend', [
    { type: 'line', color: MPL.blue, label: 'Predicted, post-update (median)' },
    { type: 'patch', color: MPL.blue, alpha: 0.25, label: '90% interval, post-update' },
    { type: 'line', color: '#555', dash: '5,4', label: 'Predicted, pre-update (median)' },
    { type: 'patch', color: '#7f7f7f', alpha: 0.18, label: '90% interval, pre-update' },
    { type: 'line', color: MPL.red, dash: '6,4', label: 'Uniform rate that just meets requirement' },
    { type: 'line', color: MPL.cyan, dash: '5,4', label: 'Runway threshold' },
    { type: 'dot', color: '#dc143c', label: 'Packet Lost (flown run)' },
    { type: 'dot', color: 'rgba(46,139,87,0.75)', label: 'Packet Received (flown run)' },
  ], 3);
}

// ---------- page 3 ----------
function renderPlan() {
  const rows = APPS.map(a => {
    const pl = plans[a]; const now = pl[0]; const hit = pl.find(p => p.decisive);
    const verdict = p => p.pMeet >= 0.9 ? 'Ready' : p.pMeet <= 0.1 ? 'Not ready' : 'Inconclusive';
    const need = now.decisive ? '0 (decided now)' : hit ? `${hit.N}` : `> ${pl.at(-1).N}`;
    const after = hit && !now.decisive ? hit : pl.at(-1);
    return `<tr data-a="${a}" class="${a === state.approach ? 'sel' : ''}"><td>${a}</td><td class="num">${pct(now.lo)} to ${pct(now.hi)}</td><td class="num">${pct(now.pMeet, 0)}</td><td class="num">${need}</td><td class="num">${after.N}</td><td class="num">${pct(after.lo)} to ${pct(after.hi)}</td><td class="${vcls(verdict(now.decisive ? now : after))}">${now.decisive ? verdict(now) : hit ? verdict(hit) : `Inconclusive <span class="sub">(median ${(100 * Math.abs(now.med - state.req)).toFixed(2)} pts from req.)</span>`}</td></tr>`;
  }).join('');
  $('#plan-table').innerHTML = `<thead><tr><th>Approach</th><th class="num">Now:<br>90% Interval</th><th class="num">Now:<br>P(meets)</th><th class="num">Runs Needed for<br>a Decisive Verdict</th><th class="num">Runs<br>Simulated</th><th class="num">Expected 90%<br>Interval After</th><th>Expected<br>Verdict</th></tr></thead><tbody>${rows}</tbody>`;
  $('#plan-table').querySelectorAll('tbody tr').forEach(tr => tr.addEventListener('click', () => { state.approach = tr.dataset.a; refresh(false); }));
  // plot: interval vs N for every approach
  const host = $('#plan-plot'); host.replaceChildren(); const W = 938, H = 270;
  const svg = el('svg', { width: W, height: H }); host.appendChild(svg);
  const all = APPS.flatMap(a => plans[a].flatMap(p => [p.lo, p.hi])).concat(state.req);
  const lo = Math.min(...all) * 100 - 0.2, hi = Math.min(100, Math.max(...all) * 100 + 0.2);
  const Ns = plans[APPS[0]].map(p => p.N);
  const A = axes(svg, { x: 90, y: 6, w: 830, h: 210, xlim: [-0.4, Ns.at(-1) + 0.4], ylim: [lo, hi], xticks: Ns, yticks: niceTicks(lo, hi, 6), xlabel: 'Additional Post-Update Runs (one per test day)', ylabel: 'Continuity, 90% interval (%)', yfmt: v => v.toFixed(1) });
  el('line', { x1: A.sx(-0.4), x2: A.sx(Ns.at(-1) + 0.4), y1: A.sy(state.req * 100), y2: A.sy(state.req * 100), stroke: MPL.red, 'stroke-dasharray': '6,4', 'stroke-width': 1.3 }, A.front);
  APPS.forEach((a, k) => {
    const col = APP_COLOR[a]; const off = (k - 1.5) * 0.09; const pl = plans[a];
    el('path', { d: pl.map((p, i) => (i ? 'L' : 'M') + A.sx(p.N + off) + ' ' + A.sy(p.med * 100)).join(''), fill: 'none', stroke: col, 'stroke-width': a === state.approach ? 2 : 1.1, 'stroke-opacity': a === state.approach ? 1 : 0.7 }, A.front);
    for (const p of pl) {
      el('line', { x1: A.sx(p.N + off), x2: A.sx(p.N + off), y1: A.sy(p.lo * 100), y2: A.sy(p.hi * 100), stroke: col, 'stroke-width': a === state.approach ? 2.2 : 1.2, 'stroke-opacity': a === state.approach ? 1 : 0.7 }, A.front);
      el('circle', { cx: A.sx(p.N + off), cy: A.sy(p.med * 100), r: 3, fill: col }, A.front);
    }
  });
  legend('#plan-legend', APPS.map(a => ({ type: 'err', color: APP_COLOR[a], label: a + (APPROACHES[a].notional ? ' (notional)' : '') })).concat([{ type: 'line', color: MPL.red, dash: '6,4', label: `Requirement (${pct(state.req)})` }]));
}
function renderBacktest() {
  const host = $('#bt-plot'); host.replaceChildren(); const W = 938, H = 300; const svg = el('svg', { width: W, height: H }); host.appendChild(svg);
  const loss = v => Math.max(0.05, 100 * (1 - v));
  const yl = [0.05, 100]; const yt = [0.1, 1, 10, 100];
  const A = axes(svg, { x: 90, y: 6, w: 830, h: 230, xlim: [-0.8, bt.length - 0.2], ylim: yl, ylog: true, xticks: [], yticks: yt, ylabel: 'Packet Loss (%), log scale', yfmt: v => String(v) });
  const fit = model.fit; const anom = new Set(camp.days.filter((d, i) => R.dayWeight(fit.theta[3 + i], fit.sigmaDay) < 0.5).map(d => d.date));
  let start = 0; const dates = [...new Set(bt.map(b => b.date))];
  dates.forEach(dt => {
    const idx = bt.map((b, i) => b.date === dt ? i : -1).filter(i => i >= 0); const x0 = A.sx(idx[0] - 0.5), x1 = A.sx(idx.at(-1) + 0.5);
    if (anom.has(dt)) el('rect', { x: x0, y: 6, width: x1 - x0, height: 230, fill: '#9467bd', 'fill-opacity': 0.18 }, A.g);
    el('line', { x1: x1, x2: x1, y1: 6, y2: 236, stroke: '#b0b0b0', 'stroke-opacity': 0.6 }, A.g);
    const t = el('text', { x: (x0 + x1) / 2, y: 236 + 17, 'text-anchor': 'middle', 'font-size': 11 }, A.front); t.textContent = dt.slice(5);
    start++;
  });
  const lbl = el('text', { x: 90 + 415, y: 236 + 38, 'text-anchor': 'middle', 'font-size': 13 }, A.front); lbl.textContent = 'Held-Out Test Day (each run predicted from the other seven days)';
  el('line', { x1: A.sx(-0.8), x2: A.sx(bt.length - 0.2), y1: A.sy(100 * (1 - state.req)), y2: A.sy(100 * (1 - state.req)), stroke: MPL.red, 'stroke-dasharray': '6,4', 'stroke-width': 1.3 }, A.front);
  bt.forEach((b, i) => {
    const X = A.sx(i);
    el('line', { x1: X, x2: X, y1: A.sy(loss(b.lo)), y2: A.sy(loss(b.hi)), stroke: '#555', 'stroke-width': 1.4 }, A.front);
    for (const v of [b.lo, b.hi]) el('line', { x1: X - 3, x2: X + 3, y1: A.sy(loss(v)), y2: A.sy(loss(v)), stroke: '#555', 'stroke-width': 1.2 }, A.front);
    el('circle', { cx: X, cy: A.sy(loss(b.obs)), r: 3.6, fill: b.covered ? '#2e8b57' : '#dc143c', stroke: '#000', 'stroke-width': 0.5 }, A.front);
  });
  legend('#bt-legend', [
    { type: 'err', color: '#555', dotColor: '#555', label: '90% predictive interval (run)' },
    { type: 'dot', color: '#2e8b57', label: 'Observed, inside interval' },
    { type: 'dot', color: '#dc143c', label: 'Observed, outside interval' },
    { type: 'patch', color: '#9467bd', alpha: 0.18, label: 'Anomalous day (down-weighted)' },
    { type: 'line', color: MPL.red, dash: '6,4', label: `Requirement (${pct(state.req)})` },
  ]);
}
function renderMethod() {
  const f = model.fit;
  const rows = [
    ['Outage Detection', 'Runs of ≥ 2 lost packets (≥ 1 s), merging runs split by a single received packet'],
    ['Onset Model', `Poisson onsets per ${CELL_M} m cell and day: range term (${f.theta[1].toFixed(2)} per log-km) + spatial GMRF field + day effect + update effect`],
    ['Hyper-Parameters', `Spatial precision τ = ${f.tau}, day spread σ = ${f.sigmaDay} (Laplace marginal likelihood over a ${R.TAU_GRID.length} x ${R.SIGMA_GRID.length} grid)`],
    ['Post-Update Outage Shape', `Mean outage ${model.nuis.meanDur.post.toFixed(2)} s from ${model.nuis.durations.post.length} post-update outages; isolated loss ${pct(model.nuis.r.post, 2)}`],
    ['Prediction', '400 Laplace posterior draws; continuity from a renewal approximation (typical day) and Gilbert-Elliott Monte Carlo runs with Student-t day effects (single run)'],
    ['Verdict Rule', 'Ready if P(meets) ≥ 90%, Not ready if ≤ 10%, otherwise Inconclusive'],
  ];
  $('#method').innerHTML = '<tbody>' + rows.map(r => `<tr><td>${r[0]}</td><td style="font-weight:400">${r[1]}</td></tr>`).join('') + '</tbody>';
}

function refresh(recompute = true) {
  if (recompute) computePredictions();
  renderMetrics(); renderApproachTable(); renderCiPlot(); renderAlong(); renderPlan(); renderBacktest(); renderMethod();
}

async function main() {
  [camp, terrain] = await Promise.all([fetch('data/campaign.json').then(r => r.json()), fetch('data/terrain.json').then(r => r.json())]);
  headers(`${camp.days[0].date} to ${camp.days.at(-1).date}`);
  await new Promise(r => setTimeout(r, 30));
  computeAll();
  setupMap(); mapLegend(); drawMap();
  $('#layer').addEventListener('change', e => { state.layer = e.target.value; drawMap(); });
  refresh(false);
  document.fonts?.ready?.then(() => drawMap());
}
main().catch(e => { console.error(e); $('#metrics').innerHTML = `<tbody><tr><td colspan="2">Failed to load: ${e.message}</td></tr></tbody>`; });
