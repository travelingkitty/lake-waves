// Surf cam: a NE-facing Chicago beach, drawn in WebGL2. No libraries.
//
// One screen-space grid is projected onto the lake each frame (dense where you
// look, so the surf zone is sharp). Each vertex is either water or sand:
//   * water: the 32 forecast wave components, taken from deep water to the
//     beach by surf.js (shoaling, refraction, depth-limited breaking), plus
//     swash running up the beach face;
//   * sand/land: beach face, berm, promenade, park.
// Foam marks breaking crests (crest higher than ~0.4 × depth), the broken
// bores and lace inside the surf zone, the swash edge, and wind whitecaps
// offshore. The sky follows the sun for the forecast hour; downtown sits up
// the shore and fades out when the storm haze closes in.

import {approach, components, measureHs, N_WAVES} from './seaState.js';
import {D0, FACE, TW, transform} from './surf.js';

const EYE = [0, 6.5, 14]; // world (s, y, -d): on the beach 14 m back from the water, 6.5 m up
export const VIEW_YAW = FACE - 45; // look out over the break, with the beach running off up the shore
const GX = 240;
const GY = 170;
const HFOV = 70;

const COMMON = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunVis;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform float uCover;
uniform vec3 uCloud;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
vec3 skyBase(vec3 d) {
  float y = max(d.y, 0.0);
  vec3 c = mix(uHorizon, uZenith, pow(y, 0.55));
  float s = max(dot(d, uSunDir), 0.0);
  c += uSunColor * (0.28 * pow(s, 5.0) + 0.6 * pow(s, 60.0)) * (0.35 + 0.65 * uSunVis);
  c += uSunColor * 6.0 * pow(s, 1800.0) * uSunVis;
  return c;
}
`;

const SKY_VS = /* glsl */ `#version 300 es
in vec2 aPos;
out vec2 vNdc;
void main() { vNdc = aPos; gl_Position = vec4(aPos, 0.9999, 1.0); }`;

const SKY_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vNdc;
out vec4 outColor;
uniform mat4 uInvViewProj;
uniform vec3 uCam;
uniform float uTime;
uniform vec2 uWindTo;
uniform float uWindMs;
uniform float uFace;
uniform float uDay;
uniform float uFogDist;
${COMMON}

float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}

// Downtown, ~11 km up the shore (bearing ~331–351°), apparent heights in degrees.
vec3 skyline(vec3 d, vec3 c) {
  float b = mod(degrees(atan(d.x, -d.z)) + uFace + 720.0, 360.0);
  float e = degrees(asin(clamp(d.y, -1.0, 1.0)));
  if (b < 331.0 || b > 351.0 || e > 2.2 || e < -0.2) return c;
  float u = (b - 331.0) * 6.0;
  float id = floor(u);
  float r = hash(vec2(id, 7.0));
  float core = exp(-pow((b - 341.5) / 4.5, 2.0));
  float top = 0.06 + core * (0.2 + 0.8 * r * r) + (1.0 - core) * 0.16 * r;
  if (abs(b - 343.2) < 0.17) top = 2.05;
  if (abs(b - 338.6) < 0.13) top = 1.75;
  if (abs(b - 340.4) < 0.12) top = 1.42;
  if (e > top) return c;
  float vis = exp(-11000.0 / (uFogDist * 2.6));
  vec3 body = mix(c * 0.6, vec3(0.17, 0.18, 0.21) * (0.3 + 0.7 * uDay), 0.55);
  vec2 cell = vec2(u * 8.0, e * 45.0);
  float lit = step(0.6, hash(floor(cell))) * step(0.25, fract(cell.x)) * step(0.3, fract(cell.y));
  body += vec3(1.0, 0.8, 0.5) * lit * 0.55 * (1.0 - uDay);
  if (top > 1.7 && e > top - 0.05) body += vec3(1.0, 0.1, 0.05) * step(0.5, fract(uTime * 0.5)) * (1.0 - uDay) * 2.0;
  return mix(c, body, vis);
}

void main() {
  vec4 w = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 d = normalize(w.xyz / w.w - uCam);
  vec3 c = skyBase(d);
  if (d.y > 0.0) {
    vec2 uv = d.xz / (d.y + 0.06) * 0.9 + uWindTo * uTime * (0.002 + 0.0009 * uWindMs);
    float n = fbm(uv * 1.6);
    float m = smoothstep(1.0 - uCover, 1.0 - uCover + 0.35, n);
    float shade = mix(1.05, 0.62, smoothstep(0.35, 0.9, n));
    c = mix(c, uCloud * shade, m * smoothstep(0.0, 0.08, d.y));
  }
  outColor = vec4(skyline(d, c), 1.0);
}`;

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

const float D0 = ${D0.toFixed(1)};
const int TW = ${TW};
const int NR = ${N_WAVES};

vec4 tab(int row, float d) {
  float u = sqrt(clamp(d / D0, 0.0, 1.0)) * float(TW - 1);
  int j = min(int(u), TW - 2);
  float f = u - float(j);
  return mix(texelFetch(uTable, ivec2(j, row), 0), texelFetch(uTable, ivec2(j + 1, row), 0), f);
}

// Beach face 1:11 up to a 2 m berm, sand to ~46 m back, a 2.85 m promenade, then park.
float land(float d) {
  float y = min(-d * 0.09, 2.0);
  y += (1.0 - smoothstep(-50.0, -46.0, d)) * 0.85;
  y += (1.0 - smoothstep(-80.0, -72.0, d)) * 0.15;
  return y;
}

void main() {
  vec2 ndc = vec2(mix(uGridX.x, uGridX.y, aGrid.x), mix(uGridY.x, uGridY.y, aGrid.y));
  vec4 far = uInvViewProj * vec4(ndc, 1.0, 1.0);
  vec3 rd = normalize(far.xyz / far.w - uCam);
  float t = rd.y < -1e-4 ? -uCam.y / rd.y : 1e9;
  t = min(t, 30000.0);
  vec2 xz = uCam.xz + rd.xz * t;
  float s = xz.x;
  float d = -xz.y;
  float spacing = t * uCell / max(-rd.y, 0.04);

  vec4 sc = tab(NR, clamp(d, 0.0, D0));
  float h = d > 0.0 ? sc.x : 0.0;
  float eta = 0.0;
  vec2 disp = vec2(0.0);
  vec3 n = vec3(0.0, 1.0, 0.0);
  if (d > 0.0) {
    float chop = sc.w;
    for (int i = 0; i < NR; i++) {
      vec4 dp = uDeep[i];
      float psi, A, kx;
      if (d >= D0) { psi = dp.w + dp.y * (d - D0); A = dp.z; kx = dp.y; }
      else { vec4 tv = tab(i, d); psi = tv.x; A = tv.y; kx = tv.z; }
      float ky = dp.x;
      float k = max(length(vec2(ky, kx)), 1e-4);
      A *= 1.0 - smoothstep(0.22, 0.5, spacing * k * 0.1591549);
      float th = ky * s - psi - uPh[i];
      float sn = sin(th), cs = cos(th);
      eta += A * sn;
      disp += chop * A * vec2(ky, kx) / k * cs;
      n.x -= A * ky * cs;
      n.z -= A * kx * cs;
      n.y -= chop * A * k * sn;
    }
  }
  // Swash: the water's edge runs up and down the beach face (infragravity pulse).
  float swash = uRunup * (0.5 + 0.3 * sin(uSwashW * uTime - 0.021 * s) + 0.2 * sin(1.37 * uSwashW * uTime - 0.034 * s + 1.3));
  float water = eta + swash * (1.0 - smoothstep(0.0, 14.0, d));
  float g = d > 0.0 ? -h : land(d);
  vec3 world = vec3(s, max(water, g), -d);
  if (water > g) world.xz += disp;
  else if (d <= 0.0) n = vec3(0.0, 1.0, (land(d + 0.5) - land(d - 0.5)));

  vWorld = world;
  vNormal = n;
  vEta = eta;
  vH = h;
  vThick = water - g;
  vGround = g;
  vFoam = d > 0.0 ? sc.y : 0.0;
  vHs = d > 0.0 ? sc.z : 0.0;
  vD = d;
  vS = s;
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

const SURF_FS = /* glsl */ `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in float vEta;
in float vH;
in float vThick;
in float vGround;
in float vFoam;
in float vHs;
in float vD;
in float vS;
out vec4 outColor;
uniform vec3 uCam;
uniform float uTime;
uniform vec2 uWindTo;
uniform float uMicro;
uniform float uFoamWind;
uniform float uFogDist;
uniform vec3 uDeepCol;
uniform vec3 uScatter;
uniform vec3 uAmbient;
uniform float uRunup;
uniform float uDrift;
${COMMON}

vec3 skyRefl(vec3 d) {
  vec3 c = skyBase(d);
  return mix(c, uCloud * 0.9, uCover * 0.75 * smoothstep(0.0, 0.25, d.y));
}

void main() {
  vec3 toCam = uCam - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec3 sunL = uSunColor * uSunVis;
  vec3 col;

  if (vThick <= 0.0) {
    // --- sand, promenade, park -------------------------------------------
    vec3 n = normalize(vNormal);
    float wet = (1.0 - smoothstep(uRunup * 1.25, uRunup * 1.25 + 0.3, vGround)) * step(-30.0, vD);
    vec3 sand = vec3(0.78, 0.71, 0.57) * (0.86 + 0.28 * noise(vWorld.xz * 1.9) * noise(vWorld.xz * 0.21));
    sand = mix(sand, vec3(0.46, 0.41, 0.33), wet * 0.85);
    float paved = smoothstep(2.55, 2.75, vGround) * step(vD, -45.0);
    vec3 albedo = mix(sand, vec3(0.5, 0.5, 0.48), paved);
    albedo = mix(albedo, vec3(0.25, 0.28, 0.18), 1.0 - smoothstep(-80.0, -72.0, vD));
    col = albedo * (uAmbient + sunL * max(dot(n, uSunDir), 0.0));
    vec3 R = reflect(-V, n);
    col += wet * skyRefl(R) * (0.03 + 0.45 * pow(1.0 - max(dot(n, V), 0.0), 5.0));
  } else {
    // --- water ------------------------------------------------------------
    float foot = max(length(fwidth(vWorld.xz)), 1e-3);
    vec2 across = vec2(-uWindTo.y, uWindTo.x);
    vec2 q = vec2(dot(vWorld.xz, uWindTo), dot(vWorld.xz, across));
    vec2 grad = vec2(0.0);
    float resolved = 0.0;
    for (int j = 0; j < 3; j++) {
      float L = 3.2 * pow(0.345, float(j));
      float sc = 6.2831853 / L;
      float amp = uMicro * 0.38 / sc * (1.0 - smoothstep(0.25, 1.0, foot / L));
      resolved += (amp * sc) * (amp * sc);
      vec2 uv = vec2(q.x * sc, q.y * sc * 0.6) - vec2(uTime * sqrt(9.81 * sc) * 0.9, 0.0) + float(j) * 31.7;
      float e = 0.15;
      float h0 = noise(uv);
      vec2 g = vec2((noise(uv + vec2(e, 0.0)) - h0) / e * sc, (noise(uv + vec2(0.0, e)) - h0) / e * sc * 0.6) * amp;
      grad += uWindTo * g.x + across * g.y;
    }
    vec3 N = normalize(normalize(vNormal) + vec3(-grad.x, 0.0, -grad.y));
    float rough = clamp(uMicro * uMicro - resolved * 0.5, 0.0, 1.0);

    vec3 R = reflect(-V, N);
    R.y = abs(R.y);
    vec3 refl = mix(skyRefl(R), skyRefl(normalize(vec3(R.x, R.y + 0.35, R.z))), clamp(rough * 8.0, 0.0, 0.7));
    float F = 0.02 + 0.98 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);

    float hsLocal = max(vHs, 0.03);
    float crest = clamp(vEta / (hsLocal * 0.5), -1.5, 2.5);
    vec3 body = mix(uDeepCol, uScatter, clamp(0.25 + 0.35 * crest, 0.0, 1.0));
    float back = pow(clamp(dot(-V, uSunDir) * 0.5 + 0.5, 0.0, 1.0), 3.0);
    body += uScatter * 0.6 * back * clamp(crest, 0.0, 1.0) * uSunVis;
    // Shallow water: the sandy bottom shows through, greener and brighter.
    float clarity = exp(-max(vThick, 0.0) / 1.2);
    vec3 bottom = vec3(0.5, 0.46, 0.36) * (uAmbient + sunL * 0.7);
    body = mix(body, mix(bottom, uScatter * 2.2, 0.35), clarity * 0.8);
    col = mix(body, refl, F * (1.0 - 0.5 * clarity));
    float spec = pow(max(dot(R, uSunDir), 0.0), mix(900.0, 120.0, clamp(rough * 30.0, 0.0, 1.0)));
    col += uSunColor * spec * 3.0 * uSunVis;

    // Foam --------------------------------------------------------------
    // 1. a crest that has outgrown the depth is breaking: whitewater on the lip
    float lip = smoothstep(0.32, 0.48, vEta / max(vH, 0.05)) * step(0.0, vD) * (1.0 - smoothstep(5.0, 8.0, vH));
    // 2. inside the break, every crest is a broken bore
    float bore = vFoam * smoothstep(-0.2, 0.45, crest);
    // 3. lace left behind, drifting in and along the beach
    vec2 flow = vec2(vS - uDrift * uTime, vD + 1.3 * uTime);
    float lace = vFoam * smoothstep(0.5, 0.78, noise(flow * 0.32) * 0.6 + noise(flow * 1.25) * 0.4);
    // 4. the swash edge
    float edge = (1.0 - smoothstep(0.02, 0.2, vThick)) * (1.0 - step(25.0, vD));
    // 5. wind whitecaps offshore (Beaufort)
    vec2 drift = uWindTo * uTime * 1.2;
    float groups = noise((vWorld.xz - drift) * 0.045) * 0.65 + noise((vWorld.xz - drift) * 0.11) * 0.35;
    float wc = uFoamWind * smoothstep(1.15 - 0.6 * uFoamWind, 1.6 - 0.6 * uFoamWind, crest)
      * smoothstep(0.6 - 0.2 * uFoamWind, 0.76 - 0.18 * uFoamWind, groups) * step(4.0, vH);
    float tear = noise(vWorld.xz * 0.9 + vec2(uTime * 0.4, 0.0)) * 0.6 + noise(vWorld.xz * 3.1) * 0.4;
    float surf = max(max(lip, bore * 0.9), max(lace * 0.75, edge * 0.85));
    float foam = max(surf * smoothstep(0.15, 0.55, tear + 0.3 * surf), wc * smoothstep(0.3, 0.7, tear));
    vec3 foamCol = vec3(0.93, 0.95, 0.96) * (uAmbient * 1.35 + sunL * max(dot(N, uSunDir), 0.0) * 0.9 + 0.03);
    col = mix(col, foamCol, clamp(foam, 0.0, 0.97));
  }

  float fog = 1.0 - exp(-pow(dist / uFogDist, 1.25));
  col = mix(col, skyRefl(normalize(vec3(-V.x, 0.012, -V.z))), fog);
  outColor = vec4(col, 1.0);
}`;

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
const R = Math.PI / 180;

/** Compass bearing (deg) + elevation -> world vector (x = alongshore, z = onshore). */
const toWorld = (bearingDeg, elevDeg = 0) => {
  const b = (bearingDeg - FACE) * R;
  const e = elevDeg * R;
  return [Math.sin(b) * Math.cos(e), Math.sin(e), -Math.cos(b) * Math.cos(e)];
};

/** Sky + light for a sun elevation (rad) and a 0..1 storminess. */
function lighting(sunDir, storm) {
  const el = Math.asin(sunDir[1]);
  const day = smooth(-0.1, 0.12, el);
  const twilight = smooth(-0.14, 0, el) * (1 - smooth(0.02, 0.22, el));
  let zenith = mix([0.36, 0.5, 0.64], [0.27, 0.31, 0.35], storm);
  let horizon = mix([0.68, 0.74, 0.78], [0.5, 0.53, 0.55], storm);
  horizon = mix(horizon, [0.85, 0.5, 0.32], twilight * 0.8 * (1 - storm * 0.5));
  // Night over Chicago is never black: the city lights the cloud deck from below.
  const glow = 0.45 + 0.55 * storm;
  zenith = mix(mix([0.03, 0.04, 0.068], [0.1, 0.088, 0.09], glow), zenith, day);
  horizon = mix(mix([0.1, 0.1, 0.12], [0.24, 0.18, 0.15], glow), horizon, Math.max(day, twilight * 0.6));
  const sunColor = mix([1.0, 0.5, 0.25], [1.0, 0.93, 0.82], smooth(0.02, 0.35, el)).map(v => v * day);
  const light = 0.32 + 0.68 * day;
  return {
    day, zenith, horizon, sunColor,
    sunVis: day * (1 - storm * 0.85),
    ambient: zenith.map((v, i) => v * 0.55 + horizon[i] * 0.45),
    cloud: mix(mix([0.08, 0.08, 0.1], [0.17, 0.14, 0.13], glow), mix([0.78, 0.8, 0.82], [0.42, 0.44, 0.46], storm), Math.max(day, twilight * 0.5)),
    deep: [0.008, 0.045, 0.058].map(v => v * light + 0.004),
    scatter: [0.04, 0.19, 0.18].map(v => v * light + 0.004),
  };
}

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
  return [Math.sin(az * R) * Math.cos(el * R), Math.sin(el * R), -Math.cos(az * R) * Math.cos(el * R)];
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{onMeasure?: (m:{hsFt:number, sea:object}) => void}} opts
 */
export function createWater(canvas, {onMeasure, marker} = {}) {
  const gl = canvas.getContext('webgl2', {antialias: true, alpha: false, powerPreference: 'high-performance'});
  if (!gl) throw new Error('WebGL2 is not available in this browser.');

  const sky = program(gl, SKY_VS, SKY_FS);
  const surf = program(gl, SURF_VS, SURF_FS);

  const tri = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, tri);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const skyVao = gl.createVertexArray();
  gl.bindVertexArray(skyVao);
  const aPos = gl.getAttribLocation(sky.p, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  // Screen-space grid, projected onto the lake in the vertex shader.
  const verts = new Float32Array((GX + 1) * (GY + 1) * 2);
  let o = 0;
  for (let j = 0; j <= GY; j++) {
    for (let i = 0; i <= GX; i++) {
      verts[o++] = i / GX;
      verts[o++] = j / GY;
    }
  }
  const idx = new Uint32Array(GX * GY * 6);
  o = 0;
  for (let j = 0; j < GY; j++) {
    for (let i = 0; i < GX; i++) {
      const a = j * (GX + 1) + i, b = a + 1, c = a + GX + 1, d = c + 1;
      idx.set([a, b, c, b, d, c], o);
      o += 6;
    }
  }
  const surfVao = gl.createVertexArray();
  gl.bindVertexArray(surfVao);
  const vb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  const aGrid = gl.getAttribLocation(surf.p, 'aGrid');
  gl.enableVertexAttribArray(aGrid);
  gl.vertexAttribPointer(aGrid, 2, gl.FLOAT, false, 0, 0);
  const ib = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  gl.bindVertexArray(null);

  // Nearshore table (surf.js) as a float texture.
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TW, N_WAVES + 1, 0, gl.RGBA, gl.FLOAT, null);

  // --- state ---------------------------------------------------------------
  let target = null;
  let cur = null;
  let tau = 0.8;
  let sunTarget = toWorld(180, 20);
  let sun = [...sunTarget];
  let yaw = VIEW_YAW;
  let pitch = -11;
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

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
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
    sun = mix(sun, sunTarget, 1 - Math.exp(-dt / Math.min(tau, 0.3)));
    const sl = Math.hypot(...sun);
    const sunDir = sun.map(v => v / sl);

    const comps = components(cur);
    if (!phasesInit) {
      comps.forEach((c, i) => (phases[i] = -c.phase0));
      phasesInit = true;
    }
    let slopeVar = 0;
    comps.forEach((c, i) => {
      phases[i] = (phases[i] + c.omega * dt) % (Math.PI * 2);
      uPh[i] = phases[i];
      slopeVar += (c.amp * c.k) ** 2 / 2;
    });
    // Rebuild the nearshore table when the sea has moved on (≤ 15×/s).
    if (changed(cur, tableSea) && now - lastTable > 66) {
      const tr = transform(comps, cur);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TW, N_WAVES + 1, gl.RGBA, gl.FLOAT, tr.table);
      deep = tr.deep;
      surfReport = tr.report;
      tableSea = cur;
      lastTable = now;
    }

    // Cox & Munk (1954): mean-square slope = 0.003 + 5.12e-3 U.
    const micro = Math.sqrt(Math.max(0.002, 0.003 + 5.12e-3 * cur.windMs - slopeVar));
    const foamWind = smooth(7, 24, cur.windMph); // Beaufort 2 → 5
    const storm = Math.min(1, smooth(6, 26, cur.windMph) * 0.8 + smooth(1, 5, cur.hsFt) * 0.35);
    const L = lighting(sunDir, storm);
    const windTo = toWorld(cur.towardDeg);
    const fogDist = 4200 - 2400 * storm;
    const drift = surfReport?.breaking ? surfReport.driftMs * (surfReport.driftBearing === (FACE + 90) % 360 ? 1 : -1) : 0;

    // Camera
    const aspect = canvas.width / canvas.height;
    const hfov = HFOV * R;
    const fovy = Math.max(48 * R, 2 * Math.atan(Math.tan(hfov / 2) / aspect));
    const fwd = toWorld(yaw, pitch);
    const viewProj = mul(perspective(fovy, aspect, 0.5, 40000), lookDir(EYE, fwd));
    const inv = invert(viewProj);
    const horizon = toWorld(yaw, 0).map((v, i) => EYE[i] + v * 30000 * (i === 1 ? 0 : 1));
    horizon[1] = 0;
    const hy = transformPoint(viewProj, horizon);
    const yTop = hy[2] > 0 ? Math.min(1.05, hy[1] + 0.03) : 1.05;

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const shared = u => {
      gl.uniform3fv(u.uSunDir, sunDir);
      gl.uniform3fv(u.uSunColor, L.sunColor);
      gl.uniform1f(u.uSunVis, L.sunVis);
      gl.uniform3fv(u.uZenith, L.zenith);
      gl.uniform3fv(u.uHorizon, L.horizon);
      gl.uniform1f(u.uCover, 0.45 + 0.5 * storm);
      gl.uniform3fv(u.uCloud, L.cloud);
      gl.uniform3fv(u.uCam, EYE);
      gl.uniform1f(u.uTime, time);
      gl.uniform2fv(u.uWindTo, [windTo[0], windTo[2]]);
      gl.uniform1f(u.uFogDist, fogDist);
    };

    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(sky.p);
    shared(sky.u);
    gl.uniformMatrix4fv(sky.u.uInvViewProj, false, inv);
    gl.uniform1f(sky.u.uWindMs, cur.windMs);
    gl.uniform1f(sky.u.uFace, FACE);
    gl.uniform1f(sky.u.uDay, L.day);
    gl.bindVertexArray(skyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(surf.p);
    shared(surf.u);
    gl.uniformMatrix4fv(surf.u.uViewProj, false, viewProj);
    gl.uniformMatrix4fv(surf.u.uInvViewProj, false, inv);
    gl.uniform2fv(surf.u.uGridX, [-1.15, 1.15]);
    gl.uniform2fv(surf.u.uGridY, [-1.7, yTop]);
    gl.uniform1f(surf.u.uCell, (hfov * 1.15) / GX);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(surf.u.uTable, 0);
    gl.uniform4fv(surf.u.uDeep, deep);
    gl.uniform1fv(surf.u.uPh, uPh);
    gl.uniform1f(surf.u.uRunup, surfReport?.runup ?? 0.05);
    gl.uniform1f(surf.u.uSwashW, (2 * Math.PI) / (2.2 * cur.tp));
    gl.uniform1f(surf.u.uMicro, micro);
    gl.uniform1f(surf.u.uFoamWind, foamWind);
    gl.uniform3fv(surf.u.uDeepCol, L.deep);
    gl.uniform3fv(surf.u.uScatter, L.scatter);
    gl.uniform3fv(surf.u.uAmbient, L.ambient);
    gl.uniform1f(surf.u.uDrift, drift);
    gl.bindVertexArray(surfVao);
    gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_INT, 0);

    // Pin the break-point label to the water where the camera's line of sight crosses it.
    if (marker) {
      const rel = (yaw - FACE) * R;
      const along = Math.sin(rel);
      const out = Math.cos(rel);
      let shown = false;
      if (surfReport?.breaking && surfReport.distance >= 15 && out > 0.15) {
        const t = (surfReport.distance + EYE[2]) / out;
        const p = transformPoint(viewProj, [along * t, 0.8, -surfReport.distance]);
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
      const hsM = measureHs(comps, phases, {size: 900, n: 48});
      onMeasure({hsFt: hsM / 0.3048, sea: cur});
    }
  }

  // Look around: drag on the water.
  let drag = null;
  const down = e => {
    drag = {x: e.clientX, y: e.clientY, yaw, pitch};
    canvas.setPointerCapture(e.pointerId);
  };
  const move = e => {
    if (!drag) return;
    yaw = (drag.yaw - (e.clientX - drag.x) * 0.15 + 360) % 360;
    pitch = Math.max(-35, Math.min(6, drag.pitch + (e.clientY - drag.y) * 0.1));
    api.onView?.(yaw);
  };
  const up = () => (drag = null);
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);

  const api = {
    /**
     * @param {object} sea  from seaState()
     * @param {{az:number, el:number}} sunPos  from sunPosition()
     * @param {{tau?:number}} opts  smoothing time constant (s); short while playing
     */
    set(sea, sunPos, opts = {}) {
      target = sea;
      tau = opts.tau ?? 0.8;
      if (sunPos) sunTarget = toWorld(sunPos.az, sunPos.el);
      if (!cur) sun = [...sunTarget];
    },
    get yaw() { return yaw; },
    onView: null,
    destroy() {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
    },
  };
  raf = requestAnimationFrame(frame);
  return api;
}
