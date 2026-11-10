// The darkroom and the easel: an HDR scene target, a mirror target for the water,
// bloom, and a final pass that turns the frame into paint on canvas.
//
// Texture units: 0–4 belong to the scene (see water.js). 5 = mirror, 6 = scene, 7 = bloom.

const VS = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const HEAD = '#version 300 es\nprecision highp float;\nin vec2 vUv;\nout vec4 o;\n';

// What glows: anything brighter than paper white, plus a breath of everything (the dream haze).
const PRE_FS = HEAD + `
uniform sampler2D uTex;
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  if (any(isnan(c))) c = vec3(0.0);
  c = clamp(c, 0.0, 16.0);
  float l = max(c.r, max(c.g, c.b));
  o = vec4(c * smoothstep(0.95, 2.0, l) + c * 0.04, 1.0);
}`;

const BLUR_FS = HEAD + `
uniform sampler2D uTex;
uniform vec2 uTexel;
void main() {
  vec2 d = uTexel;
  o = 0.25 * (texture(uTex, vUv + d) + texture(uTex, vUv - d)
    + texture(uTex, vUv + vec2(d.x, -d.y)) + texture(uTex, vUv + vec2(-d.x, d.y)));
}`;

const FINAL_FS = HEAD + `
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2 uTexel;
uniform vec2 uRes;
uniform float uPaint;
uniform float uBloomAmt;
uniform float uTime;
uniform float uShiver;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

// Kuwahara, softened: each pixel takes the colour of whichever neighbouring patch is
// calmest, so edges stay crisp while everything between them flattens into brushwork.
vec3 brush(vec2 uv, float radius) {
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int q = 0; q < 4; q++) {
    vec2 sgn = vec2((q == 0 || q == 2) ? -1.0 : 1.0, q < 2 ? -1.0 : 1.0);
    vec3 m = vec3(0.0);
    vec3 m2 = vec3(0.0);
    for (int i = 0; i < 3; i++) {
      for (int j = 0; j < 3; j++) {
        vec3 c = min(texture(uScene, uv + sgn * vec2(float(i), float(j)) * uTexel * radius).rgb, vec3(3.0));
        m += c;
        m2 += c * c;
      }
    }
    m /= 9.0;
    m2 = abs(m2 / 9.0 - m * m);
    float v = m2.r + m2.g + m2.b;
    float w = 1.0 / (1e-5 + v * v * 4000.0);
    acc += m * w;
    wsum += w;
  }
  return acc / wsum;
}

vec3 shoulder(vec3 x) {
  // paint values pass straight through; only the lights roll off toward white
  vec3 hi = 0.62 + 0.38 * tanh((x - 0.62) / 0.38);
  return mix(x, hi, step(0.62, x));
}

const vec3 LUMA = vec3(0.299, 0.587, 0.114);
// The canvas was toned with burnt sienna before anything else went on. It still shows.
const vec3 GROUND = vec3(0.46, 0.27, 0.16);

void main() {
  vec2 px = vUv * uRes;
  float unit = max(min(uRes.x, uRes.y) / 800.0, 0.5); // flaws stay the same size on any screen
  vec2 cp = px / unit;
  // a hand is never perfectly steady: wobble the stroke by a pixel or so
  vec2 wob = (vec2(noise(cp * 0.045), noise(cp * 0.045 + 37.0)) - 0.5) * 2.4;
  // ...and on a freezing morning it shakes. The tremor comes in beats, the way shivering does,
  // harder when the wind is up and the light is gone.
  float beat = uTime * 6.0;
  float b0 = floor(beat);
  float bf = smoothstep(0.15, 0.85, fract(beat));
  vec2 q0 = cp * 0.021 + b0 * 13.7;
  vec2 q1 = cp * 0.021 + (b0 + 1.0) * 13.7;
  vec2 tremor = mix(vec2(noise(q0), noise(q0 + 71.0)), vec2(noise(q1), noise(q1 + 71.0)), bf) - 0.5;
  wob += tremor * 3.2 * uShiver;
  vec2 uv = vUv + wob * uPaint * unit * uTexel;
  vec3 sharp = texture(uScene, uv).rgb;
  if (any(isnan(sharp))) sharp = vec3(0.0);
  vec3 col = sharp;
  if (uPaint > 0.01) col = mix(sharp, brush(uv, 1.7), uPaint);
  // impasto: the lights are laid on thick, stand up off the canvas and catch the room's light
  float l0 = dot(min(col, vec3(2.0)), LUMA);
  float lx = dot(min(texture(uScene, uv + vec2(uTexel.x * 2.5 * unit, 0.0)).rgb, vec3(2.0)), LUMA);
  float ly = dot(min(texture(uScene, uv + vec2(0.0, uTexel.y * 2.5 * unit)).rgb, vec3(2.0)), LUMA);
  float relief = clamp(dot(vec2(lx - l0, ly - l0), vec2(-0.7, 0.7)), -0.3, 0.3);
  col += relief * 0.55 * smoothstep(0.35, 0.9, l0) * uPaint;
  vec3 bloom = texture(uBloom, vUv).rgb;
  col += bloom * uBloomAmt;
  col = shoulder(col);
  // grade: a little more colour, a warm lift in the lights, cool in the darks
  float l = dot(col, LUMA);
  col = mix(vec3(l), col, 1.1);
  col *= mix(vec3(0.96, 0.98, 1.05), vec3(1.03, 1.0, 0.96), smoothstep(0.1, 0.8, l));
  vec2 v = (vUv - 0.5) * vec2(1.05, 1.0);
  col *= 1.0 - 0.34 * pow(length(v) * 1.3, 2.6);
  l = dot(col, LUMA);
  // The flaws. The darks went on thin and fast with a dry brush, so the ground grins through
  // them in long streaks...
  float streak = noise(cp * vec2(0.011, 0.31) + 11.0) * 0.6 + noise(cp * vec2(0.05, 0.9)) * 0.4;
  float thin = smoothstep(0.5, 0.76, streak) * (1.0 - smoothstep(0.04, 0.4, l));
  col = mix(col, GROUND * (0.45 + l), thin * 0.26 * uPaint);
  // ...there are places the brush skipped altogether...
  float fleck = smoothstep(0.8, 0.86, noise(cp * 0.35)) * smoothstep(0.6, 0.7, noise(cp * 0.013 + 5.0));
  col = mix(col, GROUND * (0.8 + 0.7 * l), fleck * 0.2 * uPaint);
  // ...and the painting stops short of the edge, ragged, the canvas left bare. Cold hands, no time.
  vec2 ed = min(px, uRes - px) / unit;
  // Strokes run with the horizon, so at the sides each one ends where the brush ran dry.
  float side = ed.x + (noise(vec2(cp.x * 0.012, cp.y * 0.085)) - 0.5) * 20.0 + (noise(vec2(cp.x * 0.05, cp.y * 0.6) + 5.0) - 0.5) * 5.0;
  float lid = ed.y + (noise(vec2(cp.x * 0.02, cp.y * 0.2) + 9.0) - 0.5) * 9.0 + (noise(cp * 0.2) - 0.5) * 3.0;
  float painted = mix(1.0, smoothstep(1.5, 7.5, min(side, lid)), step(0.01, uPaint));
  col = mix(GROUND * (0.85 + 0.4 * noise(cp * 0.017 + 3.0)), col, painted);
  // canvas: tooth, weave and the odd fibre, fixed to the screen like a real support
  float tooth = hash(floor(px)) - 0.5;
  float weave = sin(px.x * 2.1) * sin(px.y * 2.1);
  float fibre = noise(px * vec2(0.35, 0.05)) + noise(px * vec2(0.05, 0.35)) - 1.0;
  col *= 1.0 + (tooth * 0.045 + weave * 0.022 + fibre * 0.035) * (1.0 + 1.6 * (1.0 - painted));
  o = vec4(max(col, 0.0), 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
  return s;
}

function program(gl, fs, names) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
  const u = {};
  for (const n of names) u[n] = gl.getUniformLocation(p, n);
  return {p, u};
}

const LEVELS = 5;
export const REFL_UNIT = 5;
const SCENE_UNIT = 6;
const BLOOM_UNIT = 7;

export function createPost(gl) {
  const hdr = !!gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('OES_texture_float_linear');
  const internal = hdr ? gl.RGBA16F : gl.RGBA8;
  const type = hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
  let samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) || 0);

  const pre = program(gl, PRE_FS, ['uTex']);
  const blur = program(gl, BLUR_FS, ['uTex', 'uTexel']);
  const fin = program(gl, FINAL_FS, ['uScene', 'uBloom', 'uTexel', 'uRes', 'uPaint', 'uBloomAmt', 'uTime', 'uShiver']);

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  let W = 0, H = 0;
  let msaaFbo = null, msaaColor = null, msaaDepth = null;
  let sceneFbo = null, sceneTex = null, sceneDepth = null;
  let reflFbo = null, reflTex = null, reflDepth = null, RW = 0, RH = 0;
  let chain = [];

  function tex(unit, w, h) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function target(t, depth) {
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    if (depth) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    return f;
  }
  function depthBuffer(w, h, n) {
    const r = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, r);
    if (n > 0) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, n, gl.DEPTH_COMPONENT24, w, h);
    else gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    return r;
  }

  function dispose() {
    for (const t of [sceneTex, reflTex, ...chain.map(c => c.tex)]) if (t) gl.deleteTexture(t);
    for (const f of [msaaFbo, sceneFbo, reflFbo, ...chain.map(c => c.fbo)]) if (f) gl.deleteFramebuffer(f);
    for (const r of [msaaColor, msaaDepth, sceneDepth, reflDepth]) if (r) gl.deleteRenderbuffer(r);
    msaaFbo = msaaColor = msaaDepth = sceneFbo = sceneTex = sceneDepth = reflFbo = reflTex = reflDepth = null;
    chain = [];
  }

  function resize(w, h) {
    if (w === W && h === H) return;
    dispose();
    W = w; H = h;
    sceneTex = tex(SCENE_UNIT, w, h);
    if (samples > 0) {
      msaaColor = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, msaaColor);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, internal, w, h);
      msaaDepth = depthBuffer(w, h, samples);
      msaaFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, msaaFbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, msaaColor);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, msaaDepth);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.deleteFramebuffer(msaaFbo); gl.deleteRenderbuffer(msaaColor); gl.deleteRenderbuffer(msaaDepth);
        msaaFbo = msaaColor = msaaDepth = null;
        samples = 0;
      }
    }
    if (msaaFbo) sceneFbo = target(sceneTex, null);
    else { sceneDepth = depthBuffer(w, h, 0); sceneFbo = target(sceneTex, sceneDepth); }

    RW = Math.max(2, w >> 1); RH = Math.max(2, h >> 1);
    reflTex = tex(REFL_UNIT, RW, RH);
    reflDepth = depthBuffer(RW, RH, 0);
    reflFbo = target(reflTex, reflDepth);

    let cw = RW, ch = RH;
    for (let i = 0; i < LEVELS; i++) {
      const t = tex(BLOOM_UNIT, cw, ch);
      chain.push({tex: t, fbo: target(t, null), w: cw, h: ch});
      cw = Math.max(2, cw >> 1); ch = Math.max(2, ch >> 1);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function beginMirror() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, reflFbo);
    gl.viewport(0, 0, RW, RH);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  function beginScene() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, msaaFbo || sceneFbo);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0 + REFL_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, reflTex);
  }

  /** Resolve, bloom, paint, and put it on the canvas. */
  function finish({paint = 0.8, bloom = 0.16, time = 0, shiver = 0.3} = {}) {
    if (msaaFbo) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msaaFbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, sceneFbo);
      gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0 + SCENE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, sceneTex);

    // bright pass into the first level
    gl.bindFramebuffer(gl.FRAMEBUFFER, chain[0].fbo);
    gl.viewport(0, 0, chain[0].w, chain[0].h);
    gl.useProgram(pre.p);
    gl.uniform1i(pre.u.uTex, SCENE_UNIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // down the chain…
    gl.useProgram(blur.p);
    gl.uniform1i(blur.u.uTex, BLOOM_UNIT);
    gl.activeTexture(gl.TEXTURE0 + BLOOM_UNIT);
    for (let i = 1; i < LEVELS; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, chain[i].fbo);
      gl.viewport(0, 0, chain[i].w, chain[i].h);
      gl.bindTexture(gl.TEXTURE_2D, chain[i - 1].tex);
      gl.uniform2f(blur.u.uTexel, 1 / chain[i - 1].w, 1 / chain[i - 1].h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    // …and back up, each level adding its wider glow
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = LEVELS - 1; i > 0; i--) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, chain[i - 1].fbo);
      gl.viewport(0, 0, chain[i - 1].w, chain[i - 1].h);
      gl.bindTexture(gl.TEXTURE_2D, chain[i].tex);
      gl.uniform2f(blur.u.uTexel, 0.75 / chain[i].w, 0.75 / chain[i].h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.bindTexture(gl.TEXTURE_2D, chain[0].tex);
    gl.useProgram(fin.p);
    gl.uniform1i(fin.u.uScene, SCENE_UNIT);
    gl.uniform1i(fin.u.uBloom, BLOOM_UNIT);
    gl.uniform2f(fin.u.uTexel, 1 / W, 1 / H);
    gl.uniform2f(fin.u.uRes, W, H);
    gl.uniform1f(fin.u.uPaint, paint);
    gl.uniform1f(fin.u.uBloomAmt, bloom);
    gl.uniform1f(fin.u.uTime, time);
    gl.uniform1f(fin.u.uShiver, shiver);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  return {resize, beginMirror, beginScene, finish, dispose, hdr, get mirrorSize() { return [RW, RH]; }};
}
