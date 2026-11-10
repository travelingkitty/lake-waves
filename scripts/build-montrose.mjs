// Builds the Montrose Beach scene from real data.
//
//   npm run geo        (writes public/montrose/geo.bin + scene.json; commit them)
//
// Sources
//   * OpenStreetMap (Overpass API): beach, dog beach, dunes, Montrose Point,
//     the hook (Montrose Harbor breakwater), harbor walls, the beach access mat,
//     buildings, trees, and the heights of the towers you can see from the sand.
//   * NOAA NCEI DEM global mosaic: Lake Michigan bathymetry (relative to Low
//     Water Datum, 176.0 m IGLD85) and land elevation (IGLD85/NAVD88 metres).
//
// Local frame: metres east (x) and north (y) of 41.9655 N, 87.6370 W (mid-beach).
// All elevations are relative to Low Water Datum (LWD = 176.0 m); the runtime
// adds the live lake level from NOAA's Calumet Harbor gauge.
//
// What is measured vs. modelled
//   measured: shoreline, beach/dune/park outlines, the hook, buildings, trees,
//             tower heights, offshore depths (DEM, beyond ~300 m).
//   modelled: the surf-zone profile inside ~300 m (foreshore, an inner and an
//             outer sandbar with rhythmic rip channels — Montrose's bars shift,
//             so these are typical, not surveyed), dune relief, beach slope.

import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deflateRawSync} from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(root, 'scripts', '.cache');
const outDir = join(root, 'public', 'montrose');
await mkdir(cacheDir, {recursive: true});
await mkdir(outDir, {recursive: true});

const LAT0 = 41.9655;
const LON0 = -87.637;
const KX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const KY = 110574;
const mx = lon => (lon - LON0) * KX;
const my = lat => (lat - LAT0) * KY;
const lonOf = x => LON0 + x / KX;
const latOf = y => LAT0 + y / KY;

// Grid: 3 km x 3 km at 5 m (fields) and 10 m (shelter).
const G = {x0: -1500, y0: -1000, cell: 5, nx: 600, ny: 600};
const S = {x0: G.x0, y0: G.y0, cell: 10, nx: 300, ny: 300};
const MAP_LEVEL = 0.4; // lake level above LWD when OSM's waterline was traced (≈ 2023–25 mean)
const CAMERA = {x: 130, y: 123}; // end of the beach access mat (OSM way 555066219)

// ---------------------------------------------------------------- inputs
async function cached(name, fetcher) {
  const p = join(cacheDir, name);
  if (existsSync(p)) return readFile(p);
  const buf = await fetcher();
  await writeFile(p, buf);
  return buf;
}

async function overpass(name, query) {
  const buf = await cached(name, async () => {
    console.log(`  fetching ${name} from Overpass…`);
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: {'User-Agent': 'lake-waves-geo-build', 'Content-Type': 'application/x-www-form-urlencoded'},
      body: 'data=' + encodeURIComponent(query),
    });
    if (!res.ok) throw new Error(`Overpass ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  });
  return JSON.parse(buf.toString('utf8'));
}

const bb = (x0, y0, x1, y1) => `${latOf(y0).toFixed(5)},${lonOf(x0).toFixed(5)},${latOf(y1).toFixed(5)},${lonOf(x1).toFixed(5)}`;
const near = bb(G.x0, G.y0, G.x0 + G.nx * G.cell, G.y0 + G.ny * G.cell);
console.log('OpenStreetMap');
const osm = await overpass('osm-montrose.json', `[out:json][timeout:120];
(
  relation["natural"="beach"](${near});
  way["natural"~"beach|sand|wood|scrub|grassland|heath|wetland|water"](${near});
  way["man_made"~"breakwater|groyne|pier|lighthouse"](${near});
  node["man_made"="lighthouse"](${near});
  way["leisure"~"park|nature_reserve|dog_park|golf_course|pitch|playground|garden"](${near});
  way["landuse"](${near});
  way["building"](${near});
  way["highway"~"motorway|primary|secondary|tertiary|cycleway|footway|path"](${near});
  node["natural"="tree"](${near});
);
out geom;`);
const towers = await overpass('osm-towers.json', `[out:json][timeout:120];
(
  way["building"]["height"](41.860,-87.700,42.010,-87.600);
  way["building:part"]["height"](41.860,-87.700,42.010,-87.600);
  way["building"]["building:levels"](41.955,-87.700,42.010,-87.640);
);
out tags center qt;`);

console.log('NOAA NCEI DEM');
const DEM = {nx: 360, ny: 360};
const demBox = [lonOf(G.x0), latOf(G.y0), lonOf(G.x0 + G.nx * G.cell), latOf(G.y0 + G.ny * G.cell)];
const demBuf = await cached('dem-montrose.bsq', async () => {
  const u = 'https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_global_mosaic/ImageServer/exportImage'
    + `?bbox=${demBox.join(',')}&bboxSR=4326&imageSR=4326&size=${DEM.nx},${DEM.ny}&format=bsq&pixelType=F32`
    + '&interpolation=RSP_BilinearInterpolation&f=image';
  const res = await fetch(u);
  if (!res.ok) throw new Error(`DEM ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
});
const dem = new Float32Array(DEM.nx * DEM.ny);
for (let i = 0; i < dem.length; i++) dem[i] = demBuf.readFloatLE(i * 4);

// Far field (what you see out to the horizon): 16 km x 20 km at 100 m.
const F = {x0: -8000, y0: -12000, cell: 100, nx: 160, ny: 200};
const farBox = [lonOf(F.x0), latOf(F.y0), lonOf(F.x0 + F.nx * F.cell), latOf(F.y0 + F.ny * F.cell)];
const farBuf = await cached('dem-far.bsq', async () => {
  const u = 'https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_global_mosaic/ImageServer/exportImage'
    + `?bbox=${farBox.join(',')}&bboxSR=4326&imageSR=4326&size=${F.nx},${F.ny}&format=bsq&pixelType=F32`
    + '&interpolation=RSP_BilinearInterpolation&f=image';
  const res = await fetch(u);
  if (!res.ok) throw new Error(`DEM far ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
});
const far = new Float32Array(F.nx * F.ny);
for (let j = 0; j < F.ny; j++) for (let i = 0; i < F.nx; i++) {
  const v = farBuf.readFloatLE(((F.ny - 1 - j) * F.nx + i) * 4); // row 0 = south
  far[j * F.nx + i] = v > 100 ? Math.min(40, Math.max(1.5, v - 176.0)) : Math.min(-0.5, v);
}
/** DEM value at local (x, y): water < 0 (m below LWD), land ≈ 176+ (m IGLD85). */
function demAt(x, y) {
  const u = ((lonOf(x) - demBox[0]) / (demBox[2] - demBox[0])) * DEM.nx - 0.5;
  const v = ((demBox[3] - latOf(y)) / (demBox[3] - demBox[1])) * DEM.ny - 0.5;
  const i0 = Math.max(0, Math.min(DEM.nx - 2, Math.floor(u)));
  const j0 = Math.max(0, Math.min(DEM.ny - 2, Math.floor(v)));
  const fu = Math.min(1, Math.max(0, u - i0)), fv = Math.min(1, Math.max(0, v - j0));
  const q = [dem[j0 * DEM.nx + i0], dem[j0 * DEM.nx + i0 + 1], dem[(j0 + 1) * DEM.nx + i0], dem[(j0 + 1) * DEM.nx + i0 + 1]];
  const w = [(1 - fu) * (1 - fv), fu * (1 - fv), (1 - fu) * fv, fu * fv];
  // Never blend lake depths (≈ -5) with land heights (≈ 180): use the majority class.
  const landW = q.reduce((s, val, k) => s + (val > 100 ? w[k] : 0), 0);
  let num = 0, den = 0;
  q.forEach((val, k) => { if ((val > 100) === (landW > 0.5)) { num += val * w[k]; den += w[k]; } });
  return num / den;
}

// ---------------------------------------------------------------- geometry helpers
const pts = g => g.map(p => [mx(p.lon), my(p.lat)]);
const ways = osm.elements.filter(e => e.type === 'way' && e.geometry);
const tagged = (pred) => ways.filter(e => pred(e.tags || {}));

function rasterPolygon(poly, grid, fn) {
  // Even-odd scanline fill of one ring on a grid; fn(i, j).
  let ymin = Infinity, ymax = -Infinity;
  for (const [, y] of poly) { ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
  const j0 = Math.max(0, Math.floor((ymin - grid.y0) / grid.cell));
  const j1 = Math.min(grid.ny - 1, Math.ceil((ymax - grid.y0) / grid.cell));
  for (let j = j0; j <= j1; j++) {
    const y = grid.y0 + (j + 0.5) * grid.cell;
    const xs = [];
    for (let k = 0; k < poly.length; k++) {
      const [ax, ay] = poly[k];
      const [bx, by] = poly[(k + 1) % poly.length];
      if ((ay <= y) !== (by <= y)) xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - grid.x0) / grid.cell - 0.5));
      const i1 = Math.min(grid.nx - 1, Math.floor((xs[k + 1] - grid.x0) / grid.cell - 0.5));
      for (let i = i0; i <= i1; i++) fn(i, j);
    }
  }
}

function rasterLine(line, width, grid, fn) {
  for (let k = 0; k + 1 < line.length; k++) {
    const [ax, ay] = line[k];
    const [bx, by] = line[k + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(len / (grid.cell * 0.5)));
    const r = Math.ceil(width / 2 / grid.cell);
    for (let s = 0; s <= steps; s++) {
      const x = ax + ((bx - ax) * s) / steps;
      const y = ay + ((by - ay) * s) / steps;
      const ci = Math.floor((x - grid.x0) / grid.cell);
      const cj = Math.floor((y - grid.y0) / grid.cell);
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= grid.nx || j >= grid.ny) continue;
        const cx = grid.x0 + (i + 0.5) * grid.cell, cy = grid.y0 + (j + 0.5) * grid.cell;
        if (Math.hypot(cx - x, cy - y) <= width / 2 + grid.cell * 0.35) fn(i, j);
      }
    }
  }
}

// Value noise for dunes / bars.
const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x, y) => vnoise(x, y) * 0.55 + vnoise(x * 2.1 + 5, y * 2.1 + 9) * 0.3 + vnoise(x * 4.3 + 1, y * 4.3 + 3) * 0.15;

// ---------------------------------------------------------------- materials
// 0 water · 1 beach sand · 2 dune (grass on sand) · 3 park grass · 4 concrete/stone
// 5 woods/scrub (Montrose Point) · 6 urban/paved · 7 harbor wall
const N = G.nx * G.ny;
const mat = new Uint8Array(N);
const idx = (i, j) => j * G.nx + i;
const cx = i => G.x0 + (i + 0.5) * G.cell;
const cy = j => G.y0 + (j + 0.5) * G.cell;

// Start from the DEM: land where it is clearly land, smoothed to hide 90 m blocks.
{
  const land = new Float32Array(N);
  for (let j = 0; j < G.ny; j++) for (let i = 0; i < G.nx; i++) land[idx(i, j)] = demAt(cx(i), cy(j)) > 100 ? 1 : 0;
  const blurred = boxBlur(land, G.nx, G.ny, 7, 2);
  for (let k = 0; k < N; k++) mat[k] = blurred[k] > 0.5 ? 6 : 0;
}
function boxBlur(src, nx, ny, r, passes = 1) {
  let a = Float32Array.from(src);
  let b = new Float32Array(a.length);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < ny; j++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += a[j * nx + Math.min(nx - 1, Math.max(0, i))];
      for (let i = 0; i < nx; i++) {
        b[j * nx + i] = acc / (2 * r + 1);
        acc += a[j * nx + Math.min(nx - 1, i + r + 1)] - a[j * nx + Math.max(0, i - r)];
      }
    }
    for (let i = 0; i < nx; i++) {
      let acc = 0;
      for (let j = -r; j <= r; j++) acc += b[Math.min(ny - 1, Math.max(0, j)) * nx + i];
      for (let j = 0; j < ny; j++) {
        a[j * nx + i] = acc / (2 * r + 1);
        acc += b[Math.min(ny - 1, j + r + 1) * nx + i] - b[Math.max(0, j - r) * nx + i];
      }
    }
  }
  return a;
}

const paint = (polys, m) => polys.forEach(p => rasterPolygon(p, G, (i, j) => (mat[idx(i, j)] = m)));
const closed = e => {
  const g = e.geometry;
  return g.length > 3 && g[0].lat === g.at(-1).lat && g[0].lon === g.at(-1).lon;
};
const polysOf = list => list.filter(closed).map(e => pts(e.geometry));

paint(polysOf(tagged(t => /grass|recreation_ground|meadow|village_green|cemetery/.test(t.landuse || '') || /park|golf_course|pitch|playground|garden/.test(t.leisure || ''))), 3);
paint(polysOf(tagged(t => /forest/.test(t.landuse || '') || /wood|scrub|heath/.test(t.natural || ''))), 5);
paint(polysOf(tagged(t => t.leisure === 'nature_reserve' && /Bird Sanctuary|Savannah/i.test(t.name || ''))), 5);
paint(polysOf(tagged(t => /residential|commercial|retail/.test(t.landuse || ''))), 6);
paint(polysOf(tagged(t => /grassland/.test(t.natural || ''))), 3);
// Beach sand: the Montrose Beach relation (outer rings), the dog beach and sand patches.
const beachRel = osm.elements.find(e => e.type === 'relation' && /Montrose Beach/i.test(e.tags?.name || ''));
const beachRings = (beachRel?.members || []).filter(m => m.role !== 'inner' && m.geometry).map(m => pts(m.geometry));
// Stitch member ways into one ring.
const beachRing = stitch(beachRings);
function stitch(parts) {
  if (!parts.length) return [];
  const rest = parts.slice(1).map(p => p.slice());
  const ring = parts[0].slice();
  const close = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1;
  while (rest.length) {
    const end = ring.at(-1);
    const k = rest.findIndex(p => close(p[0], end) || close(p.at(-1), end));
    if (k < 0) break;
    const p = rest.splice(k, 1)[0];
    if (!close(p[0], end)) p.reverse();
    ring.push(...p.slice(1));
  }
  return ring;
}
paint([beachRing], 1);
paint(polysOf(tagged(t => t.natural === 'beach' || (t.natural === 'sand' && !t.sport))), 1);
paint(polysOf(tagged(t => t.leisure === 'nature_reserve' && /Dunes/i.test(t.name || ''))), 2);
// OSM traces the waterline with a few long straight segments; a real beach is a
// smooth crescent. Round the sand/water boundary over ~20 m.
{
  const open = new Float32Array(N), sand = new Float32Array(N);
  for (let k = 0; k < N; k++) { const sw = mat[k] === 0 || mat[k] === 1; open[k] = sw ? 1 : 0; sand[k] = mat[k] === 1 ? 1 : 0; }
  const bs = boxBlur(sand, G.nx, G.ny, 2, 2), bo = boxBlur(open, G.nx, G.ny, 2, 2);
  for (let k = 0; k < N; k++) if (open[k] && bo[k] > 0.5) mat[k] = bs[k] / bo[k] > 0.5 ? 1 : 0;
}
paint(polysOf(tagged(t => !!t.building)), 6);

// The hook and the harbor walls: stone/concrete ~8 m wide.
const breakwaters = tagged(t => t.man_made === 'breakwater' || t.man_made === 'groyne');
breakwaters.forEach(e => rasterLine(pts(e.geometry), /Montrose Harbor/i.test(e.tags?.name || '') ? 9 : 7, G, (i, j) => (mat[idx(i, j)] = 7)));

// ---------------------------------------------------------------- the beach waterline
// Wherever beach sand touches open water (Montrose Beach + the dog beach).
const isSand = k => mat[k] === 1 || mat[k] === 2;
const edge = [];
for (let j = 1; j < G.ny - 1; j++) for (let i = 1; i < G.nx - 1; i++) {
  const k = idx(i, j);
  if (!isSand(k)) continue;
  const x = cx(i), y = cy(j);
  if (x < -620 || x > 430 || y < 40 || y > 520) continue;
  if (mat[k + 1] === 0 || mat[k - 1] === 0 || mat[k + G.nx] === 0 || mat[k - G.nx] === 0) edge.push([x, y]);
}
console.log(`  beach waterline: ${edge.length} cells where sand meets the lake`);

// Representative shore normal: least-squares line through the waterline.
const fit = (() => {
  const n = edge.length;
  const mxv = edge.reduce((s, p) => s + p[0], 0) / n;
  const myv = edge.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0, sxy = 0;
  for (const [x, y] of edge) { sxx += (x - mxv) ** 2; sxy += (x - mxv) * (y - myv); }
  const slope = sxy / sxx; // dy/dx
  const alongBearing = (Math.atan2(1, slope) * 180) / Math.PI; // bearing of +x along the line
  const face = (((alongBearing - 90) % 360) + 360) % 360; // water is to the north
  return {cx: mxv, cy: myv, face};
})();
console.log(`  beach faces ${fit.face.toFixed(1)}° (least squares through the waterline)`);
const FACE = fit.face;
const fr = (FACE * Math.PI) / 180;
const nrm = [Math.sin(fr), Math.cos(fr)]; // seaward unit (east, north)
const tng = [Math.cos(fr), -Math.sin(fr)]; // alongshore unit (+s = FACE + 90°)

function distToPolyline(x, y, line) {
  let best = Infinity, bk = 0, bt = 0;
  for (let k = 0; k + 1 < line.length; k++) {
    const [ax, ay] = line[k], [bx, by] = line[k + 1];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
    if (d < best) { best = d; bk = k; bt = t; }
  }
  return {d: best, k: bk, t: bt};
}

// ---------------------------------------------------------------- surf-zone profile
// Typical multi-barred Lake Michigan sand beach (Montrose's bars move; this is a
// representative state): foreshore 1:12, inner bar ~45 m out, outer bar ~125 m
// out, rhythmic outer-bar horns every ~170 m (peaks) with rip channels between.
function surfEnvelope(dw) { // smooth depth below the mapped waterline (no bars)
  if (dw <= 0) return 0;
  if (dw <= 10.8) return dw / 12;
  return 0.9 + (Math.min(dw, 260) - 10.8) * 0.0155 + Math.max(0, dw - 260) * 0.003;
}
function bars(dw, s) {
  const inner = 0.45 * Math.exp(-(((dw - 45) / 11) ** 2));
  const horn = 0.5 + 0.5 * Math.cos((2 * Math.PI * s) / 170 + 0.8);
  const outer = (0.45 + 0.35 * horn) * Math.exp(-(((dw - 125 - 18 * (1 - horn)) / 22) ** 2));
  return inner + outer; // metres the bottom is raised
}

// ---------------------------------------------------------------- elevation (rel. LWD) and fields
const elev = new Float32Array(N);
const envDepth = new Float32Array(N); // smooth (bar-free) depth below LWD, for wave refraction
const waterDist = new Float32Array(N).fill(1e9);
// Distance from each water cell to the nearest beach sand (the surf zone's
// "distance offshore"); alongshore position for the bar rhythm.
const beachD = new Float32Array(N);
for (let k = 0; k < N; k++) beachD[k] = isSand(k) ? 0 : 1e9;
chamfer(beachD, G.nx, G.ny, G.cell, k => mat[k] === 0); // measured through water only
{
  // Chamfer distances step in 5 m increments along the grid. Use the exact
  // Euclidean distance to the sand's water edge instead (smooth contours, exact
  // at the waterline) wherever the water route is no detour (not behind land).
  const edgePts = [];
  for (let j = 1; j < G.ny - 1; j++) for (let i = 1; i < G.nx - 1; i++) {
    const k = idx(i, j);
    if (!isSand(k)) continue;
    if (mat[k + 1] === 0 || mat[k - 1] === 0 || mat[k + G.nx] === 0 || mat[k - G.nx] === 0) edgePts.push(cx(i), cy(j));
  }
  for (let j = 0; j < G.ny; j++) for (let i = 0; i < G.nx; i++) {
    const k = idx(i, j);
    if (mat[k] !== 0 || beachD[k] > 900) continue;
    const x = cx(i), y = cy(j);
    let best = Infinity;
    for (let e = 0; e < edgePts.length; e += 2) {
      const dx = x - edgePts[e], dy = y - edgePts[e + 1];
      const d2 = dx * dx + dy * dy;
      if (d2 < best) best = d2;
    }
    // edge points are sand-cell centres; the waterline is half a cell lakeward of them
    const eu = Math.max(0, Math.sqrt(best) - G.cell / 2);
    if (beachD[k] < eu * 1.4 + 15) beachD[k] = eu;
  }
}
const beachS = new Float32Array(N);
for (let j = 0; j < G.ny; j++) for (let i = 0; i < G.nx; i++) {
  beachS[idx(i, j)] = (cx(i) - fit.cx) * tng[0] + (cy(j) - fit.cy) * tng[1];
}
const beachMid = 0;
const beachHalf = 1e9; // the sand itself bounds the surf zone
// DEM depth below LWD (water), lightly smoothed.
const demDepth = new Float32Array(N);
for (let j = 0; j < G.ny; j++) for (let i = 0; i < G.nx; i++) {
  const v = demAt(cx(i), cy(j));
  demDepth[idx(i, j)] = v < 50 ? Math.max(0, -v) : 0;
}
const demSmooth = boxBlur(demDepth, G.nx, G.ny, 6, 2);

for (let j = 0; j < G.ny; j++) for (let i = 0; i < G.nx; i++) {
  const k = idx(i, j);
  const x = cx(i), y = cy(j);
  const m = mat[k];
  if (m === 0) {
    const dw = beachD[k];
    const lateral = 1 - smoothstep(beachHalf, beachHalf + 220, Math.abs(beachS[k] - beachMid));
    const nearBeach = dw > -5 && dw < 600 && lateral > 0;
    let h = Math.max(demSmooth[k], 0.5);
    let henv = h;
    if (nearBeach) {
      const w = 1 - (1 - smoothstep(260, 520, dw)) * lateral;
      const syn = surfEnvelope(dw) - MAP_LEVEL; // depth below LWD (the waterline sits MAP_LEVEL above it)
      henv = syn * (1 - w) + h * w;
      h = henv - bars(dw, beachS[k]) * (1 - w);
    }
    envDepth[k] = henv;
    elev[k] = -h;
  } else if (m === 1 || m === 2) {
    elev[k] = 0; // filled below once distance-to-water is known
  } else if (m === 7) {
    elev[k] = 2.6; // the hook: ~2.2 m above today's water
  } else {
    const v = demAt(x, y);
    elev[k] = v > 100 ? Math.min(10, Math.max(1.8, v - 176.0)) : 2.2;
  }
}
// Distance from land cells to the nearest water (two-pass chamfer).
for (let k = 0; k < N; k++) waterDist[k] = mat[k] === 0 ? 0 : 1e9;
chamfer(waterDist, G.nx, G.ny, G.cell);
function chamfer(d, nx, ny, cell, open = () => true) {
  const a = cell, b = cell * Math.SQRT2;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    if (!open(k)) continue;
    if (i > 0) d[k] = Math.min(d[k], d[k - 1] + a);
    if (j > 0) d[k] = Math.min(d[k], d[k - nx] + a);
    if (i > 0 && j > 0) d[k] = Math.min(d[k], d[k - nx - 1] + b);
    if (i < nx - 1 && j > 0) d[k] = Math.min(d[k], d[k - nx + 1] + b);
  }
  for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    const k = j * nx + i;
    if (!open(k)) continue;
    if (i < nx - 1) d[k] = Math.min(d[k], d[k + 1] + a);
    if (j < ny - 1) d[k] = Math.min(d[k], d[k + nx] + a);
    if (i < nx - 1 && j < ny - 1) d[k] = Math.min(d[k], d[k + nx + 1] + b);
    if (i > 0 && j < ny - 1) d[k] = Math.min(d[k], d[k + nx - 1] + b);
  }
}
function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

// Beach and dune relief.
for (let j = 0; j < G.ny; j++) for (let i = 0; i < G.nx; i++) {
  const k = idx(i, j);
  const m = mat[k];
  if (m !== 1 && m !== 2) continue;
  const x = cx(i), y = cy(j);
  const dl = Math.max(0, waterDist[k] - G.cell * 0.5); // metres inland from the water
  let e = MAP_LEVEL + Math.min(dl / 12, 1.0 + (dl - 12) / 85); // 1:12 foreshore, then gentle berm
  e = Math.min(e, 2.7);
  e += (fbm(x / 9, y / 9) - 0.5) * 0.12; // wind ripples / footprints
  if (m === 2) e += smoothstep(0, 30, dl) * (0.4 + 2.6 * fbm(x / 38 + 20, y / 38 - 7)); // dunes
  elev[k] = e;
}

// ---------------------------------------------------------------- representative transect
// From the end of the beach mat straight out along the beach normal: this is
// the 1-D profile the wave transform runs on (bar-free envelope).
const D0 = 2400;
const PROFILE_N = 241;
const profile = [];
{
  // where the transect crosses the waterline
  const base = (() => {
    let best = null;
    for (let t = 0; t < 200; t += 0.5) {
      const x = CAMERA.x + nrm[0] * t, y = CAMERA.y + nrm[1] * t;
      const i = Math.floor((x - G.x0) / G.cell), j = Math.floor((y - G.y0) / G.cell);
      if (mat[idx(i, j)] === 0) { best = {x, y}; break; }
    }
    return best ?? {x: CAMERA.x + nrm[0] * 45, y: CAMERA.y + nrm[1] * 45};
  })();
  let prev = 0.05;
  for (let n = 0; n < PROFILE_N; n++) {
    const d = (D0 * n * n) / ((PROFILE_N - 1) ** 2);
    const x = base.x + nrm[0] * d, y = base.y + nrm[1] * d;
    const i = Math.floor((x - G.x0) / G.cell), j = Math.floor((y - G.y0) / G.cell);
    let h;
    if (i >= 0 && j >= 0 && i < G.nx && j < G.ny && mat[idx(i, j)] === 0) h = envDepth[idx(i, j)] + MAP_LEVEL; // depth below the mapped water level
    else h = prev + 0.004 * d * 0 + 0.002 * (D0 / PROFILE_N);
    h = Math.max(prev + 1e-3, h); // monotone
    profile.push([+d.toFixed(2), +h.toFixed(3)]);
    prev = h;
  }
  profile.base = base;
}
const hAt = d => {
  if (d <= 0) return 0;
  for (let n = 1; n < profile.length; n++) if (profile[n][0] >= d) {
    const [d0, h0] = profile[n - 1], [d1, h1] = profile[n];
    return h0 + ((h1 - h0) * (d - d0)) / (d1 - d0);
  }
  return profile.at(-1)[1];
};
const dOfH = h => { // inverse of the monotone profile
  if (h <= 0) return 0;
  for (let n = 1; n < profile.length; n++) if (profile[n][1] >= h) {
    const [d0, h0] = profile[n - 1], [d1, h1] = profile[n];
    return d0 + ((d1 - d0) * (h - h0)) / (h1 - h0 || 1);
  }
  return D0 + (h - profile.at(-1)[1]) / 0.004;
};
console.log(`  transect: ${hAt(50).toFixed(1)} m @50, ${hAt(200).toFixed(1)} m @200, ${hAt(500).toFixed(1)} m @500, ${hAt(1000).toFixed(1)} m @1 km, ${hAt(2000).toFixed(1)} m @2 km`);

// Equivalent offshore distance: crests follow depth contours near shore (refraction),
// straight lines offshore. dGeom = distance from the representative shoreline.
const dEq = new Float32Array(N);
for (let j = 0; j < G.ny; j++) for (let i = 0; i < G.nx; i++) {
  const k = idx(i, j);
  const x = cx(i), y = cy(j);
  const dGeom = (x - profile.base.x) * nrm[0] + (y - profile.base.y) * nrm[1];
  if (mat[k] === 0) {
    const de = dOfH(envDepth[k] + MAP_LEVEL);
    const w = smoothstep(3.8, 5.2, envDepth[k]);
    dEq[k] = de * (1 - w) + Math.max(dGeom, 0) * w;
  } else {
    dEq[k] = -waterDist[k];
  }
}

// ---------------------------------------------------------------- shelter (16 directions waves come FROM)
console.log('Shelter maps (16 directions)…');
const solid = new Uint8Array(S.nx * S.ny);
for (let j = 0; j < S.ny; j++) for (let i = 0; i < S.nx; i++) {
  // solid if any underlying 5 m cell is land
  let any = 0;
  for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) any |= mat[idx(i * 2 + a, j * 2 + b)] !== 0 ? 1 : 0;
  solid[j * S.nx + i] = any;
}
const shelter = new Uint8Array(16 * S.nx * S.ny);
for (let b = 0; b < 16; b++) {
  const from = (b * 22.5 * Math.PI) / 180;
  const ux = Math.sin(from), uy = Math.cos(from); // toward where waves come from
  const map = new Float32Array(S.nx * S.ny);
  for (let j = 0; j < S.ny; j++) for (let i = 0; i < S.nx; i++) {
    const k = j * S.nx + i;
    if (solid[k]) { map[k] = 0; continue; }
    let open = 1;
    for (let t = S.cell; t < 2500; t += S.cell * 0.8) {
      const x = S.x0 + (i + 0.5) * S.cell + ux * t, y = S.y0 + (j + 0.5) * S.cell + uy * t;
      const ii = Math.floor((x - S.x0) / S.cell), jj = Math.floor((y - S.y0) / S.cell);
      if (ii < 0 || jj < 0 || ii >= S.nx || jj >= S.ny) {
        // outside the grid: blocked only if heading back onto the mainland (west of the shore)
        if (ux < -0.2 && x < -900) open = 0;
        break;
      }
      if (solid[jj * S.nx + ii]) { open = 0; break; }
    }
    map[k] = open;
  }
  // Diffraction softens shadow edges over a few wavelengths: blur ~30 m,
  // over water only (land itself must not read as "sheltered water").
  const wet = Float32Array.from(solid, v => (v ? 0 : 1));
  const num = boxBlur(map.map((v, k) => v * wet[k]), S.nx, S.ny, 2, 2);
  const den = boxBlur(wet, S.nx, S.ny, 2, 2);
  // Edge cells (part sand, part water) take the value of the water around them.
  for (let k = 0; k < map.length; k++) shelter[b * S.nx * S.ny + k] = Math.round(255 * Math.min(1, den[k] > 1e-3 ? num[k] / den[k] : 0));
}

// ---------------------------------------------------------------- scene objects
const camGround = (() => { const i = Math.floor((CAMERA.x - G.x0) / G.cell), j = Math.floor((CAMERA.y - G.y0) / G.cell); return elev[idx(i, j)]; })();

// Buildings inside the grid: footprints + heights.
const buildings = [];
for (const e of tagged(t => !!t.building)) {
  const p = pts(e.geometry);
  if (p.some(([x, y]) => x < G.x0 || y < G.y0 || x > G.x0 + G.nx * G.cell || y > G.y0 + G.ny * G.cell)) continue;
  const t = e.tags;
  let h = parseFloat(t.height);
  if (!Number.isFinite(h)) h = t['building:levels'] ? parseFloat(t['building:levels']) * 3.05 + 3 : /shed|roof|shelter|kiosk/.test(t.building) ? 3 : 4.5;
  const i = Math.floor((p[0][0] - G.x0) / G.cell), j = Math.floor((p[0][1] - G.y0) / G.cell);
  const base = Math.max(1.5, elev[idx(Math.min(G.nx - 1, Math.max(0, i)), Math.min(G.ny - 1, Math.max(0, j)))]);
  buildings.push({name: t.name || undefined, h: +h.toFixed(1), base: +base.toFixed(2), p: p.slice(0, -1).map(([x, y]) => [+x.toFixed(1), +y.toFixed(1)])});
}
// Trees (OSM), on their ground.
const trees = osm.elements.filter(e => e.type === 'node' && e.tags?.natural === 'tree').map(e => {
  const x = mx(e.lon), y = my(e.lat);
  const i = Math.floor((x - G.x0) / G.cell), j = Math.floor((y - G.y0) / G.cell);
  if (i < 0 || j < 0 || i >= G.nx || j >= G.ny) return null;
  return [+x.toFixed(1), +y.toFixed(1), +Math.max(1.5, elev[idx(i, j)]).toFixed(2), +(9 + 9 * hash(x, y)).toFixed(1)];
}).filter(Boolean);
// Woods on Montrose Point / park edges get extra trees on a jittered grid.
for (let j = 0; j < G.ny; j += 3) for (let i = 0; i < G.nx; i += 3) {
  const k = idx(i, j);
  if (mat[k] !== 5) continue;
  const x = cx(i) + (hash(i, j) - 0.5) * 12, y = cy(j) + (hash(j, i) - 0.5) * 12;
  if (hash(i * 3.1, j * 7.7) > 0.55) trees.push([+x.toFixed(1), +y.toFixed(1), +elev[k].toFixed(2), +(4 + 7 * hash(i, j * 2)).toFixed(1)]);
}
// Lights.
const lights = osm.elements.filter(e => e.tags?.man_made === 'lighthouse' && (e.lat || e.center)).map(e => {
  const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
  return {name: e.tags.name, x: +mx(lon).toFixed(1), y: +my(lat).toFixed(1)};
}).filter(l => l.x > G.x0 && l.y > G.y0 && l.x < G.x0 + G.nx * G.cell && l.y < G.y0 + G.ny * G.cell);

// Distant towers as skyline silhouettes (bearing, half-width, top) seen from the camera.
const sky = [];
for (const e of towers.elements) {
  const t = e.tags || {};
  let h = parseFloat(t.height);
  if (!Number.isFinite(h) && t['building:levels']) h = parseFloat(t['building:levels']) * 3.05 + 3;
  if (!(h >= 40) || !e.center) continue;
  const x = mx(e.center.lon), y = my(e.center.lat);
  const dx = x - CAMERA.x, dy = y - CAMERA.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1600) continue; // close buildings are real geometry
  const width = h > 300 ? 55 : h > 150 ? 40 : 32;
  const bearing = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  sky.push([+bearing.toFixed(3), +((Math.atan(width / 2 / dist) * 180) / Math.PI).toFixed(4), +((Math.atan((h + 176.6 - 178.5) / dist) * 180) / Math.PI).toFixed(4), Math.round(dist), t.name || '']);
}
// Thin spires: a part much taller than its neighbours at the same spot.
sky.sort((a, b) => b[2] - a[2]);
for (const s of sky) {
  const twin = sky.find(o => o !== s && Math.abs(o[0] - s[0]) < s[1] * 1.5 && Math.abs(o[3] - s[3]) < 60 && o[2] < s[2] && o[2] > s[2] * 0.6);
  if (twin && s[2] > twin[2] * 1.12) s[1] = +(s[1] * 0.08).toFixed(4);
}
const skyKept = sky.slice(0, 160);

// ---------------------------------------------------------------- write
const header = {
  version: 1,
  origin: {lat: LAT0, lon: LON0},
  grid: G,
  shelterGrid: S,
  farGrid: F,
  face: +FACE.toFixed(2),
  mapLevel: MAP_LEVEL,
  camera: {x: CAMERA.x, y: CAMERA.y, ground: +camGround.toFixed(2)},
  profileBase: {x: +profile.base.x.toFixed(1), y: +profile.base.y.toFixed(1)},
  D0,
};
const q16 = (arr, scale) => { const o = new Int16Array(arr.length); for (let k = 0; k < arr.length; k++) o[k] = Math.max(-32767, Math.min(32767, Math.round(arr[k] * scale))); return o; };
const body = Buffer.concat([
  Buffer.from(q16(elev, 100).buffer), // cm
  Buffer.from(q16(dEq, 10).buffer), // dm
  Buffer.from(q16(far, 100).buffer), // cm, far field
  Buffer.from(mat.buffer),
  Buffer.from(shelter.buffer),
]);
const hjson = Buffer.from(JSON.stringify(header));
const len = Buffer.alloc(4);
len.writeUInt32LE(hjson.length);
const packed = deflateRawSync(Buffer.concat([len, hjson, body]), {level: 9});
await writeFile(join(outDir, 'geo.bin'), packed);
await writeFile(join(outDir, 'scene.json'), JSON.stringify({
  ...header,
  profile,
  walls: breakwaters.map(e => ({
    name: e.tags?.name,
    w: /Montrose Harbor/i.test(e.tags?.name || '') ? 9 : 7,
    p: pts(e.geometry).map(([x, y]) => [+x.toFixed(1), +y.toFixed(1)]),
  })),
  buildings,
  trees,
  lights,
  skyline: skyKept,
  sources: {
    osm: '© OpenStreetMap contributors (ODbL)',
    dem: 'NOAA NCEI DEM Global Mosaic (Great Lakes bathymetry, LWD)',
  },
}));
console.log(`wrote geo.bin (${(packed.length / 1024).toFixed(0)} KB), scene.json: ${buildings.length} buildings, ${trees.length} trees, ${skyKept.length} skyline towers, ${lights.length} lights`);

// Debug map (optional): node scripts/build-montrose.mjs --png
if (process.argv.includes('--png')) {
  const {deflateSync} = await import('node:zlib');
  const W = G.nx, H = G.ny;
  const img = Buffer.alloc(W * H * 3);
  const colors = [[0, 0, 0], [214, 196, 150], [170, 160, 100], [95, 130, 70], [150, 150, 150], [60, 90, 50], [120, 110, 110], [200, 200, 200]];
  const sh = from => Math.round((from / 22.5)) % 16;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = idx(i, G.ny - 1 - j);
    let c;
    if (mat[k] === 0) {
      const t = Math.min(1, -elev[k] / 8);
      const s = shelter[sh(0) * S.nx * S.ny + Math.floor((G.ny - 1 - j) / 2) * S.nx + Math.floor(i / 2)] / 255;
      c = [30 + 120 * (1 - t), 70 + 140 * (1 - t), 130 + 110 * (1 - t)].map(v => v * (0.45 + 0.55 * s));
      const de = dEq[k];
      if (de > 0 && Math.abs((de % 50) - 25) < 1.6) c = [255, 255, 255];
    } else c = colors[mat[k]];
    img.set(c.map(Math.round), (j * W + i) * 3);
  }
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let r = 0; r < H; r++) img.copy(raw, r * (W * 3 + 1) + 1, r * W * 3, (r + 1) * W * 3);
  const crcT = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 2;
  await writeFile(join(cacheDir, 'montrose-debug.png'), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  console.log('debug map: scripts/.cache/montrose-debug.png');
}
