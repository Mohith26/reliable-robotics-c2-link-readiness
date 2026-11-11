// Terrain covariate: single dominant knife-edge diffraction loss (ITU-R P.526) on the GRS -> aircraft path.
// Used as a physics-informed covariate; the model learns how much of the dropout pattern it explains.

const F_HZ = 5.06e9;               // C-Band CNPC (5030-5091 MHz)
const LAMBDA = 299792458 / F_HZ;   // ~5.9 cm
const K_EARTH = 4 / 3 * 6371000;   // effective earth radius

export function makeTerrain(t) {
  const { e0, n0, res_m, nx, ny, elev_m } = t;
  return function elevAt(e, n) {
    const fx = (e - e0) / res_m, fy = (n - n0) / res_m;
    const i = Math.max(0, Math.min(nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(ny - 2, Math.floor(fy)));
    const ax = Math.min(1, Math.max(0, fx - i)), ay = Math.min(1, Math.max(0, fy - j));
    const z00 = elev_m[j * nx + i], z10 = elev_m[j * nx + i + 1], z01 = elev_m[(j + 1) * nx + i], z11 = elev_m[(j + 1) * nx + i + 1];
    return (z00 * (1 - ax) + z10 * ax) * (1 - ay) + (z01 * (1 - ax) + z11 * ax) * ay;
  };
}

/** ITU-R P.526 knife-edge loss J(v) in dB (0 for v <= -0.78). */
export function knifeEdgeDb(v) {
  if (v <= -0.78) return 0;
  return 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1);
}

/** Max Fresnel-Kirchhoff parameter v along the path and the resulting loss in dB. */
export function diffractionDb(elevAt, grs, grsElev, ac, step_m = 150) {
  const h1 = grsElev + grs.mast_m;
  const D = Math.hypot(ac.e - grs.e, ac.n - grs.n);
  if (D < 2 * step_m) return 0;
  let vmax = -Infinity;
  for (let d1 = step_m; d1 < D - step_m; d1 += step_m) {
    const t = d1 / D, d2 = D - d1;
    const los = h1 + (ac.alt_m - h1) * t;
    const bulge = d1 * d2 / (2 * K_EARTH);
    const obst = elevAt(grs.e + t * (ac.e - grs.e), grs.n + t * (ac.n - grs.n)) + bulge;
    const hgt = obst - los;
    const v = hgt * Math.sqrt(2 * D / (LAMBDA * d1 * d2));
    if (v > vmax) vmax = v;
  }
  return knifeEdgeDb(vmax);
}
