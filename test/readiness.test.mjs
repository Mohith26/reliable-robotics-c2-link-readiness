import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cholesky, cholSolve, cholInverse, logDetFromChol } from '../core/linalg.js';
import { makeRng } from '../core/rng.js';
import { APPROACHES, approachPath, GRS } from '../core/geo.js';
import { makeTerrain, diffractionDb, knifeEdgeDb } from '../core/rf.js';
import { simulateCampaign, simulateLink, defaultTruth } from '../core/simulate.js';
import * as R from '../core/readiness.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const planned = Object.fromEntries(Object.keys(APPROACHES).map(a => [a, approachPath(a)]));

function truthContinuity(name, truth, n = 1500, seed = 42) {
  const rng = makeRng(seed); const p = approachPath(name); let L = 0, T = 0;
  for (let k = 0; k < n; k++) for (const b of simulateLink(p, truth, 'typical', true, rng)) { L += (b & 1) + ((b >> 1) & 1); T += 2; }
  return 1 - L / T;
}

test('linear algebra: Cholesky solve, inverse and log-determinant match hand values', () => {
  const A = Float64Array.from([4, 2, 0, 2, 5, 1, 0, 1, 3]);
  const L = cholesky(A, 3);
  const x = cholSolve(L, 3, Float64Array.from([2, 1, 4]));
  const Ax = [0, 1, 2].map(i => [0, 1, 2].reduce((s, j) => s + A[i * 3 + j] * x[j], 0));
  Ax.forEach((v, i) => assert.ok(Math.abs(v - [2, 1, 4][i]) < 1e-12));
  assert.ok(Math.abs(logDetFromChol(L, 3) - Math.log(4 * (5 * 3 - 1) - 2 * (2 * 3))) < 1e-12); // det = 44
  const inv = cholInverse(L, 3);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const v = [0, 1, 2].reduce((s, k) => s + A[i * 3 + k] * inv[k * 3 + j], 0);
    assert.ok(Math.abs(v - (i === j ? 1 : 0)) < 1e-12);
  }
});

test('outage extraction: runs >= 2 packets are outages, 1-packet gaps are merged, singletons are isolated', () => {
  // 2 packets/s. bits: bit0 = first packet lost, bit1 = second.
  const bits = [0, 1, 0, 3, 3, 1, 2, 0, 0, 2, 0, 0];
  //            s0 s1(iso) s3..s6: lost 3,3,(1:first),(2:second) -> packets 6,7,8,9,10,(11 ok? no) ...
  const samples = bits.map(b => [0, 0, 0, b]);
  const ev = R.extractEvents(samples, 2);
  // packet stream: 0 0 | 1 0 | 0 0 | 1 1 | 1 1 | 1 0 | 0 1 | 0 0 | 0 0 | 0 1 | 0 0 | 0 0
  // lost runs: [2], [6..10] (5 lost), [13] -> gap between run end 11 and 13 is 2 received -> not merged, [19]
  assert.equal(ev.durations.length, 1);
  assert.equal(ev.durations[0], 2.5);
  assert.equal(ev.isolated, 3);
  assert.equal(ev.onset[3], 1);
  assert.deepEqual([...ev.inOutage.slice(3, 7)], [0, 1, 1, 0]);
  // a single received packet inside an outage is merged into it
  const ev2 = R.extractEvents([[0, 0, 0, 3], [0, 0, 0, 1], [0, 0, 0, 3]].map(s => s), 2);
  assert.equal(ev2.durations.length, 1); assert.equal(ev2.durations[0], 3); assert.equal(ev2.outLost, 5);
});

test('closed-form expected continuity agrees with Monte Carlo of the channel, and inverts', () => {
  const T = 500, h = 0.01, durs = [1, 2, 3, 4], r = 0.002;
  const rng = makeRng(9); const design = new Array(T).fill(0); const hz = new Float64Array(T).fill(h);
  let s = 0; const n = 4000; for (let k = 0; k < n; k++) s += R.simulateRun(design, hz, durs, r, 2, rng, 0.97).cont;
  const cf = R.expectedContinuity(T * h, 2.5, T, r, 0.97);
  assert.ok(Math.abs(s / n - cf) < 0.002, `MC ${s / n} vs closed form ${cf}`);
  const H = R.hazardForContinuity(0.982, 2.5, T, r, 0.97);
  assert.ok(Math.abs(R.expectedContinuity(H, 2.5, T, r, 0.97) - 0.982) < 1e-9);
});

test('ITU knife-edge loss and line-of-sight finals on the shipped terrain', () => {
  assert.ok(Math.abs(knifeEdgeDb(0) - 6.03) < 0.05);
  assert.equal(knifeEdgeDb(-1), 0);
  const terrain = JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'terrain.json')));
  const el = makeTerrain(terrain); const g = el(GRS.e, GRS.n);
  for (const a of Object.keys(APPROACHES)) for (const p of planned[a]) assert.equal(diffractionDb(el, GRS, g, p), 0);
  // sanity: a point at 300 m MSL behind the Gabilan Range (to the south-west) is shadowed
  assert.ok(diffractionDb(el, GRS, g, { e: -16000, n: -16000, alt_m: 300 }) > 6);
});

let shared;
function model() {
  if (!shared) { const camp = JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'campaign.json'))); shared = { camp, m: R.buildModel(camp, planned) }; }
  return shared;
}

test('shipped campaign is reproducible from the seeded generator', () => {
  const regen = simulateCampaign({ seed: 20250806 });
  const shipped = JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'campaign.json')));
  assert.equal(JSON.stringify(regen), JSON.stringify(shipped));
});

test('MAP is a stationary point (finite-difference check) and the anomalous day is down-weighted', () => {
  const { camp, m } = model(); const fit = m.fit;
  // perturb delta and b0 slightly: objective must not decrease
  const base = R.fitModel(m.data, m.cells, camp.days.length, { tau: fit.tau, sigmaDay: fit.sigmaDay, init: fit.theta, maxIter: 0 });
  for (const k of [0, 2, 5]) for (const e of [1e-3, -1e-3]) {
    const t = Float64Array.from(fit.theta); t[k] += e;
    const f = R.fitModel(m.data, m.cells, camp.days.length, { tau: fit.tau, sigmaDay: fit.sigmaDay, init: t, maxIter: 0 });
    assert.ok(f.negLogPost >= base.negLogPost - 1e-6);
  }
  const w = camp.days.map((d, i) => R.dayWeight(fit.theta[3 + i], fit.sigmaDay));
  const i14 = camp.days.findIndex(d => d.date === '2025-08-14');
  assert.ok(w[i14] < 0.5, 'Aug 14 flagged'); w.forEach((v, i) => { if (i !== i14) assert.ok(v > 0.5); });
});

test('update effect: adjusted CI contains the true effect; naive before/after is outside it (route-mix confounding)', () => {
  const { m } = model(); const u = R.updateEffect(m); const tr = Math.exp(defaultTruth().delta);
  assert.ok(u.lo <= tr && tr <= u.hi, `true ratio ${tr} in [${u.lo}, ${u.hi}]`);
  assert.ok(u.naiveRatio < u.lo, 'naive overstates the improvement');
});

test('typical-day intervals cover the simulated truth for all four approaches; verdicts are consistent', () => {
  const { m } = model(); const draws = R.drawThetas(m.fit.theta, m.fit.L, m.fit.P, 400, makeRng(1));
  const truth = defaultTruth();
  for (const a of Object.keys(APPROACHES)) {
    const p = R.predictPath(m, R.pathDesign(planned[a], m.cells), { draws });
    const tc = truthContinuity(a, truth, 600);
    assert.ok(p.lo <= tc && tc <= p.hi, `${a}: truth ${tc} in [${p.lo}, ${p.hi}]`);
    if (p.verdict === 'Ready') assert.ok(p.lo > 0.975); if (p.verdict === 'Not ready') assert.ok(p.hi < 0.985);
  }
});

test('characterization plan: interval width never grows with more runs and draws are common-random', () => {
  const { m } = model();
  for (const a of ['RNAV 24', 'RNAV 31']) {
    const plan = R.characterizationPlan(m, R.pathDesign(planned[a], m.cells), { M: 200 });
    for (let i = 1; i < plan.length; i++) assert.ok(plan[i].hi - plan[i].lo <= plan[i - 1].hi - plan[i - 1].lo + 1e-4);
    assert.ok(plan[plan.length - 1].hi - plan[plan.length - 1].lo < plan[0].hi - plan[0].lo);
  }
});

test('calibration across independent campaigns: >= 80% of approach intervals cover the truth', () => {
  const truth = defaultTruth(); const tc = Object.fromEntries(Object.keys(APPROACHES).map(a => [a, truthContinuity(a, truth, 500, 7)]));
  let cov = 0, tot = 0;
  for (const seed of [11, 23, 37, 51, 68]) {
    const camp = simulateCampaign({ seed }); const mm = R.buildModel(camp, planned);
    const draws = R.drawThetas(mm.fit.theta, mm.fit.L, mm.fit.P, 250, makeRng(seed));
    for (const a of Object.keys(APPROACHES)) {
      const p = R.predictPath(mm, R.pathDesign(planned[a], mm.cells), { draws, runsPerDraw: 1 });
      tot++; if (p.lo <= tc[a] && tc[a] <= p.hi) cov++;
    }
  }
  assert.ok(cov / tot >= 0.8, `coverage ${cov}/${tot}`);
});
