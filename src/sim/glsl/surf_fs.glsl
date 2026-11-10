// The lake and the land, painted. Wave geometry comes from SURF_VS (the forecast);
// this decides what colour each brush mark is.
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
in float vShelter;
in float vCap;
flat in int vMat;
out vec4 outColor;
uniform vec3 uCam;
uniform float uTime;
uniform vec2 uWindTo;
uniform float uMicro;
uniform float uFoamWind;
uniform vec3 uDeepCol;
uniform vec3 uScatter;
uniform vec3 uAmbient;
uniform float uRunup;
uniform float uDrift;
uniform vec2 uTng;
uniform sampler2D uRefl; // the world mirrored in the water plane: sky, clouds, skyline, pier, trees
uniform vec2 uRes;

// Look up the mirror. A tilted facet throws its reflection up or down the screen, and
// rough water drags it out into a long vertical stroke.
vec3 mirror(vec3 N, vec3 V, float rough) {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 vh = normalize(V.xz + vec2(1e-5));
  float toward = dot(N.xz, vh);
  float side = dot(N.xz, vec2(-vh.y, vh.x));
  uv += vec2(side * 0.3, -toward * 0.55);
  float sm = 0.006 + 0.22 * rough;
  vec3 c = vec3(0.0);
  c += texture(uRefl, clamp(uv, 0.002, 0.998)).rgb * 0.4;
  c += texture(uRefl, clamp(uv - vec2(0.0, sm), 0.002, 0.998)).rgb * 0.3;
  c += texture(uRefl, clamp(uv - vec2(0.0, sm * 2.3), 0.002, 0.998)).rgb * 0.2;
  c += texture(uRefl, clamp(uv - vec2(0.0, sm * 4.0), 0.002, 0.998)).rgb * 0.1;
  return c;
}

void main() {
  vec3 toCam = uCam - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec3 sunL = uSunColor * uSunVis * 0.62;
  vec3 col;

  if (vThick <= 0.0) {
    // --- land ---------------------------------------------------------------
    vec3 n = normalize(vNormal);
    vec2 q = vWorld.xz;
    float grain = noise(q * 1.9) * noise(q * 0.21);
    float patches = noise(q * 0.06) * 0.6 + noise(q * 0.31) * 0.4;
    vec3 albedo;
    float wet = 0.0;
    if (vMat == 0) {
      // lakebed bared in a wave trough: wet sand
      albedo = vec3(0.5, 0.41, 0.3) * (0.86 + 0.28 * grain);
      wet = 1.0;
    } else if (vMat == 1 || vMat == 2) {
      // Montrose sand, gilded; wet and mirror-dark where the swash reaches.
      albedo = mix(vec3(0.95, 0.8, 0.57), vec3(0.86, 0.7, 0.5), patches) * (0.86 + 0.28 * grain);
      wet = (1.0 - smoothstep(uRunup * 1.25, uRunup * 1.25 + 0.3, vGround)) * step(vD, 0.5) * step(-40.0, vD);
      albedo = mix(albedo, vec3(0.5, 0.41, 0.3), wet * 0.85);
      if (vMat == 2) {
        // dune grass (marram, gone to gold by November) in clumps
        float clump = smoothstep(0.42, 0.62, noise(q * 0.35) * 0.7 + noise(q * 2.1) * 0.3);
        albedo = mix(albedo, mix(vec3(0.78, 0.6, 0.24), vec3(0.6, 0.5, 0.22), noise(q * 6.0)), clump * 0.88);
      }
    } else if (vMat == 3) {
      // park lawns: late green going to straw
      albedo = mix(vec3(0.33, 0.45, 0.19), vec3(0.6, 0.52, 0.22), smoothstep(0.35, 0.75, patches)) * (0.8 + 0.4 * grain);
    } else if (vMat == 5) {
      // fallen leaves under the trees
      albedo = mix(vec3(0.56, 0.28, 0.1), vec3(0.72, 0.5, 0.15), noise(q * 0.9)) * (0.7 + 0.5 * grain);
    } else if (vMat == 7) {
      float blocks = step(0.06, fract(q.x * 0.33)) * step(0.06, fract(q.y * 0.33));
      albedo = vec3(0.68, 0.64, 0.58) * (0.82 + 0.18 * blocks) * (0.9 + 0.2 * grain); // the hook: concrete & stone
    } else {
      albedo = vec3(0.44, 0.42, 0.44) * (0.85 + 0.3 * grain);           // paths, lots, city
    }
    col = albedo * (uAmbient * 1.05 + sunL * max(dot(n, uSunDir), 0.0)
      + uMoonColor * 0.4 * max(dot(n, uMoonDir), 0.0) + uCity * 0.25 + (1.0 - uDay) * vec3(0.03, 0.031, 0.042));
    float fres = pow(clamp(1.0 - dot(n, V), 0.0, 1.0), 4.0);
    col = mix(col, mirror(n, V, 0.01), wet * (0.1 + 0.75 * fres));
  } else {
    // --- water --------------------------------------------------------------
    float foot = max(length(fwidth(vWorld.xz)), 1e-3);
    vec2 across = vec2(-uWindTo.y, uWindTo.x);
    vec2 q = vec2(dot(vWorld.xz, uWindTo), dot(vWorld.xz, across));
    vec2 grad = vec2(0.0);
    float resolved = 0.0;
    float calm = 0.35 + 0.65 * vShelter;
    for (int j = 0; j < 3; j++) {
      float L = 3.2 * pow(0.345, float(j));
      float sc = 6.2831853 / L;
      float amp = uMicro * calm * 0.38 / sc * (1.0 - smoothstep(0.25, 1.0, foot / L));
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
    vec3 refl = mirror(N, V, rough);
    float F = 0.02 + 0.98 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);

    float hsLocal = max(vHs, 0.03);
    float crest = clamp(vEta / (hsLocal * 0.5), -1.5, 2.5);
    vec3 body = mix(uDeepCol, uScatter, clamp(0.25 + 0.35 * crest, 0.0, 1.0));
    // After dark the crests keep a little of the sky's light, so the swell lines still read.
    body += uAmbient * 0.12 * clamp(crest, 0.0, 1.5) * (1.0 - 0.6 * uDay);
    // Light through the crests: jade when the sun is behind the wave.
    float back = pow(clamp(dot(-V, uSunDir) * 0.5 + 0.5, 0.0, 1.0), 3.0);
    body += (uScatter * 1.1 + uSunColor * vec3(0.02, 0.07, 0.05)) * back * clamp(crest, 0.0, 1.5) * uSunVis;
    float clarity = exp(-max(vThick, 0.0) / 1.2);
    vec3 bottom = vec3(0.66, 0.56, 0.4) * (uAmbient + sunL * 0.8);
    body = mix(body, mix(bottom, uScatter * 2.4, 0.4), clarity * 0.8);
    col = mix(body, refl, F * (1.0 - 0.5 * clarity));
    // The sun on the water: a hard glint on every facet and a broad burning path.
    float rs = max(dot(R, uSunDir), 0.0);
    float spec = pow(rs, mix(900.0, 120.0, clamp(rough * 30.0, 0.0, 1.0)));
    // (When the sun is low it is behind the bank: the glint goes from white fire to a thin gold glitter.)
    float glint = 0.16 + 0.84 * smoothstep(0.03, 0.3, uSunDir.y);
    col += uSunColor * (spec * 5.0 + pow(rs, 28.0) * 0.16) * glint * uSunVis;
    // A low sun lays a wide road of gold across the lake and gilds every face tilted toward it.
    float lowSun = (1.0 - smoothstep(0.05, 0.4, uSunDir.y)) * uSunVis;
    float facing = clamp(dot(N.xz, normalize(uSunDir.xz + vec2(1e-5))) * 4.0 + 0.2, 0.0, 1.0);
    col += uSunColor * (pow(rs, 9.0) * 0.07 + pow(rs, 3.0) * 0.02 + facing * facing * 0.05 * pow(rs, 2.0)) * lowSun;
    // The moon does the same in silver.
    float rm = max(dot(R, uMoonDir), 0.0);
    col += uMoonColor * (pow(rm, mix(500.0, 90.0, clamp(rough * 30.0, 0.0, 1.0))) * 3.0 + pow(rm, 24.0) * 0.22);

    // Foam ---------------------------------------------------------------
    float lip = smoothstep(0.32, 0.48, vEta / max(vH, 0.05)) * step(0.0, vD) * (1.0 - smoothstep(5.0, 8.0, vH)) * step(0.05, vHs);
    // Broken waves are whiter where the local bar is forcing the break (cap < 1)
    // and break in sections along the crest rather than as one even line.
    float sections = 0.55 + 0.45 * smoothstep(0.3, 0.7, noise(vec2(vS * 0.035, vD * 0.02 - uTime * 0.05)));
    float forced = mix(0.6, 1.0, smoothstep(0.98, 0.7, vCap));
    float bore = vFoam * smoothstep(-0.2, 0.45, crest) * sections * forced;
    vec2 flow = vec2(vS - uDrift * uTime, vD + 1.3 * uTime);
    float lace = vFoam * smoothstep(0.5, 0.78, noise(flow * 0.32) * 0.6 + noise(flow * 1.25) * 0.4);
    float edge = (1.0 - smoothstep(0.02, 0.2, vThick)) * (1.0 - step(25.0, vD)) * step(0.15, vShelter);
    vec2 drift = uWindTo * uTime * 1.2;
    float groups = noise((vWorld.xz - drift) * 0.045) * 0.65 + noise((vWorld.xz - drift) * 0.11) * 0.35;
    float wc = uFoamWind * smoothstep(1.15 - 0.6 * uFoamWind, 1.6 - 0.6 * uFoamWind, crest)
      * smoothstep(0.6 - 0.2 * uFoamWind, 0.76 - 0.18 * uFoamWind, groups) * step(4.0, vH) * vShelter;
    float tear = noise(vWorld.xz * 0.9 + vec2(uTime * 0.4, 0.0)) * 0.6 + noise(vWorld.xz * 3.1) * 0.4;
    float surf = max(max(lip, bore * 0.9), max(lace * 0.75, edge * 0.85));
    float foam = max(surf * smoothstep(0.15, 0.55, tear + 0.3 * surf), wc * smoothstep(0.3, 0.7, tear));
    // Foam takes the colour of the light: rose at dusk, cream at noon, blue by night.
    // After dark it stays luminous (moon, city glow, a painter's licence): the waves are the point.
    vec3 foamCol = vec3(0.95, 0.96, 0.97) * (uAmbient * 1.5 + sunL * (0.35 + 0.75 * max(dot(N, uSunDir), 0.0)) + 0.03
      + uMoonColor * (0.25 + 0.5 * max(dot(N, uMoonDir), 0.0)) + (1.0 - uDay) * vec3(0.05, 0.07, 0.11) + uCity * 0.3);
    col = mix(col, foamCol, clamp(foam, 0.0, 0.97));
  }
  outColor = vec4(fogged(col, toCam, dist), 1.0);
}
