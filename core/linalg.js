// Small dense linear algebra on Float64Array row-major matrices (n <= ~500).

export function cholesky(A, n) {
  const L = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    let s = A[j * n + j];
    for (let k = 0; k < j; k++) s -= L[j * n + k] * L[j * n + k];
    if (s <= 0) throw new Error('matrix not positive definite at ' + j);
    const d = Math.sqrt(s); L[j * n + j] = d;
    for (let i = j + 1; i < n; i++) {
      let t = A[i * n + j];
      const Li = i * n, Lj = j * n;
      for (let k = 0; k < j; k++) t -= L[Li + k] * L[Lj + k];
      L[i * n + j] = t / d;
    }
  }
  return L;
}

export function cholSolve(L, n, b) {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]; y[i] = s / L[i * n + i]; }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
  return x;
}

export const logDetFromChol = (L, n) => { let s = 0; for (let i = 0; i < n; i++) s += 2 * Math.log(L[i * n + i]); return s; };

export function cholInverse(L, n) {
  const inv = new Float64Array(n * n); const e = new Float64Array(n);
  for (let j = 0; j < n; j++) { e.fill(0); e[j] = 1; const c = cholSolve(L, n, e); for (let i = 0; i < n; i++) inv[i * n + j] = c[i]; }
  return inv;
}

/** Solve L^T x = z (for sampling from N(mu, H^-1) when L = chol(H)). */
export function cholSolveUpperT(L, n, z) {
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = z[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
  return x;
}

export const normCdf = x => {
  // Abramowitz-Stegun 7.1.26 via erf
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
};
