// Trees as a painter dabs them: the last of the autumn colour, with bare crowns between.
in vec2 vUv;
in vec3 vPos;
in float vSeed;
out vec4 outColor;
uniform vec3 uCam;
uniform vec3 uAmbient;
uniform float uClip;

void main() {
  if (uClip > 0.5 && vPos.y < 0.0) discard;
  vec2 p = vUv;
  float trunk = step(abs(p.x), 0.025 + 0.02 * (1.0 - p.y)) * step(p.y, 0.5);
  vec2 c = (p - vec2(0.0, 0.62)) / vec2(0.46, 0.38);
  float r = length(c);
  // a lumpy crown outline, different for every tree
  float lump = noise(vec2(atan(c.y, c.x) * 2.2 + vSeed * 50.0, vSeed * 9.0)) * 0.3;
  float crown = 1.0 - smoothstep(0.62 + lump, 0.74 + lump, r);
  float kind = fract(vSeed * 5.3);
  float bare = step(0.72, kind);  // about a quarter have dropped everything
  float twigs = noise(vec2(p.x * 26.0 + vSeed * 40.0, p.y * 11.0)) * 0.6 + noise(p * 61.0 + vSeed * 9.0) * 0.4;
  float dabs = noise(p * 13.0 + vSeed * 31.0) * 0.6 + noise(p * 29.0 + vSeed * 7.0) * 0.4;
  float leaf = crown * mix(step(0.3, dabs), step(0.56, twigs), bare);
  float a = max(trunk, leaf);
  if (a < 0.5) discard;
  // gold (honey locust, cottonwood), rust (oak), a little crimson (maple)
  vec3 leafCol = mix(vec3(0.92, 0.62, 0.12), vec3(0.72, 0.33, 0.1), smoothstep(0.3, 0.42, kind));
  leafCol = mix(leafCol, vec3(0.74, 0.16, 0.12), smoothstep(0.58, 0.64, kind));
  leafCol *= 0.72 + 0.56 * dabs;
  vec3 bark = vec3(0.2, 0.15, 0.15);
  vec3 albedo = mix(bark, leafCol, leaf * (1.0 - bare) * (1.0 - trunk * step(p.y, 0.3)));
  vec3 V = normalize(uCam - vPos);
  // lit from above and from the sun's side; leaves glow when the sun is behind them
  float top = 0.55 + 0.45 * smoothstep(0.3, 0.95, p.y + dabs * 0.25);
  float back = pow(max(dot(-V, uSunDir), 0.0), 3.0);
  vec3 col = albedo * (uAmbient * 1.15 + uSunColor * uSunVis * (0.3 * top + 0.5 * back * (1.0 - bare)));
  vec3 toCam = uCam - vPos;
  outColor = vec4(fogged(col, toCam, length(toCam)), 1.0);
}
