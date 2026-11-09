// From the buoy to the beach.
//
// Takes the offshore sea (seaState.components) onto a NE-facing Chicago beach
// with a sandbar and works out, for every distance from shore, what each wave
// component does:
//   * slows and shortens  — linear dispersion  ω² = g k tanh(k h)
//   * bends toward shore  — Snell's law (alongshore wavenumber conserved)
//   * grows               — shoaling + refraction (energy flux conserved)
//   * breaks              — wave height capped at GAMMA × depth (random waves)
// The renderer samples this as a texture; the test samples the same numbers.
//
// Shore frame: s = metres alongshore (+s = bearing FACE+90), d = metres
// offshore (+d = bearing FACE). World render axes: x = s, z = -d, y up.

import {G, N_WAVES} from './seaState.js';

export let FACE = 45; // bearing of the beach's seaward normal (Montrose: set from the map)
export let D0 = 1500; // m offshore; beyond this the lake is treated as uniform depth
export const TW = 512; // samples across the nearshore
export const GAMMA = 0.6; // breaking: Hs ≤ 0.6 h (Thornton & Guza: Hrms ≈ 0.42 h)
const R = Math.PI / 180;

// Seabed along the beach normal. Default: a generic barred Chicago beach.
// configureBeach() swaps in Montrose's real profile (scripts/build-montrose.mjs:
// NOAA bathymetry offshore, a modelled bar-free surf-zone envelope inshore).
let PROFILE = [
  [0, 0], [8, 0.7], [30, 1.3], [60, 1.9], [85, 2.15], [110, 1.75], [140, 2.4],
  [200, 3.4], [300, 5.0], [600, 8.5], [1000, 12.5], [1500, 17.0],
];
let SHIFT = 0; // lake level above the level the profile was mapped at (m)
let SMOOTH = true;

/**
 * @param {{face:number, D0:number, profile:number[][], levelShift?:number}} b
 *   profile: [distance offshore m, depth m] pairs, monotone.
 */
export function configureBeach({face, D0: d0, profile, levelShift = 0}) {
  FACE = face;
  D0 = d0;
  PROFILE = profile;
  SHIFT = levelShift;
  SMOOTH = false; // dense measured profile: linear interpolation
}

/** Still-water depth (m) at d metres offshore. */
export function depth(d) {
  if (d <= 0) return 0;
  if (d >= D0) return Math.max(0.02, PROFILE.at(-1)[1] + SHIFT);
  let i = 1;
  while (PROFILE[i][0] < d) i++;
  const [d0, h0] = PROFILE[i - 1];
  const [d1, h1] = PROFILE[i];
  const t = (d - d0) / (d1 - d0);
  const f = SMOOTH ? 0.5 - 0.5 * Math.cos(Math.PI * t) : t;
  return Math.max(0.02, h0 + (h1 - h0) * f + SHIFT);
}

/** Depth for wave maths: never exactly zero at the waterline. */
const wetDepth = d => Math.max(depth(d), 0.02);

/** Distance offshore for table column j (denser near the beach). */
export const dAt = j => D0 * (j / (TW - 1)) ** 2;

/** Wavenumber for angular frequency ω in depth h (Guo 2002 + one Newton step). */
export function waveNumber(omega, h) {
  const y = (omega * omega * h) / G;
  let kh = y / (1 - Math.exp(-(y ** 1.25))) ** 0.4;
  if (kh < 20) {
    const t = Math.tanh(kh);
    const f = kh * t - y;
    const df = t + kh * (1 - t * t);
    kh -= f / df;
  }
  return kh / h;
}

function groupVelocity(omega, k, h) {
  const kh = k * h;
  const n = kh > 10 ? 0.5 : 0.5 * (1 + (2 * kh) / Math.sinh(2 * kh));
  return (omega / k) * n;
}

/**
 * Transform an offshore sea onto the beach.
 * @param comps components(sea) from seaState.js
 * @param sea   the sea state (for Tp, Hs)
 * @returns {{table: Float32Array, deep: Float32Array, H: Float32Array, unbroken: Float32Array, report: object}}
 *   table: TW × (N+1) RGBA texels. Row i<N: (phase integral Ψ, amplitude, kx, 0).
 *          Row N: (depth h, foam 0..1, Hs, Gerstner chop).
 *   deep:  N × (ky, kx at D0, amplitude, Ψ at D0); for d ≥ D0, Ψ = Ψ(D0) + kx·(d − D0).
 */
export function transform(comps, sea) {
  const N = comps.length;
  const table = new Float32Array(TW * (N + 1) * 4);
  const deep = new Float32Array(N * 4);
  const hD0 = depth(D0);
  const shore = (FACE + 180) * R;

  const info = comps.map(c => {
    const kD = waveNumber(c.omega, hD0);
    const rel = c.bearing - FACE * R; // travel bearing relative to the seaward normal
    const ky = kD * Math.sin(rel);
    const kxD = -kD * Math.cos(rel); // > 0 when the wave is heading for the beach
    const onshore = kxD > 0.08 * kD;
    return {c, kD, ky, kxD, onshore, cgD: groupVelocity(c.omega, kD, hD0), cosD: kxD / kD};
  });

  // Per-column linear (unbroken) amplitudes and wavenumbers.
  const lin = new Float32Array(TW * N);
  const kxs = new Float32Array(TW * N);
  const ks = new Float32Array(TW * N);
  const Hlin = new Float32Array(TW);
  for (let j = 0; j < TW; j++) {
    const d = dAt(j);
    const h = wetDepth(d);
    let e = 0;
    info.forEach((w, i) => {
      let a;
      let kx;
      let k;
      if (w.onshore) {
        k = waveNumber(w.c.omega, h);
        kx = Math.sqrt(Math.max(k * k - w.ky * w.ky, 1e-9));
        const Ks = Math.sqrt(w.cgD / groupVelocity(w.c.omega, k, h));
        const Kr = Math.sqrt(w.cosD / (kx / k));
        a = w.c.amp * Ks * Kr;
      } else {
        // Running along or away from the beach: never reaches it.
        k = w.kD;
        kx = w.kxD;
        a = w.c.amp * Math.min(1, Math.max(0, (d - 0.3 * D0) / (0.7 * D0)));
      }
      lin[j * N + i] = a;
      kxs[j * N + i] = kx;
      ks[j * N + i] = k;
      e += (a * a) / 2;
    });
    Hlin[j] = 4 * Math.sqrt(e);
  }

  // March shoreward: shoal the (possibly already broken) height, cap at GAMMA·h.
  const H = new Float32Array(TW);
  const foam = new Float32Array(TW);
  let breakJ = -1;
  let unbrokenAtBreak = 0;
  H[TW - 1] = Hlin[TW - 1];
  for (let j = TW - 2; j >= 0; j--) {
    const h = wetDepth(dAt(j));
    const grown = Hlin[j + 1] > 0 ? H[j + 1] * (Hlin[j] / Hlin[j + 1]) : 0;
    H[j] = Math.min(grown, GAMMA * h);
    const dd = dAt(j + 1) - dAt(j);
    const rate = grown > 1e-6 ? (grown - H[j]) / grown / dd : 0; // fraction lost per metre
    foam[j] = Math.min(1, Math.max(rate * 40, foam[j + 1] * Math.exp(-dd / 30)));
    if (breakJ < 0 && rate * 40 > 0.03 && dAt(j) > 1) {
      breakJ = j;
      unbrokenAtBreak = grown;
    }
  }

  // Phase integral Ψ(d) = Ψ(D0) − ∫_d^D0 kx, so Ψ = kx(D0)·d offshore of D0.
  const psi = new Float64Array(N);
  info.forEach((w, i) => (psi[i] = w.kxD * D0));
  for (let j = TW - 1; j >= 0; j--) {
    const d = dAt(j);
    const h = wetDepth(d);
    const B = Hlin[j] > 1e-6 ? H[j] / Hlin[j] : 0;
    let sumAK = 0;
    for (let i = 0; i < N; i++) {
      if (j < TW - 1) {
        const dd = dAt(j + 1) - d;
        psi[i] -= 0.5 * (kxs[j * N + i] + kxs[(j + 1) * N + i]) * dd;
      }
      const a = lin[j * N + i] * B;
      table.set([psi[i], a, kxs[j * N + i], 0], (i * TW + j) * 4);
      sumAK += a * ks[j * N + i];
    }
    table.set([h, foam[j], H[j], Math.min(1, 0.85 / Math.max(sumAK, 1e-6))], (N * TW + j) * 4);
  }
  // Measure phase from the sandbar (Ψ = 0 at 100 m), so a change of sea state
  // barely shifts the waves where you watch them break.
  info.forEach((w, i) => {
    const ref = sample(table, i, 100)[0];
    for (let j = 0; j < TW; j++) table[(i * TW + j) * 4] -= ref;
    deep.set([w.ky, w.kxD, w.c.amp, w.kxD * D0 - ref], i * 4);
  });

  // Surf report at the outermost break.
  let report = {breaking: false};
  if (breakJ >= 0) {
    const d = dAt(breakJ);
    const hb = unbrokenAtBreak;
    const slope = Math.abs(depth(d + 8) - depth(Math.max(0, d - 8))) / 16 || 0.02;
    const L0 = (G * sea.tp * sea.tp) / (2 * Math.PI);
    const xi = Math.max(slope, 0.015) / Math.sqrt(Math.max(hb, 0.01) / L0);
    // Energy-weighted wave angle at the break -> longshore current
    // (Longuet-Higgins 1970: V ≈ 1.17·√(g·Hrms)·sinα·cosα).
    let sx = 0;
    let sz = 0;
    info.forEach((w, i) => {
      if (!w.onshore) return;
      const e = lin[breakJ * N + i] ** 2;
      const k = ks[breakJ * N + i];
      sx += e * (w.ky / k);
      sz += e * (kxs[breakJ * N + i] / k);
    });
    const ab = Math.atan2(sx, sz);
    const drift = 1.17 * Math.sqrt(G * (hb / 1.416)) * Math.sin(ab) * Math.cos(ab);
    report = {
      breaking: true,
      breakerFt: hb / 0.3048,
      distance: d,
      depth: depth(d),
      type: xi < 0.4 ? 'spilling' : xi < 2 ? 'plunging' : 'surging',
      iribarren: xi,
      angleDeg: ab / R,
      driftMs: Math.abs(drift),
      driftBearing: (((FACE + (drift >= 0 ? 90 : -90)) % 360) + 360) % 360,
    };
  }
  // Wave runup (Stockdon et al. 2006, dissipative beaches): R2% ≈ 0.043·√(H0·L0).
  const L0 = (G * sea.tp * sea.tp) / (2 * Math.PI);
  report.runup = 0.043 * Math.sqrt(Math.max(sea.hs, 0) * L0);
  return {table, deep, H, unbroken: Hlin, report};
}

/** Look up row r of the table at distance d (linear in the sqrt-spaced columns). */
export function sample(table, row, d) {
  const u = Math.sqrt(Math.min(1, Math.max(0, d / D0))) * (TW - 1);
  const j = Math.min(TW - 2, Math.floor(u));
  const f = u - j;
  const a = (row * TW + j) * 4;
  const b = a + 4;
  return [0, 1, 2, 3].map(c => table[a + c] + (table[b + c] - table[a + c]) * f);
}

/** Surface elevation at (s, d), exactly as the vertex shader computes it. */
export function shoreElevation({table, deep}, phases, s, d) {
  const N = deep.length / 4;
  let eta = 0;
  for (let i = 0; i < N; i++) {
    const ky = deep[i * 4];
    let psi;
    let a;
    if (d >= D0) {
      psi = deep[i * 4 + 3] + deep[i * 4 + 1] * (d - D0);
      a = deep[i * 4 + 2];
    } else {
      const t = sample(table, i, Math.max(d, 0));
      psi = t[0];
      a = d > 0 ? t[1] : 0;
    }
    eta += a * Math.sin(ky * s - psi - phases[i]);
  }
  return eta;
}

export {N_WAVES};
