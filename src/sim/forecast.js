// Reads the flat GLERL JSON (written by scripts/fetch-glerl.mjs) at any
// fractional hour, for any of the three models GLERL plots for a station.

export const MODELS = {
  ens: {label: 'Ensemble', long: 'GEFS 31-member ensemble average', hs: 'ens', wind: 'gefs'},
  xgb: {label: 'XGBoost', long: 'XGBoost (HRRR+GFS winds)', hs: 'xgb', wind: 'hrrr'},
  ww3: {label: 'WW3', long: 'WAVEWATCH III (HRRR+GFS winds)', hs: 'ww3', wind: 'hrrr'},
};

// Chart colors: categorical slots 1–3 of the dataviz reference palette, dark
// steps (validated all-pairs on the panel surface: CVD ΔE ≥ 9.4, normal ≥ 20.9).
export const SERIES_COLORS = {ens: '#3987e5', xgb: '#d95926', ww3: '#199e70'};

const H = 3600e3;

function at(arr, f) {
  const i = Math.floor(f);
  const t = f - i;
  const a = arr[i];
  const b = arr[Math.min(i + 1, arr.length - 1)];
  if (a == null && b == null) return null;
  if (a == null) return t > 0.5 ? b : null;
  if (b == null) return t < 0.5 ? a : null;
  return a + (b - a) * t;
}

function dirAt(deg, f) {
  const i = Math.floor(f);
  const t = f - i;
  const a = deg[i];
  const b = deg[Math.min(i + 1, deg.length - 1)];
  if (a == null) return b;
  if (b == null) return a;
  const r = Math.PI / 180;
  const x = Math.sin(a * r) * (1 - t) + Math.sin(b * r) * t;
  const y = Math.cos(a * r) * (1 - t) + Math.cos(b * r) * t;
  return ((Math.atan2(x, y) / r) + 360) % 360;
}

/** Fractional index into data.time for an epoch ms. */
export const indexOf = (data, ms) =>
  Math.min(data.time.length - 1, Math.max(0, (ms - data.time[0]) / H));

/** Last hour a model has data for (index). */
export function lastIndex(data, model) {
  const a = data.hs[MODELS[model].hs];
  for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return i;
  return -1;
}

/**
 * Conditions at fractional hour f for a model. Falls back to the ensemble
 * (the only series covering all 10 days) when the model has no value there.
 */
export function conditions(data, f, model = 'ens') {
  let m = MODELS[model];
  let hsFt = at(data.hs[m.hs], f);
  const fellBack = hsFt == null && model !== 'ens';
  if (fellBack) {
    m = MODELS.ens;
    hsFt = at(data.hs.ens, f);
  }
  let w = data.wind[m.wind];
  let windMph = at(w.mph, f);
  if (windMph == null) {
    w = data.wind.gefs;
    windMph = at(w.mph, f);
  }
  const i = Math.round(f);
  return {
    model: fellBack ? 'ens' : model,
    fellBack,
    time: data.time[0] + f * H,
    hsFt: hsFt ?? 0,
    windMph: windMph ?? 0,
    windFromDeg: dirAt(w.fromDeg, f) ?? 0,
    windFrom: w.from[i] ?? w.from[Math.floor(f)] ?? '—',
    band: {p10: at(data.hs.p10, f), p90: at(data.hs.p90, f)},
  };
}
