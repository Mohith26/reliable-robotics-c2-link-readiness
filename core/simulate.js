// Synthetic C-Band CNPC uplink logs for a Hollister-style test campaign.
// Ground truth is a Gilbert-Elliott channel whose outage-onset hazard depends on range, on location-fixed
// "dropout regions" (not terrain: finals are line-of-sight clear), on a per-day effect and on a mid-campaign
// radio software update. The campaign schedule mirrors the public FAA BAA #005 report (8 test days in Aug 2025,
// RNAV 13 flown only before the Aug 14 update). Dropout locations and magnitudes are invented.
import { approachPath, approachEnds, transitPath, SAN_MARTIN, GRS, NM } from './geo.js';
import { makeRng } from './rng.js';

export const PACKETS_PER_S = 2;

export const DEFAULT_SCHEDULE = [
  { date: '2025-08-06', post: false, runs: ['RNAV 13', 'RNAV 13', 'RNAV 31', 'RNAV 13', 'RNAV 13', 'RNAV 31', 'RNAV 13'] },
  { date: '2025-08-08', post: false, runs: ['RNAV 13', 'RNAV 13', 'RNAV 13', 'RNAV 13', 'RNAV 13', 'RNAV 13'] },
  { date: '2025-08-11', post: false, runs: ['RNAV 31', 'RNAV 06', 'RNAV 31', 'RNAV 06', 'RNAV 31', 'RNAV 06'] },
  { date: '2025-08-13', post: false, runs: ['RNAV 06', 'RNAV 31', 'RNAV 13', 'RNAV 06', 'RNAV 31', 'RNAV 13', 'RNAV 06'] },
  { date: '2025-08-14', post: false, runs: ['RNAV 13', 'RNAV 13', 'RNAV 13', 'RNAV 13', 'RNAV 13'] },
  { date: '2025-08-18', post: true, runs: ['RNAV 06', 'RNAV 31', 'RNAV 06', 'RNAV 31', 'RNAV 06', 'RNAV 31', 'RNAV 06'] },
  { date: '2025-08-25', post: true, runs: ['RNAV 31', 'RNAV 31', 'RNAV 06', 'RNAV 31', 'RNAV 31', 'RNAV 06', 'RNAV 31'] },
  { date: '2025-08-28', post: true, runs: ['RNAV 06', 'RNAV 31', 'RNAV 06', 'RNAV 31', 'RNAV 06', 'RNAV 31'] },
];

export function defaultTruth() {
  const on = (name, nm) => { const { start, hdg } = approachEnds(name); const d = (10 - nm) * NM; return { e: start.e + Math.sin(hdg * Math.PI / 180) * d, n: start.n + Math.cos(hdg * Math.PI / 180) * d }; };
  return {
    a0: Math.log(0.0040), bRange: 0.6, delta: -0.85,
    day: { '2025-08-06': 0.40, '2025-08-08': 0.85, '2025-08-11': -0.10, '2025-08-13': -0.20, '2025-08-14': 3.30, '2025-08-18': 0.05, '2025-08-25': -0.15, '2025-08-28': 0.10 },
    newDaySd: 0.35,
    hot: [
      { ...on('RNAV 13', 3.5), amp: 3.0, sd: 1100 },
      { ...on('RNAV 13', 7.5), amp: 3.4, sd: 1300 },
      { ...on('RNAV 24', 6.0), amp: 1.5, sd: 500 }, // never flown: an "unknown unknown"
    ],
    durMu: Math.log(1.9), durSigma: 0.65,   // outage duration (s), lognormal
    lossBad: 0.97, randLoss: { pre: 0.003, post: 0.002 },
  };
}

export function logHazard(truth, p, date, post) {
  const r = Math.max(0.3, Math.hypot(p.e - GRS.e, p.n - GRS.n) / 1000);
  let h = truth.a0 + truth.bRange * Math.log(r / 5) + (truth.day[date] ?? 0) + (post ? truth.delta : 0);
  for (const b of truth.hot) h += b.amp * Math.exp(-((p.e - b.e) ** 2 + (p.n - b.n) ** 2) / (2 * b.sd * b.sd));
  return h;
}

/** Simulate packet receipt along a list of per-second samples. Returns bits per second (bit k set = packet k lost). */
export function simulateLink(samples, truth, date, post, rng) {
  const bits = new Uint8Array(samples.length);
  let outLeft = 0; const r = post ? truth.randLoss.post : truth.randLoss.pre;
  for (let s = 0; s < samples.length; s++) {
    if (outLeft <= 0) {
      const h = Math.exp(logHazard(truth, samples[s], date, post));
      if (rng.u() < 1 - Math.exp(-h)) outLeft = Math.max(1, Math.ceil(rng.lognormal(truth.durMu, truth.durSigma) * PACKETS_PER_S));
    }
    let b = 0;
    for (let k = 0; k < PACKETS_PER_S; k++) {
      if (outLeft > 0) { if (rng.u() < truth.lossBad) b |= 1 << k; outLeft--; }
      else if (rng.u() < r) b |= 1 << k;
    }
    bits[s] = b;
  }
  return bits;
}

/** Build one flight: transit from E16, approach runs joined by transits at 4,000 ft, transit back. */
export function buildFlight(runs, rng) {
  const samples = []; const runIdx = [];
  let pos = { e: SAN_MARTIN.e, n: SAN_MARTIN.n };
  for (const name of runs) {
    const ends = approachEnds(name);
    for (const p of transitPath(pos, ends.start, { rng })) samples.push(p);
    const a = approachPath(name, { rng });
    runIdx.push({ approach: name, i0: samples.length, i1: samples.length + a.length });
    for (const p of a) samples.push(p);
    pos = ends.end;
  }
  for (const p of transitPath(pos, SAN_MARTIN, { rng })) samples.push(p);
  return { samples, runs: runIdx };
}

export function simulateCampaign({ seed = 20250806, truth = defaultTruth(), schedule = DEFAULT_SCHEDULE } = {}) {
  const rng = makeRng(seed);
  const days = schedule.map(d => {
    const f = buildFlight(d.runs, rng);
    const bits = simulateLink(f.samples, truth, d.date, d.post, rng);
    return {
      date: d.date, post: d.post, runs: f.runs,
      samples: f.samples.map((p, i) => [Math.round(p.e), Math.round(p.n), Math.round(p.alt_m), bits[i]]),
    };
  });
  return { packets_per_s: PACKETS_PER_S, update_after: '2025-08-14', days };
}
