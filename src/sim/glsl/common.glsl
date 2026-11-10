// Shared by every scene shader: the painted sky, and the air between you and things.
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunVis;
uniform vec3 uMoonDir;
uniform vec3 uMoonColor; // moonlight (already zero by day, below the horizon, or under heavy cloud)
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGlow;      // fan of light around the sun, hugging the horizon
uniform vec3 uVenus;     // the pink band opposite the sun at dusk and dawn
uniform vec3 uCity;      // Chicago's sky glow after dark (south and west of the beach)
uniform float uCover;
uniform vec3 uCloud;     // sunlit cloud
uniform vec3 uCloudDark; // cloud in shade
uniform float uDay;
uniform float uFogDist;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

// The air: gradient, sun fan, twilight band, city glow, and the halos of sun and moon (no discs).
vec3 skyAir(vec3 d) {
  float y = max(d.y, 0.0);
  float s = max(dot(d, uSunDir), 0.0);
  float m = max(dot(d, uMoonDir), 0.0);
  vec2 dh = normalize(d.xz + vec2(1e-5));
  float az = 0.5 + 0.5 * dot(dh, normalize(uSunDir.xz + vec2(1e-5)));
  vec3 c = mix(uHorizon, uZenith, 1.0 - exp(-y * 3.2));
  c += uGlow * exp(-y * 4.5) * (0.12 + 0.88 * pow(az, 3.0));
  c += uVenus * exp(-pow((y - 0.13) / 0.1, 2.0)) * pow(1.0 - az, 1.5);
  c += uCity * exp(-y * 7.0) * (0.55 + 0.45 * dot(dh, vec2(-0.3, 0.954)));
  c += uSunColor * (0.07 * pow(s, 5.0) + (0.3 * pow(s, 40.0) + 1.1 * pow(s, 500.0)) * (0.2 + 0.8 * smoothstep(0.0, 0.3, uSunDir.y))) * (0.3 + 0.7 * uSunVis);
  c += uMoonColor * (0.05 * pow(m, 6.0) + 0.16 * pow(m, 90.0) + 0.5 * pow(m, 1400.0));
  return c;
}

vec3 skyBase(vec3 d) {
  float s = max(dot(d, uSunDir), 0.0);
  // A painter's sun: a little larger than life, with a soft edge.
  return skyAir(d) + uSunColor * 14.0 * smoothstep(0.99968, 0.9999, s) * uSunVis;
}

// Sky with the cloud deck averaged in (used for haze and as a fallback mirror).
vec3 skyRefl(vec3 d) {
  vec3 c = skyAir(d);
  vec3 cl = mix(uCloudDark, uCloud, 0.55);
  return mix(c, cl, uCover * 0.6 * smoothstep(0.0, 0.3, d.y));
}

vec3 fogged(vec3 col, vec3 toCam, float dist) {
  float fog = 1.0 - exp(-pow(dist / uFogDist, 1.2));
  vec3 V = toCam / dist;
  return mix(col, skyRefl(normalize(vec3(-V.x, 0.02, -V.z))), fog);
}
