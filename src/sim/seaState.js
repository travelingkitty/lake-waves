// The one place that turns a GLERL forecast hour into a sea surface.
//
// The renderer (water.js) and the check script (scripts/check-sim.mjs) both
// build the surface from these functions, so what you see on screen and what
// the test measures are the same waves.
//
// Inputs from GLERL: significant wave height (ft), wind speed (mph) and the
// compass point the wind blows from. GLERL's point product has no wave period
// or wave direction, so:
//   * peak period comes from the JONSWAP fetch-limited growth laws, solved for
//     the fetch that gives the forecast height at the forecast wind;
//   * waves travel downwind (a wind sea), spread around that heading.

export const G = 9.81;
export const FT = 0.3048;
export const MPH = 0.44704;
export const N_WAVES = 32;

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Peak period (s) for a wind sea of height hsM (m) under windMs (m/s). */
export function peakPeriod(hsM, windMs) {
  // JONSWAP (Hasselmann et al. 1973), with X = gF/U^2:
  //   g*Hs/U^2 = 0.0016 * X^0.5      g*fp/... : U*fp/g = 3.5 * X^-0.33
  const U = Math.max(windMs, 2.5); // light air: treat the leftover sea as a 2.5 m/s sea
  const hs = Math.max(hsM, 0.02);
  const X = ((G * hs) / (0.0016 * U * U)) ** 2;
  const fp = 3.5 * (G / U) * X ** -0.33;
  return clamp(1 / fp, 1.5, 9);
}

/** Deep-water wavelength (m) for period T (s). */
export const wavelength = T => (G * T * T) / TAU;

// Fixed, seeded "shape" of the sea: each component keeps its frequency ratio,
// direction offset and starting phase forever, so changing the forecast hour
// morphs the same sea instead of re-rolling it.
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Spectral band carried by the explicit waves (f/fp). Shorter waves would read
// as a regular grid with only 32 plane waves, so the renderer draws everything
// shorter than ~Lp/7 as random wind ripples instead (water.js).
const R_MIN = 0.72;
const R_MAX = 2.6;

export const SHAPE = (() => {
  const rnd = mulberry32(20261112);
  const step = Math.log(R_MAX / R_MIN) / (N_WAVES - 1);
  const comps = [];
  for (let i = 0; i < N_WAVES; i++) {
    const r = R_MIN * Math.exp(step * (i + (rnd() - 0.5) * 0.6));
    // Short waves spread wider than the peak (directional spreading broadens
    // away from fp). Triangular draw around the mean heading.
    const spreadDeg = 22 + 38 * clamp((r - 1) / 1.6, 0, 1);
    const off = (rnd() + rnd() - 1) * spreadDeg * (Math.PI / 180);
    comps.push({r, off, phase: rnd() * TAU});
  }
  // Bin widths in r (for the discrete spectrum), then JONSWAP weights.
  const dr = comps.map((c, i) => {
    const lo = i === 0 ? c.r / Math.exp(step / 2) : Math.sqrt(c.r * comps[i - 1].r);
    const hi = i === N_WAVES - 1 ? c.r * Math.exp(step / 2) : Math.sqrt(c.r * comps[i + 1].r);
    return hi - lo;
  });
  const gamma = 3.3;
  const S = comps.map(({r}) => {
    const sigma = r <= 1 ? 0.07 : 0.09;
    const peak = gamma ** Math.exp(-((r - 1) ** 2) / (2 * sigma * sigma));
    return r ** -5 * Math.exp(-1.25 * r ** -4) * peak;
  });
  const total = S.reduce((s, v, i) => s + v * dr[i], 0);
  // weight_i = share of the variance m0 carried by component i (sums to 1).
  comps.forEach((c, i) => (c.weight = (S[i] * dr[i]) / total));
  // Re-center the spread so the energy-weighted mean heading is exactly the
  // downwind heading (the random draw alone leaves a few degrees of bias).
  const mx = comps.reduce((s, c) => s + c.weight * Math.sin(c.off), 0);
  const mz = comps.reduce((s, c) => s + c.weight * Math.cos(c.off), 0);
  const bias = Math.atan2(mx, mz);
  comps.forEach(c => (c.off -= bias));
  return comps;
})();

/**
 * Sea state for one forecast hour.
 * @param {{hsFt:number, windMph:number, windFromDeg:number}} f
 */
export function seaState({hsFt, windMph, windFromDeg}) {
  const hs = Math.max(0, hsFt) * FT;
  const windMs = Math.max(0, windMph) * MPH;
  const tp = peakPeriod(hs, windMs);
  // Waves run downwind: a north wind (from 0°) pushes them toward 180°.
  const towardDeg = ((windFromDeg ?? 0) + 180) % 360;
  return {hsFt, hs, windMph, windMs, tp, lp: wavelength(tp), towardDeg, windFromDeg};
}

/**
 * Component list for a sea state. Amplitudes are set so the variance of the
 * surface is (Hs/4)^2, i.e. 4*sqrt(m0) of the simulated surface == forecast Hs.
 * World axes: +x east, +z south, y up. Bearing b -> (sin b, -cos b).
 */
export function components(sea) {
  const m0 = (sea.hs / 4) ** 2;
  const fp = 1 / sea.tp;
  const toward = (sea.towardDeg * Math.PI) / 180;
  return SHAPE.map(c => {
    const f = c.r * fp;
    const omega = TAU * f;
    const k = (omega * omega) / G; // deep water dispersion
    const b = toward + c.off;
    return {
      amp: Math.sqrt(2 * c.weight * m0),
      k,
      omega,
      bearing: b, // direction of travel (rad, clockwise from north)
      dx: Math.sin(b),
      dz: -Math.cos(b),
      phase0: c.phase,
    };
  });
}

/** Surface elevation (m) at (x,z) given per-component accumulated phases. */
export function elevation(comps, phases, x, z) {
  let eta = 0;
  for (let i = 0; i < comps.length; i++) {
    const c = comps[i];
    eta += c.amp * Math.sin(c.k * (c.dx * x + c.dz * z) - phases[i]);
  }
  return eta;
}

/**
 * "Virtual buoy": measure Hs off the simulated surface itself, as 4 * std of
 * elevation over a patch of water (what a wave-staff array would report).
 */
export function measureHs(comps, phases, {size = 600, n = 40, cx = 0, cz = 0} = {}) {
  let s = 0;
  let s2 = 0;
  const count = n * n;
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      // Jittered grid avoids locking onto a wavelength.
      const x = cx + ((a + 0.5 + 0.37 * Math.sin(b * 12.9898)) / n - 0.5) * size;
      const z = cz + ((b + 0.5 + 0.37 * Math.sin(a * 78.233)) / n - 0.5) * size;
      const e = elevation(comps, phases, x, z);
      s += e;
      s2 += e * e;
    }
  }
  const mean = s / count;
  return 4 * Math.sqrt(Math.max(0, s2 / count - mean * mean));
}

/** Smoothly move a sea state toward a target (for scrubbing / playback). */
export function approach(cur, target, dt, tau = 0.9) {
  if (!cur) return {...target};
  const a = 1 - Math.exp(-dt / tau);
  const lerp = (p, q) => p + (q - p) * a;
  // Interpolate heading along the short way round.
  let d = ((target.towardDeg - cur.towardDeg + 540) % 360) - 180;
  const towardDeg = (cur.towardDeg + d * a + 360) % 360;
  const hs = lerp(cur.hs, target.hs);
  const tp = lerp(cur.tp, target.tp);
  return {
    ...target,
    hs,
    hsFt: hs / FT,
    tp,
    lp: wavelength(tp),
    windMs: lerp(cur.windMs, target.windMs),
    windMph: lerp(cur.windMph, target.windMph),
    towardDeg,
  };
}
