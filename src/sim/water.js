// Full-screen WebGL2 lake surface. No libraries.
//
// Geometry: a polar grid around the viewer (exponential rings out to 15 km),
// displaced on the GPU by the same 32 wave components seaState.js builds for
// the current forecast hour (Gerstner form). Short wind ripples (normals only)
// get their roughness from the Cox–Munk slope law for the forecast wind, and
// whitecaps from the Beaufort scale. The sky follows the sun for the forecast
// hour at Chicago, and the cloud deck darkens and drifts with the wind.

import {approach, components, measureHs, N_WAVES} from './seaState.js';

const EYE_HEIGHT = 3; // m — standing on a Chicago breakwater
const R_MIN = 1.5;
const R_MAX = 15000;
const RINGS = 220;
const SPOKES = 288;

const COMMON = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunVis;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform float uCover;
uniform vec3 uCloud;

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
${COMMON}

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}

void main() {
  vec4 w = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 d = normalize(w.xyz / w.w - uCam);
  vec3 c = skyBase(d);
  if (d.y > 0.0) {
    // cloud deck at ~1.5 km, drifting downwind
    vec2 uv = d.xz / (d.y + 0.06) * 0.9 + uWindTo * uTime * (0.002 + 0.0009 * uWindMs);
    float n = fbm(uv * 1.6);
    float m = smoothstep(1.0 - uCover, 1.0 - uCover + 0.35, n);
    float shade = mix(1.05, 0.62, smoothstep(0.35, 0.9, n));
    vec3 cloud = uCloud * shade;
    c = mix(c, cloud, m * smoothstep(0.0, 0.08, d.y));
  }
  outColor = vec4(c, 1.0);
}`;

const WATER_VS = /* glsl */ `#version 300 es
in vec2 aXZ;
uniform mat4 uViewProj;
uniform vec4 uA[${N_WAVES}];   // dirX, dirZ, k, amplitude
uniform float uPh[${N_WAVES}]; // accumulated phase
uniform float uChop;
out vec3 vWorld;
out vec3 vNormal;
out float vEta;
out float vJac;
void main() {
  vec2 p = aXZ;
  float spacing = max(length(p) * 0.045, 0.15);
  vec3 n = vec3(0.0, 1.0, 0.0);
  vec2 disp = vec2(0.0);
  float eta = 0.0;
  float jac = 1.0;
  for (int i = 0; i < ${N_WAVES}; i++) {
    vec4 a = uA[i];
    float k = a.z;
    float L = 6.2831853 / k;
    float A = a.w * (1.0 - smoothstep(0.22, 0.5, spacing / L));
    float th = k * dot(a.xy, p) - uPh[i];
    float s = sin(th), c = cos(th);
    eta += A * s;
    disp += uChop * A * a.xy * c;
    n.x -= a.x * k * A * c;
    n.z -= a.y * k * A * c;
    n.y -= uChop * k * A * s;
    jac -= uChop * k * A * s;
  }
  vWorld = vec3(p.x + disp.x, eta, p.y + disp.y);
  vNormal = n;
  vEta = eta;
  vJac = jac;
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}`;

const WATER_FS = /* glsl */ `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in float vEta;
in float vJac;
out vec4 outColor;
uniform vec3 uCam;
uniform float uTime;
uniform vec2 uWindTo;
uniform float uMicro;  // extra rms slope from wind ripples (Cox–Munk minus resolved waves)
uniform float uHs;
uniform float uFoam;   // 0..1 whitecap strength from wind (Beaufort)
uniform float uFogDist;
uniform vec3 uDeep;
uniform vec3 uScatter;
uniform vec3 uFoamColor;
${COMMON}

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

vec3 skyRefl(vec3 d) {
  vec3 c = skyBase(d);
  return mix(c, uCloud * 0.9, uCover * 0.75 * smoothstep(0.0, 0.25, d.y));
}

void main() {
  vec3 toCam = uCam - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  float foot = max(length(fwidth(vWorld.xz)), 1e-3);

  // Short wind waves and ripples: noise in the wind's frame, crests stretched
  // across the wind, drifting downwind. Three octaves (~3.2, 1.1, 0.38 m).
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
    float hx = noise(uv + vec2(e, 0.0));
    float hy = noise(uv + vec2(0.0, e));
    vec2 g = vec2((hx - h0) / e * sc, (hy - h0) / e * sc * 0.6) * amp;
    grad += uWindTo * g.x + across * g.y;
  }
  vec3 N = normalize(normalize(vNormal) + vec3(-grad.x, 0.0, -grad.y));
  // Ripples too small (or too far) to draw still roughen the reflection.
  float rough = clamp(uMicro * uMicro - resolved * 0.5, 0.0, 1.0);

  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  vec3 refl = mix(skyRefl(R), skyRefl(normalize(vec3(R.x, R.y + 0.35, R.z))), clamp(rough * 8.0, 0.0, 0.7));
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

  float crest = clamp(vEta / max(uHs * 0.5, 0.03), -1.5, 2.5);
  vec3 body = mix(uDeep, uScatter, clamp(0.25 + 0.35 * crest, 0.0, 1.0));
  float back = pow(clamp(dot(-V, uSunDir) * 0.5 + 0.5, 0.0, 1.0), 3.0);
  body += uScatter * 0.6 * back * clamp(crest, 0.0, 1.0) * uSunVis;
  vec3 col = mix(body, refl, F);

  float spec = pow(max(dot(R, uSunDir), 0.0), mix(900.0, 120.0, clamp(rough * 30.0, 0.0, 1.0)));
  col += uSunColor * spec * 3.0 * uSunVis;

  // Whitecaps on the steepest crests, more as the wind rises.
  // Patches ~15–30 m (wave groups breaking), torn up by finer noise.
  vec2 drift = uWindTo * uTime * 1.2;
  float groups = noise((vWorld.xz - drift) * 0.045) * 0.65 + noise((vWorld.xz - drift) * 0.11) * 0.35;
  float patchy = smoothstep(0.6 - 0.2 * uFoam, 0.76 - 0.18 * uFoam, groups);
  float breakup = noise(vWorld.xz * 0.6 + drift * 0.5) * 0.6 + noise(vWorld.xz * 2.3) * 0.4;
  float cap = smoothstep(1.15 - 0.6 * uFoam, 1.6 - 0.6 * uFoam, crest + (1.0 - vJac) * 0.8);
  float foam = uFoam * cap * patchy * smoothstep(0.3, 0.7, breakup);
  col = mix(col, uFoamColor, clamp(foam, 0.0, 0.95));

  float fog = 1.0 - exp(-pow(dist / uFogDist, 1.25));
  vec3 haze = skyRefl(normalize(vec3(-V.x, 0.012, -V.z)));
  col = mix(col, haze, fog);
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
function lookDir(eye, fwd) {
  const [fx, fy, fz] = fwd;
  let rx = fz * 0 - fy * 0, ry = 0, rz = 0;
  // right = normalize(cross(fwd, up))
  rx = -fz; ry = 0; rz = fx;
  const rl = Math.hypot(rx, rz);
  rx /= rl; rz /= rl;
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
  return [rx, ux, -fx, 0, ry, uy, -fy, 0, rz, uz, -fz, 0,
    -(rx * eye[0] + ry * eye[1] + rz * eye[2]), -(ux * eye[0] + uy * eye[1] + uz * eye[2]), fx * eye[0] + fy * eye[1] + fz * eye[2], 1];
}
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
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

/** Sky + light for a sun elevation (rad) and a 0..1 storminess. */
function lighting(sunDir, storm) {
  const el = Math.asin(sunDir[1]);
  const day = smooth(-0.1, 0.12, el);
  const twilight = smooth(-0.14, 0, el) * (1 - smooth(0.02, 0.22, el));
  let zenith = mix([0.36, 0.5, 0.64], [0.27, 0.31, 0.35], storm);
  let horizon = mix([0.68, 0.74, 0.78], [0.5, 0.53, 0.55], storm);
  horizon = mix(horizon, [0.78, 0.52, 0.36], twilight * 0.7 * (1 - storm * 0.6));
  // Night over Chicago is never black: the city lights the cloud deck from below.
  const glow = 0.45 + 0.55 * storm;
  zenith = mix(mix([0.03, 0.04, 0.068], [0.1, 0.088, 0.09], glow), zenith, day);
  horizon = mix(mix([0.1, 0.1, 0.12], [0.24, 0.18, 0.15], glow), horizon, Math.max(day, twilight * 0.6));
  const sunColor = mix([1.0, 0.55, 0.3], [1.0, 0.93, 0.82], smooth(0.02, 0.35, el)).map(v => v * Math.max(day, 0.0));
  const light = 0.32 + 0.68 * day;
  return {
    zenith, horizon, sunColor,
    sunVis: day * (1 - storm * 0.85),
    cloud: mix(mix([0.08, 0.08, 0.1], [0.17, 0.14, 0.13], glow), mix([0.78, 0.8, 0.82], [0.42, 0.44, 0.46], storm), Math.max(day, twilight * 0.5)),
    deep: [0.008, 0.045, 0.058].map(v => v * light + 0.004),
    scatter: [0.04, 0.19, 0.18].map(v => v * light + 0.004),
    foam: [0.86, 0.9, 0.92].map(v => v * (0.35 + 0.65 * day)),
  };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{onMeasure?: (m:{hsFt:number, sea:object}) => void}} opts
 */
export function createWater(canvas, {onMeasure} = {}) {
  const gl = canvas.getContext('webgl2', {antialias: true, alpha: false, powerPreference: 'high-performance'});
  if (!gl) throw new Error('WebGL2 is not available in this browser.');

  const sky = program(gl, SKY_VS, SKY_FS);
  const water = program(gl, WATER_VS, WATER_FS);

  const tri = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, tri);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const skyVao = gl.createVertexArray();
  gl.bindVertexArray(skyVao);
  const aPos = gl.getAttribLocation(sky.p, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  // Polar grid around the viewer.
  const verts = new Float32Array((RINGS + 1) * (SPOKES + 1) * 2);
  let o = 0;
  for (let i = 0; i <= RINGS; i++) {
    const r = R_MIN * (R_MAX / R_MIN) ** ((i / RINGS) ** 1.08);
    for (let j = 0; j <= SPOKES; j++) {
      const a = (j / SPOKES) * Math.PI * 2;
      verts[o++] = Math.cos(a) * r;
      verts[o++] = Math.sin(a) * r;
    }
  }
  const idx = new Uint32Array(RINGS * SPOKES * 6);
  o = 0;
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SPOKES; j++) {
      const a = i * (SPOKES + 1) + j, b = a + 1, c = a + SPOKES + 1, d = c + 1;
      idx.set([a, c, b, b, c, d], o);
      o += 6;
    }
  }
  const waterVao = gl.createVertexArray();
  gl.bindVertexArray(waterVao);
  const vb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  const aXZ = gl.getAttribLocation(water.p, 'aXZ');
  gl.enableVertexAttribArray(aXZ);
  gl.vertexAttribPointer(aXZ, 2, gl.FLOAT, false, 0, 0);
  const ib = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  gl.bindVertexArray(null);

  // --- state ---------------------------------------------------------------
  let target = null; // sea state from seaState()
  let cur = null;
  let sunTarget = [0, 0.3, -1];
  let sun = [...sunTarget];
  let yaw = 90; // compass bearing the camera faces (east, out over the lake)
  let pitch = -7;
  let comps = [];
  const phases = new Float64Array(N_WAVES);
  let phasesInit = false;
  const uA = new Float32Array(N_WAVES * 4);
  const uPh = new Float32Array(N_WAVES);
  let t0 = performance.now();
  let last = t0;
  let lastMeasure = 0;
  let raf = 0;
  let running = true;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!target) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const time = (now - t0) / 1000;
    resize();

    cur = approach(cur, target, dt);
    sun = mix(sun, sunTarget, 1 - Math.exp(-dt / 0.9));
    const sl = Math.hypot(...sun);
    const sunDir = sun.map(v => v / sl);

    comps = components(cur);
    if (!phasesInit) {
      comps.forEach((c, i) => (phases[i] = -c.phase0));
      phasesInit = true;
    }
    let sumAK = 0;
    let slopeVar = 0;
    comps.forEach((c, i) => {
      phases[i] = (phases[i] + c.omega * dt) % (Math.PI * 2);
      uA.set([c.dx, c.dz, c.k, c.amp], i * 4);
      uPh[i] = phases[i];
      sumAK += c.amp * c.k;
      slopeVar += (c.amp * c.k) ** 2 / 2;
    });
    const chop = Math.min(1, 0.8 / Math.max(sumAK, 1e-6));
    // Cox & Munk (1954): mean-square slope = 0.003 + 5.12e-3 U.
    const cm = 0.003 + 5.12e-3 * cur.windMs;
    const micro = Math.sqrt(Math.max(0.002, cm - slopeVar));
    // Whitecaps: none below ~7 mph (Beaufort 2), "many" by 19–24 mph (Beaufort 5).
    const foam = smooth(7, 24, cur.windMph);
    const storm = Math.min(1, smooth(6, 26, cur.windMph) * 0.8 + smooth(1, 5, cur.hsFt) * 0.35);
    const L = lighting(sunDir, storm);
    const towardRad = (cur.towardDeg * Math.PI) / 180;
    const windTo = [Math.sin(towardRad), -Math.cos(towardRad)];

    // Camera
    const aspect = canvas.width / canvas.height;
    const hfov = (66 * Math.PI) / 180;
    const fovy = Math.max((50 * Math.PI) / 180, 2 * Math.atan(Math.tan(hfov / 2) / aspect));
    const yr = (yaw * Math.PI) / 180;
    const pr = (pitch * Math.PI) / 180;
    const fwd = [Math.sin(yr) * Math.cos(pr), Math.sin(pr), -Math.cos(yr) * Math.cos(pr)];
    const eye = [0, EYE_HEIGHT, 0];
    const viewProj = mul(perspective(fovy, aspect, 0.5, 30000), lookDir(eye, fwd));

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const shared = (u) => {
      gl.uniform3fv(u.uSunDir, sunDir);
      gl.uniform3fv(u.uSunColor, L.sunColor);
      gl.uniform1f(u.uSunVis, L.sunVis);
      gl.uniform3fv(u.uZenith, L.zenith);
      gl.uniform3fv(u.uHorizon, L.horizon);
      gl.uniform1f(u.uCover, 0.45 + 0.5 * storm);
      gl.uniform3fv(u.uCloud, L.cloud);
      gl.uniform3fv(u.uCam, eye);
      gl.uniform1f(u.uTime, time);
      gl.uniform2fv(u.uWindTo, windTo);
    };

    // Sky
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(sky.p);
    shared(sky.u);
    gl.uniformMatrix4fv(sky.u.uInvViewProj, false, invert(viewProj));
    gl.uniform1f(sky.u.uWindMs, cur.windMs);
    gl.bindVertexArray(skyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Water
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(water.p);
    shared(water.u);
    gl.uniformMatrix4fv(water.u.uViewProj, false, viewProj);
    gl.uniform4fv(water.u.uA, uA);
    gl.uniform1fv(water.u.uPh, uPh);
    gl.uniform1f(water.u.uChop, chop);
    gl.uniform1f(water.u.uMicro, micro);
    gl.uniform1f(water.u.uHs, cur.hs);
    gl.uniform1f(water.u.uFoam, foam);
    gl.uniform1f(water.u.uFogDist, 4200 - 2400 * storm);
    gl.uniform3fv(water.u.uDeep, L.deep);
    gl.uniform3fv(water.u.uScatter, L.scatter);
    gl.uniform3fv(water.u.uFoamColor, L.foam);
    gl.bindVertexArray(waterVao);
    gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_INT, 0);

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
    pitch = Math.max(-30, Math.min(8, drag.pitch + (e.clientY - drag.y) * 0.1));
    api.onView?.(yaw);
  };
  const up = () => (drag = null);
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);

  const api = {
    /** @param {object} sea  from seaState()   @param {number[]} sunDirection */
    set(sea, sunDirection) {
      target = sea;
      if (sunDirection) sunTarget = sunDirection;
      if (!cur) sun = [...sunTarget];
    },
    get yaw() { return yaw; },
    setYaw(v) { yaw = v; api.onView?.(yaw); },
    onView: null,
    pause() { running = false; cancelAnimationFrame(raf); },
    resume() { if (!running) { running = true; last = performance.now(); raf = requestAnimationFrame(frame); } },
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

/** Sun direction in world axes (+x east, +z south, y up) for a time and place. */
export function sunDirection(ms, lat, lon) {
  const rad = Math.PI / 180;
  const d = ms / 86400000 + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const H = (gmst * 15 + lon) * rad - ra;
  const la = lat * rad;
  const el = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(H));
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
}
