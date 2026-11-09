// Montrose Beach geography (built by scripts/build-montrose.mjs from
// OpenStreetMap + NOAA NCEI bathymetry). Shared by the renderer, the app and
// the test. Local frame: metres east (x) and north (y) of 41.9655 N 87.6370 W.
// Elevations are relative to Lake Michigan's Low Water Datum (176.0 m IGLD85).

export const LWD = 176.0;

/** Decode the raw (already inflated) geo.bin payload. */
export function decodeGeo(raw) {
  const buf = raw instanceof ArrayBuffer ? raw : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const dv = new DataView(buf);
  const hlen = dv.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hlen)));
  const {grid: G, shelterGrid: S, farGrid: F} = header;
  const N = G.nx * G.ny;
  let o = 4 + hlen;
  const take = n => { const s = buf.slice(o, o + n); o += n; return s; };
  const elev = new Int16Array(take(N * 2));
  const dEq = new Int16Array(take(N * 2));
  const far = new Int16Array(take(F.nx * F.ny * 2));
  const mat = new Uint8Array(take(N));
  const shelter = new Uint8Array(take(16 * S.nx * S.ny));
  return {header, elev, dEq, far, mat, shelter};
}

/** Fetch + inflate in the browser. */
export async function loadGeo(base = 'montrose/') {
  const [bin, scene] = await Promise.all([
    fetch(`${base}geo.bin`).then(r => { if (!r.ok) throw new Error('Missing montrose/geo.bin (run npm run geo)'); return r.arrayBuffer(); }),
    fetch(`${base}scene.json`).then(r => r.json()),
  ]);
  const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const raw = await new Response(stream).arrayBuffer();
  return {...decodeGeo(raw), scene};
}

const clampi = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** CPU samplers (nearest cell) for the app and the test. */
export function samplers(geo) {
  const {grid: G, shelterGrid: S, farGrid: F} = geo.header;
  const inGrid = (x, y) => x >= G.x0 && y >= G.y0 && x < G.x0 + G.nx * G.cell && y < G.y0 + G.ny * G.cell;
  const cell = (x, y) => clampi(Math.floor((y - G.y0) / G.cell), 0, G.ny - 1) * G.nx + clampi(Math.floor((x - G.x0) / G.cell), 0, G.nx - 1);
  return {
    inGrid,
    elev(x, y) {
      if (inGrid(x, y)) return geo.elev[cell(x, y)] / 100;
      const i = clampi(Math.floor((x - F.x0) / F.cell), 0, F.nx - 1), j = clampi(Math.floor((y - F.y0) / F.cell), 0, F.ny - 1);
      return geo.far[j * F.nx + i] / 100;
    },
    dEq: (x, y) => (inGrid(x, y) ? geo.dEq[cell(x, y)] / 10 : null),
    mat: (x, y) => (inGrid(x, y) ? geo.mat[cell(x, y)] : null),
    /** 0..1 share of wave energy from `fromDeg` reaching (x, y) past the hook and point. */
    shelter(x, y, fromDeg) {
      const i = clampi(Math.floor((x - S.x0) / S.cell), 0, S.nx - 1), j = clampi(Math.floor((y - S.y0) / S.cell), 0, S.ny - 1);
      const f = ((((fromDeg % 360) + 360) % 360) / 22.5);
      const b0 = Math.floor(f) % 16, b1 = (b0 + 1) % 16, t = f - Math.floor(f);
      const at = b => geo.shelter[b * S.nx * S.ny + j * S.nx + i] / 255;
      return at(b0) * (1 - t) + at(b1) * t;
    },
  };
}
