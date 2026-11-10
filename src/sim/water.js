// Montrose Beach, Chicago — WebGL2, no libraries.
//
// You stand at the end of the beach access mat (the surfers' lineup marker)
// looking out over the break. Everything you see comes from geo.bin/scene.json
// (scripts/build-montrose.mjs): OpenStreetMap shoreline, beach, dunes, the
// hook, buildings and trees; NOAA bathymetry; real tower heights for the
// Edgewater and downtown skylines. The lake level is NOAA's live gauge.
//
// Waves: the 32 forecast components are carried onshore by surf.js along
// Montrose's real depth profile. In the vertex shader each point uses
//   * its depth contour (dEq) for phase, so crests bend along the crescent
//     and around the hook as refraction makes them,
//   * the hook/point shelter for the incoming direction (16 precomputed maps),
//   * its own depth (with sandbars) to cap wave height: Hs ≤ 0.6 h.

import {approach, components, measureHs, N_WAVES} from './seaState.js';
import {D0, GAMMA, TW, transform} from './surf.js';
import {lighting} from './light.js';
import {STARS, starFrame} from './astro.js';
import {createPost, REFL_UNIT} from './post.js';
import COMMON from './glsl/common.glsl?raw';
import SKY_SRC from './glsl/sky.glsl?raw';
import SURF_SRC from './glsl/surf_fs.glsl?raw';
import SOLID_SRC from './glsl/solid_fs.glsl?raw';
import TREE_SRC from './glsl/tree_fs.glsl?raw';

const GX = 240;
const GY = 170;

const R = Math.PI / 180;
const TAU = Math.PI * 2;

// Fragment shaders live in ./glsl (the look); the vertex shaders below are the physics.
const HEAD = '#version 300 es\nprecision highp float;\n';
// Reflect the world in the water plane (y = 0).
const MIRROR = new Float32Array([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const SKY_VS = /* glsl */ `#version 300 es
in vec2 aPos;
out vec2 vNdc;
void main() { vNdc = aPos; gl_Position = vec4(aPos, 0.9999, 1.0); }`;

const NS = STARS.length;
const skyFs = n => HEAD + '#define NT ' + n + '\n#define NS ' + NS + '\n' + COMMON + SKY_SRC;

const SURF_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 aGrid;
uniform mat4 uViewProj;
uniform mat4 uInvViewProj;
uniform vec3 uCam;
uniform vec2 uGridX;
uniform vec2 uGridY;
uniform float uCell;
uniform sampler2D uTable;
uniform vec4 uDeep[${N_WAVES}];  // ky, kx at D0, amplitude, phase integral at D0
uniform float uPh[${N_WAVES}];
uniform float uTime;
uniform float uRunup;
uniform float uSwashW;
uniform sampler2D uGeo;      // r: elevation above LWD (m), g: depth-contour distance dEq (m)
uniform vec4 uGeoBox;        // x0, y0, width, height (m, east/north)
uniform sampler2D uMat;      // material id / 255
uniform sampler2D uShelter;  // 4x4 atlas of 16 directions
uniform vec3 uBins;          // shelter bins (from-direction / 22.5°): b0, b1, t
uniform sampler2D uFar;      // far-field elevation above LWD
uniform vec4 uFarBox;
uniform vec2 uBase;          // transect origin (east, north)
uniform vec2 uNrm;           // seaward unit (east, north)
uniform vec2 uTng;           // alongshore unit (east, north)
uniform float uLevel;        // lake level above LWD (m)
out vec3 vWorld;
out vec3 vNormal;
out float vEta;
out float vH;
out float vThick;
out float vGround;
out float vFoam;
out float vHs;
out float vD;
out float vS;
out float vShelter;
out float vCap;
flat out int vMat;

const float D0 = ${D0.toFixed(1)};
const int TW = ${TW};
const int NR = ${N_WAVES};
const float GAMMA = ${GAMMA.toFixed(3)};

vec4 tab(int row, float d) {
  float u = sqrt(clamp(d / D0, 0.0, 1.0)) * float(TW - 1);
  int j = min(int(u), TW - 2);
  float f = u - float(j);
  return mix(texelFetch(uTable, ivec2(j, row), 0), texelFetch(uTable, ivec2(j + 1, row), 0), f);
}
float shelterAt(vec2 uv, float b) {
  vec2 tile = vec2(mod(b, 4.0), floor(b / 4.0));
  vec2 inner = clamp(uv, vec2(0.004), vec2(0.996));
  return texture(uShelter, (tile + inner) / 4.0).r;
}

void main() {
  vec2 ndc = vec2(mix(uGridX.x, uGridX.y, aGrid.x), mix(uGridY.x, uGridY.y, aGrid.y));
  vec4 far4 = uInvViewProj * vec4(ndc, 1.0, 1.0);
  vec3 rd = normalize(far4.xyz / far4.w - uCam);
  float t = rd.y < -1e-4 ? (-uCam.y) / rd.y : 1e9;
  t = min(t, 30000.0);
  vec2 xz = uCam.xz + rd.xz * t;
  vec2 p = vec2(xz.x, -xz.y); // east, north
  float spacing = t * uCell / max(-rd.y, 0.04);

  float s = dot(p - uBase, uTng);
  float dGeom = dot(p - uBase, uNrm);
  float elev, dEq, shel = 1.0;
  vec2 gradD = uNrm;
  int mat;
  vec3 nLand;
  vec2 guv = (p - uGeoBox.xy) / uGeoBox.zw;
  if (all(greaterThan(guv, vec2(0.001))) && all(lessThan(guv, vec2(0.999)))) {
    vec2 g = texture(uGeo, guv).rg;
    elev = g.r;
    vec2 e = 1.0 / vec2(textureSize(uGeo, 0));
    vec2 gx1 = texture(uGeo, guv + vec2(e.x, 0.0)).rg, gx0 = texture(uGeo, guv - vec2(e.x, 0.0)).rg;
    vec2 gy1 = texture(uGeo, guv + vec2(0.0, e.y)).rg, gy0 = texture(uGeo, guv - vec2(0.0, e.y)).rg;
    vec2 step2 = 2.0 * e * uGeoBox.zw;
    nLand = normalize(vec3(-(gx1.r - gx0.r) / step2.x, 1.0, (gy1.r - gy0.r) / step2.y));
    vec2 gd = vec2(gx1.g - gx0.g, gy1.g - gy0.g) / step2;
    float gl = length(gd);
    // Ease into the straight offshore frame at the edge of the mapped area.
    vec2 edge = min(guv, 1.0 - guv) * uGeoBox.zw;
    float w = smoothstep(0.0, 300.0, min(edge.x, edge.y));
    dEq = mix(dGeom, g.g, w);
    gradD = gl > 0.3 ? normalize(mix(uNrm, gd / gl, w)) : uNrm;
    mat = int(texelFetch(uMat, ivec2(guv * vec2(textureSize(uMat, 0))), 0).r * 255.0 + 0.5);
    shel = mix(shelterAt(guv, uBins.x), shelterAt(guv, uBins.y), uBins.z);
    shel = mix(1.0, shel, w);
  } else {
    vec2 fuv = (p - uFarBox.xy) / uFarBox.zw;
    elev = texture(uFar, fuv).r;
    vec2 e = 1.0 / vec2(textureSize(uFar, 0));
    float hx = texture(uFar, fuv + vec2(e.x, 0.0)).r - texture(uFar, fuv - vec2(e.x, 0.0)).r;
    float hy = texture(uFar, fuv + vec2(0.0, e.y)).r - texture(uFar, fuv - vec2(0.0, e.y)).r;
    nLand = normalize(vec3(-hx / (2.0 * e.x * uFarBox.z), 1.0, hy / (2.0 * e.y * uFarBox.w)));
    dEq = dGeom;
    mat = elev > uLevel ? 6 : 0;
  }

  float hLocal = uLevel - elev;              // water depth here (m), < 0 on land
  float dT = clamp(dEq, 0.0, D0);
  vec4 sc = tab(NR, dT);                     // (profile depth, foam, Hs, chop)
  float cap = min(1.0, GAMMA * max(hLocal, 0.0) / max(sc.z * shel, 1e-3));
  float scale = shel * cap;
  float eta = 0.0;
  vec2 disp = vec2(0.0);
  vec3 n = vec3(0.0, 1.0, 0.0);
  if (hLocal > 0.0) {
    float chop = sc.w;
    for (int i = 0; i < NR; i++) {
      vec4 dp = uDeep[i];
      float psi, A, kx;
      if (dEq >= D0) { psi = dp.w + dp.y * (dEq - D0); A = dp.z; kx = dp.y; }
      else { vec4 tv = tab(i, dT); psi = tv.x; A = tv.y; kx = tv.z; }
      vec2 kv = dp.x * uTng - kx * gradD;   // ∇θ (east, north)
      float k = max(length(kv), 1e-4);
      A *= scale * (1.0 - smoothstep(0.22, 0.5, spacing * k * 0.1591549));
      float th = dp.x * s - psi - uPh[i];
      float sn = sin(th), cs = cos(th);
      eta += A * sn;
      vec2 dirW = vec2(kv.x, -kv.y) / k;     // world x (east), z (south)
      disp += chop * A * dirW * cs;
      n.x -= A * cs * kv.x;
      n.z += A * cs * kv.y;
      n.y -= chop * A * k * sn;
    }
  }
  // Swash: the water's edge runs up and down the beach face.
  float swash = uRunup * (0.5 + 0.3 * sin(uSwashW * uTime - 0.021 * s) + 0.2 * sin(1.37 * uSwashW * uTime - 0.034 * s + 1.3));
  float water = eta + swash * (1.0 - smoothstep(0.0, 14.0, dEq));
  float g = elev - uLevel;
  vec3 world = vec3(xz.x, max(water, g), xz.y);
  if (water > g) world.xz += disp;
  else n = nLand;

  vWorld = world;
  vNormal = n;
  vEta = eta;
  vH = max(hLocal, 0.0);
  vThick = water - g;
  vGround = g;
  vFoam = hLocal > 0.0 ? sc.y * shel : 0.0;
  vHs = sc.z * shel * cap;
  vD = dEq;
  vS = s;
  vShelter = shel;
  vCap = cap;
  vMat = mat;
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

const SURF_FS = HEAD + COMMON + SURF_SRC;

// Buildings and the light: lit boxes with windows that come on at night.
const SOLID_VS = /* glsl */ `#version 300 es
in vec3 aPos;
in vec3 aNormal;
in vec3 aInfo; // along-wall metres, kind (0 wall, 1 roof, 2 light), seed
uniform mat4 uViewProj;
out vec3 vPos;
out vec3 vN;
out vec3 vInfo;
void main() { vPos = aPos; vN = aNormal; vInfo = aInfo; gl_Position = uViewProj * vec4(aPos, 1.0); }`;

const SOLID_FS = HEAD + COMMON + SOLID_SRC;

// Trees: billboards with bare November crowns (most leaves are down by now).
const TREE_VS = /* glsl */ `#version 300 es
in vec2 aCorner;           // -0.5..0.5, 0..1
in vec4 aTree;             // east, north, ground (rel. water), height
uniform mat4 uViewProj;
uniform vec3 uCam;
out vec2 vUv;
out vec3 vPos;
out float vSeed;
void main() {
  vec3 base = vec3(aTree.x, aTree.z, -aTree.y);
  vec3 toCam = uCam - base;
  vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x));
  float h = aTree.w;
  vec3 pos = base + right * aCorner.x * h * 0.8 + vec3(0.0, aCorner.y * h, 0.0);
  vUv = aCorner;
  vPos = pos;
  vSeed = fract(aTree.x * 0.37 + aTree.y * 0.71);
  gl_Position = uViewProj * vec4(pos, 1.0);
}`;

const TREE_FS = HEAD + COMMON + TREE_SRC;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
  return s;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(p, name);
  }
  return {p, u};
}

// --- tiny matrix helpers (column-major) ------------------------------------
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}
function lookDir(eye, [fx, fy, fz]) {
  let rx = -fz;
  let rz = fx;
  const rl = Math.hypot(rx, rz);
  rx /= rl;
  rz /= rl;
  const ry = 0;
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
  return [rx, ux, -fx, 0, ry, uy, -fy, 0, rz, uz, -fz, 0,
    -(rx * eye[0] + ry * eye[1] + rz * eye[2]), -(ux * eye[0] + uy * eye[1] + uz * eye[2]), fx * eye[0] + fy * eye[1] + fz * eye[2], 1];
}
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function transformPoint(m, [x, y, z]) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w, w];
}
function invert(m) {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = 1 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06);
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * det, (a02 * b10 - a01 * b11 - a03 * b09) * det,
    (a31 * b05 - a32 * b04 + a33 * b03) * det, (a22 * b04 - a21 * b05 - a23 * b03) * det,
    (a12 * b08 - a10 * b11 - a13 * b07) * det, (a00 * b11 - a02 * b08 + a03 * b07) * det,
    (a32 * b02 - a30 * b05 - a33 * b01) * det, (a20 * b05 - a22 * b02 + a23 * b01) * det,
    (a10 * b10 - a11 * b08 + a13 * b06) * det, (a01 * b08 - a00 * b10 - a03 * b06) * det,
    (a30 * b04 - a31 * b02 + a33 * b00) * det, (a21 * b02 - a20 * b04 - a23 * b00) * det,
    (a11 * b07 - a10 * b09 - a12 * b06) * det, (a00 * b09 - a01 * b07 + a02 * b06) * det,
    (a31 * b01 - a30 * b03 - a32 * b00) * det, (a20 * b03 - a21 * b01 + a22 * b00) * det,
  ];
}

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Compass bearing (deg) + elevation -> world vector (x = east, z = south). */
export const toWorld = (bearingDeg, elevDeg = 0) => {
  const b = bearingDeg * R;
  const e = elevDeg * R;
  return [Math.sin(b) * Math.cos(e), Math.sin(e), -Math.cos(b) * Math.cos(e)];
};


/** Sun azimuth/elevation (degrees) for a time and place. */
export function sunPosition(ms, lat, lon) {
  const d = ms / 86400000 + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * R;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * R;
  const e = (23.439 - 0.00000036 * d) * R;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const H = (gmst * 15 + lon) * R - ra;
  const la = lat * R;
  const el = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(H));
  return {az: ((az / R) + 360) % 360, el: el / R};
}

/** Sun direction in (east, up, south) axes — used for the chart's night shading. */
export function sunDirection(ms, lat, lon) {
  const {az, el} = sunPosition(ms, lat, lon);
  return toWorld(az, el);
}

// --- static geometry from scene.json ----------------------------------------
function earClip(poly) {
  const idx = poly.map((_, i) => i);
  const area = poly.reduce((s, [x, y], i) => { const [x2, y2] = poly[(i + 1) % poly.length]; return s + x * y2 - x2 * y; }, 0);
  if (area < 0) idx.reverse();
  const tris = [];
  const inside = (p, a, b, c) => {
    const s = (u, v, w) => (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]);
    return s(a, b, p) >= 0 && s(b, c, p) >= 0 && s(c, a, p) >= 0;
  };
  let guard = 0;
  while (idx.length > 3 && guard++ < 5000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = poly[ia], b = poly[ib], c = poly[ic];
      if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) <= 0) continue;
      if (idx.some(j => j !== ia && j !== ib && j !== ic && inside(poly[j], a, b, c))) continue;
      tris.push([ia, ib, ic]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) tris.push(idx.slice());
  return tris;
}

function buildSolids(scene, level) {
  const pos = [], nor = [], info = [];
  const push = (p, n, inf) => { pos.push(...p); nor.push(...n); info.push(...inf); };
  const addBox = (poly, base, top, seed, kind) => {
    let run = 0;
    for (let i = 0; i < poly.length; i++) {
      const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len < 0.01) continue;
      const n = [(y1 - y0) / len, 0, (x1 - x0) / len]; // outward for CCW in east/north -> world (x, -y)
      const a = [x0, base, -y0], b = [x1, base, -y1], c = [x1, top, -y1], d = [x0, top, -y0];
      const r0 = run, r1 = run + len;
      for (const [p, u] of [[a, r0], [b, r1], [c, r1], [a, r0], [c, r1], [d, r0]]) push(p, n, [u, kind, seed]);
      run = r1;
    }
    for (const [i, j, k] of earClip(poly)) for (const v of [i, k, j]) push([poly[v][0], top, -poly[v][1]], [0, 1, 0], [0, 1, seed]);
  };
  for (const b of scene.buildings) {
    let poly = b.p;
    const area = poly.reduce((s, [x, y], i) => { const [x2, y2] = poly[(i + 1) % poly.length]; return s + x * y2 - x2 * y; }, 0);
    if (area < 0) poly = poly.slice().reverse();
    const seed = Math.abs(Math.sin(poly[0][0] * 12.9 + poly[0][1] * 78.2));
    addBox(poly, b.base - level - 0.3, b.base - level + b.h, seed, 0);
  }
  // The hook, the harbor walls and the stepped seawall behind the beach.
  for (const wall of scene.walls ?? []) {
    const hw = wall.w / 2;
    const top = 2.6 - level;
    const foot = -2.5 - level;
    for (let i = 0; i + 1 < wall.p.length; i++) {
      const [x0, y0] = wall.p[i], [x1, y1] = wall.p[i + 1];
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len < 0.2) continue;
      const nx = -(y1 - y0) / len, ny = (x1 - x0) / len; // left normal (east, north)
      const L0 = [x0 + nx * hw, y0 + ny * hw], R0 = [x0 - nx * hw, y0 - ny * hw];
      const L1 = [x1 + nx * hw, y1 + ny * hw], R1 = [x1 - nx * hw, y1 - ny * hw];
      const v = (p, y) => [p[0], y, -p[1]];
      // deck
      for (const p of [L0, R0, R1, L0, R1, L1]) push(v(p, top), [0, 1, 0], [0, 3, 0.4]);
      // sloped stone sides
      const sL0 = [L0[0] + nx * 2.5, L0[1] + ny * 2.5], sL1 = [L1[0] + nx * 2.5, L1[1] + ny * 2.5];
      const sR0 = [R0[0] - nx * 2.5, R0[1] - ny * 2.5], sR1 = [R1[0] - nx * 2.5, R1[1] - ny * 2.5];
      const nl = [nx * 0.8, 0.6, -ny * 0.8], nr = [-nx * 0.8, 0.6, ny * 0.8];
      for (const [p, y] of [[L0, top], [sL0, foot], [sL1, foot], [L0, top], [sL1, foot], [L1, top]]) push(v(p, y), nl, [len, 3, 0.6]);
      for (const [p, y] of [[R0, top], [sR1, foot], [sR0, foot], [R0, top], [R1, top], [sR1, foot]]) push(v(p, y), nr, [len, 3, 0.6]);
    }
  }
  for (const l of scene.lights) {
    const r = 1.1, sides = 8, poly = [];
    for (let i = 0; i < sides; i++) poly.push([l.x + r * Math.cos((i / sides) * 2 * Math.PI), l.y + r * Math.sin((i / sides) * 2 * Math.PI)]);
    addBox(poly, 2.6 - level, 9.6 - level, 0.5, 2);
  }
  return {pos: new Float32Array(pos), nor: new Float32Array(nor), info: new Float32Array(info)};
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{geo: object, level: number, onMeasure?: Function, marker?: HTMLElement}} opts
 *   level: lake level above Low Water Datum (m).
 */
export function createWater(canvas, {geo, level, onMeasure, marker}) {
  const gl = canvas.getContext('webgl2', {antialias: false, alpha: false, powerPreference: 'high-performance'});
  if (!gl) throw new Error('WebGL2 is not available in this browser.');
  const H = geo.header;
  const scene = geo.scene;
  const towers = scene.skyline.slice(0, 120);
  const NT = Math.max(1, towers.length);

  const sky = program(gl, SKY_VS, skyFs(NT));
  const surf = program(gl, SURF_VS, SURF_FS);
  const solid = program(gl, SOLID_VS, SOLID_FS);
  const tree = program(gl, TREE_VS, TREE_FS);
  const post = createPost(gl);
  let paint = 0.8;

  // Sky triangle
  const skyVao = gl.createVertexArray();
  gl.bindVertexArray(skyVao);
  const tri = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, tri);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(gl.getAttribLocation(sky.p, 'aPos'));
  gl.vertexAttribPointer(gl.getAttribLocation(sky.p, 'aPos'), 2, gl.FLOAT, false, 0, 0);

  // Screen-space grid for the lake and the land.
  const verts = new Float32Array((GX + 1) * (GY + 1) * 2);
  let o = 0;
  for (let j = 0; j <= GY; j++) for (let i = 0; i <= GX; i++) { verts[o++] = i / GX; verts[o++] = j / GY; }
  const idx = new Uint32Array(GX * GY * 6);
  o = 0;
  for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
    const a = j * (GX + 1) + i, b = a + 1, c = a + GX + 1, d = c + 1;
    idx.set([a, b, c, b, d, c], o);
    o += 6;
  }
  const surfVao = gl.createVertexArray();
  gl.bindVertexArray(surfVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(gl.getAttribLocation(surf.p, 'aGrid'));
  gl.vertexAttribPointer(gl.getAttribLocation(surf.p, 'aGrid'), 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);

  // Buildings + the hook light
  const solids = buildSolids(scene, level);
  const solidVao = gl.createVertexArray();
  gl.bindVertexArray(solidVao);
  for (const [name, data] of [['aPos', solids.pos], ['aNormal', solids.nor], ['aInfo', solids.info]]) {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(solid.p, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
  }
  const solidCount = solids.pos.length / 3;

  // Trees (instanced billboards)
  const treeVao = gl.createVertexArray();
  gl.bindVertexArray(treeVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, 0, 0.5, 0, 0.5, 1, -0.5, 0, 0.5, 1, -0.5, 1]), gl.STATIC_DRAW);
  const aCorner = gl.getAttribLocation(tree.p, 'aCorner');
  gl.enableVertexAttribArray(aCorner);
  gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, 0, 0);
  const treeData = new Float32Array(scene.trees.length * 4);
  scene.trees.forEach(([x, y, ground, h], i) => treeData.set([x, y, ground - level, h], i * 4));
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, treeData, gl.STATIC_DRAW);
  const aTree = gl.getAttribLocation(tree.p, 'aTree');
  gl.enableVertexAttribArray(aTree);
  gl.vertexAttribPointer(aTree, 4, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(aTree, 1);
  gl.bindVertexArray(null);

  // Textures ------------------------------------------------------------------
  const G = H.grid, S = H.shelterGrid, F = H.farGrid;
  const texture = (unit, w, h, internal, format, type, data, filter) => {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const geoRG = new Float32Array(G.nx * G.ny * 2);
  for (let k = 0; k < G.nx * G.ny; k++) { geoRG[k * 2] = geo.elev[k] / 100; geoRG[k * 2 + 1] = geo.dEq[k] / 10; }
  const tTable = texture(0, TW, N_WAVES + 1, gl.RGBA32F, gl.RGBA, gl.FLOAT, null, gl.NEAREST);
  texture(1, G.nx, G.ny, gl.RG16F, gl.RG, gl.FLOAT, geoRG, gl.LINEAR);
  texture(2, G.nx, G.ny, gl.R8, gl.RED, gl.UNSIGNED_BYTE, geo.mat, gl.NEAREST);
  const atlas = new Uint8Array(S.nx * 4 * S.ny * 4);
  for (let b = 0; b < 16; b++) {
    const tx = (b % 4) * S.nx, ty = Math.floor(b / 4) * S.ny;
    for (let j = 0; j < S.ny; j++) atlas.set(geo.shelter.subarray(b * S.nx * S.ny + j * S.nx, b * S.nx * S.ny + (j + 1) * S.nx), (ty + j) * S.nx * 4 + tx);
  }
  texture(3, S.nx * 4, S.ny * 4, gl.R8, gl.RED, gl.UNSIGNED_BYTE, atlas, gl.LINEAR);
  texture(4, F.nx, F.ny, gl.R16F, gl.RED, gl.FLOAT, Float32Array.from(geo.far, v => v / 100), gl.LINEAR);

  const face = H.face * R;
  const nrm = [Math.sin(face), Math.cos(face)];
  const tng = [Math.cos(face), -Math.sin(face)];
  const base = [H.profileBase.x, H.profileBase.y];
  // Two real places to stand. Ground heights are LWD-relative.
  const VIEWS = {
    // At the water's edge in front of the beach mat: Surfline's lineup marker.
    mat: {x: base[0] - nrm[0] * 9, y: base[1] - nrm[1] * 9, ground: H.mapLevel + 9 / 12, yaw: H.face + 27, pitch: -4, hfov: 80},
    // Out on the hook (the fishing pier), looking back across the lineup: a surf-cam lens.
    hook: {x: 451, y: 215, ground: 2.6, yaw: 258, pitch: -2.5, hfov: 52},
    // Debug: straight down from 2.2 km, north up (?view=top).
    top: {x: 0, y: 200, ground: 2200, yaw: 0, pitch: -89.4, hfov: 70},
  };
  let view = VIEWS.mat;
  let eye = [view.x, view.ground - level + 1.7, -view.y];
  let HFOV = view.hfov;

  // --- state ---------------------------------------------------------------
  let target = null;
  let cur = null;
  let tau = 0.8;
  let sunTarget = toWorld(180, 20);
  let sun = [...sunTarget];
  // The moon and the star dome (sidereal time + latitude), eased like the sun so playback glides.
  let moonTarget = toWorld(200, -30);
  let moon = [...moonTarget];
  let moonLit = 0.5;
  let lstTarget = 0;
  let lst = 0;
  let latR = 41.9655 * R;
  const starU = new Float32Array(NS * 4);
  const starWarm = Float32Array.from(STARS, s => s.warm);
  let yaw = view.yaw;
  let pitch = view.pitch;
  const phases = new Float64Array(N_WAVES);
  let phasesInit = false;
  const uPh = new Float32Array(N_WAVES);
  let deep = new Float32Array(N_WAVES * 4);
  let surfReport = null;
  let tableSea = null;
  let lastTable = -1e9;
  const t0 = performance.now();
  let last = t0;
  let lastMeasure = 0;
  let raf = 0;
  const towerU = new Float32Array(NT * 4);
  // Towers by position (from the mat-camera bearings in scene.json), re-aimed from wherever you stand.
  const towerXY = towers.map(t => { const b = t[0] * R, d = t[3]; return [H.camera.x + d * Math.sin(b), H.camera.y + d * Math.cos(b), Math.tan(t[2] * R) * d, Math.tan(t[1] * R) * d]; });
  const aimTowers = () => towerXY.forEach(([x, y, h, w], i) => { const dx = x - eye[0], dy = y + eye[2], d = Math.hypot(dx, dy); towerU.set([((Math.atan2(dx, dy) / R) + 360) % 360, Math.atan(w / d) / R, Math.atan((h + 1.7 - eye[1]) / d) / R, d], i * 4); });
  aimTowers();

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    post.resize(Math.max(2, w), Math.max(2, h));
  }
  const changed = (a, b) => !b || Math.abs(a.hs - b.hs) > 0.004 || Math.abs(a.tp - b.tp) > 0.004
    || Math.abs(((a.towardDeg - b.towardDeg + 540) % 360) - 180) > 0.15;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!target) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const time = (now - t0) / 1000;
    resize();

    cur = approach(cur, target, dt, tau);
    const ease = 1 - Math.exp(-dt / Math.min(tau, 0.3));
    sun = mix(sun, sunTarget, ease);
    const sl = Math.hypot(...sun);
    const sunDir = sun.map(v => v / sl);
    moon = mix(moon, moonTarget, ease);
    const ml = Math.hypot(...moon) || 1;
    const moonDir = moon.map(v => v / ml);
    lst += (((lstTarget - lst) % TAU + TAU + Math.PI) % TAU - Math.PI) * ease;
    const starM = starFrame(lst, latR);
    STARS.forEach((s, i) => {
      for (let r = 0; r < 3; r++) starU[i * 4 + r] = starM[r * 3] * s.e[0] + starM[r * 3 + 1] * s.e[1] + starM[r * 3 + 2] * s.e[2];
      starU[i * 4 + 3] = s.b;
    });

    const comps = components(cur);
    if (!phasesInit) { comps.forEach((c, i) => (phases[i] = -c.phase0)); phasesInit = true; }
    let slopeVar = 0;
    comps.forEach((c, i) => {
      phases[i] = (phases[i] + c.omega * dt) % (Math.PI * 2);
      uPh[i] = phases[i];
      slopeVar += (c.amp * c.k) ** 2 / 2;
    });
    if (changed(cur, tableSea) && now - lastTable > 66) {
      const tr = transform(comps, cur);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tTable);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TW, N_WAVES + 1, gl.RGBA, gl.FLOAT, tr.table);
      deep = tr.deep;
      surfReport = tr.report;
      tableSea = cur;
      lastTable = now;
    }

    const micro = Math.sqrt(Math.max(0.002, 0.003 + 5.12e-3 * cur.windMs - slopeVar));
    const foamWind = smooth(7, 24, cur.windMph);
    const storm = Math.min(1, smooth(6, 26, cur.windMph) * 0.8 + smooth(1, 5, cur.hsFt) * 0.35);
    const L = lighting(sunDir, storm, {dir: moonDir, lit: moonLit});
    const windTo = toWorld(cur.towardDeg);
    const fogDist = view === VIEWS.top ? 1e7 : 4200 - 2400 * storm;
    const from = (cur.towardDeg + 180) % 360;
    const fb = from / 22.5;
    const bins = [Math.floor(fb) % 16, (Math.floor(fb) + 1) % 16, fb - Math.floor(fb)];
    const driftSign = surfReport?.breaking && Math.round(surfReport.driftBearing) === Math.round((H.face + 90) % 360) ? 1 : -1;
    const drift = surfReport?.breaking ? surfReport.driftMs * driftSign : 0;

    const aspect = canvas.width / canvas.height;
    const hfov = HFOV * R;
    const fovy = Math.max(46 * R, 2 * Math.atan(Math.tan(hfov / 2) / aspect));
    const fwd = toWorld(yaw, pitch);
    const viewProj = mul(perspective(fovy, aspect, 0.3, 40000), lookDir(eye, fwd));
    const inv = invert(viewProj);
    const hz = toWorld(yaw, 0);
    const hy = transformPoint(viewProj, [eye[0] + hz[0] * 30000, 0, eye[2] + hz[2] * 30000]);
    const yTop = hy[2] > 0 ? Math.min(1.05, hy[1] + 0.03) : 1.05;

    const shared = u => {
      gl.uniform3fv(u.uSunDir, sunDir);
      gl.uniform3fv(u.uSunColor, L.sunColor);
      gl.uniform1f(u.uSunVis, L.sunVis);
      gl.uniform3fv(u.uMoonDir, moonDir);
      gl.uniform3fv(u.uMoonColor, L.moonColor);
      gl.uniform3fv(u.uZenith, L.zenith);
      gl.uniform3fv(u.uHorizon, L.horizon);
      gl.uniform3fv(u.uGlow, L.glow);
      gl.uniform3fv(u.uVenus, L.venus);
      gl.uniform3fv(u.uCity, L.city);
      gl.uniform1f(u.uCover, L.cover);
      gl.uniform3fv(u.uCloud, L.cloud);
      gl.uniform3fv(u.uCloudDark, L.cloudDark);
      gl.uniform1f(u.uDay, L.day);
      gl.uniform1f(u.uFogDist, fogDist);
      gl.uniform3fv(u.uCam, eye);
      gl.uniform1f(u.uTime, time);
      gl.uniform3fv(u.uAmbient, L.ambient);
    };
    const drawSky = (invM, cam) => {
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(sky.p);
      shared(sky.u);
      gl.uniform3fv(sky.u.uCam, cam);
      gl.uniformMatrix4fv(sky.u.uInvViewProj, false, invM);
      gl.uniform2fv(sky.u.uWindTo, [windTo[0], windTo[2]]);
      gl.uniform1f(sky.u.uWindMs, cur.windMs);
      gl.uniform4fv(sky.u.uTowers, towerU);
      gl.uniformMatrix3fv(sky.u.uStarRot, false, starM);
      gl.uniform4fv(sky.u.uStars, starU);
      gl.uniform1fv(sky.u.uStarWarm, starWarm);
      gl.uniform1f(sky.u.uNight, L.night);
      gl.uniform1f(sky.u.uBank, L.bank);
      gl.bindVertexArray(skyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.enable(gl.DEPTH_TEST);
    };
    const drawSolids = (vp, clip) => {
      gl.useProgram(solid.p);
      shared(solid.u);
      gl.uniformMatrix4fv(solid.u.uViewProj, false, vp);
      gl.uniform1f(solid.u.uClip, clip);
      gl.bindVertexArray(solidVao);
      gl.drawArrays(gl.TRIANGLES, 0, solidCount);

      gl.useProgram(tree.p);
      shared(tree.u);
      gl.uniformMatrix4fv(tree.u.uViewProj, false, vp);
      gl.uniform1f(tree.u.uClip, clip);
      gl.bindVertexArray(treeVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, scene.trees.length);
    };

    // 1. The mirror: the world upside down in the water plane, as the lake will reflect it.
    const mirrorVP = mul(viewProj, MIRROR);
    post.beginMirror();
    drawSky(invert(mirrorVP), [eye[0], -eye[1], eye[2]]);
    drawSolids(mirrorVP, 1);

    // 2. The scene, in HDR.
    post.beginScene();
    drawSky(inv, eye);

    gl.useProgram(surf.p);
    shared(surf.u);
    gl.uniformMatrix4fv(surf.u.uViewProj, false, viewProj);
    gl.uniformMatrix4fv(surf.u.uInvViewProj, false, inv);
    gl.uniform2fv(surf.u.uGridX, [-1.15, 1.15]);
    gl.uniform2fv(surf.u.uGridY, [-1.8, yTop]);
    gl.uniform1f(surf.u.uCell, (hfov * 1.15) / GX);
    [['uTable', 0], ['uGeo', 1], ['uMat', 2], ['uShelter', 3], ['uFar', 4], ['uRefl', REFL_UNIT]].forEach(([n, i]) => gl.uniform1i(surf.u[n], i));
    gl.uniform2f(surf.u.uRes, canvas.width, canvas.height);
    gl.uniform4fv(surf.u.uGeoBox, [G.x0, G.y0, G.nx * G.cell, G.ny * G.cell]);
    gl.uniform4fv(surf.u.uFarBox, [F.x0, F.y0, F.nx * F.cell, F.ny * F.cell]);
    gl.uniform3fv(surf.u.uBins, bins);
    gl.uniform2fv(surf.u.uBase, base);
    gl.uniform2fv(surf.u.uNrm, nrm);
    gl.uniform2fv(surf.u.uTng, tng);
    gl.uniform1f(surf.u.uLevel, level);
    gl.uniform4fv(surf.u.uDeep, deep);
    gl.uniform1fv(surf.u.uPh, uPh);
    gl.uniform1f(surf.u.uRunup, surfReport?.runup ?? 0.05);
    gl.uniform1f(surf.u.uSwashW, (2 * Math.PI) / (2.2 * cur.tp));
    gl.uniform2fv(surf.u.uWindTo, [windTo[0], windTo[2]]);
    gl.uniform1f(surf.u.uMicro, micro);
    gl.uniform1f(surf.u.uFoamWind, foamWind);
    gl.uniform3fv(surf.u.uDeepCol, L.deep);
    gl.uniform3fv(surf.u.uScatter, L.scatter);
    gl.uniform1f(surf.u.uDrift, drift);
    gl.bindVertexArray(surfVao);
    gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_INT, 0);

    drawSolids(viewProj, 0);

    // 3. Bloom, brushwork, canvas.
    // The colder and windier it is, the less steady the hand holding the brush.
    const shiver = Math.min(1, 0.2 + 0.6 * smooth(8, 30, cur.windMph) + 0.25 * (1 - L.day));
    post.finish({paint: view === VIEWS.top ? 0 : paint, bloom: 0.16, time, shiver});

    // Pin the break-point label on the lineup straight out from the mat.
    if (marker) {
      let shown = false;
      if (surfReport?.breaking && surfReport.distance >= 15) {
        const px = base[0] + nrm[0] * surfReport.distance, py = base[1] + nrm[1] * surfReport.distance;
        const p = transformPoint(viewProj, [px, 0.8, -py]);
        if (p[2] > 0 && Math.abs(p[0]) < 0.95 && Math.abs(p[1]) < 0.9) {
          const x = ((p[0] + 1) / 2) * canvas.clientWidth;
          const y = ((1 - p[1]) / 2) * canvas.clientHeight;
          marker.style.transform = `translate(${x}px, ${y}px)`;
          shown = true;
        }
      }
      marker.style.opacity = shown ? '1' : '0';
    }

    if (onMeasure && now - lastMeasure > 400) {
      lastMeasure = now;
      onMeasure({hsFt: measureHs(comps, phases, {size: 900, n: 48}) / 0.3048, sea: cur});
    }
  }

  let drag = null;
  const down = e => { drag = {x: e.clientX, y: e.clientY, yaw, pitch}; canvas.setPointerCapture(e.pointerId); };
  const move = e => {
    if (!drag) return;
    yaw = (drag.yaw - (e.clientX - drag.x) * 0.15 + 360) % 360;
    pitch = Math.max(-35, Math.min(40, drag.pitch + (e.clientY - drag.y) * 0.1));
    api.onView?.(yaw);
  };
  const up = () => (drag = null);
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);

  const api = {
    /** sky: the result of celestial() (sun az/el, moon, sidereal time, latitude). */
    set(sea, sky, opts = {}) {
      target = sea;
      tau = opts.tau ?? 0.8;
      if (sky) {
        sunTarget = toWorld(sky.az, sky.el);
        if (sky.moon) { moonTarget = toWorld(sky.moon.az, sky.moon.el); moonLit = sky.moon.lit; }
        if (sky.lst != null) lstTarget = sky.lst;
        if (sky.lat != null) latR = sky.lat;
      }
      if (!cur) { sun = [...sunTarget]; moon = [...moonTarget]; lst = lstTarget; }
    },
    get yaw() { return yaw; },
    /** Point the view: compass bearing and pitch in degrees. */
    look(y, p) {
      if (Number.isFinite(y)) yaw = ((y % 360) + 360) % 360;
      if (Number.isFinite(p)) pitch = Math.max(-35, Math.min(40, p));
      api.onView?.(yaw);
    },
    /** 0 = clear glass, 1 = thick paint. */
    set paint(v) { paint = Math.max(0, Math.min(1, v)); },
    get paint() { return paint; },
    /** 'mat' (water's edge off the beach mat) or 'hook' (on the fishing pier). */
    setView(name) {
      view = VIEWS[name] ?? VIEWS.mat;
      eye = [view.x, view.ground - level + 1.7, -view.y];
      aimTowers();
      HFOV = view.hfov;
      yaw = view.yaw;
      pitch = view.pitch;
      api.onView?.(yaw);
    },
    onView: null,
    destroy() {
      cancelAnimationFrame(raf);
      post.dispose();
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
    },
  };
  raf = requestAnimationFrame(frame);
  return api;
}
