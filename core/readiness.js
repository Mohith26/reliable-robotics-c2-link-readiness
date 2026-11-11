// C2 Link Readiness: calibrated, data-driven link-continuity verdicts per approach from flight-test packet logs.
//
// Model (outage onsets, not packets, because dropouts are bursty):
//   onsets in cell c on day d ~ Poisson( E_cd * exp(b0 + bR*logRange + delta*postUpdate + gamma_d + s_c) )
//   s   ~ GMRF(tau * (R + eps I))   spatial dropout field on a 900 m grid (R = 4-neighbour graph Laplacian)
//   gamma_d ~ Student-t_3(0, sigmaDay) day-to-day variation; heavy tails so one anomalous day (e.g. Aug 14)
//                                    is flagged instead of inflating the spread assumed for every future day
//   delta                            radio software update effect (identified only where both eras flew)
// MAP by Newton, Laplace posterior, hyper-parameters (tau, sigmaDay) by Laplace marginal likelihood.
// Prediction for a planned approach: posterior draws -> expected continuity on a typical post-update day,
// plus Monte Carlo runs of a Gilbert-Elliott channel for run-level probabilities (longest outage >= T s).
import { cellKey, cellCenter, GRS } from './geo.js';
import { cholesky, cholSolve, logDetFromChol, cholSolveUpperT, normCdf } from './linalg.js';
import { makeRng } from './rng.js';

export const NU = 3; // Student-t degrees of freedom for day effects
/** IRLS weight of a day effect under the t prior (1 = ordinary day, << 1 = anomalous day). */
export const dayWeight = (g, sd) => (NU + 1) / (NU + g * g / (sd * sd));

export const logRange = (e, n) => Math.log(Math.max(0.3, Math.hypot(e - GRS.e, n - GRS.n) / 1000) / 5);

const lostCount = b => (b & 1) + ((b >> 1) & 1) + ((b >> 2) & 1) + ((b >> 3) & 1);

/** Observed packet continuity (% received) over a sample range. */
export function continuity(samples, pps, i0 = 0, i1 = samples.length) {
  let lost = 0; for (let i = i0; i < i1; i++) lost += lostCount(samples[i][3]);
  return 1 - lost / ((i1 - i0) * pps);
}

/**
 * Split a day's packet log into outage events (runs of >= minRun consecutive lost packets) and isolated losses.
 * Returns per-second exposure flags, onset seconds, outage durations (s), and isolated-loss counts.
 */
export function extractEvents(samples, pps, minRun = 2, maxGap = 1) {
  const nSec = samples.length; const lost = new Uint8Array(nSec * pps);
  for (let s = 0; s < nSec; s++) for (let k = 0; k < pps; k++) lost[s * pps + k] = (samples[s][3] >> k) & 1;
  // runs of lost packets; runs separated by <= maxGap received packets are one outage (a fading channel
  // lets the odd packet through mid-outage)
  const raw = [];
  for (let p = 0; p < lost.length;) { if (!lost[p]) { p++; continue; } let q = p; while (q < lost.length && lost[q]) q++; raw.push([p, q]); p = q; }
  const merged = [];
  for (const r of raw) { const m = merged[merged.length - 1]; if (m && r[0] - m[1] <= maxGap) { m[1] = r[1]; m[2] += r[1] - r[0]; } else merged.push([r[0], r[1], r[1] - r[0]]); }
  const inOutage = new Uint8Array(nSec); const onset = new Uint8Array(nSec);
  const durations = []; const runs = [];
  let isolated = 0, goodPackets = 0, outLost = 0, outSpan = 0;
  for (const [p, q, nLost] of merged) {
    if (nLost >= minRun) {
      const s0 = Math.floor(p / pps), s1 = Math.floor((q - 1) / pps);
      onset[s0] = 1; for (let s = s0 + 1; s <= s1; s++) inOutage[s] = 1;
      durations.push((q - p) / pps); runs.push([s0, s1, (q - p) / pps]); outLost += nLost; outSpan += q - p;
    } else isolated += nLost;
  }
  for (let s = 0; s < nSec; s++) if (!inOutage[s] && !onset[s]) goodPackets += pps;
  return { inOutage, onset, durations, runs, isolated, goodPackets, outLost, outSpan };
}

/** Build the analysis cell set (flown cells + planned approach cells) and 4-neighbour adjacency. */
export function buildCells(campaign, plannedPaths) {
  const keys = new Map();
  const add = k => { if (!keys.has(k)) keys.set(k, keys.size); };
  for (const d of campaign.days) for (const s of d.samples) add(cellKey(s[0], s[1]));
  for (const p of Object.values(plannedPaths)) for (const s of p) add(cellKey(s.e, s.n));
  const list = [...keys.keys()];
  const nbr = list.map(k => { const [i, j] = k.split(',').map(Number); return [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]].map(([a, b]) => keys.get(`${a},${b}`)).filter(v => v !== undefined); });
  return { index: keys, list, nbr, centers: list.map(cellCenter) };
}

/** Aggregate exposure/onsets into (cell, day) units. */
export function buildUnits(campaign, cells, { excludeDay = -1 } = {}) {
  const pps = campaign.packets_per_s; const units = new Map();
  const durations = { pre: [], post: [] }; const iso = { pre: [0, 0], post: [0, 0] }; const fill = { pre: [0, 0], post: [0, 0] };
  campaign.days.forEach((d, di) => {
    if (di === excludeDay) return;
    const ev = extractEvents(d.samples, pps);
    const era = d.post ? 'post' : 'pre';
    durations[era].push(...ev.durations); fill[era][0] += ev.outLost; fill[era][1] += ev.outSpan; iso[era][0] += ev.isolated; iso[era][1] += ev.goodPackets;
    for (let s = 0; s < d.samples.length; s++) {
      if (ev.inOutage[s]) continue;
      const [e, n] = d.samples[s]; const c = cells.index.get(cellKey(e, n)); const key = c * 64 + di;
      let u = units.get(key); if (!u) { u = { c, d: di, post: d.post ? 1 : 0, E: 0, N: 0, xr: 0 }; units.set(key, u); }
      u.E += 1; u.N += ev.onset[s]; u.xr += logRange(e, n);
    }
  });
  const arr = [...units.values()]; for (const u of arr) u.xr /= u.E;
  return { units: arr, durations, iso, fill };
}

function laplacianLogDet(cells, eps) {
  const C = cells.list.length; const R = new Float64Array(C * C);
  cells.nbr.forEach((ns, i) => { R[i * C + i] = ns.length + eps; for (const j of ns) R[i * C + j] = -1; });
  return logDetFromChol(cholesky(R, C), C);
}

/**
 * Penalized Newton fit. Parameter layout: [b0, bR, delta, gamma_0..gamma_{D-1}, s_0..s_{C-1}].
 */
export function fitModel(data, cells, nDays, { tau = 2, sigmaDay = 0.5, eps = 0.05, init = null, maxIter = 40 } = {}) {
  const C = cells.list.length, D = nDays, P = 3 + D + C;
  const priorMean = new Float64Array(P); priorMean[0] = Math.log(0.005);
  const priorPrec = [1 / 9, 1 / 4, 1 / 4]; // b0 sd 3, bR sd 2, delta sd 2
  const th = init ? Float64Array.from(init) : Float64Array.from(priorMean);
  const units = data.units;
  const idx = u => [0, 1, 2, 3 + u.d, 3 + D + u.c];
  const xv = u => [1, u.xr, u.post, 1, 1];
  const eta = (t, u) => t[0] + t[1] * u.xr + t[2] * u.post + t[3 + u.d] + t[3 + D + u.c];

  function objective(t) { // negative log posterior (up to const)
    let f = 0;
    for (const u of units) { const h = eta(t, u); f -= u.N * h - u.E * Math.exp(h); }
    for (let k = 0; k < 3; k++) f += 0.5 * priorPrec[k] * (t[k] - priorMean[k]) ** 2;
    for (let d = 0; d < D; d++) f += 0.5 * (NU + 1) * Math.log(1 + t[3 + d] ** 2 / (NU * sigmaDay ** 2));
    for (let i = 0; i < C; i++) { const si = t[3 + D + i]; let q = (cells.nbr[i].length + eps) * si; for (const j of cells.nbr[i]) q -= t[3 + D + j]; f += 0.5 * tau * si * q; }
    return f;
  }
  function gradHess(t) {
    const g = new Float64Array(P), H = new Float64Array(P * P);
    for (const u of units) {
      const mu = u.E * Math.exp(eta(t, u)); const r = mu - u.N; const I = idx(u), X = xv(u);
      for (let a = 0; a < 5; a++) { g[I[a]] += r * X[a]; for (let b = 0; b < 5; b++) H[I[a] * P + I[b]] += mu * X[a] * X[b]; }
    }
    for (let k = 0; k < 3; k++) { g[k] += priorPrec[k] * (t[k] - priorMean[k]); H[k * P + k] += priorPrec[k]; }
    for (let d = 0; d < D; d++) { const w = dayWeight(t[3 + d], sigmaDay); g[3 + d] += w * t[3 + d] / sigmaDay ** 2; H[(3 + d) * P + 3 + d] += w / sigmaDay ** 2; }
    for (let i = 0; i < C; i++) {
      const ii = 3 + D + i; let q = (cells.nbr[i].length + eps) * t[ii];
      H[ii * P + ii] += tau * (cells.nbr[i].length + eps);
      for (const j of cells.nbr[i]) { q -= t[3 + D + j]; H[ii * P + 3 + D + j] -= tau; }
      g[ii] += tau * q;
    }
    return { g, H };
  }
  let f = objective(th), it = 0, L = null;
  for (; it < maxIter; it++) {
    const { g, H } = gradHess(th); L = cholesky(H, P);
    const step = cholSolve(L, P, g);
    let a = 1, nt, nf;
    for (let k = 0; k < 30; k++) { nt = th.map((v, i) => v - a * step[i]); nf = objective(nt); if (nf <= f + 1e-10) break; a /= 2; }
    let mx = 0; for (let i = 0; i < P; i++) mx = Math.max(mx, Math.abs(nt[i] - th[i]));
    th.set(nt); f = nf;
    if (mx < 1e-6) break;
  }
  const { H } = gradHess(th); L = cholesky(H, P);
  return { theta: th, H, L, P, C, D, tau, sigmaDay, eps, negLogPost: f, iters: it };
}

/** Laplace approximation to log p(y | tau, sigmaDay) (up to a constant shared across the grid). */
export function logMarginal(fit, lapLogDet) {
  const { C, D, tau, sigmaDay, L, P } = fit;
  return -fit.negLogPost + 0.5 * (C * Math.log(tau) + lapLogDet) - D * Math.log(sigmaDay) - 0.5 * logDetFromChol(L, P); // t normalizer differs from Gaussian only by sigma-free constants
}

export const TAU_GRID = [2, 4, 8];
export const SIGMA_GRID = [0.25, 0.45, 0.8];
// Weakly-informative half-normal(0.5) hyper-prior on sigmaDay: with 8 test days the marginal likelihood is nearly flat in it.
const logHyperPrior = sd => -sd * sd / (2 * 0.25);

export function fitWithHyper(data, cells, nDays, { eps = 0.05 } = {}) {
  const lapLD = laplacianLogDet(cells, eps);
  let best = null, init = null; const grid = [];
  for (const sigmaDay of SIGMA_GRID) for (const tau of TAU_GRID) {
    const fit = fitModel(data, cells, nDays, { tau, sigmaDay, eps, init });
    init = fit.theta; const lm = logMarginal(fit, lapLD) + logHyperPrior(sigmaDay); grid.push({ tau, sigmaDay, logMarg: lm });
    if (!best || lm > best.lm) best = { fit, lm };
  }
  return { ...best.fit, grid, logMarg: best.lm };
}

/** Isolated-loss rate and duration summaries from the data. */
export function nuisance(data) {
  // Isolated-loss rate, outage durations and in-outage loss fraction are estimated per radio software era,
  // because the update can change outage length as well as outage frequency.
  const out = { r: {}, durations: {}, meanDur: {}, qOut: {}, isoCounts: data.iso };
  for (const era of ['pre', 'post']) {
    out.r[era] = (data.iso[era][0] + 1) / (data.iso[era][1] + 2);
    const dur = data.durations[era].slice().sort((a, b) => a - b);
    out.durations[era] = dur; out.meanDur[era] = dur.reduce((a, b) => a + b, 0) / Math.max(1, dur.length);
    out.qOut[era] = data.fill[era][0] / Math.max(1, data.fill[era][1]);
  }
  return out;
}

/** Closed-form expected continuity of a run with total onset hazard H (per run), mean outage Dbar s, T s long. */
export function expectedContinuity(Htot, Dbar, T, r, q = 1) {
  const O = Htot * Dbar / (1 + Htot * Dbar / T); // expected seconds in outage (renewal correction)
  return 1 - (q * O + r * (T - O)) / T;
}
/** Inverse of expectedContinuity in Htot (monotone). */
export function hazardForContinuity(target, Dbar, T, r, q = 1) {
  let lo = 1e-9, hi = 1e6;
  for (let k = 0; k < 200; k++) { const m = Math.sqrt(lo * hi); if (expectedContinuity(m, Dbar, T, r, q) > target) lo = m; else hi = m; }
  return Math.sqrt(lo * hi);
}

/** Per-second design rows of a path: cell index and log range. */
export function pathDesign(path, cells) {
  return path.map(p => ({ c: cells.index.get(cellKey(p.e, p.n)), xr: logRange(p.e, p.n) }));
}

function etaRow(t, D, row, post, gamma) { return t[0] + t[1] * row.xr + t[2] * post + gamma + t[3 + D + row.c]; }

/** Standard-normal vectors shared by every posterior computation (common random numbers keep numbers consistent). */
export function makeZ(P, M, rng) { const zs = []; for (let m = 0; m < M; m++) { const z = new Float64Array(P); for (let i = 0; i < P; i++) z[i] = rng.normal(); zs.push(z); } return zs; }
/** theta + L^-T z for each z: draws from N(theta, (L L^T)^-1). */
export function drawFromZ(theta, L, P, zs) { return zs.map(z => { const dz = cholSolveUpperT(L, P, z); return theta.map((v, i) => v + dz[i]); }); }
/** Draw parameter vectors from N(theta, (L L^T)^-1). */
export function drawThetas(theta, L, P, M, rng) { return drawFromZ(theta, L, P, makeZ(P, M, rng)); }

/** Simulate one run of the fitted channel along a design (per-second rows). */
export function simulateRun(design, hazards, durations, r, pps, rng, q = 1) {
  let lost = 0, out = 0, longest = 0, cur = 0; const T = design.length;
  for (let s = 0; s < T; s++) {
    if (out <= 0) {
      if (cur > 0) { longest = Math.max(longest, cur); cur = 0; }
      if (rng.u() < 1 - Math.exp(-hazards[s])) { const d = durations[Math.floor(rng.u() * durations.length)]; out = Math.round(d * pps); cur = 0; }
    }
    for (let k = 0; k < pps; k++) {
      if (out > 0) { if (rng.u() < q) lost++; out--; cur += 1 / pps; } else if (rng.u() < r) lost++;
    }
  }
  longest = Math.max(longest, cur);
  return { cont: 1 - lost / (T * pps), longest };
}

/** Student-t(NU) draw: normal / sqrt(chi2/NU). */
function tDraw(rng) { let c = 0; for (let k = 0; k < NU; k++) c += rng.normal() ** 2; return rng.normal() / Math.sqrt(c / NU); }

const quant = (a, q) => { const s = a.slice().sort((x, y) => x - y); const i = (s.length - 1) * q; const lo = Math.floor(i); return s[lo] + (s[Math.min(s.length - 1, lo + 1)] - s[lo]) * (i - lo); };
export { quant };

/**
 * Predict readiness of a planned path.
 * Returns typical-day expected continuity interval (parameter uncertainty), P(expected >= req),
 * run-level P(continuity >= req) and P(longest outage >= T) including day-to-day variation.
 */
export function predictPath(model, design, { post = true, req = 0.982, outageT = 3, draws, seed = 11, runsPerDraw = 4 } = {}) {
  const { fit, nuis, pps } = model; const D = fit.D; const rng = makeRng(seed);
  const T = design.length; const era = post ? 'post' : 'pre'; const r = nuis.r[era];
  const meanC = [], logH = [], runC = [], runLong = []; let meetRuns = 0, longRuns = 0, n = 0;
  const hz = new Float64Array(T);
  for (const t of draws) {
    let Hs = 0; for (let s = 0; s < T; s++) Hs += Math.exp(etaRow(t, D, design[s], post ? 1 : 0, 0));
    logH.push(Math.log(Hs)); meanC.push(expectedContinuity(Hs, nuis.meanDur[era], T, r, nuis.qOut[era]));
    for (let k = 0; k < runsPerDraw; k++) {
      const g = tDraw(rng) * fit.sigmaDay;
      for (let s = 0; s < T; s++) hz[s] = Math.exp(etaRow(t, D, design[s], post ? 1 : 0, g));
      const sim = simulateRun(design, hz, nuis.durations[era], r, pps, rng, nuis.qOut[era]);
      runC.push(sim.cont); runLong.push(sim.longest); n++;
      if (sim.cont >= req) meetRuns++; if (sim.longest >= outageT) longRuns++;
    }
  }
  const pMeet = meanC.filter(c => c >= req).length / meanC.length;
  const verdict = pMeet >= 0.9 ? 'Ready' : pMeet <= 0.1 ? 'Not ready' : 'Inconclusive';
  return {
    T, median: quant(meanC, 0.5), lo: quant(meanC, 0.05), hi: quant(meanC, 0.95), pMeet, verdict,
    logH: { mean: logH.reduce((a, b) => a + b, 0) / logH.length, sd: Math.sqrt(logH.reduce((a, b) => a + b * b, 0) / logH.length - (logH.reduce((a, b) => a + b, 0) / logH.length) ** 2) },
    runMeet: meetRuns / n, runLongOutage: longRuns / n, runLo: quant(runC, 0.05), runHi: quant(runC, 0.95),
    longestMedian: quant(runLong, 0.5),
  };
}

/** Along-track hazard profile (outages per minute) with 90% band on a typical day. */
export function hazardProfile(model, design, draws, post = true) {
  const D = model.fit.D; const T = design.length;
  const out = [];
  for (let s = 0; s < T; s++) {
    const v = draws.map(t => 60 * Math.exp(etaRow(t, D, design[s], post ? 1 : 0, 0)));
    out.push({ lo: quant(v, 0.05), med: quant(v, 0.5), hi: quant(v, 0.95) });
  }
  return out;
}

/**
 * Pre-posterior characterization plan: expected 90% interval of typical-day continuity after N more post-update
 * runs of the path, one run per new test day (Laplace; information added at the current estimate, each new day's effect
 * integrated out).
 */
export function characterizationPlan(model, design, { req = 0.982, Ns = [0, 1, 2, 3, 4, 6, 8], M = 300, seed = 5, zs = null } = {}) {
  const { fit, nuis } = model; const { P, D, theta } = fit; const T = design.length;
  const r = nuis.r.post;
  // per-second expected information at theta_hat (gamma_new = 0)
  const rows = design.map(row => ({ row, mu: Math.exp(etaRow(theta, D, row, 1, 0)) }));
  const out = [];
  for (const N of Ns) {
    const A = Float64Array.from(fit.H);
    if (N > 0) {
      // each run on its own new day: information F - b b^T / c after integrating out that day's effect
      const b = new Float64Array(P); let c = 1 / fit.sigmaDay ** 2;
      for (const { row, mu } of rows) {
        const I = [0, 1, 2, 3 + D + row.c], X = [1, row.xr, 1, 1];
        for (let a = 0; a < 4; a++) { b[I[a]] += mu * X[a]; for (let q = 0; q < 4; q++) A[I[a] * P + I[q]] += N * mu * X[a] * X[q]; }
        c += mu;
      }
      const nz = []; for (let i = 0; i < P; i++) if (b[i] !== 0) nz.push(i);
      for (const i of nz) for (const j of nz) A[i * P + j] -= N * b[i] * b[j] / c;
    }
    const L = cholesky(A, P);
    const Z = zs || (zs = makeZ(P, M, makeRng(seed)));
    const draws = drawFromZ(theta, L, P, Z); // common random numbers across N (and with the main report draws)
    const meanC = draws.map(t => { let Hs = 0; for (const row of design) Hs += Math.exp(etaRow(t, D, row, 1, 0)); return expectedContinuity(Hs, nuis.meanDur.post, T, r, nuis.qOut.post); });
    const pMeet = meanC.filter(v => v >= req).length / meanC.length;
    out.push({ N, lo: quant(meanC, 0.05), med: quant(meanC, 0.5), hi: quant(meanC, 0.95), pMeet, decisive: pMeet >= 0.9 || pMeet <= 0.1 });
  }
  return out;
}

/** Fit everything needed by the report. */
export function buildModel(campaign, plannedPaths, opts = {}) {
  const cells = buildCells(campaign, plannedPaths);
  const data = buildUnits(campaign, cells);
  const fit = fitWithHyper(data, cells, campaign.days.length, opts);
  const nuis = nuisance(data);
  return { cells, data, fit, nuis, pps: campaign.packets_per_s };
}

/** Naive before/after comparison (what a per-day bar chart suggests) vs. the model's adjusted update effect. */
export function updateEffect(model) {
  const { data, fit } = model; const k = 2;
  const sd = Math.sqrt(cholSolve(fit.L, fit.P, Float64Array.from({ length: fit.P }, (_, i) => i === k ? 1 : 0))[k]);
  let Npre = 0, Epre = 0, Npost = 0, Epost = 0;
  for (const u of data.units) { if (u.post) { Npost += u.N; Epost += u.E; } else { Npre += u.N; Epre += u.E; } }
  return {
    delta: fit.theta[k], sd, ratio: Math.exp(fit.theta[k]), lo: Math.exp(fit.theta[k] - 1.645 * sd), hi: Math.exp(fit.theta[k] + 1.645 * sd),
    naiveRatio: (Npost / Epost) / (Npre / Epre), ratePre: Npre / Epre, ratePost: Npost / Epost,
  };
}

/** Leave-one-day-out backtest of run-level 90% predictive intervals. */
export function backtest(campaign, plannedPaths, model, { M = 150, runsPerDraw = 4, seed = 3 } = {}) {
  const res = [];
  campaign.days.forEach((d, di) => {
    const data = buildUnits(campaign, model.cells, { excludeDay: di });
    const fit = fitModel(data, model.cells, campaign.days.length, { tau: model.fit.tau, sigmaDay: model.fit.sigmaDay, eps: model.fit.eps, init: model.fit.theta });
    const nuis = nuisance(data); const sub = { fit, nuis, pps: campaign.packets_per_s };
    const draws = drawThetas(fit.theta, fit.L, fit.P, M, makeRng(seed + di));
    for (const run of d.runs) {
      const samples = d.samples.slice(run.i0, run.i1).map(s => ({ e: s[0], n: s[1] }));
      const design = pathDesign(samples, model.cells);
      const pr = predictPath(sub, design, { post: d.post, draws, runsPerDraw, seed: seed * 7 + di });
      const obs = continuity(d.samples, campaign.packets_per_s, run.i0, run.i1);
      res.push({ date: d.date, approach: run.approach, post: d.post, obs, lo: pr.runLo, hi: pr.runHi, med: pr.median, covered: obs >= pr.runLo && obs <= pr.runHi });
    }
  });
  return res;
}
