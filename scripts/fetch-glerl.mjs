// Pulls the GLERL Experimental Point-Based Ensemble Wave Forecast for one
// Great Lakes station (the same Plotly figure the GLERL WW3 page draws when you
// click a buoy) and writes a small, flat JSON the site reads.
//
//   npm run data            -> Chicago Buoy (45198)
//   npm run data -- 45174   -> any station id GLERL publishes
//
// Source page: https://www.glerl.noaa.gov/emf/waves/WW3/?pg=ww3
// No dependencies; Node 18+ (global fetch).

import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const STATIONS = {
  45198: {name: 'Chicago Buoy', lat: 41.892, lon: -87.563},
  45174: {name: 'Wilmette Buoy', lat: 42.135, lon: -87.655},
  45186: {name: 'Waukegan Buoy', lat: 42.368, lon: -87.795},
  45170: {name: 'Michigan City Buoy', lat: 41.755, lon: -86.968},
  45007: {name: 'South Michigan (43 NM ESE of Milwaukee)', lat: 42.674, lon: -87.026},
};

const id = process.argv[2] ?? '45198';
const url = `https://www.glerl.noaa.gov/emf/waves/WW3/xgb/fig/${id}.json`;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'data', `${id}.json`);

const COMPASS = {N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5};

// Plotly can ship numeric arrays as base64 typed arrays: {dtype:'f8', bdata:'...'}.
function values(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v.bdata === 'string') {
    const TYPES = {f8: Float64Array, f4: Float32Array, i4: Int32Array, i2: Int16Array,
      i1: Int8Array, u4: Uint32Array, u2: Uint16Array, u1: Uint8Array};
    const T = TYPES[v.dtype];
    if (!T) throw new Error(`Unknown Plotly dtype ${v.dtype}`);
    const buf = Buffer.from(v.bdata, 'base64');
    return Array.from(new T(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)));
  }
  return [];
}

const clean = (a, digits = 2) =>
  a.map(v => (v == null || Number.isNaN(+v) ? null : +(+v).toFixed(digits)));

const res = await fetch(url, {headers: {'User-Agent': 'lake-waves-dashboard'}});
if (!res.ok) throw new Error(`GLERL returned ${res.status} for ${url}`);
const fig = await res.json();
const traces = fig.data;

const find = (pred, what) => {
  const i = traces.findIndex(pred);
  if (i < 0) throw new Error(`Could not find the ${what} series in ${url}`);
  return i;
};
const named = (prefix, group) => t =>
  (t.name ?? '').startsWith(prefix) && (!group || t.legendgroup === group);

const iAvg = find(named('Average', 'ens'), 'ensemble average');
const i90 = find(named('10–90'), '10–90 percentile band');
const i75 = find(named('25–75'), '25–75 percentile band');
const iXgb = find(named('XGBoost', 'xgb'), 'XGBoost');
const iWw3 = find(named('WW3', 'ww3'), 'WAVEWATCH III');
// Winds carry [mph, compass] in customdata.
const iGefsWind = find(t => t.legendgroup === 'wnd_gefs' && Array.isArray(t.customdata) && t.customdata.length > 10, 'GEFS wind');
const iHrrrWind = find(t => t.legendgroup === 'wnd_xgb' && Array.isArray(t.customdata) && t.customdata.length > 10, 'HRRR+GFS wind');

const time = traces[iAvg].x.map(s => Date.parse(s));
for (let i = 1; i < time.length; i++) {
  if (time[i] - time[i - 1] !== 3600e3) throw new Error('Expected an hourly series');
}

const wind = i => {
  const cd = traces[i].customdata;
  const ys = values(traces[i].y);
  return {
    mph: clean(cd.map((c, k) => (Number.isFinite(ys[k]) ? c[0] : null)), 1),
    from: cd.map((c, k) => (Number.isFinite(ys[k]) ? c[1] : null)),
    fromDeg: cd.map((c, k) => (Number.isFinite(ys[k]) ? COMPASS[c[1]] ?? null : null)),
  };
};

const init = (fig.layout.annotations ?? [])
  .map(a => /Initialized:\s*([\d-]+)\s+([\d:]+)\s*UTC/.exec(a.text ?? ''))
  .find(Boolean);

const data = {
  station: {id, ...(STATIONS[id] ?? {name: `Station ${id}`})},
  source: {
    page: 'https://www.glerl.noaa.gov/emf/waves/WW3/?pg=ww3',
    figure: url,
    product: 'GLERL Experimental Point-Based Ensemble Wave Forecast',
    initialized: init ? `${init[1]}T${init[2]}:00Z` : null,
    lastModified: res.headers.get('last-modified'),
    fetchedAt: new Date().toISOString(),
  },
  units: {height: 'ft', wind: 'mph', time: 'epoch ms (UTC)'},
  time,
  hs: {
    ens: clean(values(traces[iAvg].y)),
    p10: clean(values(traces[i90 - 1].y)),
    p90: clean(values(traces[i90].y)),
    p25: clean(values(traces[i75 - 1].y)),
    p75: clean(values(traces[i75].y)),
    xgb: clean(values(traces[iXgb].y)),
    ww3: clean(values(traces[iWw3].y)),
  },
  wind: {gefs: wind(iGefsWind), hrrr: wind(iHrrrWind)},
};

await mkdir(dirname(out), {recursive: true});
await writeFile(out, JSON.stringify(data));

const fmt = ms => new Date(ms).toLocaleString('en-US', {timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric'});
const peak = data.hs.ens.reduce((best, v, k) => (v > (data.hs.ens[best] ?? -1) ? k : best), 0);
console.log(`${data.station.name} (${id}) — run ${data.source.initialized}`);
console.log(`  ${time.length} hours, ${fmt(time[0])} → ${fmt(time.at(-1))} CT`);
console.log(`  ensemble peak ${data.hs.ens[peak]} ft at ${fmt(time[peak])} CT, wind ${data.wind.gefs.from[peak]} ${data.wind.gefs.mph[peak]} mph`);
console.log(`  wrote ${out}`);
