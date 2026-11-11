// Seeded RNG (mulberry32) with normal, Poisson and lognormal draws. Deterministic across node and browser.
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6D2B79F5) >>> 0; let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  const normal = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let x, y, r; do { x = 2 * u() - 1; y = 2 * u() - 1; r = x * x + y * y; } while (r === 0 || r >= 1);
    const f = Math.sqrt(-2 * Math.log(r) / r); spare = y * f; return x * f;
  };
  const poisson = lam => {
    if (lam > 30) return Math.max(0, Math.round(lam + Math.sqrt(lam) * normal()));
    const L = Math.exp(-lam); let k = 0, p = 1; do { k++; p *= u(); } while (p > L); return k - 1;
  };
  const lognormal = (mu, sigma) => Math.exp(mu + sigma * normal());
  const gamma1 = () => -Math.log(1 - u()); // Exp(1), for Bayesian-bootstrap Dirichlet weights
  return { u, normal, poisson, lognormal, gamma1 };
}
