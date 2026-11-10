// Buildings, the hook's stonework and the light: blocked in with warm lights and violet shade.
in vec3 vPos;
in vec3 vN;
in vec3 vInfo;
out vec4 outColor;
uniform vec3 uCam;
uniform vec3 uAmbient;
uniform float uTime;
uniform float uClip; // 1 while drawing the mirror image: nothing below the water plane

void main() {
  if (uClip > 0.5 && vPos.y < 0.0) discard;
  vec3 n = normalize(vN);
  float seed = vInfo.z;
  float night = 1.0 - uDay;
  vec3 sunL = uSunColor * uSunVis * 0.62;
  float nl = max(dot(n, uSunDir), 0.0);
  vec3 col;
  if (vInfo.y > 2.5) {
    // concrete deck and limestone blocks of the hook and the harbor walls
    vec2 q = vPos.xz;
    float joint = step(0.97, fract(q.x * 0.31 + q.y * 0.07)) + step(0.97, fract(q.y * 0.31 - q.x * 0.07));
    vec3 albedo = mix(vec3(0.74, 0.69, 0.6), vec3(0.62, 0.57, 0.5), step(0.5, vInfo.z))
      * (1.0 - 0.1 * min(joint, 1.0)) * (0.86 + 0.28 * noise(q * 0.9));
    float wetLine = (1.0 - smoothstep(-0.4, 0.9, vPos.y)) * step(0.5, vInfo.z);
    albedo *= 1.0 - 0.5 * wetLine;
    col = albedo * (uAmbient * 1.05 + sunL * nl);
  } else if (vInfo.y > 1.5) {
    // the Wilson Avenue breakwater light on the hook: a white tower, flashing after dark
    col = vec3(0.96, 0.94, 0.9) * (uAmbient * 1.1 + sunL * nl);
    float flash = step(0.86, fract(uTime / 4.0)) * night;
    col += vec3(1.0, 0.92, 0.75) * flash * step(vPos.y, 9.6) * step(8.6, vPos.y) * 9.0;
  } else {
    vec3 albedo = mix(vec3(0.62, 0.54, 0.46), vec3(0.8, 0.73, 0.63), fract(seed * 7.13));
    albedo = mix(albedo, vec3(0.56, 0.31, 0.23), step(0.7, fract(seed * 3.7)));     // brick
    col = albedo * (uAmbient * 0.95 + sunL * nl);
    if (vInfo.y < 0.5) {
      vec2 w = vec2(vInfo.x / 3.2, vPos.y / 3.3);
      float win = step(0.25, fract(w.x)) * step(0.35, fract(w.y)) * step(1.0, vPos.y);
      // glass holds the sky by day and lamplight after dark
      col = mix(col, col * 0.4 + skyAir(reflect(normalize(vPos - uCam), n)) * 0.5, win * 0.7);
      float lit = step(0.55, hash(floor(w) + seed * 13.0)) * win * night;
      col += vec3(1.7, 1.05, 0.45) * lit;
    }
  }
  vec3 toCam = uCam - vPos;
  outColor = vec4(fogged(col, toCam, length(toCam)), 1.0);
}
