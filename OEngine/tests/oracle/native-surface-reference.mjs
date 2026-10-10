import { lightSphereDistanceAttenuation } from "../../.test-dist/render/DirectLightingReference.js";
const srgb = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const normalize = (v) => {
  const length = Math.hypot(...v);
  return v.map((value) => value / length);
};
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const clamp = (v) => Math.min(1, Math.max(0, v));
export const workingColor = (c) => [
  c[0] * 0.627404 + c[1] * 0.329282 + c[2] * 0.0433136,
  c[0] * 0.069097 + c[1] * 0.91954 + c[2] * 0.0113612,
  c[0] * 0.0163916 + c[1] * 0.0880132 + c[2] * 0.895595,
];

// Independent double-precision BRDF algebra matching the existing Lambert /
// Smith-GGX / Schlick / clearcoat profile. The old DirectLightingReference has
// a different diffuse-energy convention and is deliberately not our oracle.
export function directReference(surface, position, direction, radiance, cameraPosition = [0, 0, 3]) {
  const view = normalize(position.map((v, i) => cameraPosition[i] - v));
  const half = normalize(view.map((v, i) => v + direction[i]));
  const noL = clamp(dot(surface.normal, direction));
  const noV = clamp(dot(surface.normal, view));
  const noH = clamp(dot(surface.normal, half));
  const voH = clamp(dot(view, half));
  const alpha = Math.max(surface.roughness ** 2, 0.002);
  const a2 = alpha * alpha;
  const distribution = a2 / (Math.PI * (noH * noH * (a2 - 1) + 1) ** 2);
  const visibility =
    0.5 /
    Math.max(noL * Math.sqrt(noV * noV * (1 - a2) + a2) + noV * Math.sqrt(noL * noL * (1 - a2) + a2), 1e-6);
  const coatFresnel = (0.04 + 0.96 * (1 - voH) ** 5) * surface.coat[0];
  const coatAlpha2 = Math.max(surface.coat[1] ** 2, 0.002) ** 2;
  const coatD = coatAlpha2 / (Math.PI * (dot(surface.coatNormal, half) ** 2 * (coatAlpha2 - 1) + 1) ** 2);
  const coatBrdf = ((coatD * 0.25) / Math.max(voH * voH, 0.0000039)) * coatFresnel;
  return radiance.map((r, i) => {
    const f0 = 0.04 + (surface.base[i] - 0.04) * surface.metallic;
    const fresnel = f0 + (1 - f0) * (1 - voH) ** 5;
    return (
      r *
      (noL *
        (fresnel * visibility * distribution + (surface.base[i] * (1 - surface.metallic)) / Math.PI) *
        (1 - coatFresnel) +
        clamp(dot(surface.coatNormal, direction)) * coatBrdf)
    );
  });
}

/** Double precision, independently authored fixture PBR expectation. Does not
 * import native lowering/emitter or invoke GPU lighting code. Exact samples are
 * chosen away from alpha/filter/page boundaries, so GPU approximation of LOD
 * cannot change these constant per-region texture values. */
export function nativeFixtureExpectedPixel(
  x,
  y,
  width,
  height,
  materialSlot,
  {
    scale = [1, 1, 1],
    perspective = 0,
    preExposure = 1.25,
    sunTransmission = null,
    gain = 0.7,
    customRoughness = 0.45,
  } = {},
) {
  const family = materialSlot % 4,
    variant = materialSlot >= 4;
  const base = [variant ? 192 : 128, variant ? 96 : 64, 32].map((v) => srgb(v / 255));
  if (family === 2) return workingColor(base).map((v) => v * preExposure);
  const ndcX = ((x + 0.5) / width) * 2 - 1;
  const worldX = ndcX / (1 - perspective * ndcX);
  const position = [worldX, (1 - ((y + 0.5) / height) * 2) * (1 + perspective * worldX), 0.5 * scale[2]];
  const normal =
    family === 3
      ? [0, 0, 1]
      : normalize([
          (((position[0] / scale[0] < 0 ? 144 : 112) / 255) * 2 - 1) * Math.sign(scale[0]),
          ((128 / 255) * 2 - 1) * Math.sign(scale[1]),
          ((253 / 255) * 2 - 1) * Math.sign(scale[2]),
        ]);
  const surface = {
    base: family === 3 ? base.map((v) => v * gain) : base,
    normal,
    coatNormal: family === 1 ? normal : [0, 0, 1],
    metallic: family === 3 ? 0.1 : ((variant ? 102 : 51) / 255) * 0.2,
    roughness: family === 3 ? customRoughness : ((position[0] / scale[0] < 0 ? 153 : 204) / 255) * 0.6,
    occlusion: 1,
    coat: family === 1 ? [0.5, 0.3] : [0, 1],
  };
  const shadow = (Math.floor((position[0] + 1) * 8) + Math.floor((position[1] + 1) * 8)) % 2 === 1 ? 0 : 1;
  let color = directReference(surface, position, [0, 0, 1], [0.8 * shadow, 0.6 * shadow, 0.4 * shadow]);
  if (sunTransmission) {
    const incident = sunTransmission.map(
      (t, k) => t * [98242.786222, 69954.398112, 66475.012354][k] * 0.000013207021769386792 * shadow,
    );
    const contribution = directReference(surface, position, [0, 0.6, 0.8], incident);
    color = color.map((v, k) => v + contribution[k]);
  }
  for (let i = 0; i < 8; i++) {
    const delta = [Math.cos((i * Math.PI) / 4) * 1.5, Math.sin((i * Math.PI) / 4) * 1.5, 2.5].map(
      (v, k) => v - position[k],
    );
    const attenuation = lightSphereDistanceAttenuation(Math.hypot(...delta), 0.1, 8);
    const contribution = directReference(
      surface,
      position,
      normalize(delta),
      [1.1 + i * 0.1, 0.7 + i * 0.08, 0.4 + i * 0.06].map((v) => v * attenuation),
    );
    color = color.map((v, k) => v + contribution[k]);
  }
  const view = normalize([0, 0, 3].map((v, k) => v - position[k]));
  const coat = (0.04 + 0.96 * (1 - clamp(dot(surface.coatNormal, view))) ** 5) * surface.coat[0];
  color = color.map((v, k) => {
    const f0 = 0.04 + (surface.base[k] - 0.04) * surface.metallic;
    const diffuse =
      (([0.2, 0.25, 0.3][k] * surface.base[k] * (1 - surface.metallic)) / Math.PI) * (192 / 255);
    const specular = [0.25, 0.3, 0.35][k] * (0.02 * (1 - f0) + 0.8 * f0);
    return v + (diffuse + specular) * (1 - coat) + [0.25, 0.3, 0.35][k] * coat;
  });
  return workingColor(color).map((v) => v * preExposure);
}
