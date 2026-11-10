// The sky: a gradient, a larger-than-life sun, back-lit brushed clouds, stars,
// and the real skyline (bearing, half-width, top, distance for every tower).
in vec2 vNdc;
out vec4 outColor;
uniform mat4 uInvViewProj;
uniform vec3 uCam;
uniform float uTime;
uniform vec2 uWindTo;
uniform float uWindMs;
uniform vec4 uTowers[NT];
uniform mat3 uStarRot;       // world direction -> the frame of the fixed stars
uniform vec4 uStars[NS];     // named stars: world direction, brightness
uniform float uStarWarm[NS];
uniform float uNight;        // 0 until the end of civil twilight, 1 in full dark
uniform float uBank;         // the low bank of lake cloud on the eastern horizon

float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
float fbm3(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 3; i++) { s += a * noise(p); p = p * 2.11 + 9.3; a *= 0.5; }
  return s;
}

// The moon, with the phase it really has tonight: a little sphere lit from wherever the sun is.
vec4 moon(vec3 d, float night) { // rgb light, a = how much of the sky behind it is covered
  float md = dot(d, uMoonDir);
  if (md < 0.998 || uMoonDir.y < -0.03) return vec4(0.0);
  const float RM = 0.021; // painted about twice life size
  vec3 ax = normalize(cross(vec3(0.0, 1.0, 0.0), uMoonDir));
  vec3 ay = cross(uMoonDir, ax);
  vec2 p = vec2(dot(d, ax), dot(d, ay)) / RM;
  float r2 = dot(p, p);
  float disc = 1.0 - smoothstep(0.86, 1.0, r2);
  if (disc <= 0.0) return vec4(0.0);
  float z = sqrt(max(1.0 - r2, 0.0));
  vec3 n = p.x * ax + p.y * ay - z * uMoonDir;
  float lit = smoothstep(-0.04, 0.14, dot(n, uSunDir));
  float maria = 0.72 + 0.28 * smoothstep(0.35, 0.65, fbm3(p * 1.9 + 4.0));
  vec3 tint = mix(vec3(1.0, 0.6, 0.28), vec3(1.0, 0.96, 0.86), smoothstep(0.0, 0.28, uMoonDir.y));
  vec3 light = tint * maria * lit * mix(0.32, 2.6, night) * (0.6 + 0.4 * z);
  light += vec3(0.05, 0.065, 0.1) * night * (1.0 - lit); // earthshine on the dark limb
  return vec4(light * disc, disc);
}

// The stars turn with the night. d is rotated into the frame of the fixed stars, so the
// Milky Way, the scattered field and the named stars all rise out of the lake together.
const vec3 GNP = vec3(-0.8676, -0.1980, 0.4560); // north galactic pole
const vec3 GC = vec3(-0.0549, -0.8734, -0.4839); // galactic centre
vec3 stars(vec3 d) {
  vec3 e = uStarRot * d;
  float lift = smoothstep(0.0, 0.16, d.y); // the thick air at the horizon swallows them
  float gl = dot(e, GNP);
  float band = exp(-pow(gl / 0.19, 2.0));
  float core = 0.5 + 0.5 * dot(e, GC);
  float dust = fbm3(e.xy * 7.0 + e.z * 4.3);
  float lane = smoothstep(0.35, 0.6, fbm3(e.yz * 11.0 - e.x * 6.0)) * exp(-pow(gl / 0.07, 2.0));
  vec3 mw = mix(vec3(0.1, 0.13, 0.24), vec3(0.24, 0.18, 0.2), core) * band * (0.3 + 0.9 * dust)
    * (0.55 + 0.9 * core * core) * (1.0 - 0.6 * lane);
  // the scattered field: one dab per cell, most cells empty
  vec3 p = e * 130.0;
  vec3 i = floor(p), f = fract(p);
  float h = hash(i.xy + i.z * 17.31);
  vec3 o = vec3(hash(i.yz + 3.1), hash(i.zx + 5.7), hash(i.xy + 9.2)) * 0.5 + 0.25;
  float mag = pow(hash(i.zy + 23.7), 3.0);
  float star = step(0.982 - 0.02 * band, h) * (1.0 - smoothstep(0.0, 0.26, length(f - o))) * (0.35 + 1.4 * mag);
  float tw = 1.0 - (0.25 + 0.45 * (1.0 - lift)) * (0.5 + 0.5 * sin(uTime * (1.5 + 4.0 * h) + h * 60.0));
  vec3 tint = mix(vec3(0.72, 0.84, 1.0), vec3(1.0, 0.82, 0.62), hash(i.xy + 1.7));
  vec3 c = tint * star * tw * 3.0 + mw;
  // the ones with names: Orion, the Dipper, Cassiopeia, Sirius, Vega...
  for (int k = 0; k < NS; k++) {
    float q = 1.0 - dot(d, uStars[k].xyz);
    if (q > 4e-4) continue;
    float tk = 1.0 - (0.15 + 0.4 * (1.0 - lift)) * (0.5 + 0.5 * sin(uTime * (2.0 + float(k) * 0.37) + float(k) * 1.9));
    vec3 tn = mix(vec3(0.7, 0.83, 1.0), vec3(1.0, 0.72, 0.45), uStarWarm[k]);
    c += tn * uStars[k].w * tk * (exp(-q / 3e-6) * 5.0 + exp(-q / 4e-5) * 0.5);
  }
  return c * lift;
}

vec3 skyline(vec3 d, vec3 c) {
  float e = degrees(asin(clamp(d.y, -1.0, 1.0)));
  if (e > 6.0 || e < -0.3) return c;
  float b = mod(degrees(atan(d.x, -d.z)) + 360.0, 360.0);
  float best = 1e9;
  float id = 0.0;
  for (int i = 0; i < NT; i++) {
    vec4 t = uTowers[i];
    float db = abs(mod(b - t.x + 540.0, 360.0) - 180.0);
    if (db < t.y && e < t.z && t.w < best) { best = t.w; id = float(i) + db / max(t.y, 1e-4) * 0.5; }
  }
  if (best > 1e8) return c;
  float vis = max(0.45 + 0.2 * uDay, exp(-best / (uFogDist * 5.0)));
  float s = max(dot(d, uSunDir), 0.0);
  // Towers as a painter blocks them in: violet silhouettes, warmed where the sun grazes them.
  vec3 body = mix(c * 0.5, uCloudDark * 0.55 + uSunColor * 0.05 * uSunVis, 0.6);
  body += uSunColor * 0.25 * pow(s, 8.0) * uSunVis;
  vec2 cell = vec2(b * 55.0, e * 60.0);
  float lit = step(0.5 + 0.2 * uDay, hash(floor(cell) + floor(id))) * step(0.25, fract(cell.x)) * step(0.3, fract(cell.y));
  body += vec3(1.9, 1.25, 0.6) * lit * (1.0 - uDay) * 0.9;
  return mix(c, body, vis);
}

void main() {
  vec4 w = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 d = normalize(w.xyz / w.w - uCam);
  vec3 c = skyAir(d);
  if (d.y <= 0.0) c = skyBase(d);
  if (d.y > 0.0) {
    // The bank that sits on the lake horizon on cold mornings: the sun comes up behind it,
    // slate below, its ragged top edge on fire.
    vec2 hd = normalize(d.xz + vec2(1e-5));
    float top = 0.024 + 0.04 * fbm3(hd * 4.1 + vec2(uTime * 0.002, 4.0)) + 0.02 * abs(2.0 * noise(hd * 13.0 + vec2(1.7, uTime * 0.004)) - 1.0);
    float bank = (1.0 - smoothstep(top * 0.3, top * 1.1, d.y)) * uBank * smoothstep(-0.25, 0.3, hd.x);
    float sd = max(dot(d, uSunDir), 0.0);
    c += uSunColor * mix(7.0, 14.0, smoothstep(0.0, 0.3, uSunDir.y)) * smoothstep(0.99968, 0.9999, sd) * uSunVis * (1.0 - bank) * (1.0 - bank);
    vec4 mn = moon(d, 1.0 - uDay);
    if (uNight > 0.01) c += stars(d) * uNight * (1.0 - mn.a);
    c += mn.rgb;
    float s = max(dot(d, uSunDir), 0.0);
    vec2 uv = d.xz / (d.y + 0.09);
    vec2 q = uv * 0.5 + uWindTo * uTime * (0.004 + 0.0012 * uWindMs);
    vec2 warp = vec2(fbm3(q * 1.7 + 3.1), fbm3(q * 1.7 - 7.7)) - 0.5;
    vec2 p = q + warp * 0.6;
    float n = fbm(p);
    float th = 0.79 - 0.5 * uCover;
    float m = smoothstep(th, th + 0.2, n);
    // Which side of the cloud faces the sun: step toward it and see if the cloud thins.
    vec2 toSun = uSunDir.xz / (max(uSunDir.y, 0.0) + 0.09) - uv;
    vec2 ls = toSun / (length(toSun) + 1e-4);
    float n2 = fbm(p + ls * 0.11);
    float lit = clamp((n - n2) * 5.0 + 0.55, 0.0, 1.0);
    float thick = smoothstep(th + 0.08, th + 0.36, n);
    // A low sun only reaches the clouds near it, and only their edges: slate bases, peach rims.
    float low = 1.0 - smoothstep(0.02, 0.32, uSunDir.y);
    float toward = 0.5 + 0.5 * dot(hd, normalize(uSunDir.xz + vec2(1e-5)));
    float reach = mix(1.0, 0.16 + 0.84 * toward * toward, low);
    vec3 cl = mix(uCloudDark + uCity * 0.4, uCloud, lit * (1.0 - mix(0.55, 0.88, low) * thick) * reach);
    // Silver linings: thin edges near the sun burn.
    cl += uSunColor * (0.3 * pow(s, 6.0) + 1.0 * pow(s, 32.0)) * (1.0 - thick) * (0.35 + 0.65 * uSunVis);
    // High cirrus, combed out along the wind.
    vec2 cu = vec2(dot(uv, uWindTo), dot(uv, vec2(-uWindTo.y, uWindTo.x)));
    float ci = smoothstep(0.5, 0.82, fbm(vec2(cu.x * 0.16, cu.y * 1.1) + 31.0 + uTime * 0.002)) * 0.45 * (1.0 - 0.6 * uCover);
    vec3 air = skyAir(normalize(vec3(d.x, 0.04, d.z)));
    float far = exp(-d.y * 9.0);
    c = mix(c, mix(uCloud * 0.92 + uSunColor * 0.3 * pow(s, 4.0), air, far * 0.7), ci * smoothstep(0.02, 0.2, d.y));
    c = mix(c, mix(cl, air, far * 0.75), m * smoothstep(0.0, 0.07, d.y));
    float rim = smoothstep(top * 0.45, top, d.y);
    vec3 bc = mix(uCloudDark * 0.9 + uHorizon * 0.12, uCloud * 0.85, rim * rim * 0.6);
    bc += uSunColor * (0.8 * pow(s, 60.0) + 0.2 * pow(s, 8.0)) * rim * uSunVis;
    c = mix(c, bc, bank * 0.94);
  }
  outColor = vec4(skyline(d, c), 1.0);
}
