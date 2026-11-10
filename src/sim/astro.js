// Where the sun, the moon and the stars are over Montrose at a given moment.
// Low-precision almanac formulas (a fraction of a degree), which is plenty for a painting:
// the point is that Orion really does climb out of the lake on a November evening
// and the moon is in the right place with the right phase.

const R = Math.PI / 180;
const sind = x => Math.sin(x * R);

const horizon = (ra, dec, lst, la) => {
  const H = lst - ra;
  const el = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(H));
  return {az: ((az / R) + 360) % 360, el: el / R};
};

/**
 * Lift by the air: near the horizon the atmosphere bends light about half a degree, so the sun
 * and moon are still in view when geometry says they have gone. With it, the disc touches the
 * lake at the almanac's rise and set times. (Saemundsson's formula; faded out below the horizon.)
 */
const refract = el => {
  const h = Math.max(el, -1);
  const lift = 1.02 / Math.tan((h + 10.3 / (h + 5.11)) * R) / 60;
  return el + lift * Math.min(1, Math.max(0, (el + 6) / 5));
};

/**
 * @returns {{az: number, el: number, moon: {az: number, el: number, lit: number}, lst: number, lat: number}}
 *   az/el: the sun (degrees). moon.lit: illuminated fraction 0..1.
 *   lst: local sidereal time (radians), lat: latitude (radians) — together they orient the star dome.
 */
export function celestial(ms, lat, lon) {
  const d = ms / 86400000 + 2440587.5 - 2451545.0;
  const la = lat * R;
  const eps = (23.439 - 0.00000036 * d) * R;
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const lst = ((((gmst * 15 + lon) % 360) + 360) % 360) * R;

  // Sun
  const g = (357.529 + 0.98560028 * d) * R;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * R;
  const sra = Math.atan2(Math.cos(eps) * Math.sin(L), Math.cos(L));
  const sdec = Math.asin(Math.sin(eps) * Math.sin(L));
  const sun = horizon(sra, sdec, lst, la);
  sun.el = refract(sun.el);

  // Moon
  const T = d / 36525;
  const lam = (218.32 + 481267.881 * T + 6.29 * sind(135.0 + 477198.87 * T) - 1.27 * sind(259.3 - 413335.36 * T)
    + 0.66 * sind(235.7 + 890534.22 * T) + 0.21 * sind(269.9 + 954397.74 * T)
    - 0.19 * sind(357.5 + 35999.05 * T) - 0.11 * sind(186.5 + 966404.03 * T)) * R;
  const bet = (5.13 * sind(93.3 + 483202.02 * T) + 0.28 * sind(228.2 + 960400.89 * T)
    - 0.28 * sind(318.3 + 6003.15 * T) - 0.17 * sind(217.6 - 407332.21 * T)) * R;
  const x = Math.cos(bet) * Math.cos(lam);
  const y = Math.cos(eps) * Math.cos(bet) * Math.sin(lam) - Math.sin(eps) * Math.sin(bet);
  const z = Math.sin(eps) * Math.cos(bet) * Math.sin(lam) + Math.cos(eps) * Math.sin(bet);
  const mra = Math.atan2(y, x);
  const mdec = Math.asin(z);
  const moon = horizon(mra, mdec, lst, la);
  moon.el -= 0.95 * Math.cos(moon.el * R); // parallax: the moon is close enough to sit lower than its geocentric place
  moon.el = refract(moon.el);
  const cosElong = Math.sin(sdec) * Math.sin(mdec) + Math.cos(sdec) * Math.cos(mdec) * Math.cos(sra - mra);
  moon.lit = (1 - cosElong) / 2;

  return {az: sun.az, el: sun.el, moon, lst, lat: la};
}

/**
 * Rows are the world axes (east, up, south) written in equatorial coordinates, so
 * world = M · e. Handed to GLSL as a column-major mat3 it is Mᵀ, i.e. e = uStarRot * d.
 */
export function starFrame(lst, la) {
  const sl = Math.sin(lst), cl = Math.cos(lst), sp = Math.sin(la), cp = Math.cos(la);
  return new Float32Array([-sl, cl, 0, cp * cl, cp * sl, sp, sp * cl, sp * sl, -cp]);
}

// The stars you can actually pick out over a city lakefront: [RA deg, Dec deg, magnitude, warmth 0 blue .. 1 orange]
const CATALOG = [
  [101.287, -16.716, -1.46, 0.25], // Sirius
  [213.915, 19.182, -0.05, 0.85],  // Arcturus
  [279.235, 38.784, 0.03, 0.2],    // Vega
  [79.172, 45.998, 0.08, 0.6],     // Capella
  [78.634, -8.202, 0.13, 0.05],    // Rigel
  [114.825, 5.225, 0.34, 0.4],     // Procyon
  [88.793, 7.407, 0.5, 1.0],       // Betelgeuse
  [297.696, 8.868, 0.77, 0.3],     // Altair
  [68.98, 16.509, 0.85, 0.95],     // Aldebaran
  [201.298, -11.161, 0.97, 0.05],  // Spica
  [247.352, -26.432, 1.06, 1.0],   // Antares
  [116.329, 28.026, 1.14, 0.75],   // Pollux
  [344.413, -29.622, 1.16, 0.25],  // Fomalhaut
  [310.358, 45.28, 1.25, 0.25],    // Deneb
  [152.093, 11.967, 1.35, 0.1],    // Regulus
  [113.65, 31.888, 1.58, 0.25],    // Castor
  [81.283, 6.35, 1.64, 0.05],      // Bellatrix
  [81.573, 28.608, 1.65, 0.1],     // Elnath
  [84.053, -1.202, 1.69, 0.05],    // Alnilam  \
  [85.19, -1.943, 1.77, 0.05],     // Alnitak   } Orion's belt
  [83.002, -0.299, 2.23, 0.05],    // Mintaka  /
  [86.939, -9.67, 2.09, 0.05],     // Saiph
  [165.932, 61.751, 1.79, 0.75],   // Dubhe    \
  [165.46, 56.382, 2.37, 0.2],     // Merak     |
  [178.458, 53.695, 2.44, 0.2],    // Phecda    |
  [183.857, 57.033, 3.31, 0.2],    // Megrez    } the Big Dipper
  [193.507, 55.96, 1.77, 0.2],     // Alioth    |
  [200.981, 54.925, 2.27, 0.2],    // Mizar     |
  [206.885, 49.313, 1.86, 0.1],    // Alkaid   /
  [37.954, 89.264, 1.98, 0.5],     // Polaris
  [10.127, 56.537, 2.23, 0.8],     // Schedar  \
  [2.295, 59.15, 2.27, 0.45],      // Caph      |
  [14.177, 60.717, 2.47, 0.05],    // Gamma Cas } Cassiopeia
  [21.454, 60.235, 2.68, 0.25],    // Ruchbah   |
  [28.599, 63.67, 3.37, 0.1],      // Segin    /
  [56.871, 24.105, 2.87, 0.05],    // Alcyone (the Pleiades)
  [2.097, 29.09, 2.06, 0.1],       // Alpheratz
  [51.081, 49.861, 1.79, 0.45],    // Mirfak
  [47.042, 40.956, 2.1, 0.1],      // Algol
  [31.793, 23.462, 2.0, 0.8],      // Hamal
  [99.428, 16.399, 1.93, 0.2],     // Alhena
  [177.265, 14.572, 2.14, 0.2],    // Denebola
  [305.557, 40.257, 2.2, 0.5],     // Sadr
  [292.68, 27.96, 3.1, 0.85],      // Albireo
];

/** Unit vectors in equatorial coordinates, a painter's brightness (compressed magnitudes) and warmth. */
export const STARS = CATALOG.map(([ra, dec, mag, warm]) => ({
  e: [Math.cos(dec * R) * Math.cos(ra * R), Math.cos(dec * R) * Math.sin(ra * R), Math.sin(dec * R)],
  b: Math.pow(2.512, (1.5 - mag) * 0.6),
  warm,
}));
