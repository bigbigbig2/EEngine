import {
  GPU_SHADING_DEPENDENCY,
  GPU_SHADING_PROGRAM,
  GPU_SHADING_PROGRAM_COUNT,
  GPU_SHADING_PROGRAM_NAMES
} from "./GpuShadingProgramAbi.js";
import {
  GPU_SHADING_OUTPUT_DEPENDENCY,
  GPU_SHADING_OUTPUT_DEPENDENCY_VALID_MASK
} from "./GpuSparseShadingPipelineContract.js";

export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];
export type Vec4 = readonly [number, number, number, number];

export interface GpuShadingProgramSpecialization {
  readonly programId: number;
  readonly name: string;
  readonly dependencyMask: number;
  readonly lit: boolean;
  readonly authoredVertexColor: "never" | "required" | "geometry-conditional";
  readonly baseTexture: "never" | "required" | "material-conditional";
  readonly ormTexture: "never" | "required" | "material-conditional";
  readonly normalTexture: "never" | "required" | "material-conditional";
  readonly emissiveTexture: "never" | "required" | "material-conditional";
  readonly reconstructTriangle: boolean;
  readonly outputDependencyMask: number;
  readonly publishesShadingSurface: boolean;
  readonly publishesDiffuseSurface: boolean;
  readonly publishesVelocity: boolean;
}

export interface PerspectiveBarycentricReference {
  readonly weights: Vec3;
  readonly ddx: Vec3;
  readonly ddy: Vec3;
  readonly valid: boolean;
}

export interface GpuShadingMaterialReferenceInput {
  readonly baseColorFactor: Vec3;
  readonly metallicFactor: number;
  readonly roughnessFactor: number;
  readonly normalScale: number;
  readonly occlusionStrength: number;
  readonly emissiveFactor: Vec3;
  readonly vertexColor?: Vec3;
  readonly baseSample?: Vec4;
  readonly ormSample?: Vec4;
  readonly normalSample?: Vec4;
  readonly emissiveSample?: Vec4;
  readonly shadingNormal: Vec3;
  readonly geometricNormal: Vec3;
  readonly tangent?: Vec4;
}

export interface GpuDirectLightReference {
  /** Unit direction from the receiver toward the light. */
  readonly direction: Vec3;
  /** Scene-linear incident radiance before visibility. */
  readonly radiance: Vec3;
  readonly visibility: number;
}

export interface GpuShadingProgramReferenceInput {
  readonly programId: number;
  readonly outputDependencyMask: number;
  readonly material: GpuShadingMaterialReferenceInput;
  readonly viewDirection: Vec3;
  readonly directLights: readonly GpuDirectLightReference[];
  readonly preExposure: number;
  readonly gradientValid: boolean;
}

export interface GpuShadingProgramReferenceResult {
  readonly radiance: Vec3;
  readonly albedo: Vec3;
  readonly ambientOcclusion: number;
  readonly metallic: number;
  readonly roughness: number;
  readonly shadingNormal: Vec3;
  readonly geometricNormal: Vec3;
  readonly emissive: Vec3;
  readonly gradientFallback: boolean;
  readonly publishesShadingSurface: boolean;
  readonly publishesDiffuseSurface: boolean;
  readonly publishesVelocity: boolean;
}

const FIXED_PROGRAM_DEPENDENCIES = Object.freeze([
  0,
  GPU_SHADING_DEPENDENCY.AuthoredVertexColor,
  GPU_SHADING_DEPENDENCY.Uv0 | GPU_SHADING_DEPENDENCY.BaseTexture,
  GPU_SHADING_DEPENDENCY.AuthoredVertexColor | GPU_SHADING_DEPENDENCY.Uv0 |
    GPU_SHADING_DEPENDENCY.BaseTexture,
  GPU_SHADING_DEPENDENCY.Normal | GPU_SHADING_DEPENDENCY.Lit,
  GPU_SHADING_DEPENDENCY.Normal | GPU_SHADING_DEPENDENCY.BaseTexture |
    GPU_SHADING_DEPENDENCY.Uv0 | GPU_SHADING_DEPENDENCY.Lit,
  GPU_SHADING_DEPENDENCY.Normal | GPU_SHADING_DEPENDENCY.OrmTexture | GPU_SHADING_DEPENDENCY.Uv0 |
    GPU_SHADING_DEPENDENCY.Lit,
  GPU_SHADING_DEPENDENCY.Normal | GPU_SHADING_DEPENDENCY.BaseTexture |
    GPU_SHADING_DEPENDENCY.OrmTexture | GPU_SHADING_DEPENDENCY.Uv0 | GPU_SHADING_DEPENDENCY.Lit,
  GPU_SHADING_DEPENDENCY.Normal | GPU_SHADING_DEPENDENCY.Tangent |
    GPU_SHADING_DEPENDENCY.NormalTexture | GPU_SHADING_DEPENDENCY.Uv0 | GPU_SHADING_DEPENDENCY.Lit,
  GPU_SHADING_DEPENDENCY.Normal | GPU_SHADING_DEPENDENCY.Tangent |
    GPU_SHADING_DEPENDENCY.BaseTexture | GPU_SHADING_DEPENDENCY.NormalTexture |
    GPU_SHADING_DEPENDENCY.Uv0 | GPU_SHADING_DEPENDENCY.Lit,
  GPU_SHADING_DEPENDENCY.Normal | GPU_SHADING_DEPENDENCY.Tangent |
    GPU_SHADING_DEPENDENCY.OrmTexture | GPU_SHADING_DEPENDENCY.NormalTexture |
    GPU_SHADING_DEPENDENCY.Uv0 | GPU_SHADING_DEPENDENCY.Lit,
  GPU_SHADING_DEPENDENCY.Normal | GPU_SHADING_DEPENDENCY.Tangent |
    GPU_SHADING_DEPENDENCY.BaseTexture | GPU_SHADING_DEPENDENCY.OrmTexture |
    GPU_SHADING_DEPENDENCY.NormalTexture | GPU_SHADING_DEPENDENCY.Uv0 |
    GPU_SHADING_DEPENDENCY.Lit,
  GPU_SHADING_DEPENDENCY.Normal | GPU_SHADING_DEPENDENCY.Tangent |
    GPU_SHADING_DEPENDENCY.BaseTexture | GPU_SHADING_DEPENDENCY.OrmTexture |
    GPU_SHADING_DEPENDENCY.NormalTexture | GPU_SHADING_DEPENDENCY.EmissiveTexture |
    GPU_SHADING_DEPENDENCY.Uv0 | GPU_SHADING_DEPENDENCY.Lit,
  GPU_SHADING_DEPENDENCY.Normal | GPU_SHADING_DEPENDENCY.BaseTexture |
    GPU_SHADING_DEPENDENCY.EmissiveTexture | GPU_SHADING_DEPENDENCY.Uv0 |
    GPU_SHADING_DEPENDENCY.Lit,
  GPU_SHADING_DEPENDENCY.Normal | GPU_SHADING_DEPENDENCY.Tangent |
    GPU_SHADING_DEPENDENCY.OrmTexture | GPU_SHADING_DEPENDENCY.NormalTexture |
    GPU_SHADING_DEPENDENCY.EmissiveTexture | GPU_SHADING_DEPENDENCY.Uv0 |
    GPU_SHADING_DEPENDENCY.Lit,
  GPU_SHADING_DEPENDENCY.Normal | GPU_SHADING_DEPENDENCY.Tangent |
    GPU_SHADING_DEPENDENCY.BaseTexture | GPU_SHADING_DEPENDENCY.OrmTexture |
    GPU_SHADING_DEPENDENCY.NormalTexture | GPU_SHADING_DEPENDENCY.EmissiveTexture |
    GPU_SHADING_DEPENDENCY.Uv0 | GPU_SHADING_DEPENDENCY.Lit
]);

export function gpuShadingProgramSpecialization(
  programId: number,
  outputDependencyMask: number
): Readonly<GpuShadingProgramSpecialization> {
  validateProgram(programId);
  validateOutputMask(outputDependencyMask);
  const dependencyMask = FIXED_PROGRAM_DEPENDENCIES[programId]!;
  const generic = programId === GPU_SHADING_PROGRAM.PbrGeneric;
  const lit = programId >= GPU_SHADING_PROGRAM.PbrFactor;
  const has = (dependency: number): boolean => (dependencyMask & dependency) !== 0;
  return Object.freeze({
    programId,
    name: GPU_SHADING_PROGRAM_NAMES[programId]!,
    dependencyMask,
    lit,
    authoredVertexColor: lit
      ? "geometry-conditional"
      : has(GPU_SHADING_DEPENDENCY.AuthoredVertexColor) ? "required" : "never",
    baseTexture: generic
      ? "material-conditional"
      : has(GPU_SHADING_DEPENDENCY.BaseTexture) ? "required" : "never",
    ormTexture: generic
      ? "material-conditional"
      : has(GPU_SHADING_DEPENDENCY.OrmTexture) ? "required" : "never",
    normalTexture: generic
      ? "material-conditional"
      : has(GPU_SHADING_DEPENDENCY.NormalTexture) ? "required" : "never",
    emissiveTexture: generic
      ? "material-conditional"
      : has(GPU_SHADING_DEPENDENCY.EmissiveTexture) ? "required" : "never",
    reconstructTriangle: lit || programId !== GPU_SHADING_PROGRAM.UnlitFactor ||
      (outputDependencyMask & GPU_SHADING_OUTPUT_DEPENDENCY.Velocity) !== 0,
    outputDependencyMask,
    publishesShadingSurface:
      (outputDependencyMask & GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite) !== 0,
    publishesDiffuseSurface:
      (outputDependencyMask & GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite) !== 0,
    publishesVelocity:
      (outputDependencyMask & GPU_SHADING_OUTPUT_DEPENDENCY.Velocity) !== 0
  });
}

export function perspectiveBarycentricReference(
  pixel: Vec2,
  projected0: Vec4,
  projected1: Vec4,
  projected2: Vec4
): Readonly<PerspectiveBarycentricReference> {
  const fallback = (): Readonly<PerspectiveBarycentricReference> => Object.freeze({
    weights: freeze3([1, 0, 0]), ddx: freeze3([0, 0, 0]), ddy: freeze3([0, 0, 0]), valid: false
  });
  if (![...pixel, ...projected0, ...projected1, ...projected2].every(Number.isFinite) ||
      projected0[3] === 0 || projected1[3] === 0 || projected2[3] === 0) return fallback();
  const p0: Vec2 = [projected0[0] / projected0[3], projected0[1] / projected0[3]];
  const p1: Vec2 = [projected1[0] / projected1[3], projected1[1] / projected1[3]];
  const p2: Vec2 = [projected2[0] / projected2[3], projected2[1] / projected2[3]];
  const denominator = (p1[1] - p2[1]) * (p0[0] - p2[0]) +
    (p2[0] - p1[0]) * (p0[1] - p2[1]);
  if (Math.abs(denominator) < 1e-8) return fallback();
  const l0 = ((p1[1] - p2[1]) * (pixel[0] - p2[0]) +
    (p2[0] - p1[0]) * (pixel[1] - p2[1])) / denominator;
  const l1 = ((p2[1] - p0[1]) * (pixel[0] - p2[0]) +
    (p0[0] - p2[0]) * (pixel[1] - p2[1])) / denominator;
  const screen: Vec3 = [l0, l1, 1 - l0 - l1];
  const screenDdx: Vec3 = [
    (p1[1] - p2[1]) / denominator,
    (p2[1] - p0[1]) / denominator,
    (p0[1] - p1[1]) / denominator
  ];
  const screenDdy: Vec3 = [
    (p2[0] - p1[0]) / denominator,
    (p0[0] - p2[0]) / denominator,
    (p1[0] - p0[0]) / denominator
  ];
  const reciprocalW: Vec3 = [1 / projected0[3], 1 / projected1[3], 1 / projected2[3]];
  const weighted = multiply3(screen, reciprocalW);
  const weightedSum = sum3(weighted);
  if (Math.abs(weightedSum) < 1e-8) return fallback();
  const weightedDdx = multiply3(screenDdx, reciprocalW);
  const weightedDdy = multiply3(screenDdy, reciprocalW);
  const sumDdx = sum3(weightedDdx);
  const sumDdy = sum3(weightedDdy);
  const inverse = 1 / weightedSum;
  const inverseSquared = inverse * inverse;
  return Object.freeze({
    weights: freeze3(scale3(weighted, inverse)),
    ddx: freeze3(scale3(subtract3(scale3(weightedDdx, weightedSum), scale3(weighted, sumDdx)), inverseSquared)),
    ddy: freeze3(scale3(subtract3(scale3(weightedDdy, weightedSum), scale3(weighted, sumDdy)), inverseSquared)),
    valid: true
  });
}

export function reconstructAttributeReference(
  values: readonly [Vec2, Vec2, Vec2],
  barycentric: PerspectiveBarycentricReference,
  upscaleRatio: Vec2,
  offset: Vec2 = [0, 0],
  scale: Vec2 = [1, 1],
  rotation: Vec2 = [1, 0]
): Readonly<{ uv: Vec2; ddx: Vec2; ddy: Vec2 }> {
  if (!upscaleRatio.every((value) => Number.isFinite(value) && value > 0)) {
    throw new RangeError("UV reconstruction upscale ratio must be finite and positive");
  }
  const interpolate = (weights: Vec3): Vec2 => [
    values[0][0] * weights[0] + values[1][0] * weights[1] + values[2][0] * weights[2],
    values[0][1] * weights[0] + values[1][1] * weights[1] + values[2][1] * weights[2]
  ];
  const transform = (value: Vec2, includeOffset: boolean): Vec2 => {
    const x = value[0] * scale[0];
    const y = value[1] * scale[1];
    return Object.freeze([
      (includeOffset ? offset[0] : 0) + rotation[0] * x - rotation[1] * y,
      (includeOffset ? offset[1] : 0) + rotation[1] * x + rotation[0] * y
    ] as const);
  };
  const ddx = interpolate(barycentric.ddx);
  const ddy = interpolate(barycentric.ddy);
  return Object.freeze({
    uv: transform(interpolate(barycentric.weights), true),
    ddx: transform([ddx[0] / upscaleRatio[0], ddx[1] / upscaleRatio[0]], false),
    ddy: transform([ddy[0] / upscaleRatio[1], ddy[1] / upscaleRatio[1]], false)
  });
}

export function evaluateGpuShadingProgramReference(
  input: GpuShadingProgramReferenceInput
): Readonly<GpuShadingProgramReferenceResult> {
  const specialization = gpuShadingProgramSpecialization(input.programId, input.outputDependencyMask);
  assertFinitePositive(input.preExposure, "preExposure");
  const material = input.material;
  const vertexColor = specialization.authoredVertexColor === "never"
    ? [1, 1, 1] as const
    : material.vertexColor ?? [1, 1, 1] as const;
  const baseSample = specialization.baseTexture === "never"
    ? [1, 1, 1, 1] as const
    : material.baseSample ?? [1, 1, 1, 1] as const;
  const albedo = multiply3(multiply3(material.baseColorFactor, vertexColor), baseSample);
  const geometricNormal = normalize3(material.geometricNormal, [0, 0, 1]);
  let shadingNormal = normalize3(material.shadingNormal, geometricNormal);
  if (specialization.normalTexture !== "never") {
    const sampled = material.normalSample ?? [0.5, 0.5, 1, 1];
    const tangent = material.tangent ?? [1, 0, 0, 1];
    const tangentDirection = normalize3([tangent[0], tangent[1], tangent[2]], [1, 0, 0]);
    const bitangent = scale3(normalize3(cross3(shadingNormal, tangentDirection), [0, 1, 0]),
      tangent[3] < 0 ? -1 : 1);
    const mapped: Vec3 = [
      (sampled[0] * 2 - 1) * material.normalScale,
      (sampled[1] * 2 - 1) * material.normalScale,
      sampled[2] * 2 - 1
    ];
    shadingNormal = normalize3(add3(add3(
      scale3(tangentDirection, mapped[0]),
      scale3(bitangent, mapped[1])
    ), scale3(shadingNormal, mapped[2])), shadingNormal);
  }
  const orm = specialization.ormTexture === "never"
    ? [1, 1, 1, 1] as const
    : material.ormSample ?? [1, 1, 1, 1] as const;
  const ambientOcclusion = mix(1, orm[0], clamp01(material.occlusionStrength));
  const metallic = clamp01(orm[2] * material.metallicFactor);
  const roughness = clamp01(orm[1] * material.roughnessFactor);
  const emissiveSample = specialization.emissiveTexture === "never"
    ? [1, 1, 1, 1] as const
    : material.emissiveSample ?? [1, 1, 1, 1] as const;
  const emissive = multiply3(material.emissiveFactor, emissiveSample);
  let radiance: Vec3;
  if (!specialization.lit) {
    radiance = scale3(albedo, input.preExposure);
  } else {
    const diffuse = scale3(albedo, 1 - metallic);
    const f0 = mix3([0.04, 0.04, 0.04], albedo, metallic);
    let direct: Vec3 = [0, 0, 0];
    const view = normalize3(input.viewDirection, [0, 0, 1]);
    for (const light of input.directLights) {
      const direction = normalize3(light.direction, [0, 0, 1]);
      const half = normalize3(add3(direction, view), shadingNormal);
      const noL = clamp01(dot3(shadingNormal, direction));
      const noV = clamp01(dot3(shadingNormal, view));
      const noH = clamp01(dot3(shadingNormal, half));
      const voH = clamp01(dot3(view, half));
      const alpha = Math.max(roughness * roughness, 0.02);
      const fresnel = fresnelSchlickReference(f0, 1, voH);
      const specular = scale3(fresnel,
        visibilityGgxSmithCorrelated(alpha, noL, noV) *
        distributionGgx(alpha * alpha, noH * noH));
      const diffuseEnergy = multiply3(diffuse, subtract3([1, 1, 1], fresnel));
      const incident = scale3(light.radiance, noL * clamp01(light.visibility));
      direct = add3(direct, multiply3(incident,
        add3(specular, scale3(diffuseEnergy, 1 / Math.PI))));
    }
    radiance = scale3(add3(direct, emissive), input.preExposure);
  }
  return Object.freeze({
    radiance: freeze3(radiance),
    albedo: freeze3(albedo),
    ambientOcclusion,
    metallic,
    roughness,
    shadingNormal: freeze3(shadingNormal),
    geometricNormal: freeze3(geometricNormal),
    emissive: freeze3(emissive),
    gradientFallback: specialization.baseTexture !== "never" ||
      specialization.ormTexture !== "never" || specialization.normalTexture !== "never" ||
      specialization.emissiveTexture !== "never" ? !input.gradientValid : false,
    publishesShadingSurface: specialization.publishesShadingSurface,
    publishesDiffuseSurface: specialization.publishesDiffuseSurface,
    publishesVelocity: specialization.publishesVelocity
  });
}

export function fresnelSchlickReference(f0: Vec3, f90: number, cosine: number): Vec3 {
  const fifth = (1 - clamp01(cosine)) ** 5;
  return freeze3(f0.map((value) => value + (f90 - value) * fifth) as unknown as Vec3);
}

function distributionGgx(alphaSquared: number, noHSquared: number): number {
  const denominator = noHSquared * (alphaSquared - 1) + 1;
  return alphaSquared / (Math.PI * denominator * denominator);
}

function visibilityGgxSmithCorrelated(alpha: number, noL: number, noV: number): number {
  const alphaSquared = alpha * alpha;
  const lambdaV = noL * Math.sqrt(noV * noV * (1 - alphaSquared) + alphaSquared);
  const lambdaL = noV * Math.sqrt(noL * noL * (1 - alphaSquared) + alphaSquared);
  return 0.5 / Math.max(lambdaV + lambdaL, 1e-6);
}

function validateProgram(programId: number): void {
  if (!Number.isInteger(programId) || programId < 0 || programId >= GPU_SHADING_PROGRAM_COUNT) {
    throw new RangeError("Shading program id must be in [0, 15]");
  }
}

function validateOutputMask(mask: number): void {
  if (!Number.isInteger(mask) || mask < 0 || (mask & ~GPU_SHADING_OUTPUT_DEPENDENCY_VALID_MASK) !== 0) {
    throw new RangeError("Shading output dependency mask has reserved bits");
  }
}

function assertFinitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be finite and positive`);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError("Shading scalar must be finite");
  return Math.min(1, Math.max(0, value));
}

function mix(left: number, right: number, amount: number): number {
  return left + (right - left) * amount;
}

function add3(left: Vec3, right: Vec3): Vec3 {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function subtract3(left: Vec3, right: Vec3): Vec3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function multiply3(left: Vec3, right: Vec3 | Vec4): Vec3 {
  return [left[0] * right[0], left[1] * right[1], left[2] * right[2]];
}

function scale3(value: Vec3, scale: number): Vec3 {
  return [value[0] * scale, value[1] * scale, value[2] * scale];
}

function sum3(value: Vec3): number {
  return value[0] + value[1] + value[2];
}

function dot3(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross3(left: Vec3, right: Vec3): Vec3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0]
  ];
}

function normalize3(value: Vec3, fallback: Vec3): Vec3 {
  const length = Math.sqrt(dot3(value, value));
  return Number.isFinite(length) && length > 1e-8 ? scale3(value, 1 / length) : fallback;
}

function mix3(left: Vec3, right: Vec3, amount: number): Vec3 {
  return [mix(left[0], right[0], amount), mix(left[1], right[1], amount), mix(left[2], right[2], amount)];
}

function freeze3(value: Vec3): Vec3 {
  return Object.freeze([value[0], value[1], value[2]] as const);
}
