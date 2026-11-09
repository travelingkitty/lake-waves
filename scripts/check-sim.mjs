// Does the water on screen match the forecast?
//
// For every hour from Wednesday noon to Sunday noon (Chicago time) around the
// next Thursday after the forecast run, this builds the exact sea surface the
// renderer draws and measures it the way instruments would:
//   * Hs   — 4·std(elevation) over a 1.2 km patch (and over 30 min at a point)
//   * Tp   — peak of the elevation spectrum at a virtual buoy
//   * dir  — mean wave direction from slope × vertical velocity (pitch-roll buoy)
// and compares with GLERL's forecast. Exit code 1 if any hour is off.
//
//   npm test                 (uses public/data/45198.json)
//   npm test -- 45174        (another station after `npm run data -- 45174`)

import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {components, elevation, measureHs, seaState} from '../src/sim/seaState.js';
import {conditions, indexOf} from '../src/sim/forecast.js';
import {FACE, GAMMA, TW, dAt, depth, sample, shoreElevation, transform} from '../src/sim/surf.js';

const id = process.argv[2] ?? '45198';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(await readFile(join(root, 'public', 'data', `${id}.json`), 'utf8'));
const TZ = 'America/Chicago';

// --- find "next Thursday" after the run, in Chicago time -------------------
const parts = ms => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
}).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
const runMs = Date.parse(data.source.initialized ?? data.time[0]);
let thu = null;
for (let i = 0; i < data.time.length; i++) {
  const p = parts(data.time[i]);
  if (p.weekday === 'Thu' && p.hour === '00' && data.time[i] > runMs) { thu = i; break; }
}
if (thu == null) throw new Error('This forecast run does not reach a Thursday.');
const from = Math.max(0, thu - 12); // Wednesday noon
const to = Math.min(data.time.length - 1, thu + 84); // Sunday noon

const label = ms => new Date(ms).toLocaleString('en-US', {timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric'});

// --- measurements ----------------------------------------------------------
function buoyRecord(comps, seconds = 1800, hz = 8) {
  const n = seconds * hz;
  const dt = 1 / hz;
  const eta = new Float64Array(n);
  let fx = 0, fz = 0;
  const h = 0.05; // m, slope finite difference
  for (let s = 0; s < n; s++) {
    const t = s * dt;
    const ph = comps.map(c => c.omega * t - c.phase0);
    eta[s] = elevation(comps, ph, 0, 0);
    // vertical velocity and slopes at the buoy
    const ph2 = comps.map(c => c.omega * (t + 1e-3) - c.phase0);
    const w = (elevation(comps, ph2, 0, 0) - eta[s]) / 1e-3;
    const sx = (elevation(comps, ph, h, 0) - elevation(comps, ph, -h, 0)) / (2 * h);
    const sz = (elevation(comps, ph, 0, h) - elevation(comps, ph, 0, -h)) / (2 * h);
    fx -= w * sx;
    fz -= w * sz;
  }
  let mean = 0;
  for (const v of eta) mean += v / n;
  let v2 = 0;
  for (const v of eta) v2 += (v - mean) ** 2 / n;
  // Welch spectrum: 64 s Hann segments, 50% overlap (what a buoy processor
  // does), then the peak bin refined by a parabola -> Tp.
  const seg = 64 * hz;
  const win = Array.from({length: seg}, (_, s) => 0.5 - 0.5 * Math.cos((2 * Math.PI * s) / (seg - 1)));
  const bins = [];
  for (let k = 3; k <= 77; k++) bins.push(k); // 0.047–1.2 Hz
  const P = new Float64Array(bins.length);
  for (let start = 0; start + seg <= n; start += seg / 2) {
    bins.forEach((k, b) => {
      let re = 0, im = 0;
      const w = (2 * Math.PI * k) / seg;
      for (let s = 0; s < seg; s++) {
        const v = (eta[start + s] - mean) * win[s];
        re += v * Math.cos(w * s);
        im += v * Math.sin(w * s);
      }
      P[b] += re * re + im * im;
    });
  }
  let ip = 0;
  for (let b = 1; b < P.length; b++) if (P[b] > P[ip]) ip = b;
  let kPeak = bins[ip];
  if (ip > 0 && ip < P.length - 1) {
    const d = (P[ip - 1] - P[ip + 1]) / (2 * (P[ip - 1] - 2 * P[ip] + P[ip + 1]));
    kPeak += Math.max(-0.5, Math.min(0.5, d));
  }
  const fPeak = kPeak / (seg * dt);
  const bearing = ((Math.atan2(fx, -fz) * 180) / Math.PI + 360) % 360;
  return {hsPoint: 4 * Math.sqrt(v2), tp: 1 / fPeak, bearing};
}

const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// --- run -------------------------------------------------------------------
console.log(`\n${data.station.name} (${data.station.id}) · GLERL run ${data.source.initialized}`);
console.log(`Checking ${label(data.time[from])} → ${label(data.time[to])} CT (next Thursday = ${label(data.time[thu]).split(',').slice(0, 2).join(',')})\n`);
console.log('time (CT)            forecast   sim patch  sim buoy   Tp model  Tp buoy   L     wind        waves to  buoy dir');

const fails = [];
let above1 = 0, above2 = 0, thuPeak = 0;
for (let i = from; i <= to; i++) {
  const c = conditions(data, i, 'ens');
  const sea = seaState(c);
  const comps = components(sea);
  const ph = comps.map(k => k.omega * 1234.5 - k.phase0);
  const simPatch = measureHs(comps, ph, {size: 1200, n: 60}) / 0.3048;
  const hourly = (i - from) % 3 === 0;
  const rec = hourly ? buoyRecord(comps) : null;
  if (c.hsFt >= 1) above1++;
  if (c.hsFt >= 2) above2++;
  if (i >= thu && i < thu + 24) thuPeak = Math.max(thuPeak, c.hsFt);

  const errPatch = Math.abs(simPatch - c.hsFt) / Math.max(c.hsFt, 0.3);
  if (errPatch > 0.06) fails.push(`${label(c.time)}: patch Hs ${simPatch.toFixed(2)} vs ${c.hsFt.toFixed(2)} ft`);
  if (rec) {
    const hsBuoy = rec.hsPoint / 0.3048;
    if (Math.abs(hsBuoy - c.hsFt) / Math.max(c.hsFt, 0.3) > 0.12) fails.push(`${label(c.time)}: buoy Hs ${hsBuoy.toFixed(2)} vs ${c.hsFt.toFixed(2)} ft`);
    if (Math.abs(rec.tp - sea.tp) / sea.tp > 0.15) fails.push(`${label(c.time)}: buoy Tp ${rec.tp.toFixed(1)} vs ${sea.tp.toFixed(1)} s`);
    if (angleDiff(rec.bearing, sea.towardDeg) > 10) fails.push(`${label(c.time)}: waves heading ${rec.bearing.toFixed(0)}° vs ${sea.towardDeg.toFixed(0)}°`);
    console.log(
      `${label(c.time).padEnd(20)} ${c.hsFt.toFixed(2).padStart(5)} ft  ${simPatch.toFixed(2).padStart(5)} ft  ${hsBuoy.toFixed(2).padStart(5)} ft  ` +
      `${sea.tp.toFixed(1).padStart(4)} s   ${rec.tp.toFixed(1).padStart(4)} s  ${sea.lp.toFixed(0).padStart(3)} m  ` +
      `${(c.windFrom + ' ' + c.windMph.toFixed(0) + ' mph').padEnd(11)} ${sea.towardDeg.toFixed(0).padStart(4)}°    ${rec.bearing.toFixed(0).padStart(4)}°`,
    );
  }
}

console.log(`\nEvent: ${above1} h with waves ≥ 1 ft, ${above2} h ≥ 2 ft in this window; Thursday peak ${thuPeak.toFixed(1)} ft.`);
if (thuPeak < 2) console.log('Note: this run no longer shows a Thursday wave event at this station.');

// --- the beach -----------------------------------------------------------
// Same hours, now carried onto the surf-cam beach by surf.js. Measures the
// drawn surface (the shader's own formula) along the shore at several
// distances out, and checks it against the transform: shoaled/broken height
// where it should be, never taller than the depth allows.
console.log(`\nAt the beach (faces ${FACE}°; sandbar ~110 m out; break when Hs > ${GAMMA}·depth)`);
console.log('time (CT)            offshore  @300 m drawn/model   @110 m drawn/model   @40 m drawn/model    breakers                 drift');
const PROBES = [300, 110, 40];
for (let i = from; i <= to; i += 3) {
  const c = conditions(data, i, 'ens');
  const sea = seaState(c);
  const comps = components(sea);
  const tr = transform(comps, sea);
  if (![...tr.table, ...tr.deep].every(Number.isFinite)) fails.push(`${label(c.time)}: surf table has non-finite values`);
  for (let j = 0; j < TW; j++) {
    const d = dAt(j);
    if (d > 0.5 && tr.H[j] > GAMMA * Math.max(depth(d), 0.02) + 1e-6) {
      fails.push(`${label(c.time)}: Hs ${tr.H[j].toFixed(2)} m exceeds ${GAMMA}×depth at ${d.toFixed(0)} m`);
      break;
    }
  }
  const cells = PROBES.map(d => {
    const model = sample(tr.table, comps.length, d)[2];
    // 4·std of the drawn elevation over 4 km of shore and 6 moments in time.
    let s2 = 0;
    let n = 0;
    for (let k = 0; k < 6; k++) {
      const ph = comps.map(w => w.omega * (100 + 37.3 * k) - w.phase0);
      for (let s = -2000; s <= 2000; s += 5) {
        const e = shoreElevation(tr, ph, s, d);
        s2 += e * e;
        n++;
      }
    }
    const drawn = 4 * Math.sqrt(s2 / n);
    if (model > 0.03 && Math.abs(drawn - model) / model > 0.1) {
      fails.push(`${label(c.time)}: drawn Hs at ${d} m ${(drawn / 0.3048).toFixed(2)} ft vs model ${(model / 0.3048).toFixed(2)} ft`);
    }
    return `${(drawn / 0.3048).toFixed(1).padStart(4)}/${(model / 0.3048).toFixed(1).padEnd(4)} ft`;
  });
  const r = tr.report;
  const brk = r.breaking ? `${r.breakerFt.toFixed(1)} ft ${r.type} @${r.distance.toFixed(0)} m` : 'flat';
  const drift = r.breaking && r.driftMs > 0.05 ? `${r.driftMs.toFixed(1)} m/s → ${r.driftBearing}°` : '—';
  console.log(`${label(c.time).padEnd(20)} ${c.hsFt.toFixed(1).padStart(5)} ft   ${cells.map(x => x.padEnd(20)).join(' ')} ${brk.padEnd(24)} ${drift}`);
}

if (fails.length) {
  console.log(`\nFAIL — ${fails.length} mismatch(es):\n  ` + fails.join('\n  '));
  process.exit(1);
}
console.log(`PASS — offshore water matches the forecast every hour (Hs within 6% over the patch, 12% at the buoy; Tp within 15%; heading within 10°),`);
console.log(`       and at the beach the drawn waves match the surf model within 10% and never outgrow the depth.\n`);
