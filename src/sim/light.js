// The palette: what colour everything is for a given sun height, time of day and weather.
// Keyframes are a painter's idea of the lakefront, a little more vivid than life.
//
// Two sets of keys share the night and the high sun and differ around the horizon:
// dusk is rose and violet (the sun goes down behind the city), dawn is amber and
// slate over bronze water (the sun comes up out of the lake, on the cold mornings
// when the surf is best).

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const smooth = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// el = sun elevation in degrees.
// Night is a nocturne, not a blackout: deep blue you can still read the waves in.
const NIGHT = {el: -18, zenith: [0.036, 0.064, 0.165], horizon: [0.11, 0.165, 0.31], glow: [0, 0, 0], venus: [0, 0, 0], sun: [0, 0, 0],
  cloud: [0.2, 0.24, 0.38], dark: [0.055, 0.072, 0.14], deep: [0.014, 0.038, 0.088], scatter: [0.042, 0.115, 0.175]};
const HIGH = [
  {el: 16, zenith: [0.12, 0.31, 0.7], horizon: [0.74, 0.82, 0.88], glow: [0.5, 0.36, 0.18], venus: [0.05, 0.03, 0.05], sun: [1.9, 1.6, 1.15],
    cloud: [1.08, 1.0, 0.9], dark: [0.4, 0.44, 0.6], deep: [0.01, 0.07, 0.115], scatter: [0.05, 0.28, 0.28]},
  {el: 40, zenith: [0.1, 0.3, 0.72], horizon: [0.64, 0.82, 0.94], glow: [0.25, 0.22, 0.14], venus: [0, 0, 0], sun: [1.9, 1.75, 1.5],
    cloud: [1.06, 1.04, 1.0], dark: [0.44, 0.5, 0.64], deep: [0.008, 0.075, 0.125], scatter: [0.04, 0.31, 0.31]},
];
const DUSK = [
  NIGHT,
  {el: -7, zenith: [0.04, 0.065, 0.2], horizon: [0.22, 0.17, 0.35], glow: [0.95, 0.3, 0.12], venus: [0.1, 0.06, 0.16], sun: [0, 0, 0],
    cloud: [0.44, 0.24, 0.32], dark: [0.06, 0.065, 0.15], deep: [0.012, 0.026, 0.065], scatter: [0.035, 0.08, 0.13]},
  {el: -1, zenith: [0.1, 0.16, 0.44], horizon: [0.7, 0.42, 0.4], glow: [0.8, 0.32, 0.1], venus: [0.5, 0.24, 0.38], sun: [1.7, 0.5, 0.14],
    cloud: [1.0, 0.48, 0.38], dark: [0.2, 0.14, 0.32], deep: [0.014, 0.042, 0.08], scatter: [0.06, 0.16, 0.18]},
  {el: 5, zenith: [0.14, 0.27, 0.6], horizon: [0.82, 0.58, 0.42], glow: [0.7, 0.36, 0.12], venus: [0.36, 0.2, 0.3], sun: [2.0, 1.05, 0.42],
    cloud: [1.02, 0.74, 0.56], dark: [0.3, 0.24, 0.44], deep: [0.012, 0.06, 0.095], scatter: [0.05, 0.23, 0.23]},
  ...HIGH,
];
const DAWN = [
  NIGHT,
  // first light: the lake still charcoal, a seam of ember along the horizon
  {el: -7, zenith: [0.045, 0.085, 0.23], horizon: [0.3, 0.25, 0.33], glow: [0.7, 0.3, 0.07], venus: [0.08, 0.07, 0.15], sun: [0, 0, 0],
    cloud: [0.46, 0.3, 0.28], dark: [0.055, 0.07, 0.13], deep: [0.014, 0.022, 0.04], scatter: [0.05, 0.075, 0.09]},
  // sunrise: amber horizon through pale gold to a soft blue, slate clouds with peach edges, bronze water
  {el: -1, zenith: [0.17, 0.28, 0.52], horizon: [0.66, 0.44, 0.25], glow: [0.5, 0.24, 0.05], venus: [0.26, 0.19, 0.3], sun: [1.9, 0.78, 0.17],
    cloud: [0.98, 0.6, 0.36], dark: [0.15, 0.17, 0.26], deep: [0.03, 0.034, 0.032], scatter: [0.115, 0.12, 0.07]},
  {el: 5, zenith: [0.2, 0.37, 0.68], horizon: [0.76, 0.62, 0.42], glow: [0.4, 0.24, 0.07], venus: [0.18, 0.15, 0.22], sun: [2.15, 1.3, 0.52],
    cloud: [1.0, 0.78, 0.54], dark: [0.2, 0.235, 0.35], deep: [0.03, 0.045, 0.042], scatter: [0.12, 0.16, 0.105]},
  ...HIGH,
];
const FIELDS = ['zenith', 'horizon', 'glow', 'venus', 'sun', 'cloud', 'dark', 'deep', 'scatter'];

function sample(keys, el) {
  if (el <= keys[0].el) return keys[0];
  const last = keys[keys.length - 1];
  if (el >= last.el) return last;
  let i = 0;
  while (keys[i + 1].el < el) i++;
  const a = keys[i], b = keys[i + 1];
  const t = smooth(a.el, b.el, el);
  const out = {};
  for (const f of FIELDS) out[f] = mix(a[f], b[f], t);
  return out;
}

function palette(el, morning) {
  const dusk = sample(DUSK, el), dawn = sample(DAWN, el);
  const out = {};
  for (const f of FIELDS) out[f] = mix(dusk[f], dawn[f], morning);
  return out;
}

/**
 * @param {number[]} sunDir world-space unit vector to the sun (x east, y up, z south)
 * @param {number} storm 0 calm and clear … 1 gale
 * @param {{dir: number[], lit: number}} [moon] unit vector to the moon and its lit fraction
 */
export function lighting(sunDir, storm, moon) {
  const el = (Math.asin(Math.max(-1, Math.min(1, sunDir[1]))) * 180) / Math.PI;
  const morning = smooth(-0.3, 0.3, sunDir[0]);
  const p = palette(el, morning);
  const day = smooth(-6, 7, el);
  const night = 1 - smooth(-14, -3, el);
  // Weather: a gale turns the high sky to slate-violet and deepens the cloud bases,
  // but the light keeps breaking through. This is a painting, not a webcam.
  const slate = [0.07, 0.085, 0.14].map(v => v * (0.25 + 0.75 * day));
  const zenith = mix(p.zenith, mix(p.zenith, slate, 0.75), storm);
  const horizon = mix(p.horizon, p.horizon.map((v, i) => v * 0.8 + slate[i] * 0.3), storm * 0.7);
  const dark = mix(p.dark, p.dark.map((v, i) => v * 0.5 + slate[i] * 0.35), storm);
  const deep = mix(p.deep, p.deep.map((v, i) => v * 0.8 + [0.004, 0.012, 0.014][i]), storm);
  const scatter = mix(p.scatter, p.scatter.map((v, i) => v * [0.85, 1.0, 0.82][i]), storm);
  // The moon: full strength when it is up and fat, but never nothing. A thin crescent
  // still silvers the foam, because the point of the night is to see the waves.
  const up = moon ? smooth(-0.05, 0.14, moon.dir[1]) : 0;
  const moonPower = night * up * (0.35 + 0.65 * (moon?.lit ?? 0)) * (1 - 0.45 * storm);
  const moonColor = [0.62, 0.74, 1.0].map(v => v * moonPower);
  // Ambient: the sky's own light, plus a floor after dark so breaking water stays luminous.
  const ambient = zenith.map((v, i) => v * 0.45 + horizon[i] * 0.4 + 0.02
    + night * [0.045, 0.066, 0.11][i] + (1 - day) * [0.05, 0.052, 0.075][i] + moonPower * [0.03, 0.04, 0.06][i]);
  return {
    el, day, night, morning, zenith, horizon,
    glow: p.glow.map(v => v * (1 - 0.35 * storm)),
    venus: p.venus.map(v => v * (1 - 0.5 * storm)),
    city: [0.46, 0.27, 0.12].map(v => v * night * (0.55 + 0.45 * storm)),
    sunColor: p.sun,
    sunVis: 1 - 0.6 * storm,
    moonColor,
    ambient,
    cloud: p.cloud.map(v => v * (1 - 0.12 * storm)),
    cloudDark: dark,
    deep, scatter,
    cover: 0.36 + 0.4 * storm,
    // the low bank of lake cloud on the eastern horizon: heaviest on cold mornings
    bank: (0.55 + 0.45 * morning) * (1 - 0.4 * storm),
  };
}
