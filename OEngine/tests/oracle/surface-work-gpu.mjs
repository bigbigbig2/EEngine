import { SurfaceWorkRuntime } from "../../.test-dist/render/surface/SurfaceWorkRuntime.js";
import { FrameGraph } from "../../.test-dist/framegraph/FrameGraph.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import { GPUBufferAllocator } from "../../.test-dist/gpu/GPUBufferAllocator.js";
import { GPUStagingBufferAllocator } from "../../.test-dist/gpu/GPUStagingBufferAllocator.js";
import { GPUTextureAllocator } from "../../.test-dist/gpu/GPUTextureAllocator.js";
import { FrameGeometryArena } from "../../.test-dist/render/FrameGeometryArena.js";
import { FrameGeometryVertices } from "../../.test-dist/render/FrameGeometryVertices.js";
import { FrameProfiler } from "../../.test-dist/debug/FrameProfiler.js";
import { ResourceAccounting } from "../../.test-dist/debug/profiling/ResourceAccounting.js";
import { GpuAppearancePublication } from "../../.test-dist/gpu/GpuAppearancePublication.js";
import { AppearanceProgramRegistry } from "../../.test-dist/gpu/AppearanceProgramRegistry.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { compileCanonicalMaterial } from "../../.test-dist/material/CanonicalMaterial.js";
import {
  AppearanceGraphBuilder,
  snapshotAppearanceTexture
} from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import {
  GEOMETRY_PRODUCT_GPU_ABI_VERSION_V1,
  encodeGeometryProductGpuLocationV1
} from "../../.test-dist/gpu/GeometryProductGpuAbiV1.js";
import {
  packGpuInstanceRecord,
  GPU_INSTANCE_FLAGS,
  GPU_INSTANCE_RECORD_OFFSETS
} from "../../.test-dist/gpu/GpuInstanceAbi.js";
import {
  GPU_FRAME_INSTANCE_STRIDE,
  GPU_FRAME_INSTANCE_OFFSETS
} from "../../.test-dist/gpu/GpuFrameInstanceAbi.js";
import {
  GPU_GEOMETRY_RECORD_SCHEMA,
  GPU_MESHLET_RECORD_SCHEMA
} from "../../.test-dist/gpu/GpuGeometryAbi.js";
import {
  DIRECTIONAL_LIGHT_DESCRIPTOR,
  DIRECTIONAL_LIGHT_RECORD_TYPE
} from "../../.test-dist/gpu/LightDatabase.js";
import { SURFACE_WORK_LIGHTING_WGSL } from "../../.test-dist/shaders/surface_work_lighting.js";
import { SURFACE_WORK_COVERAGE_WGSL } from "../../.test-dist/shaders/surface_work.js";
import { SURFACE_WORK_RATE_WGSL } from "../../.test-dist/shaders/surface_work_rate.js";
import { SURFACE_WORK_RECONSTRUCT_WGSL } from "../../.test-dist/shaders/surface_work_reconstruct.js";
import { SURFACE_RADIOMETRY_WGSL } from "../../.test-dist/render/surface/SurfaceRadiometryPass.js";
import { APPEARANCE_FIELD_NAMES } from "../../.test-dist/gpu/GpuAppearanceFieldAbi.js";
import { evaluateCompiledAppearance } from "../../.test-dist/material/AppearanceGraphEvaluation.js";
import { bindAppearanceProducts } from "../../.test-dist/material/AppearanceProductBinding.js";
import { cookAppearanceNormalProduct } from "../../.test-dist/material/AppearanceNormalCooker.js";
import {
  cookAppearanceMipProduct,
  sampleAppearanceCookedField
} from "../../.test-dist/material/AppearanceMipCooker.js";
import {
  writeAppearanceAssetPackage,
  openAppearanceAssetPackage
} from "../../.test-dist/assets/AppearanceAssetPackage.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import {
  compileAppearanceExecutionPlan,
  APPEARANCE_DAG_OPS
} from "../../.test-dist/material/ExactAppearanceDag.js";
import { lowerAppearanceWgsl } from "../../.test-dist/shaders/appearance_program.js";
import { APPEARANCE_EXACT_DAG_WGSL } from "../../.test-dist/shaders/appearance_exact_dag.js";
import { surfaceWorkAppearanceWgsl } from "../../.test-dist/shaders/surface_work.js";
import {
  fixedPrivateScratchReference,
  residentSamplerCostReference,
  fullChannelGatherCostReference
} from "./appearance-cost-reference.mjs";
import { checkSurfaceGeometryBoundaries } from "./surface-geometry-boundary-gpu.mjs";
import { SurfaceTemporalValueFixture } from "./surface-temporal-value-gpu.mjs";
import { checkSurfaceCoverageValues } from "./surface-coverage-value-gpu.mjs";

// Isolated cost reference: specialize this fixture's complete IR into named
// values, keeping the same C/X/Y samples, constants and output slots. This is
// never registered by production; no per-material production dispatch is added.
function straightLineCostReference(program) {
  const dag = compileAppearanceExecutionPlan(
    {
      ...program,
      outputs: Object.fromEntries(Object.entries(program.outputs).filter(([name]) => name !== "alpha"))
    },
    lowerAppearanceWgsl(program)
  ).varying;
  const values = new Map(),
    statements = [];
  const ops = APPEARANCE_DAG_OPS;
  const binary = { [ops.add]: "+", [ops.subtract]: "-", [ops.multiply]: "*", [ops.divide]: "/" };
  const intrinsic = {
    [ops.min]: "min",
    [ops.max]: "max",
    [ops.pow]: "pow",
    [ops.sin]: "sin",
    [ops.cos]: "cos",
    [ops.abs]: "abs",
    [ops.sqrt]: "sqrt",
    [ops.clamp]: "clamp"
  };
  const load = (slot) => {
    const value = values.get(slot);
    check(value !== undefined, "reference requires every live operand");
    return value;
  };
  for (let index = 0; index < dag.instructions.length / 8; index++) {
    const [op, destination, a, b, c, mask, auxiliary, control] = dag.instructions.slice(
      index * 8,
      index * 8 + 8
    );
    const name = `reference_${index}`,
      channel = control & 255,
      neighbors = (control & 65536) !== 0;
    const width = control >>> 28;
    if (op === ops.fieldSink) {
      statements.push(
        `if (missing & ${mask}u) != 0u { appearance_dag_output(${auxiliary}u, ${channel}u, ${load(a)}.x); }`
      );
      continue;
    }
    if (op === ops.sample || op === ops.product) {
      const u = load(a),
        v = load(b),
        points = neighbors ? 3 : 1;
      for (let point = 0; point < points; point++) {
        const sample = `${name}_${point}`,
          component = "xyz"[point];
        statements.push(
          `let ${sample} = appearance_dag_${op === ops.sample ? "sample" : "product"}(${auxiliary}u, vec2f(${u}.${component}, ${v}.${component}), vec2f(${u}.y - ${u}.x, ${v}.y - ${v}.x), vec2f(${u}.z - ${u}.x, ${v}.z - ${v}.x));`
        );
        values.set(destination + point * 4, sample);
      }
      continue;
    }
    for (let component = 0; component < width; component++) {
      const valueName = `${name}_${component}`;
      const operand = (slot, ordinal) => load(slot + ((control & (256 << ordinal)) !== 0 ? 0 : component));
      let expression;
      if (op === ops.constant) expression = `vec3f(appearance_dag_constant(${auxiliary + component}u))`;
      else if (op === ops.uniformLoad)
        expression = `vec3f(appearance_dag_uniform(${auxiliary + component}u))`;
      else if (op === ops.input)
        expression = `appearance_dag_input(${auxiliary}u, ${a}u, ${channel + component}u, ${neighbors})`;
      else if (op === ops.channel)
        expression = `vec3f(${Array.from({ length: 3 }, (_, point) => `${load(a + (neighbors ? point * 4 : 0))}[${channel}u]`).join(", ")})`;
      else if (binary[op]) expression = `${operand(a, 0)} ${binary[op]} ${operand(b, 1)}`;
      else if (op === ops.mix)
        expression = `${operand(a, 0)} * (vec3f(1.0) - ${operand(c, 2)}) + ${operand(b, 1)} * ${operand(c, 2)}`;
      else if (intrinsic[op]) {
        const args = [operand(a, 0)];
        if ([ops.min, ops.max, ops.pow, ops.clamp].includes(op)) args.push(operand(b, 1));
        if (op === ops.clamp) args.push(operand(c, 2));
        expression = `${intrinsic[op]}(${args.join(", ")})`;
      } else throw new Error(`Cost reference does not cover fixture opcode ${op}`);
      statements.push(`let ${valueName} = ${expression};`);
      values.set(destination + component, valueName);
    }
  }
  return `fn appearance_dag_evaluate(code: u32, count: u32, lane: u32, missing: u32, slot_stride: u32) {\n${statements.join("\n")}\n}`;
}
import { encodeGpuTextureRef } from "../../.test-dist/gpu/GpuTextureRefAbi.js";
import { decodeFloat16, encodeFloat16 } from "../../.test-dist/core/Float16.js";
const workingColor = ([r, g, b]) => [
  r * 0.627404 + g * 0.329282 + b * 0.0433136,
  r * 0.069097 + g * 0.91954 + b * 0.0113612,
  r * 0.0163916 + g * 0.0880132 + b * 0.895595
];
function observeNativeCommands(encoder) {
  const counts = {
    computePasses: 0,
    dispatch: 0,
    dispatchIndirect: 0,
    clear: 0,
    clearBytes: 0,
    copy: 0,
    copyBytes: 0,
    oracleCopies: 0,
    oracleComputePasses: 0,
    oracleDispatch: 0
  };
  const begin = encoder.beginComputePass.bind(encoder);
  encoder.beginComputePass = function (...args) {
    const oracle = args[0]?.label?.startsWith("Independent ") === true;
    counts[oracle ? "oracleComputePasses" : "computePasses"]++;
    const pass = begin(...args);
    for (const [method, key] of [
      ["dispatchWorkgroups", "dispatch"],
      ["dispatchWorkgroupsIndirect", "dispatchIndirect"]
    ]) {
      const original = pass[method].bind(pass);
      pass[method] = function (...values) {
        counts[oracle ? "oracleDispatch" : key]++;
        return original(...values);
      };
    }
    return pass;
  };
  const clear = encoder.clearBuffer.bind(encoder);
  encoder.clearBuffer = function (buffer, offset = 0, size = buffer.size - offset) {
    counts.clear++;
    counts.clearBytes += size;
    return clear(buffer, offset, size);
  };
  const copy = encoder.copyBufferToBuffer.bind(encoder);
  encoder.copyBufferToBuffer = function (source, sourceOffset, destination, destinationOffset, size) {
    if ((destination.usage & GPUBufferUsage.MAP_READ) !== 0) {
      counts.oracleCopies++;
    } else {
      counts.copy++;
      counts.copyBytes += size;
    }
    return copy(source, sourceOffset, destination, destinationOffset, size);
  };
  return counts;
}
function independentLit(
  x,
  y,
  width,
  height,
  ior = 1.5,
  ao = 1,
  cameraPosition = [0, 0, 100],
  specularEnvironment = false
) {
  const position = [((x + 0.5) / width) * 2 - 1, 1 - ((y + 0.5) / height) * 2, 0.5];
  const delta = cameraPosition.map((value, channel) => Math.fround(value - position[channel])),
    length = Math.hypot(...delta);
  const v = delta.map((value) => value / length),
    half = [v[0], v[1], v[2] + 1],
    halfLength = Math.hypot(...half);
  const h = half.map((value) => value / halfLength),
    voh = v.reduce((sum, value, index) => sum + value * h[index], 0);
  const a2 = 0.8 ** 4;
  const d = a2 / (Math.PI * (h[2] ** 2 * (a2 - 1) + 1) ** 2);
  const visibility = 0.5 / (Math.sqrt(v[2] ** 2 * (1 - a2) + a2) + v[2]);
  const f0 = ((ior - 1) / (ior + 1)) ** 2;
  const f = f0 + (1 - f0) * (1 - voh) ** 5;
  const specular = f * visibility * d;
  const value = [
    4 * (1 / Math.PI + specular) + ao / Math.PI,
    2 * (1 / Math.PI + specular) + (2 * ao) / Math.PI,
    1 / Math.PI + specular + (3 * ao) / Math.PI
  ];
  if (specularEnvironment)
    [0.25, 0.5, 0.75].forEach((radiance, channel) => {
      value[channel] += radiance * (f0 * 0.5 + 0.25);
    });
  return workingColor(value);
}
// Independent scalar BRDF oracle, using the actual closed f32 input product.
// The separate field/guide assertions above validate that product against the
// authored graph. This isolates Lighting errors from source-filter quantization.
function independentSignals(fields, normal, angular) {
  const clamp = (value) => Math.max(0, Math.min(1, value));
  const f = Math.fround;
  const [nl, nv, nh, vh, coatNl, coatNh] = angular;
  const base = fields.baseColor.map((value) => Math.max(0, value));
  const metallic = clamp(fields.metallic?.[0] ?? 0);
  const roughness = Math.max(0.04, Math.min(1, fields.roughness?.[0] ?? 1));
  const ior = Math.max(1, fields.ior?.[0] ?? 1.5);
  const dielectric = ((ior - 1) / (ior + 1)) ** 2;
  const weight = clamp(fields.specularWeight?.[0] ?? 1);
  const color = fields.specularColor ?? [1, 1, 1];
  const f0 = base.map((value, i) => (dielectric * (1 - metallic) + value * metallic) * weight * color[i]);
  const alpha = Math.max(f(roughness * roughness), f(0.002)),
    a2 = f(alpha * alpha);
  const denominator = f(f(f(nh * nh) * f(a2 - 1)) + 1);
  const d = f(a2 / f(f(f(Math.PI) * denominator) * denominator));
  const v =
    0.5 / Math.max(nl * Math.sqrt(nv ** 2 * (1 - a2) + a2) + nv * Math.sqrt(nl ** 2 * (1 - a2) + a2), 1e-6);
  const fresnel = f0.map((value) => value + (1 - value) * (1 - vh) ** 5);
  const coatFactor = clamp(fields.coatWeight?.[0] ?? 0);
  const coatRoughness = Math.max(0.04, Math.min(1, fields.coatRoughness?.[0] ?? 1));
  const coatAlpha = Math.max(f(coatRoughness * coatRoughness), f(0.002));
  const coatA2 = f(coatAlpha * coatAlpha);
  const coatF = (0.04 + 0.96 * (1 - vh) ** 5) * coatFactor;
  const coatDenominator = f(f(f(coatNh * coatNh) * f(coatA2 - 1)) + 1);
  const coatD = f(coatA2 / f(f(f(Math.PI) * coatDenominator) * coatDenominator));
  const coatBrdf = ((coatD * 0.25) / Math.max(vh ** 2, 0.0000039)) * coatF;
  const attenuation = 1 - coatF;
  const light = [4, 2, 1];
  // All probed normals face +Z, so their octahedral lookup lies inside the
  // original linear gradient's seam-free interior (no wrap oracle ambiguity).
  const sum = normal.reduce((total, value) => total + Math.abs(value), 0);
  const u = 0.5 + (0.5 * normal[0]) / sum,
    w = 0.5 + (0.5 * normal[1]) / sum;
  const irradiance = [1 + (u * 8 - 4) / 16, 2 + (w * 8 - 4) / 16, 3 + ((u + w) * 8 - 8) / 32];
  const environment = [0.25, 0.5, 0.75];
  return [
    light.map((value) => ((value * nl) / Math.PI) * attenuation),
    irradiance,
    light.map((value, i) => value * nl * fresnel[i] * v * d * attenuation),
    environment.map((value, i) => value * (f0[i] * 0.5 + 0.25)),
    light.map((value) => value * coatNl * coatBrdf),
    environment.map((value) => value * coatFactor * 0.04)
  ];
}
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
export async function runSurfaceWorkLightingCompileGpuOracle(device) {
  const started = performance.now();
  const module = device.createShaderModule({
    label: "Surface/isolated closed lighting",
    code: SURFACE_WORK_LIGHTING_WGSL
  });
  console.log("SurfaceWork isolated lighting compilation info");
  const info = await module.getCompilationInfo();
  check(
    info.messages.every((message) => message.type !== "error"),
    JSON.stringify(info.messages)
  );
  const infoMs = performance.now() - started;
  console.log("SurfaceWork isolated lighting pipeline");
  await device.createComputePipelineAsync({
    label: "Surface/isolated closed lighting",
    layout: "auto",
    compute: { module, entryPoint: "lighting" }
  });
  return {
    passed: true,
    scope: "compilation diagnosis only",
    infoMs,
    completeMs: performance.now() - started
  };
}
export async function runSurfaceWorkCompileGpuOracle(device) {
  const timings = [];
  for (const [entryPoint, code] of [
    ["prove_radiometry", SURFACE_RADIOMETRY_WGSL],
    ["coverage", SURFACE_WORK_COVERAGE_WGSL],
    ["finalize", SURFACE_WORK_COVERAGE_WGSL],
    ["rate", SURFACE_WORK_RATE_WGSL],
    ["lighting", SURFACE_WORK_LIGHTING_WGSL],
    ["reconstruct", SURFACE_WORK_RECONSTRUCT_WGSL]
  ]) {
    console.log("SurfaceWork isolated compile " + entryPoint);
    const start = performance.now();
    const module = device.createShaderModule({ label: entryPoint, code });
    const info = await module.getCompilationInfo();
    check(
      info.messages.every((message) => message.type !== "error"),
      entryPoint + JSON.stringify(info.messages)
    );
    await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint } });
    timings.push({ entryPoint, ms: performance.now() - start });
    console.log("SurfaceWork compiled " + entryPoint);
  }
  return { passed: true, scope: "current work kernel compilation only", timings };
}
export async function runSurfaceWorkCostGpuOracle(device) {
  return runSurfaceWorkGpuOracle(device, { cost: true });
}
export async function runSurfaceWorkNativeReferenceGpuOracle(device) {
  return runSurfaceWorkGpuOracle(device, { cost: true, nativeReference: true });
}
export async function runSurfaceWorkFixedScratchReferenceGpuOracle(device) {
  return runSurfaceWorkGpuOracle(device, { cost: true, fixedScratchReference: true });
}
export async function runSurfaceWorkResidentSamplerReferenceGpuOracle(device) {
  return runSurfaceWorkGpuOracle(device, { cost: true, residentSamplerReference: true });
}
export async function runSurfaceWorkChannelReferenceGpuOracle(device) {
  return runSurfaceWorkGpuOracle(device, { cost: true, channelReference: true });
}
export async function runSurfaceWorkGpuOracle(
  device,
  {
    cost = false,
    nativeReference = false,
    fixedScratchReference = false,
    residentSamplerReference = false,
    channelReference = false
  } = {}
) {
  const retained = [],
    modules = [],
    apiErrors = [],
    timings = [];
  const originalModule = device.createShaderModule.bind(device);
  device.createShaderModule = (descriptor) => {
    const module = originalModule(descriptor);
    modules.push([descriptor.label ?? "", module]);
    return module;
  };
  const originalPipeline = device.createComputePipeline.bind(device);
  device.createComputePipeline = (descriptor) => {
    console.log("SurfaceWork compile " + descriptor.label);
    return originalPipeline(descriptor);
  };
  const buffer = (data, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST) => {
    const result = device.createBuffer({ size: data.byteLength, usage });
    device.queue.writeBuffer(result, 0, data);
    retained.push(result);
    return result;
  };
  const texture = (width, height, format, data, depth = 1) => {
    const result = device.createTexture({
      size: [width, height, depth],
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    if (data)
      device.queue.writeTexture(
        { texture: result },
        data,
        {
          bytesPerRow: width * data.BYTES_PER_ELEMENT * (format === "r32uint" ? 1 : 4),
          rowsPerImage: height
        },
        { width, height, depthOrArrayLayers: depth }
      );
    retained.push(result);
    return result;
  };
  const ledger = new ResourceAccounting();
  const profiler = new FrameProfiler({ enabled: false });
  const graphics = {
    device,
    profiler,
    buffer_allocator_main: new GPUBufferAllocator(device, ledger),
    buffer_allocator_staging: new GPUStagingBufferAllocator(device, ledger),
    allocator_textures: new GPUTextureAllocator(device, ledger)
  };
  const registry = new AppearanceProgramRegistry(device);
  let publication,
    runtime,
    frameArenaOwner,
    frameVertexOwner,
    temporalFixture = null;
  let failureSnapshot = null;
  const errorListener = (event) => apiErrors.push(event.error.message);
  device.addEventListener("uncapturederror", errorListener);
  try {
    const upload = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    const material = new StandardShadeMaterial();
    material.roughness_factor = 0.8;
    const unlit = new StandardShadeMaterial();
    const builder = new AppearanceGraphBuilder();
    builder.output("baseColor", builder.constant([0.1, 0.2, 0.3]));
    builder.output("emissive", builder.constant([0.03, 0.02, 0.01]));
    builder.output("alpha", builder.constant([1]));
    const resident = new ShadeTexture();
    resident.wrapS = 1;
    resident.wrapT = 1;
    const genericBuilder = new AppearanceGraphBuilder();
    const uv0 = genericBuilder.input("uv0", 2, "surface", undefined, "uv0");
    const uv1 = genericBuilder.input("uv1", 2, "surface", undefined, "uv1");
    const uv2 = genericBuilder.input("uv2", 2, "surface", undefined, "uv2");
    const first = genericBuilder.texture(
      snapshotAppearanceTexture(resident, "linear-rgb", [-0.3, 1.2], [1.4, 1.7], 0.25),
      genericBuilder.operation(
        "sin",
        genericBuilder.operation(
          "multiply",
          genericBuilder.operation("add", uv0, uv1),
          genericBuilder.constant(0.3)
        )
      )
    );
    const nested = genericBuilder.texture(
      snapshotAppearanceTexture(resident, "linear-rgb"),
      genericBuilder.operation(
        "add",
        genericBuilder.swizzle(first, [0, 1]),
        genericBuilder.operation("multiply", uv2, genericBuilder.constant(0.2))
      )
    );
    // These twelve source queries are used both by an early RGB output and by
    // a later nested coordinate. Their genuine C/X/Y live ranges coexist; the
    // storage family is exercised without lowering a production slot ceiling.
    const retainedQueries = Array.from({ length: 12 }, (_, index) =>
      genericBuilder.texture(
        snapshotAppearanceTexture(resident, "linear-rgb"),
        genericBuilder.operation(
          "sin",
          genericBuilder.operation("add", uv0, genericBuilder.constant([index * 0.013, index * 0.017]))
        )
      )
    );
    const aggregate = retainedQueries.reduce(
      (value, query) => genericBuilder.operation("add", value, genericBuilder.swizzle(query, [0, 1, 2])),
      genericBuilder.constant([0, 0, 0])
    );
    const phase = genericBuilder.parameter("phase", 0);
    const gain = genericBuilder.operation(
      "add",
      genericBuilder.constant(1),
      genericBuilder.operation("sin", phase)
    );
    const widths = [3, 1, 1, 1, 1, 3, 3, 1, 1, 3, 1, 1, 3, 1, 1];
    APPEARANCE_FIELD_NAMES.forEach((name, field) => {
      let value = genericBuilder.operation(
        "add",
        genericBuilder.swizzle(nested, widths[field] === 3 ? [0, 1, 2] : [0]),
        genericBuilder.constant((field + 1) * 0.03125)
      );
      if (name === "baseColor")
        value = genericBuilder.operation(
          "multiply",
          genericBuilder.operation("multiply", aggregate, genericBuilder.constant(1 / 12)),
          gain
        );
      if (name === "coatNormalTS") {
        const lateUv = retainedQueries.reduce(
          (value, query) => genericBuilder.operation("add", value, genericBuilder.swizzle(query, [0, 1])),
          genericBuilder.constant([0, 0])
        );
        const lateCoordinate = genericBuilder.texture(
          snapshotAppearanceTexture(resident, "linear-rgb"),
          genericBuilder.operation("multiply", lateUv, genericBuilder.constant(1 / 12))
        );
        const lateSample = genericBuilder.texture(
          snapshotAppearanceTexture(resident, "linear-rgb"),
          genericBuilder.operation(
            "add",
            genericBuilder.swizzle(lateCoordinate, [0, 1]),
            genericBuilder.operation("multiply", uv1, genericBuilder.constant(0.125))
          )
        );
        value = genericBuilder.swizzle(lateSample, [0, 1, 2]);
      }
      if (name === "normalTS" || name === "coatNormalTS")
        value = genericBuilder.operation(
          "add",
          genericBuilder.operation("multiply", value, genericBuilder.constant(0.2)),
          genericBuilder.constant([0, 0, 1])
        );
      if (name === "normalTSValidity" || name === "coatNormalTSValidity" || name === "alpha")
        value = genericBuilder.constant(1);
      if (name === "ior") value = genericBuilder.operation("add", value, genericBuilder.constant(1));
      genericBuilder.output(name, value);
    });
    const generic = compileAppearanceGraph(genericBuilder.build());
    let genericReference = generic;
    const procedural = new AppearanceGraphBuilder();
    const pUv = procedural.input("uv0", 2, "surface", undefined, "uv0");
    procedural.output("baseColor", procedural.constant([0.6, 0.4, 0.2]));
    procedural.output("alpha", procedural.constant(1));
    procedural.output("roughness", procedural.constant(0.7));
    procedural.output(
      "normalTS",
      procedural.combine(
        procedural.operation(
          "multiply",
          procedural.operation(
            "sin",
            procedural.operation("multiply", procedural.swizzle(pUv, [0]), procedural.constant(45))
          ),
          procedural.constant(0.35)
        ),
        procedural.constant(0),
        procedural.constant(1)
      )
    );
    procedural.output("normalTSValidity", procedural.constant(1));
    const highFrequency = compileAppearanceGraph(procedural.build());
    const coated = new StandardShadeMaterial();
    for (const role of [
      "albedo",
      "normal",
      "orm",
      "occlusion",
      "emissive",
      "specular",
      "specular_color",
      "clearcoat",
      "clearcoat_roughness",
      "clearcoat_normal"
    ])
      coated["texture_" + role] = resident;
    coated.normal_uv_set = 1;
    coated.clearcoat_normal_uv_set = 2;
    coated.normal_scale = 0.37;
    coated.clearcoat_normal_scale = 0.53;
    coated.clearcoat_factor = 0.7;
    coated.clearcoat_roughness_factor = 0.44;
    coated.ior_factor = 1.7;
    coated.specular_factor = 0.8;
    const fixedStandard = compileCanonicalMaterial(coated).appearance;
    const extraMaterials = [new StandardShadeMaterial(), new StandardShadeMaterial()];
    const publicationSources = [
      {
        material,
        materialSlot: 0,
        textureBindingSetId: 0,
        program: compileCanonicalMaterial(material).appearance,
        textureRefs: new Map()
      },
      {
        material: unlit,
        materialSlot: 1,
        textureBindingSetId: 0,
        program: compileAppearanceGraph(builder.build()),
        textureRefs: new Map()
      },
      {
        material: extraMaterials[0],
        materialSlot: 2,
        textureBindingSetId: 1,
        program: generic,
        textureRefs: new Map([[resident, encodeGpuTextureRef(0, 1)]])
      },
      {
        material: extraMaterials[1],
        materialSlot: 3,
        textureBindingSetId: 2,
        program: highFrequency,
        textureRefs: new Map()
      },
      {
        material: coated,
        materialSlot: 4,
        textureBindingSetId: 3,
        program: fixedStandard,
        textureRefs: new Map([[resident, encodeGpuTextureRef(0, 1)]])
      }
    ];
    publication = new GpuAppearancePublication(
      device,
      registry,
      publicationSources,
      upload,
      new Map(),
      new Map()
    );
    await publication.ready;
    check(
      publication.exactDagLiveWords > 32,
      "complete generic fixture must execute the storage-lane family"
    );
    console.log("SurfaceWork publication ready");
    upload.finish();
    await upload.gpuDone;
    runtime = new SurfaceWorkRuntime(device, ledger);
    runtime.setDiagnosticsMode("detailed");
    for (const [label, module] of modules) {
      // Registry.ready already awaits each Appearance module's info and PSO.
      // Querying the same large module a second time is redundant validation;
      // all runtime-owned modules below still require their own error checks.
      if (label === "Appearance/program") continue;
      console.log("SurfaceWork awaiting module info " + label);
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter((message) => message.type === "error");
      check(errors.length === 0, label + ": " + errors.map((message) => message.message).join("; "));
      console.log("SurfaceWork module info ready " + label);
    }
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const instances = new Uint8Array(GPU_FRAME_INSTANCE_STRIDE);
    instances.set(
      packGpuInstanceRecord({
        geometryRecordIndex: 1,
        geometryGeneration: 3,
        instanceSetGeneration: 7,
        materialHandle: 0,
        flags: 1,
        debugId: 0,
        boundsSphere: [0, 0, 0, 2],
        boundsMin: [-1, -1, 0, 0],
        boundsMax: [1, 1, 1, 0],
        currentObjectToWorld: identity,
        previousObjectToWorld: identity,
        dynamicRevision: 1
      })
    );
    new Float32Array(instances.buffer).set(identity, GPU_FRAME_INSTANCE_OFFSETS.objectToClip / 4);
    new Float32Array(instances.buffer).set(
      [1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0],
      GPU_FRAME_INSTANCE_OFFSETS.normalX / 4
    );
    new DataView(instances.buffer).setUint32(GPU_FRAME_INSTANCE_OFFSETS.generation, 11, true);
    const attributes = new Uint32Array(144),
      floats = new Float32Array(attributes.buffer);
    attributes.set([0, 1, 2, 3]);
    new Uint8Array(attributes.buffer).set([0, 1, 2, 2, 1, 3], 16);
    [
      [-1, -1, 0.5],
      [3, -1, 0.5],
      [-1, 3, 0.5],
      [3, 3, 0.5]
    ].forEach((p, vertex) =>
      floats.set(
        [
          0,
          0,
          1,
          1,
          1,
          0,
          0,
          1,
          (p[0] + 1) / 2,
          (p[1] + 1) / 2,
          1 - (p[0] + 1) / 2,
          (p[1] + 1) / 4 + 0.125,
          1,
          1,
          1,
          1,
          (p[0] + 1) / 4 + 0.1,
          (p[1] + 1) / 4 + 0.2,
          0,
          0,
          ...p,
          1
        ],
        8 + vertex * 24
      )
    );
    for (let triangle = 0; triangle < 2; triangle++)
      attributes.set([7, 8, 9, 10, 11, 12, 0, 0], 112 + triangle * 16);
    const source = new Uint32Array(
      (GPU_GEOMETRY_RECORD_SCHEMA.stride + GPU_MESHLET_RECORD_SCHEMA.stride) / 4
    );
    source[GPU_GEOMETRY_RECORD_SCHEMA.offsets.resident_attribute_word_offset / 4] = 8;
    const mesh = (name, value) =>
      (source[GPU_GEOMETRY_RECORD_SCHEMA.stride / 4 + GPU_MESHLET_RECORD_SCHEMA.offsets[name] / 4] = value);
    mesh("vertex_offset", 0);
    mesh("vertex_count", 4);
    mesh("triangle_byte_offset", 0);
    mesh("triangle_count", 2);
    let work = buffer(
      new Uint32Array([
        5,
        5,
        0,
        5,
        0,
        11,
        0,
        0,
        ...Array.from({ length: 5 }, (_, slot) => [0, 0, 0, slot, 0, 0]).flat()
      ])
    );
    const sourceHeap = buffer(
        source,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
      ),
      vertexPayload = buffer(attributes),
      frameInstances = buffer(instances);
    frameArenaOwner = new FrameGeometryArena(device, ledger);
    frameVertexOwner = new FrameGeometryVertices(device, ledger);
    await frameVertexOwner.ready;
    const geometryBudget = {
      workCapacity: 5,
      vertexCapacity: 20,
      triangleCapacity: 10,

      maxBytes: 1024 * 1024
    };
    let frameArena = frameArenaOwner.prepare(sourceHeap, sourceHeap.size, geometryBudget);
    let productGeometry = null;
    const vertexInputs = {
      instances: { records: frameInstances },
      work,
      assets: {
        sparseShading: {
          assetMetadataHeap: sourceHeap,
          vertexPayloadHeap: vertexPayload,
          geometryWordBase: 0,
          meshletWordBase: GPU_GEOMETRY_RECORD_SCHEMA.stride / 4,
          meshletVertexWordBase: 0,
          meshletTriangleWordBase: 4,
          vertexDataWordBase: 0
        }
      }
    };
    let preparedVertices = frameVertexOwner.prepare({ arena: frameArena, ...vertexInputs });
    const vertexCommand = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    vertexCommand.onFinished.addOne(
      frameArenaOwner.encodeMetadataPublication(vertexCommand.gpu_encoder, frameArena)
    );
    frameVertexOwner.encode(vertexCommand.gpu_encoder, preparedVertices);
    vertexCommand.finish();
    await vertexCommand.gpuDone;
    const cameraValues = new Float32Array(164);
    for (let index = 0; index < 8; index++) cameraValues.set(identity, index * 16);
    cameraValues[14] = 100;
    cameraValues[30] = -100;
    cameraValues[46] = -100;
    cameraValues[62] = 100;
    cameraValues[78] = 100;
    cameraValues[94] = -100;
    const camera = buffer(cameraValues, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const lightWords = new Uint32Array(32768).fill(0xffffffff);
    const descriptor = DIRECTIONAL_LIGHT_DESCRIPTOR,
      page = 8000;
    lightWords[descriptor.page_lookup_address] = page;
    lightWords.fill(0, page, page + descriptor.page_header_words);
    lightWords[page + 1] = 1;
    for (const field of DIRECTIONAL_LIGHT_RECORD_TYPE.fields) {
      const at = page + descriptor.page_header_words + field.offset / 4;
      if (field.name === "direction") new Float32Array(lightWords.buffer).set([0, 0, -1], at);
      else if (field.name === "color") new Float32Array(lightWords.buffer).set([4, 2, 1], at);
      else lightWords[at] = 0;
    }
    const lights = buffer(lightWords);
    const clusterParameters = buffer(
      new Float32Array([0, 1, 1, 0]),
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    );
    const clusterLookup = buffer(new Uint32Array(24 * 4));
    const clusterData = buffer(new Uint32Array([0, 0, 32, 0, 0, 0, 0, 0, ...Array(32).fill(0)]));
    const clusterList = buffer(new Uint32Array(256));
    const irradianceTexels = new Uint16Array(8 * 8 * 4);
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++)
        irradianceTexels.set(
          [1 + (x - 3.5) / 16, 2 + (y - 3.5) / 16, 3 + (x + y - 7) / 32, 1].map(encodeFloat16),
          (y * 8 + x) * 4
        );
    const environment = texture(8, 8, "rgba16float", irradianceTexels);
    const black = texture(1, 1, "rgba16float", new Uint16Array(4));
    const nonzeroSpecular = texture(
      1,
      1,
      "rgba16float",
      new Uint16Array([0.25, 0.5, 0.75, 1].map(encodeFloat16))
    );
    const nonzeroDfg = texture(1, 1, "rgba16float", new Uint16Array([0.5, 0.25, 0, 0].map(encodeFloat16)));
    const texels = new Uint8Array(8 * 8 * 2 * 4);
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const at = (64 + y * 8 + x) * 4;
        texels.set([Math.round(64 + x * 16), Math.round(48 + y * 16), 224, 255], at);
      }
    const residentTexture = texture(8, 8, "rgba8unorm", texels, 2);
    const banks = residentTexture.createView({ dimension: "2d-array" });
    const sampleResident = (binding, coordinate) => {
      const x = coordinate[0] * 8 - 0.5,
        y = coordinate[1] * 8 - 0.5;
      const ix = Math.floor(x),
        iy = Math.floor(y),
        fx = x - ix,
        fy = y - iy;
      const address = (index, mode) => {
        if (mode === 0) return Math.max(0, Math.min(7, index));
        if (mode === 1) return ((index % 8) + 8) % 8;
        const mirrored = ((index % 16) + 16) % 16;
        return mirrored < 8 ? mirrored : 15 - mirrored;
      };
      const texel = (px, py, channel) =>
        texels[(64 + address(py, binding.sampler[5]) * 8 + address(px, binding.sampler[4])) * 4 + channel] /
        255;
      return Array.from(
        { length: 4 },
        (_, channel) =>
          (texel(ix, iy, channel) * (1 - fx) + texel(ix + 1, iy, channel) * fx) * (1 - fy) +
          (texel(ix, iy + 1, channel) * (1 - fx) + texel(ix + 1, iy + 1, channel) * fx) * fy
      );
    };
    const exposure = buffer(new Float32Array([1]));
    const angularPipeline = device.createComputePipeline({
      layout: "auto",
      compute: {
        entryPoint: "main",
        module: device.createShaderModule({
          code: `
        struct Settings { size: vec4u, regions: vec4u, }
        @group(0) @binding(0) var<uniform> parameters: Settings;
        @group(0) @binding(1) var<storage, read> closed: array<f32>;
        @group(0) @binding(2) var<storage, read_write> angular: array<f32>;
        @group(0) @binding(3) var<uniform> camera: array<vec4f, 41>;
        @compute @workgroup_size(64)
        fn main(@builtin(global_invocation_id) id: vec3u) {
          let pixel = id.x;
          let pixels = parameters.size.x * parameters.size.y;
          if pixel >= pixels { return; }
          let hot = parameters.regions.x;
          let at = pixel * hot;
          let position = vec3f(closed[at], closed[at + 1u], closed[at + 2u]);
          let guide = pixels * hot + parameters.regions.y * pixels + pixel;
          let normal = vec3f(closed[guide], closed[guide + pixels], closed[guide + 2u * pixels]);
          let coat = vec3f(closed[guide + 3u * pixels], closed[guide + 4u * pixels], closed[guide + 5u * pixels]);
          let delta = camera[3u].xyz - position;
          let direction = delta * inverseSqrt(dot(delta, delta));
          let half_vector = normalize(direction + vec3f(0.0, 0.0, 1.0));
          angular[pixel * 6u] = clamp(normal.z, 0.0, 1.0);
          angular[pixel * 6u + 1u] = clamp(dot(normal, direction), 0.0, 1.0);
          angular[pixel * 6u + 2u] = clamp(dot(normal, half_vector), 0.0, 1.0);
          angular[pixel * 6u + 3u] = clamp(dot(direction, half_vector), 0.0, 1.0);
          angular[pixel * 6u + 4u] = clamp(coat.z, 0.0, 1.0);
          angular[pixel * 6u + 5u] = clamp(dot(coat, half_vector), 0.0, 1.0);
        }
      `
        })
      }
    });
    let uniformReference = null;
    let productReference = null;
    let productReferenceData = null;
    let guideSigns = [1, 1, 1];
    const reports = [],
      geometryBoundaries = [];
    async function runCase(
      width,
      height,
      reuse,
      overlay,
      fixture = "baseline",
      coherenceCapacity,
      abortOnly = false,
      useAo = false
    ) {
      if (cost) console.log(`SurfaceWork cost begin ${fixture}/${reuse}/${width}x${height}`);
      runtime.setReuseEnabled(reuse);
      runtime.setOverlayCapacity(overlay);
      runtime.setCoherenceCapacity(coherenceCapacity);
      runtime.prepareFrame(width, height, 11, publication);
      const visibilityPixels = new Uint32Array(width * height).fill(0xffffffff);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width - 1; x++)
          visibilityPixels[y * width + x] =
            fixture === "empty"
              ? 0xffffffff
              : fixture === "template-stress"
                ? (y * width + x) % publication.entries.length
                : fixture === "unlit"
                  ? 1
                  : x < width / 2
                    ? 0
                    : fixture === "generic" ||
                        fixture === "resource-uniform" ||
                        fixture === "appearance-product"
                      ? 2
                      : fixture === "high-frequency"
                        ? 3
                        : fixture === "standard"
                          ? 4
                          : 1;
      const visibility = texture(width, height, "r32uint", visibilityPixels);
      const facts = texture(width, height, "rgba8unorm", new Uint8Array(width * height * 4));
      const graph = new FrameGraph("Surface B1 B2 real chain");
      const imported = (name, value) => graph.import_resource(name, { kind: "imported" }, value);
      const meta = imported("Appearance metadata", publication.surfaceMetadata),
        dummy = imported("fixture unused stable resource", exposure);
      const aoBytes = new Uint8Array(Math.ceil((width * height) / 4) * 4).fill(255);
      if (useAo)
        for (let pixel = 0; pixel < width * height; pixel++) aoBytes[pixel] = pixel % 2 === 0 ? 64 : 255;
      const ao = useAo ? imported("Actual output-pixel AO", buffer(aoBytes)) : null;
      const residentBanks = Array.from({ length: 4 }, (_, set) =>
        Array.from({ length: 9 }, (_, bank) => imported("Texture " + set + "/" + bank, banks))
      );
      const cameraResource = imported("Camera", camera);
      const appearanceValues = runtime.addPublicationToGraph(graph, {
        publication,
        metadata: meta,
        camera: cameraResource,
        textureBanks: residentBanks,
        frame: { value: 11 },
        bind: (_name, resolve) => resolve()
      });
      const factsResource =
        temporalFixture === null
          ? imported("Temporal facts", facts)
          : temporalFixture.add(graph, {
              width,
              height,
              publication,
              metadata: appearanceValues.metadata,
              camera: cameraResource,
              visibility: imported("Real Temporal visibility", visibility),
              work: imported("Real Temporal work", work),
              instances: imported("Real Temporal instances", frameInstances),
              source: imported("Real Temporal source", sourceHeap),
              vertices: imported("Real Temporal vertices", vertexPayload),
              sourceBindings: {
                meshletWordBase: GPU_GEOMETRY_RECORD_SCHEMA.stride / 4,
                vertexDataWordBase: 0
              }
            });
      const output = runtime.addToGraph(graph, {
        visibility: imported("Visibility", visibility),
        meshletWork: imported("Meshlet work", work),
        sourceHeap: imported("Geometry source", frameArena.buffer),
        vertexPayload: imported("Resident vertices", vertexPayload),
        frameInstances: imported("Instances", frameInstances),
        frameAttributes: imported("Published frame attributes", frameArena.buffer),
        camera: cameraResource,
        appearanceMetadata: appearanceValues.metadata,
        appearanceTemporary: appearanceValues.temporary,
        publication,
        product:
          productGeometry === null
            ? null
            : {
                heap: imported("Product metadata", productGeometry.heap),
                banks: productGeometry.banks.map((value, index) => imported("Product bank " + index, value))
              },
        textureBanks: residentBanks,
        lightRecords: imported("Nonzero lights", lights),
        clusters: {
          parameters: imported("Cluster parameters", clusterParameters),
          lookup: imported("Cluster lookup", clusterLookup),
          data: imported("Cluster data", clusterData),
          activeLightList: imported("Active light list", clusterList)
        },
        environment: {
          diffuse: imported("Nonzero diffuse environment", environment),
          specular: imported(
            "Specular environment",
            ["generic", "standard"].includes(fixture) ? nonzeroSpecular : black
          ),
          dfg: imported("DFG", ["generic", "standard"].includes(fixture) ? nonzeroDfg : black)
        },
        shadow: null,
        scalarAo: ao,
        physicalSun: null,
        factsMask: factsResource,
        preExposure: dummy,
        width,
        height,
        historyBinding: (_name, resolve) => resolve(),
        revisions: { environment: 1, light: 1, shadow: 1, sun: 1 },
        viewRevision: { value: 1 },
        nonlocalRevision: { value: 1 },
        diagnosticFrame: { value: 1 },
        frame: {
          generation: 11,
          sourceGeometry: 0,
          sourceMeshlet: GPU_GEOMETRY_RECORD_SCHEMA.stride / 4,
          sourceMeshletVertices: 0,
          sourceMeshletTriangles: 4,
          sourceVertexData: 0,
          geometryArenaHeader: frameArena.layout.header.offset / 4
        }
      });
      const capacity = runtime.capacityEvidence();
      const angularBuffers =
        !cost && ["generic", "standard"].includes(fixture)
          ? Array.from({ length: 4 }, (_, bank) => {
              const settings = buffer(
                new Uint32Array([
                  width,
                  capacity.bankRows,
                  0,
                  0,
                  capacity.hotWords,
                  capacity.fieldChannels,
                  0,
                  0
                ]),
                GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
              );
              const destination = buffer(
                new Float32Array(capacity.bankPixels * 6),
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
              );
              const source = output.heaps[bank];
              const destinationId = imported("Independent angular values " + bank, destination);
              const probe = graph.add("Independent angular builtins " + bank, {}, (_, resources, context) => {
                const pass = context.encoder.beginComputePass({ label: "Independent angular builtins" });
                pass.setPipeline(angularPipeline);
                pass.setBindGroup(
                  0,
                  device.createBindGroup({
                    layout: angularPipeline.getBindGroupLayout(0),
                    entries: [
                      { binding: 0, resource: { buffer: settings } },
                      { binding: 1, resource: { buffer: resources.get(source) } },
                      { binding: 2, resource: { buffer: destination } },
                      { binding: 3, resource: { buffer: camera } }
                    ]
                  })
                );
                pass.dispatchWorkgroups(Math.ceil(capacity.bankPixels / 64));
                pass.end();
              });
              probe.read(source);
              probe.read(output.signals[bank]);
              return { buffer: destination, resource: probe.write(destinationId) };
            })
          : [];
      const rowBytes = Math.ceil((width * 8) / 256) * 256;
      const signalReadOffset =
        rowBytes * height + 2048 + publication.surfaceMetadata.size + capacity.heapBytes * 4;
      const controlReadOffset = signalReadOffset + (cost ? 0 : capacity.signalBytes * 4);
      const codeReadOffset = controlReadOffset + (cost ? 0 : capacity.controlBytes);
      const angularReadOffset = codeReadOffset + publication.exactDagCode.size;
      const angularReadBytes = angularBuffers.length * capacity.bankPixels * 6 * 4;
      const temporalReadOffset = angularReadOffset + angularReadBytes;
      const readback = device.createBuffer({
        size: cost
          ? rowBytes * height + 2048 + publication.surfaceMetadata.size
          : temporalReadOffset + (temporalFixture !== null ? rowBytes * height : 0),
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
      });
      retained.push(readback);
      const read = graph.add("Independent Surface output readback", {}, (_, resources, context) => {
        const radiance = resources.get(output.radiance);
        context.encoder.gpu_encoder.copyTextureToBuffer(
          { texture: radiance.isGPUTextureContext ? radiance.gpu_texture : radiance },
          { buffer: readback, bytesPerRow: rowBytes },
          { width, height }
        );
        context.encoder.gpu_encoder.copyBufferToBuffer(
          resources.get(output.control),
          0,
          readback,
          rowBytes * height,
          2048
        );
        context.encoder.gpu_encoder.copyBufferToBuffer(
          resources.get(output.metadata),
          0,
          readback,
          rowBytes * height + 2048,
          publication.surfaceMetadata.size
        );
        if (!cost)
          for (let bank = 0; bank < 4; bank++)
            context.encoder.gpu_encoder.copyBufferToBuffer(
              resources.get(output.heaps[bank]),
              0,
              readback,
              rowBytes * height + 2048 + publication.surfaceMetadata.size + bank * capacity.heapBytes,
              capacity.heapBytes
            );
        if (!cost) {
          if (temporalFixture !== null) {
            const reactive = resources.get(output.reactiveMask);
            context.encoder.gpu_encoder.copyTextureToBuffer(
              { texture: reactive.isGPUTextureContext ? reactive.gpu_texture : reactive },
              { buffer: readback, offset: temporalReadOffset, bytesPerRow: rowBytes },
              { width, height }
            );
          }
          for (let bank = 0; bank < 4; bank++)
            context.encoder.gpu_encoder.copyBufferToBuffer(
              resources.get(output.signals[bank]),
              0,
              readback,
              signalReadOffset + bank * capacity.signalBytes,
              capacity.signalBytes
            );
          context.encoder.gpu_encoder.copyBufferToBuffer(
            resources.get(output.control),
            0,
            readback,
            controlReadOffset,
            capacity.controlBytes
          );
          context.encoder.gpu_encoder.copyBufferToBuffer(
            publication.exactDagCode,
            0,
            readback,
            codeReadOffset,
            publication.exactDagCode.size
          );
          angularBuffers.forEach((value, bank) =>
            context.encoder.gpu_encoder.copyBufferToBuffer(
              resources.get(value.resource),
              0,
              readback,
              angularReadOffset + bank * capacity.bankPixels * 6 * 4,
              value.buffer.size
            )
          );
        }
      });
      read.read(output.radiance);
      read.read(output.control);
      read.read(output.metadata);
      if (temporalFixture !== null) read.read(output.reactiveMask);
      output.heaps.forEach((heap) => read.read(heap));
      read.make_side_effect();
      output.signals.forEach((signal) => read.read(signal));
      angularBuffers.forEach((value) => read.read(value.resource));
      const commandCount = graph.compile().dump().executablePassOrder.length;
      const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
      const nativeCommands = observeNativeCommands(command.gpu_encoder);
      publication.syncRuntime(command);
      const gpuResults = cost
        ? new Promise((resolve, reject) => command.enable_debug_timers(resolve, reject))
        : null;
      const started = performance.now();
      command.encodeGraph(graph);
      if (abortOnly) {
        command.abort(new Error("fixture-controlled unsubmitted frame abort"));
        runtime.abort();
        temporalFixture?.abort();
        readback.destroy();
        visibility.destroy();
        facts.destroy();
        return null;
      }
      command.finish();
      runtime.commit(command.gpuDone, 11);
      temporalFixture?.commit(command.gpuDone);
      await command.gpuDone;
      const submitAndCompleteMs = performance.now() - started;
      const gpuPasses =
        gpuResults === null
          ? null
          : (await gpuResults)
              .filter((result) => result.scope === "pass")
              .map(({ label, duration_ms }) => ({ label, ms: duration_ms }));
      timings.push({ fixture, width, height, reuse, overlay, submitAndCompleteMs, gpuPasses });
      if (cost) console.log("SurfaceWork cost GPU " + JSON.stringify(timings.at(-1)));
      await readback.mapAsync(GPUMapMode.READ);
      const copy = readback.getMappedRange().slice(0);
      readback.unmap();
      readback.destroy();
      const pixels = new Uint16Array(copy, 0, (rowBytes * height) / 2);
      const counters = Array.from(new Uint32Array(copy, rowBytes * height, 512));
      const palette = Array.from(
        new Uint32Array(
          copy,
          rowBytes * height + 2048 + publication.surfaceMetadataOffsets.constantFields * 4,
          128
        )
      );
      const heap = cost
        ? null
        : new Uint32Array(
            copy,
            rowBytes * height + 2048 + publication.surfaceMetadata.size,
            capacity.heapBytes
          );
      if (!cost) {
        failureSnapshot = () => {
          const metadata = new Uint32Array(
            copy,
            rowBytes * height + 2048,
            publication.surfaceMetadata.size / 4
          );
          const code = new Uint32Array(copy, codeReadOffset, publication.exactDagCode.size / 4);
          const metadataFloat = new Float32Array(metadata.buffer, metadata.byteOffset, metadata.length);
          return {
            fixture,
            width,
            height,
            reuse,
            overlay,
            coherenceCapacity,
            commandCount,
            inputs: { lookupUV: Array.from(extraMaterials[0].appearance_inputs.get("lookupUV") ?? []) },
            counters,
            entries: publication.entries.map((entry, index) => {
              const plan = code[index * 16 + 2];
              const base = code[plan + 4];
              return {
                index,
                header: Array.from(code.slice(index * 16, index * 16 + 16)),
                plan: Array.from(code.slice(plan, plan + 8)),
                dirty: metadata[code[code[plan + 7] + 2]],
                paletteHeader: Array.from(
                  metadata.slice(
                    publication.surfaceMetadataOffsets.constantFields + index * 64,
                    publication.surfaceMetadataOffsets.constantFields + index * 64 + 4
                  )
                ),
                uniformValues: Array.from(metadataFloat.slice(base, base + code[plan + 2])),
                constants: Array.from(
                  metadataFloat.slice(
                    publication.surfaceMetadataOffsets.constants + entry.constantBase,
                    publication.surfaceMetadataOffsets.constants +
                      entry.constantBase +
                      entry.lowered.constants.length
                  )
                ),
                palette: Array.from(
                  metadataFloat.slice(
                    publication.surfaceMetadataOffsets.constantFields + index * 64 + 4,
                    publication.surfaceMetadataOffsets.constantFields + index * 64 + 64
                  )
                )
              };
            }),
            samples: [
              [0, 0],
              [Math.floor(width * 0.75), Math.floor(height / 2)]
            ].map(([x, y]) => {
              const bank = Math.floor(y / capacity.bankRows);
              const pixel = (y % capacity.bankRows) * width + x;
              const words = new Uint32Array(
                copy,
                rowBytes * height + 2048 + publication.surfaceMetadata.size + bank * capacity.heapBytes,
                capacity.heapBytes / 4
              );
              const floats = new Float32Array(words.buffer, words.byteOffset, words.length);
              const signalWords = new Uint32Array(
                copy,
                signalReadOffset + bank * capacity.signalBytes,
                capacity.signalBytes / 4
              );
              const signalFloats = new Float32Array(
                signalWords.buffer,
                signalWords.byteOffset,
                signalWords.length
              );
              return {
                x,
                y,
                bank,
                entry: words[pixel * capacity.hotWords + capacity.hotWords - 1],
                geometry: Array.from(
                  floats.slice(pixel * capacity.hotWords, (pixel + 1) * capacity.hotWords)
                ),
                fields: Array.from(
                  { length: capacity.fieldChannels + capacity.guideChannels },
                  (_, field) =>
                    floats[capacity.bankPixels * capacity.hotWords + field * capacity.bankPixels + pixel]
                ),
                signals: Array.from(
                  { length: 18 },
                  (_, channel) => signalFloats[channel * capacity.bankPixels + pixel]
                ),
                signalState: signalWords[18 * capacity.bankPixels + pixel],
                hdr: Array.from(
                  pixels.slice((y * rowBytes) / 2 + x * 4, (y * rowBytes) / 2 + x * 4 + 4),
                  decodeFloat16
                )
              };
            }),
            radiometry: Array.from(
              metadataFloat.slice(
                publication.surfaceMetadataOffsets.radiometry,
                publication.surfaceMetadataOffsets.radiometry + 5
              )
            )
          };
        };
      }
      if (!cost) {
        const actualControl = new Uint32Array(copy, controlReadOffset, capacity.controlBytes / 4);
        const actualCode = new Uint32Array(copy, codeReadOffset, publication.exactDagCode.size / 4);
        const expectedBins = Array.from({ length: 16 }, () => new Map());
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width - 1; x++) {
            const slot = visibilityPixels[y * width + x];
            if (slot === 0xffffffff) continue;
            const entry = publication.entries.findIndex((value) => value.materialSlot === slot);
            check(entry >= 0, "fixture winner has an independently known material snapshot");
            if ((actualCode[entry * 16 + 13] & 0x80000000) !== 0) continue;
            const bank = Math.floor(y / capacity.bankRows);
            const bin = bank * 4 + publication.entries[entry].textureBindingSetId;
            const template = actualCode[actualCode[entry * 16 + 2] + 3];
            if (!expectedBins[bin].has(template)) expectedBins[bin].set(template, new Set());
            expectedBins[bin].get(template).add((y % capacity.bankRows) * width + x);
          }
        for (let bin = 0; bin < 16; bin++) {
          const config = actualControl.slice(384 + bin * 8, 384 + bin * 8 + 8);
          if (config[5] !== 2) continue;
          let padded = 0;
          for (let template = 0; template < config[3]; template++) {
            const count = actualControl[config[0] + template * 3];
            const start = actualControl[config[0] + template * 3 + 1];
            const expected = new Set(expectedBins[bin].get(template) ?? []);
            check(
              count === expected.size && start === padded,
              "actual histogram and exclusive prefix match complete independently enumerated work"
            );
            const length = Math.ceil(count / 64) * 64;
            for (let lane = 0; lane < length; lane++) {
              const pixel = actualControl[config[1] + start + lane];
              if (lane < count) {
                check(
                  expected.delete(pixel),
                  "each coherent packet contains only its own template, original address, exactly once"
                );
              } else {
                check(pixel === 0xffffffff, "padded packet lanes have explicit invalid payloads");
              }
            }
            check(expected.size === 0, "coherent runs preserve every complete original work item");
            padded += length;
          }
          check(padded === config[4], "published actual packet count includes every tail exactly once");
        }
      }
      check(counters[228] === 0, "every valid visible source must complete geometry");
      check(
        counters[233] === (fixture === "empty" ? 0 : width - 1) * height &&
          counters[234] === (fixture === "empty" ? width * height : height),
        "covered/background complete exclusive write set"
      );
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const at = (y * rowBytes) / 2 + x * 4;
          check(
            pixels[at + 3] === (fixture === "empty" || x === width - 1 ? 0 : 0x3c00),
            "output alpha independently matches complete coverage"
          );
          // This selector measures the full 1080p work domain and checks every
          // alpha destination. Numerical field closure remains the small oracle;
          // sample HDR across every bank without millions of CPU DAG evaluations.
          if (cost && (x % 127 !== 0 || y % 47 !== 0)) continue;
          if (x < width - 1 && fixture === "template-stress") {
            const template = (y * width + x) % publication.entries.length;
            let value = Math.fround((x + 0.5) / width);
            for (let operation = 0; operation <= template; operation++) value = Math.fround(Math.sin(value));
            value = Math.fround(Math.fround(value * Math.fround(0.7)) + Math.fround(0.35));
            const expected = workingColor([value, value, value]);
            for (let channel = 0; channel < 3; channel++) {
              check(
                Math.abs(decodeFloat16(pixels[at + channel]) - expected[channel]) <= 0.002,
                "independent full template tape output including long-tail work"
              );
            }
          }
          if (!cost && x >= width / 2 && x < width - 1 && ["generic", "standard"].includes(fixture)) {
            const bank = Math.floor(y / capacity.bankRows),
              local = (y % capacity.bankRows) * width + x;
            const words = new Uint32Array(
              copy,
              rowBytes * height + 2048 + publication.surfaceMetadata.size + bank * capacity.heapBytes,
              capacity.heapBytes / 4
            );
            const floats = new Float32Array(words.buffer, words.byteOffset, words.length);
            const metadata = new Uint32Array(
              copy,
              rowBytes * height + 2048,
              publication.surfaceMetadata.size / 4
            );
            const entry = fixture === "generic" ? 2 : 4;
            const paletteAt = publication.surfaceMetadataOffsets.constantFields + entry * 64;
            const fields = {};
            for (let field = 0; field < 15; field++) {
              if ([1, 6, 12, 13, 14].includes(field)) continue;
              const width = [0, 5, 9].includes(field) ? 3 : 1;
              fields[APPEARANCE_FIELD_NAMES[field]] = Array.from({ length: width }, (_, channel) =>
                (metadata[paletteAt] & (1 << field)) !== 0
                  ? new Float32Array(metadata.buffer, metadata.byteOffset)[
                      paletteAt + 4 + field * 4 + channel
                    ]
                  : floats[
                      capacity.bankPixels * capacity.hotWords +
                        (publication.exactDagFieldOffsetValues[field] + channel) * capacity.bankPixels +
                        local
                    ]
              );
            }
            const guide = (coat) =>
              Array.from(
                { length: 3 },
                (_, channel) =>
                  floats[
                    capacity.bankPixels * capacity.hotWords +
                      (capacity.fieldChannels + (coat ? 3 : 0) + channel) * capacity.bankPixels +
                      local
                  ]
              );
            const signals = independentSignals(
              fields,
              guide(false),
              Array.from(
                new Float32Array(
                  copy,
                  angularReadOffset + bank * capacity.bankPixels * 6 * 4 + local * 6 * 4,
                  6
                )
              )
            );
            const actualControl = new Uint32Array(copy, controlReadOffset, capacity.controlBytes / 4);
            const signalWords = new Uint32Array(
              copy,
              signalReadOffset + bank * capacity.signalBytes,
              capacity.signalBytes / 4
            );
            const signalFloats = new Float32Array(
              signalWords.buffer,
              signalWords.byteOffset,
              signalWords.length
            );
            const tile = Math.floor((y % capacity.bankRows) / 8) * capacity.tilesX + Math.floor(x / 8);
            const quad = Math.floor((y % 8) / 2) * 4 + Math.floor((x % 8) / 2);
            for (let kind = 0; kind < 6; kind++) {
              const recipe =
                actualControl[
                  capacity.recipeBase + (bank * capacity.bankTiles + tile) * 4 + Math.floor(kind / 2)
                ];
              const shared = (recipe & (1 << (quad + (kind % 2) * 16))) !== 0;
              const owner = shared ? (y % capacity.bankRows & ~1) * width + (x & ~1) : local;
              check(
                (signalWords[18 * capacity.bankPixels + owner] & (1 << kind)) !== 0,
                "the actual authoritative RGB writer publishes its kind validity"
              );
              for (let channel = 0; channel < 3; channel++) {
                const actual = signalFloats[(kind * 3 + channel) * capacity.bankPixels + owner];
                const expected = signals[kind][channel];
                check(
                  Math.abs(actual - expected) <= Math.abs(expected) * 1e-4 + 1e-5,
                  "independent six-signal BRDF/IBL mismatch " +
                    JSON.stringify({ fixture, x, y, kind, channel, actual, expected })
                );
              }
            }
          }
          if (
            x < width - 1 &&
            fixture !== "empty" &&
            fixture !== "template-stress" &&
            (fixture === "baseline" || fixture === "unlit" || x < width / 2)
          ) {
            const expected =
              fixture !== "unlit" && x < width / 2
                ? independentLit(
                    x,
                    y,
                    width,
                    height,
                    material.ior_factor,
                    useAo ? aoBytes[y * width + x] / 255 : 1,
                    cameraValues.slice(12, 15),
                    ["generic", "standard"].includes(fixture)
                  )
                : workingColor([0.13, 0.22, 0.31]);
            for (let channel = 0; channel < 3; channel++) {
              const actual = decodeFloat16(pixels[at + channel]);
              // rgba16float final-store rounding plus independent double/f32
              // BRDF arithmetic. No production evaluator supplies the expectation.
              check(
                Math.abs(actual - expected[channel]) <= Math.abs(expected[channel]) / 1024 + 2e-5,
                "independent Lighting/PBR/radiometry mismatch " +
                  JSON.stringify({ x, y, channel, actual, expected: expected[channel] })
              );
            }
            if (!cost && fixture === "baseline" && x < width / 2) {
              const bank = Math.floor(y / capacity.bankRows),
                local = (y % capacity.bankRows) * width + x;
              const state = new Uint32Array(
                copy,
                signalReadOffset + bank * capacity.signalBytes,
                capacity.signalBytes / 4
              )[18 * capacity.bankPixels + local];
              if (!reuse)
                check((state & 63) === 63, "exact baseline publishes all six independent validity bits");
              check(
                ((state & 256) !== 0) === material.ior_factor <= 131072,
                "transport state follows the complete raw IOR numeric guard"
              );
              check(
                ((state & 512) !== 0) === material.ior_factor > 131072,
                "unsafe raw IOR retains explicit colored residual semantics"
              );
            }
          }
          if (
            !cost &&
            x >= width / 2 &&
            x < width - 1 &&
            ["generic", "high-frequency", "standard", "resource-uniform", "appearance-product"].includes(
              fixture
            )
          ) {
            const bank = Math.floor(y / capacity.bankRows),
              local = (y % capacity.bankRows) * width + x;
            const program =
              fixture === "appearance-product"
                ? productReference
                : fixture === "resource-uniform"
                  ? uniformReference
                  : fixture === "generic"
                    ? genericReference
                    : fixture === "standard"
                      ? fixedStandard
                      : highFrequency;
            const inputs = {
              cameraPosition: Array.from(cameraValues.slice(12, 15)),
              vertexColor: [1, 1, 1],
              uv0: [(x + 0.5) / width, 1 - (y + 0.5) / height],
              uv1: [1 - (x + 0.5) / width, (1 - (y + 0.5) / height) * 0.5 + 0.125],
              uv2: [((x + 0.5) / width) * 0.5 + 0.1, (1 - (y + 0.5) / height) * 0.5 + 0.2]
            };
            const currentProgram =
              fixture === "generic"
                ? {
                    ...program,
                    instructions: program.instructions.map((node) =>
                      node.parameter === "phase"
                        ? { ...node, value: extraMaterials[0].appearance_inputs.get("phase")?.[0] ?? 0 }
                        : node
                    )
                  }
                : fixture === "standard"
                  ? {
                      ...program,
                      instructions: program.instructions.map((node) =>
                        node.parameter === "coat weight" ? { ...node, value: coated.clearcoat_factor } : node
                      )
                    }
                  : fixture === "resource-uniform"
                    ? {
                        ...program,
                        instructions: program.instructions.map((node) =>
                          node.parameter === "lookupUV"
                            ? {
                                ...node,
                                value:
                                  extraMaterials[0].appearance_inputs.get("lookupUV")?.[node.channel] ??
                                  node.value
                              }
                            : node
                        )
                      }
                    : program;
            const expected = evaluateCompiledAppearance(currentProgram, {
              inputs,
              sample: sampleResident,
              sampleProduct: (index, uv) =>
                sampleAppearanceCookedField(
                  productReferenceData.fields[currentProgram.productReads[index].field.name],
                  ...uv,
                  0
                )
            });
            const allMetadata = new Uint32Array(
                copy,
                rowBytes * height + 2048,
                publication.surfaceMetadata.size / 4
              ),
              metadataFloats = new Float32Array(
                allMetadata.buffer,
                allMetadata.byteOffset,
                allMetadata.length
              );
            for (let field = 0; field < 15; field++) {
              const wanted = expected[APPEARANCE_FIELD_NAMES[field]];
              if (!wanted) continue;
              if (
                publication.exactDagFieldOffsetValues[field] === 0xffffffff &&
                (field === 1 || field === 6 || field === 12 || field === 13 || field === 14)
              ) {
                // Production exports world-space guides rather than raw TS values.
                // Complete raw outputs remain covered by the standalone tape oracle.
                if (field === 6 || field === 12) {
                  const normalized = wanted.map(
                    (value, channel) => (guideSigns[channel] * value) / Math.hypot(...wanted)
                  );
                  const at =
                    (bank * capacity.heapBytes) / 4 +
                    capacity.bankPixels * capacity.hotWords +
                    (capacity.fieldChannels + (field === 12 ? 3 : 0)) * capacity.bankPixels +
                    local;
                  for (let component = 0; component < 3; component++) {
                    const guide = new Float32Array(heap.buffer, heap.byteOffset, heap.length)[
                      at + component * capacity.bankPixels
                    ];
                    check(
                      Math.abs(guide - normalized[component]) <= 0.003,
                      "independent producer-local TS→world guide mismatch " +
                        JSON.stringify({
                          fixture,
                          x,
                          y,
                          field,
                          component,
                          guide,
                          expected: normalized[component]
                        })
                    );
                  }
                }
                continue;
              }
              const entry = ["generic", "resource-uniform", "appearance-product"].includes(fixture)
                  ? 2
                  : fixture === "standard"
                    ? 4
                    : 3,
                paletteAt = publication.surfaceMetadataOffsets.constantFields + entry * 64;
              for (let channel = 0; channel < wanted.length; channel++) {
                const address =
                  (allMetadata[paletteAt] & (1 << field)) !== 0
                    ? null
                    : (bank * capacity.heapBytes) / 4 +
                      capacity.bankPixels * capacity.hotWords +
                      (publication.exactDagFieldOffsetValues[field] + channel) * capacity.bankPixels +
                      local;
                const actual =
                  address === null
                    ? metadataFloats[paletteAt + 4 + field * 4 + channel]
                    : new Float32Array(heap.buffer, heap.byteOffset, heap.length)[address];
                const bound =
                  fixture === "appearance-product" ? 1e-4 : fixture === "high-frequency" ? 2e-5 : 0.003;
                check(
                  Math.abs(actual - wanted[channel]) <= bound,
                  "independent complete Appearance field mismatch " +
                    JSON.stringify({
                      fixture,
                      x,
                      y,
                      field,
                      channel,
                      actual,
                      expected: wanted[channel],
                      parameters: Object.fromEntries(
                        Object.entries(publication.entries[entry].lowered.parameterSlots).map(
                          ([name, slots]) => [
                            name,
                            slots.map(
                              (slot) =>
                                metadataFloats[
                                  publication.surfaceMetadataOffsets.constants +
                                    publication.entries[entry].constantBase +
                                    slot.slot
                                ]
                            )
                          ]
                        )
                      ),
                      versions: Array.from(
                        allMetadata.slice(
                          publication.surfaceMetadataOffsets.valueVersions,
                          publication.surfaceMetadataOffsets.valueVersions + publication.entries.length * 2
                        )
                      ),
                      queries: publication.requiresUniformResources
                        ? Array.from(
                            allMetadata.slice(
                              publication.uniformQueryStatsBase,
                              publication.uniformQueryStatsBase + publication.entries.length * 2
                            )
                          )
                        : []
                    })
                );
              }
            }
          }
          if (x < width - 1 && fixture !== "empty" && !(pixels[at] > 0 && pixels[at] < 0x7c00))
            throw new Error(
              "nonzero finite real radiance " +
                JSON.stringify({
                  x,
                  y,
                  words: Array.from(pixels.slice(at, at + 4)),
                  palette,
                  active: counters.slice(32, 36),
                  diagnostic: counters.slice(224, 294)
                })
            );
        }
      reports.push({
        temporalSample:
          temporalFixture === null
            ? null
            : Array.from(
                new Uint8Array(
                  copy,
                  temporalReadOffset + Math.floor(height / 2) * rowBytes + Math.floor(width * 0.75) * 4,
                  4
                )
              ),
        valueVersions: Array.from(
          new Uint32Array(
            copy,
            rowBytes * height + 2048 + publication.surfaceMetadataOffsets.valueVersions * 4,
            publication.entries.length * 2
          )
        ),
        uniformQueries: publication.requiresUniformResources
          ? Array.from(
              new Uint32Array(
                copy,
                rowBytes * height + 2048 + publication.uniformQueryStatsBase * 4,
                publication.entries.length * 2
              )
            )
          : [],
        width,
        height,
        reuse,
        overlay,
        fixture,
        coherenceCapacity,
        commandCount,
        nativeCommands,
        coherence: Array.from({ length: 16 }, (_, bin) => counters.slice(384 + bin * 8, 384 + bin * 8 + 8)),
        counters: {
          visible: counters[224],
          geometry: counters[229],
          setups: counters[244],
          material: counters[230],
          quads: counters[231],
          promoted: counters[232],
          covered: counters[233],
          background: counters[234],
          envDiffuse: counters[259],
          directLightLoops: counters[264],
          packetWrites: counters.slice(276, 282),
          sampleTextureQueries: counters[300],
          sampleProductQueries: counters[301],
          uniformScalarReads: counters[302]
        },
        capacity
      });
      check(
        counters[264] === counters[276],
        "real directional provider executes once for each authoritative direct sample"
      );
      visibility.destroy();
      facts.destroy();
      angularBuffers.forEach((value) => value.buffer.destroy());
      return pixels;
    }
    if (cost) {
      let genericPixels;
      const fixedPixels = new Map();
      const fixtures =
        nativeReference || channelReference
          ? ["generic"]
          : fixedScratchReference
            ? ["baseline", "standard"]
            : ["baseline", "standard", "generic"];
      for (const fixture of fixtures) {
        for (const reuse of residentSamplerReference || channelReference ? [false] : [false, true]) {
          const exact = await runCase(1920, 1080, reuse, null, fixture);
          const repeated = await runCase(1920, 1080, reuse, null, fixture);
          check(
            exact.every((value, index) => value === repeated[index]),
            "full-resolution output remains identical across repeat execution"
          );
          if (fixture === "generic" && !reuse) genericPixels = repeated;
          if ((fixedScratchReference || residentSamplerReference || channelReference) && !reuse)
            fixedPixels.set(fixture, repeated);
        }
      }
      if (channelReference) {
        const originalWorkPipeline = publication.workPipeline;
        const original = publication.workPipeline(false, false);
        const module = device.createShaderModule({
          label: "Surface/isolated retired full channel gather",
          code: fullChannelGatherCostReference(surfaceWorkAppearanceWgsl(false, false))
        });
        const info = await module.getCompilationInfo();
        check(!info.messages.some((message) => message.type === "error"), JSON.stringify(info.messages));
        const pipeline = await device.createComputePipelineAsync({
          label: "Surface/isolated retired full channel gather",
          layout: device.createPipelineLayout({
            bindGroupLayouts: [0, 1, 2].map((index) => original.pipeline.getBindGroupLayout(index))
          }),
          compute: { module, entryPoint: "appearance" }
        });
        try {
          publication.workPipeline = function (product, common) {
            return !product && !common
              ? { ...original, pipeline }
              : originalWorkPipeline.call(this, product, common);
          };
          for (let repeat = 0; repeat < 2; repeat++) {
            const result = await runCase(1920, 1080, false, null, "generic");
            const mismatch = result.findIndex((value, index) => value !== fixedPixels.get("generic")[index]);
            check(mismatch < 0, "scalar channel access preserves every full HDR word " + mismatch);
            timings.at(-1).implementation = "isolated retired four-component channel gather, not production";
          }
        } finally {
          publication.workPipeline = originalWorkPipeline;
        }
      }
      if (residentSamplerReference) {
        check(
          publicationSources.every((source) =>
            source.program.samples.every((sample) =>
              sample.binding.sampler.every((value, index) => value === [1, 1, 1, 1, 1, 1, 1, 2, 1][index])
            )
          ),
          "resident reference must prove all immutable sampler semantics are linear/repeat"
        );
        const originalWorkPipeline = publication.workPipeline;
        const selected = new Map();
        for (const common of [false, true]) {
          const original = publication.workPipeline(false, common);
          const module = device.createShaderModule({
            label: "Surface/isolated single resident sampler " + common,
            code: residentSamplerCostReference(surfaceWorkAppearanceWgsl(false, common), 2)
          });
          const info = await module.getCompilationInfo();
          check(!info.messages.some((message) => message.type === "error"), JSON.stringify(info.messages));
          const pipeline = await device.createComputePipelineAsync({
            label: "Surface/isolated single resident sampler " + common,
            layout: device.createPipelineLayout({
              bindGroupLayouts: [0, 1, 2].map((index) => original.pipeline.getBindGroupLayout(index))
            }),
            compute: { module, entryPoint: "appearance" }
          });
          selected.set(common, { ...original, pipeline });
        }
        try {
          publication.workPipeline = function (product, common) {
            return !product ? selected.get(common) : originalWorkPipeline.call(this, product, common);
          };
          for (const fixture of fixtures) {
            for (let repeat = 0; repeat < 2; repeat++) {
              const result = await runCase(1920, 1080, false, null, fixture);
              const mismatch = result.findIndex((value, index) => value !== fixedPixels.get(fixture)[index]);
              check(
                mismatch < 0,
                "resident sampler specialization preserves every HDR word " +
                  JSON.stringify({ fixture, mismatch })
              );
              timings.at(-1).implementation =
                "isolated proven linear-repeat sampler reference, not production";
            }
          }
        } finally {
          publication.workPipeline = originalWorkPipeline;
        }
      }
      if (fixedScratchReference) {
        const originalWorkPipeline = publication.workPipeline;
        const fixedPipeline = publication.workPipeline(false, true);
        const module = device.createShaderModule({
          label: "Surface/isolated fixed private sample reference",
          code: fixedPrivateScratchReference(surfaceWorkAppearanceWgsl(false, true))
        });
        const info = await module.getCompilationInfo();
        check(!info.messages.some((message) => message.type === "error"), JSON.stringify(info.messages));
        const pipeline = await device.createComputePipelineAsync({
          label: "Surface/isolated fixed private sample reference",
          layout: device.createPipelineLayout({
            bindGroupLayouts: [0, 1, 2].map((index) => fixedPipeline.pipeline.getBindGroupLayout(index))
          }),
          compute: { module, entryPoint: "appearance" }
        });
        try {
          publication.workPipeline = function (product, common) {
            return !product && common
              ? { ...fixedPipeline, pipeline }
              : originalWorkPipeline.call(this, product, common);
          };
          for (const fixture of fixtures) {
            for (let repeat = 0; repeat < 2; repeat++) {
              const result = await runCase(1920, 1080, false, null, fixture);
              const mismatch = result.findIndex((value, index) => value !== fixedPixels.get(fixture)[index]);
              check(
                mismatch < 0,
                "fixed scratch candidate preserves every complete HDR word " +
                  JSON.stringify({ fixture, mismatch })
              );
              timings.at(-1).implementation = "isolated named-private sample reference, not production";
            }
          }
        } finally {
          publication.workPipeline = originalWorkPipeline;
        }
      }
      if (nativeReference) {
        const originalWorkPipeline = publication.workPipeline;
        const genericPipeline = publication.workPipeline(false, false);
        let source = surfaceWorkAppearanceWgsl(false, false).replace(
          APPEARANCE_EXACT_DAG_WGSL,
          straightLineCostReference(generic)
        );
        check(
          generic.samples.every((sample) =>
            sample.binding.sampler.every((value, index) => value === [1, 1, 1, 1, 1, 1, 1, 2, 1][index])
          ),
          "native reference specializes only this fixture's linear/repeat resource profile"
        );
        // Fully expanding nine banks × six samplers at every straight-line
        // sample call explodes backend compilation. This fixture has one actual
        // bank and sampler; retain its route, mip clamping and transformed Grad.
        const samplerBegin = source.indexOf("fn dag_sample_resident("),
          samplerEnd = source.indexOf("fn dag_transform_uv(");
        check(
          samplerBegin >= 0 && samplerEnd > samplerBegin,
          "reference requires the original resident sampler boundary"
        );
        source =
          source.slice(0, samplerBegin) +
          `fn dag_sample_resident(route: vec2u, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
        return oengine_sample_texture_clamped(dag_texture_0, dag_sampler_2, route.x, route.y, uv, i32(oengine_texture_ref_layer(route.x)), dx, dy);
      }\n` +
          source.slice(samplerEnd);
        check(
          !source.includes("for (var index = 0u; index < count; index++)"),
          "cost reference removes the interpreter, retaining the complete fixture"
        );
        const module = device.createShaderModule({
          label: "Surface/isolated native Generic cost reference",
          code: source
        });
        console.log(`SurfaceWork native reference compilation info; ${source.length} characters`);
        const info = await module.getCompilationInfo();
        check(
          info.messages.every((message) => message.type !== "error"),
          JSON.stringify(info.messages)
        );
        console.log("SurfaceWork native reference pipeline compilation");
        const nativePipeline = await device.createComputePipelineAsync({
          label: "Surface/isolated native Generic cost reference",
          layout: device.createPipelineLayout({
            bindGroupLayouts: [0, 1, 2].map((index) => genericPipeline.pipeline.getBindGroupLayout(index))
          }),
          compute: { module, entryPoint: "appearance" }
        });
        try {
          publication.workPipeline = function (product, common) {
            return common
              ? originalWorkPipeline.call(this, product, common)
              : { ...genericPipeline, pipeline: nativePipeline };
          };
          for (let repeat = 0; repeat < 2; repeat++) {
            const nativePixels = await runCase(1920, 1080, false, null, "generic");
            const mismatch = nativePixels.findIndex((value, index) => value !== genericPixels[index]);
            check(
              mismatch < 0,
              "complete straight-line reference and interpreter must produce identical HDR destinations " +
                JSON.stringify({ mismatch, native: nativePixels[mismatch], generic: genericPixels[mismatch] })
            );
            timings.at(-1).implementation = "isolated straight-line reference, not production";
          }
        } finally {
          publication.workPipeline = originalWorkPipeline;
        }
      }
      const shapes = new Map();
      for (const report of reports.slice(1)) {
        const shape = JSON.stringify([
          report.nativeCommands.dispatch,
          report.nativeCommands.dispatchIndirect
        ]);
        const previous = shapes.get(report.reuse);
        check(
          previous === undefined || previous === shape,
          "actual native dispatch topology is stable within each reuse mode, including the native reference"
        );
        shapes.set(report.reuse, shape);
      }
      if (shapes.has(false) && shapes.has(true)) {
        const exactShape = JSON.parse(shapes.get(false));
        const reusedShape = JSON.parse(shapes.get(true));
        check(
          exactShape[0] === reusedShape[0] && reusedShape[1] === exactShape[1] + 4,
          "reuse OFF removes the four bank rate dispatches without altering other production topology"
        );
      }
      check(apiErrors.length === 0, JSON.stringify(apiErrors));
      return {
        passed: true,
        scope: "1080p full-domain cost diagnostic; small Surface oracle owns full numerical closure",
        reports,
        timings,
        apiErrors
      };
    }
    const exact = await runCase(25, 9, false, null);
    const shared = await runCase(25, 9, true, null);
    check(
      exact.every((word, index) => word === shared[index]),
      "reuse OFF/ON exact normal equality yields identical outputs"
    );
    check(
      reports[0].counters.setups === reports[0].counters.geometry &&
        reports[1].counters.setups === reports[1].counters.geometry,
      "each current pixel record has one direct setup; rejected optional setup-sharing is absent"
    );
    check(
      reports[1].counters.quads > 0 && reports[1].counters.envDiffuse < reports[0].counters.envDiffuse,
      "ordinary legal coarse success must save actual sampling"
    );
    material.ior_factor = 131073;
    await runCase(25, 9, false, null);
    material.ior_factor = 1.5;
    cameraValues.set([1e10, 1e10, 1e10], 12);
    device.queue.writeBuffer(camera, 0, cameraValues);
    const farExact = await runCase(25, 9, false, null);
    const farShared = await runCase(25, 9, true, null);
    check(
      farExact.every((word, index) => word === farShared[index]),
      "all six kinds preserve bit-identical HDR at equal view/material/provider dependencies"
    );
    const sixFine = reports.at(-2).counters.packetWrites;
    const sixCoarse = reports.at(-1).counters.packetWrites;
    check(
      sixCoarse.every((count, kind) => count > 0 && count < sixFine[kind]),
      "each kind has a legal actual coarse success, including complete direct/specular/coat closures"
    );
    cameraValues.set([0, 0, 100], 12);
    device.queue.writeBuffer(camera, 0, cameraValues);
    const withAo = await runCase(25, 9, true, null, "baseline", undefined, false, true);
    check(
      withAo.some((value, index) => value !== exact[index]),
      "output-pixel AO affects only its existing environment-diffuse scope"
    );
    const exhausted = await runCase(25, 9, true, 0);
    check(
      exact.every((word, index) => word === exhausted[index]),
      "zero optional capacity keeps exact mandatory output"
    );
    check(
      reports.at(-1).counters.promoted > 0 && reports.at(-1).counters.quads === 0,
      "zero capacity actually promotes complete tiles before writes"
    );
    await runCase(33, 17, true, 1);
    const genericExact = await runCase(33, 17, false, null, "generic");
    const genericShared = await runCase(33, 17, true, null, "generic");
    check(
      genericExact.every((value, index) => value === genericShared[index]),
      "generic family reuse OFF/ON preserves exact consumer output"
    );
    const genericIndexed = await runCase(33, 17, false, null, "generic", 0);
    check(
      genericExact.every((value, index) => value === genericIndexed[index]),
      "coherence OFF retains complete original queue and identical HDR"
    );
    const genericExhausted = await runCase(33, 17, false, null, "generic", 1);
    check(
      genericExact.every((value, index) => value === genericExhausted[index]),
      "tiny packet capacity promotes to complete indexed work before writes"
    );
    check(
      reports.at(-1).capacity.coherenceCapacity === 0,
      "already coherent resource partitions allocate no sorting pool"
    );
    extraMaterials[0].appearance_inputs.set("phase", [0.375]);
    await runCase(33, 17, false, null, "generic", undefined, true);
    const uniformUpdated = await runCase(33, 17, false, null, "generic");
    check(
      uniformUpdated.some((value, index) => value !== genericExact[index]),
      "zero→nonzero internal uniform update affects real final HDR after abort retry"
    );
    const uniformRepeated = await runCase(33, 17, false, null, "generic");
    check(
      uniformUpdated.every((value, index) => value === uniformRepeated[index]),
      "unchanged snapshot reuses matching uniform publication"
    );
    check(
      reports.at(-1).nativeCommands.computePasses === reports.at(-2).nativeCommands.computePasses - 1,
      "stable material snapshot omits its GPU update dispatch, rather than hiding it behind a counter"
    );
    extraMaterials[0].appearance_inputs.set("phase", [0]);
    const frameBuilder = new AppearanceGraphBuilder();
    const frameUv = frameBuilder.input("uv0", 2, "surface", undefined, "uv0");
    const frameCamera = frameBuilder.input("cameraPosition", 3, "view");
    const frameFactor = frameBuilder.operation(
      "add",
      frameBuilder.swizzle(frameCamera, [0]),
      frameBuilder.operation("sin", frameBuilder.parameter("phase", 0.375))
    );
    frameBuilder.output(
      "roughness",
      frameBuilder.operation("multiply", frameBuilder.swizzle(frameUv, [0]), frameFactor)
    );
    frameBuilder.output("baseColor", frameBuilder.constant([0.3, 0.4, 0.5]));
    frameBuilder.output("alpha", frameBuilder.constant(1));
    const frameProgram = compileAppearanceGraph(frameBuilder.build());
    const savedPublication = publication;
    const frameUpload = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    extraMaterials[0].appearance_inputs.set("phase", [0.375]);
    publication = new GpuAppearancePublication(
      device,
      registry,
      publicationSources.map((source, index) =>
        index === 2 ? { ...source, program: frameProgram } : source
      ),
      frameUpload,
      new Map(),
      new Map()
    );
    await publication.ready;
    frameUpload.finish();
    await frameUpload.gpuDone;
    genericReference = frameProgram;
    const cameraBaseline = await runCase(33, 17, false, null, "generic");
    cameraValues[12] = 0.25;
    device.queue.writeBuffer(camera, 0, cameraValues);
    await runCase(33, 17, false, null, "generic", undefined, true);
    const cameraMoved = await runCase(33, 17, false, null, "generic");
    check(
      cameraMoved.some((value, index) => value !== cameraBaseline[index]),
      "matching frame uniform reaches actual HDR after camera motion and aborted encoding"
    );
    const cameraRepeated = await runCase(33, 17, false, null, "generic");
    check(
      cameraMoved.every((value, index) => value === cameraRepeated[index]),
      "stable frame uniforms preserve complete results while material uniforms remain committed"
    );
    publication.destroy();
    publication = savedPublication;
    genericReference = generic;
    cameraValues[12] = 0;
    device.queue.writeBuffer(camera, 0, cameraValues);
    extraMaterials[0].appearance_inputs.set("phase", [0]);
    const completePublication = publication;
    for (const lanes of [1, 7, 64]) {
      const laneUpload = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
      publication = new GpuAppearancePublication(
        device,
        registry,
        publicationSources,
        laneUpload,
        new Map(),
        new Map(),
        undefined,
        undefined,
        lanes
      );
      await publication.ready;
      laneUpload.finish();
      await laneUpload.gpuDone;
      const laneResult = await runCase(33, 17, false, null, "generic");
      check(
        genericExact.every((value, index) => value === laneResult[index]),
        `Q=${lanes} packet contexts own disjoint scratch and still consume every complete sample`
      );
      publication.destroy();
    }
    publication = completePublication;
    const frequencyExact = await runCase(33, 17, false, null, "high-frequency");
    const frequencyShared = await runCase(33, 17, true, null, "high-frequency");
    check(
      frequencyExact.every((value, index) => value === frequencyShared[index]),
      "local high-frequency normal rejection preserves all exact work"
    );
    check(
      reports.at(-1).counters.quads > 0 &&
        reports.at(-1).counters.quads <= Math.floor(Math.ceil(33 / 2) / 2) * Math.floor(17 / 2),
      "only the flat half may admit coarse quads; high-frequency normals must reject locally"
    );
    const standardExact = await runCase(33, 17, false, null, "standard");
    const standardShared = await runCase(33, 17, true, null, "standard");
    check(
      standardExact.every((value, index) => value === standardShared[index]),
      "full Standard/Coated fixed formulas preserve every consumer with reuse on/off"
    );
    coated.clearcoat_factor = 0;
    const coatZero = await runCase(33, 17, false, null, "standard");
    coated.clearcoat_factor = 0.7;
    const coatRestored = await runCase(33, 17, false, null, "standard");
    check(
      coatZero.some((word, index) => word !== coatRestored[index]) &&
        standardExact.every((word, index) => word === coatRestored[index]),
      "coat zero-to-nonzero numeric edits retain their sources and recover every original result"
    );
    cameraValues.set([1e10, 1e10, 1e10], 12);
    device.queue.writeBuffer(camera, 0, cameraValues);
    const variedExact = await runCase(33, 17, false, null, "generic");
    const variedShared = await runCase(33, 17, true, null, "generic");
    check(
      variedExact.every((word, index) => word === variedShared[index]),
      "all independent kind recipes preserve exact output at local material/normal/view rejection boundaries"
    );
    const variedWrites = reports.at(-1).counters.packetWrites;
    const minimumExact = (33 - 1 - Math.ceil(33 / 2)) * 17;
    check(
      variedWrites.every((count) => count >= minimumExact),
      "varying complete closure dependencies retain local exact signal destinations"
    );
    cameraValues.set([0, 0, 100], 12);
    device.queue.writeBuffer(camera, 0, cameraValues);
    check(
      publication.surfaceWorkProfiles[6],
      "standard fixture must actually execute the fixed family in set 3"
    );
    const completeArena = frameArena,
      completeVertices = preparedVertices;
    const checkGeometryBoundaries = async () => {
      geometryBoundaries.push(
        ...(await checkSurfaceGeometryBoundaries(device, {
          arena: frameArena,
          vertexOwner: frameVertexOwner,
          vertices: preparedVertices,
          frameInstances,
          instances,
          work,
          vertexPayload,
          camera,
          product: productGeometry
        }))
      );
    };
    await checkGeometryBoundaries();
    for (const preparedCapacity of [8, 0]) {
      const maxBytes = completeArena.layout.attributes.offset + Math.max(16, preparedCapacity * 144);
      frameArena = frameArenaOwner.prepare(sourceHeap, sourceHeap.size, { ...geometryBudget, maxBytes });
      preparedVertices = frameVertexOwner.prepare({ arena: frameArena, ...vertexInputs });
      const prepare = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
      prepare.onFinished.addOne(frameArenaOwner.encodeMetadataPublication(prepare.gpu_encoder, frameArena));
      frameVertexOwner.encode(prepare.gpu_encoder, preparedVertices);
      prepare.finish();
      await prepare.gpuDone;
      const preparedResult = await runCase(33, 17, false, null, "standard");
      check(
        standardExact.every((value, index) => value === preparedResult[index]),
        `prepared vertex capacity ${preparedCapacity} keeps exact resident Geometry→Appearance consumers`
      );
      await checkGeometryBoundaries();
      frameVertexOwner.release(preparedVertices);
      frameArenaOwner.release(frameArena);
    }
    frameArena = completeArena;
    preparedVertices = completeVertices;
    await runCase(17, 5, false, null, "empty");
    check(
      reports.at(-1).counters.geometry === 0 && reports.at(-1).counters.material === 0,
      "empty coverage executes no geometry/material work"
    );
    const originalPublication = publication;
    const unlitUpload = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    publication = new GpuAppearancePublication(
      device,
      registry,
      [
        {
          material: unlit,
          materialSlot: 1,
          textureBindingSetId: 0,
          program: compileAppearanceGraph(builder.build()),
          textureRefs: new Map()
        }
      ],
      unlitUpload,
      new Map(),
      new Map()
    );
    await publication.ready;
    unlitUpload.finish();
    await unlitUpload.gpuDone;
    await runCase(17, 5, false, null, "unlit");
    check(
      reports.at(-1).capacity.hotWords === 2 && reports.at(-1).capacity.signalBytes === 16,
      "all-unlit profile has no closed lighting products"
    );
    check(
      reports.at(-1).counters.geometry === 0 && reports.at(-1).counters.material === 0,
      "publication-only unlit emits no per-pixel geometry/material work"
    );
    publication.destroy();
    publication = originalPublication;
    // An independently authored valid Product page represents exactly the
    // ordinary square above. Both paths consume real resident f32 attributes.
    const productHeapWords = new Uint32Array(100);
    productHeapWords.set([GEOMETRY_PRODUCT_GPU_ABI_VERSION_V1, 1, 1, 100, 16, 32, 40, 72, 76, 88, 92, 96]);
    productHeapWords.set([3, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1], 16);
    productHeapWords.set([0, 3, 0, 0, 0, 3, 0, 0], 32);
    productHeapWords.set([0, 1, 0, 1, 0, 1], 40 + 18);
    productHeapWords.set([0, 0, 8192, 0], 88);
    productHeapWords.set(
      new Uint32Array(
        encodeGeometryProductGpuLocationV1({
          bankIndex: 0,
          slotIndex: 0,
          residentBankIndex: 0,
          residentSlotIndex: 1,
          productGeneration: 3,
          flags: 1,
          byteOffset: 0
        }).buffer
      ),
      92
    );
    productHeapWords.set([16 | (3 << 16), 12 << 8, 1 << 16, 0], 96);
    const productPage = new Uint32Array((2 * 262144) / 4);
    productPage.set([1, 64, 112, 256, 8192], 11);
    productPage.set([4 | (2 << 16), 256, 112, 0xffffffff, 0, 0], 16);
    new Float32Array(productPage.buffer).set([-1, -1, 0.5, 3, 3, 0.5], 22);
    new Uint8Array(productPage.buffer).set([0, 1, 2, 2, 1, 3], 112);
    productPage.set(attributes.slice(112, 144), 30);
    productPage[65536] = 1;
    productPage[65537] = 65552;
    productPage.set(attributes.slice(8, 104), 65552);
    productGeometry = {
      heap: buffer(productHeapWords),
      banks: [
        buffer(productPage),
        buffer(new Uint32Array(1)),
        buffer(new Uint32Array(1)),
        buffer(new Uint32Array(1))
      ]
    };
    new DataView(instances.buffer).setUint32(
      GPU_INSTANCE_RECORD_OFFSETS.flags,
      GPU_INSTANCE_FLAGS.Active | GPU_INSTANCE_FLAGS.VirtualGeometry,
      true
    );
    device.queue.writeBuffer(frameInstances, 0, instances);
    for (const attributeCapacity of [20, 8, 0]) {
      const maxBytes = completeArena.layout.attributes.offset + Math.max(16, attributeCapacity * 144);
      frameArena = frameArenaOwner.prepare(sourceHeap, sourceHeap.size, { ...geometryBudget, maxBytes });
      check(
        frameArena.layout.attributeCapacity === attributeCapacity,
        "Product prepared-region capacity is explicit"
      );
      preparedVertices = frameVertexOwner.prepare({
        arena: frameArena,
        ...vertexInputs,
        product: { metadata: productGeometry.heap },
        productBanks: productGeometry.banks
      });
      const productCommand = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
      productCommand.onFinished.addOne(
        frameArenaOwner.encodeMetadataPublication(productCommand.gpu_encoder, frameArena)
      );
      frameVertexOwner.encode(productCommand.gpu_encoder, preparedVertices);
      productCommand.finish();
      await productCommand.gpuDone;
      const result = await runCase(33, 17, false, null, "generic");
      check(
        genericExact.every((word, index) => word === result[index]),
        `Product prepared=${attributeCapacity} and resident fallback retain the full independent Ordinary result`
      );
      await checkGeometryBoundaries();
      frameVertexOwner.release(preparedVertices);
      frameArenaOwner.release(frameArena);
    }
    productGeometry = null;
    frameArena = completeArena;
    preparedVertices = completeVertices;
    new DataView(instances.buffer).setUint32(
      GPU_INSTANCE_RECORD_OFFSETS.flags,
      GPU_INSTANCE_FLAGS.Active,
      true
    );
    device.queue.writeBuffer(frameInstances, 0, instances);
    new Float32Array(instances.buffer).set(
      identity.map((value) => -value),
      GPU_FRAME_INSTANCE_OFFSETS.objectToClip / 4
    );
    device.queue.writeBuffer(frameInstances, 0, instances);
    const negativeWCommand = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    frameVertexOwner.encode(negativeWCommand.gpu_encoder, completeVertices);
    negativeWCommand.finish();
    await negativeWCommand.gpuDone;
    const negativeW = await runCase(33, 17, false, null, "generic");
    check(
      genericExact.every((word, index) => word === negativeW[index]),
      "actual negative-W prepared Geometry retains projectively equivalent complete Appearance output"
    );
    new Float32Array(instances.buffer).set(identity, GPU_FRAME_INSTANCE_OFFSETS.objectToClip / 4);
    device.queue.writeBuffer(frameInstances, 0, instances);
    const restoreClip = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    frameVertexOwner.encode(restoreClip.gpu_encoder, completeVertices);
    restoreClip.finish();
    await restoreClip.gpuDone;
    const originalWork = work;
    const commandShapes = [];
    for (const count of [1, 25, 257]) {
      const sources = Array.from({ length: count }, (_, index) => {
        const graph = new AppearanceGraphBuilder();
        const uv = graph.input("uv0", 2, "surface", undefined, "uv0");
        let value = graph.swizzle(uv, [0]);
        for (let op = 0; op <= index; op++) value = graph.operation("sin", value);
        value = graph.operation(
          "add",
          graph.operation("multiply", value, graph.constant(0.7)),
          graph.constant(0.35)
        );
        graph.output("baseColor", graph.combine(value, value, value));
        graph.output("alpha", graph.constant(1));
        return {
          material: new StandardShadeMaterial(),
          materialSlot: index,
          textureBindingSetId: 0,
          program: compileAppearanceGraph(graph.build()),
          textureRefs: new Map()
        };
      });
      const upload = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
      publication = new GpuAppearancePublication(
        device,
        registry,
        sources,
        upload,
        new Map(),
        new Map(),
        undefined,
        undefined,
        7
      );
      await publication.ready;
      upload.finish();
      await upload.gpuDone;
      check(
        publication.surfaceTemplateCount === count,
        "stress must contain distinct complete templates, not only instances"
      );
      work = buffer(
        new Uint32Array([
          count,
          count,
          0,
          count,
          0,
          11,
          0,
          0,
          ...Array.from({ length: count }, (_, slot) => [0, 0, 0, slot, 0, 0]).flat()
        ])
      );
      frameArena = frameArenaOwner.prepare(sourceHeap, sourceHeap.size, {
        ...geometryBudget,
        workCapacity: count,
        vertexCapacity: 4 * count,
        triangleCapacity: 2 * count
      });
      preparedVertices = frameVertexOwner.prepare({ arena: frameArena, ...vertexInputs, work });
      const prepare = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
      prepare.onFinished.addOne(frameArenaOwner.encodeMetadataPublication(prepare.gpu_encoder, frameArena));
      frameVertexOwner.encode(prepare.gpu_encoder, preparedVertices);
      prepare.finish();
      await prepare.gpuDone;
      const pixels = await runCase(33, 17, false, null, "template-stress");
      commandShapes.push(reports.at(-1).nativeCommands);
      for (const width of [2, 8, 9]) await runCase(width, 1, false, null, "template-stress");
      if (count > 1) {
        const coherent = await runCase(513, 9, false, null, "template-stress");
        const indexed = await runCase(513, 9, false, null, "template-stress", 0);
        const overflow = await runCase(513, 9, false, null, "template-stress", 1);
        check(
          coherent.every((word, index) => word === indexed[index]) &&
            coherent.every((word, index) => word === overflow[index]),
          "mixed-template zero/tiny optional capacity preserves complete indexed output"
        );
        check(
          reports.at(-1).coherence.some((config) => config[6] > 0),
          "mixed-template tiny capacity actually exercises pre-write overflow promotion"
        );
      }

      if (count > 1) {
        check(
          reports.some(
            (report) =>
              report.fixture === "template-stress" &&
              report.capacity.templateCount === count &&
              report.coherence.some((config) => config[5] === 2 && config[4] > 0)
          ),
          "mixed templates actually consume coherent runs"
        );
        const indexed = await runCase(33, 17, false, null, "template-stress", 0);
        check(
          pixels.every((value, index) => value === indexed[index]),
          "all mixed-template outputs match complete indexed work bit-for-bit"
        );
      }
      frameVertexOwner.release(preparedVertices);
      frameArenaOwner.release(frameArena);
      publication.destroy();
    }
    check(
      commandShapes[1].dispatch === commandShapes[2].dispatch &&
        commandShapes[1].dispatchIndirect === commandShapes[2].dispatchIndirect,
      "25→257 templates change GPU data/work only, not actual native dispatch counts"
    );
    check(
      commandShapes[1].dispatch + commandShapes[1].dispatchIndirect <=
        commandShapes[0].dispatch + commandShapes[0].dispatchIndirect + 5,
      "single-template bypass differs only by finite prefix/scatter stages"
    );
    work = originalWork;
    frameArena = completeArena;
    preparedVertices = completeVertices;
    publication = originalPublication;
    const originalTexels = texels.slice();
    for (const [general, frameDependent] of [
      [false, false],
      [true, false],
      [true, true]
    ]) {
      const graph = new AppearanceGraphBuilder();
      const uv = graph.input("uv0", 2, "surface", undefined, "uv0");
      const lookup = graph.parameter("lookupUV", [0.375, 0.625]);
      graph.output("alpha", graph.constant(1));
      const coordinate = frameDependent
        ? graph.operation("add", lookup, graph.swizzle(graph.input("cameraPosition", 3, "view"), [0, 1]))
        : lookup;
      const sampled = graph.texture(snapshotAppearanceTexture(resident, "linear-rgb"), coordinate);
      const factor = graph.swizzle(sampled, [0]);
      graph.output("emissive", graph.swizzle(sampled, [0, 1, 2]));
      graph.output("metallic", graph.constant(0.3));
      const varying = graph.swizzle(uv, [0]);
      graph.output(
        "roughness",
        graph.operation("multiply", general ? graph.operation("sin", varying) : varying, factor)
      );
      uniformReference = compileAppearanceGraph(graph.build());
      extraMaterials[0].appearance_inputs.set("lookupUV", [0.375, 0.625]);
      const revision = {
        slot: 0,
        generation: 1,
        revision: 1,
        currentRevision: 1,
        localVariationSlot: 0,
        variation: { known: false, low: [0, 0, 0, 0], high: [1, 1, 1, 1] }
      };
      const update = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
      publication = new GpuAppearancePublication(
        device,
        registry,
        publicationSources.map((source, index) =>
          index === 2 ? { ...source, program: uniformReference } : source
        ),
        update,
        new Map(),
        new Map([[resident, revision]])
      );
      await publication.ready;
      update.finish();
      await update.gpuDone;
      check(
        publication.surfaceWorkProfiles[general ? 3 : 2],
        "uniform value reaches the requested fixed/General consumer"
      );
      temporalFixture = new SurfaceTemporalValueFixture(device);
      await runCase(17, 5, false, null, "resource-uniform");
      check(
        reports.at(-1).temporalSample[2] === 255,
        "new history is produced by the real TemporalFacts chain"
      );
      const valueRevision = reports.at(-1).valueVersions[5];
      check(reports.at(-1).uniformQueries[4] === 1, "real GPU producer samples the uniform query once");
      check(
        reports.at(-1).counters.sampleTextureQueries === 0 && reports.at(-1).counters.uniformScalarReads > 0,
        "original sample consumer reads values without repeating the resolved heavy query"
      );
      await runCase(33, 17, false, null, "resource-uniform");
      check(
        reports.at(-1).valueVersions[5] === valueRevision,
        "stable values retain their real published version across extent changes"
      );
      check(
        reports.at(-1).uniformQueries[4] === (frameDependent ? 2 : 1),
        "more covered pixels do not repeat heavy uniform queries"
      );
      extraMaterials[0].appearance_inputs.set("lookupUV", [0.25, 0.5]);
      await runCase(33, 17, false, null, "resource-uniform", undefined, true);
      await runCase(33, 17, false, null, "resource-uniform");
      check(
        reports.at(-1).valueVersions[5] === valueRevision + 1,
        "numeric edit and abort publish one changed value version on retry"
      );
      check(
        reports.at(-1).temporalSample[2] === 255 && reports.at(-1).temporalSample[1] === 255,
        "current custom Appearance edits invalidate previous identity while retaining valid zero motion " +
          JSON.stringify(reports.at(-1).temporalSample)
      );
      check(
        reports.at(-1).uniformQueries[4] === (frameDependent ? 3 : 2),
        "aborted material update retries exactly once and reaches consumers"
      );
      await runCase(33, 17, false, null, "resource-uniform");
      check(
        reports.at(-1).valueVersions[5] === valueRevision + 1,
        "unchanged frame-query results do not invalidate value history"
      );
      check(
        reports.at(-1).temporalSample[2] === 0 && reports.at(-1).temporalSample[0] === 0,
        "stable current values reuse real identity history without perpetual reactive rejection"
      );
      check(
        reports.at(-1).uniformQueries[4] === (frameDependent ? 4 : 2),
        "committed material is stable; frame-dependent queries follow the frame domain"
      );
      for (let edit = 0; edit < 16; edit++) {
        extraMaterials[0].appearance_inputs.set("lookupUV", edit % 2 === 0 ? [0.375, 0.625] : [0.25, 0.5]);
        await runCase(33, 17, false, null, "resource-uniform", undefined, true);
        await runCase(33, 17, false, null, "resource-uniform");
        check(
          reports.at(-1).temporalSample[2] === 255,
          "each changed abort/retry input reaches the authoritative temporal consumer"
        );
        await runCase(33, 17, false, null, "resource-uniform");
        check(
          reports.at(-1).temporalSample[2] === 0,
          "each stable retry result has reusable current history"
        );
      }
      const beforeResourceQueryCount = reports.at(-1).uniformQueries[4];
      const beforeResourceValueRevision = reports.at(-1).valueVersions[5];
      if (frameDependent) {
        cameraValues[12] = 0.125;
        device.queue.writeBuffer(camera, 0, cameraValues);
      }
      for (let index = 64 * 4; index < texels.length; index += 4) texels[index] = 192;
      device.queue.writeTexture(
        { texture: residentTexture },
        texels,
        { bytesPerRow: 32, rowsPerImage: 8 },
        { width: 8, height: 8, depthOrArrayLayers: 2 }
      );
      revision.currentRevision++;
      await runCase(33, 17, false, null, "resource-uniform");
      check(
        reports.at(-1).valueVersions[5] === beforeResourceValueRevision + 1,
        "actual resource edit publishes the changed value identity for history"
      );
      check(
        reports.at(-1).temporalSample[2] === 255,
        "per-resource invalidation reaches TemporalFacts and Reconstruction"
      );
      check(
        reports.at(-1).uniformQueries[4] === beforeResourceQueryCount + 1,
        "actual per-resource revision invalidates the uniform query value"
      );
      device.queue.writeBuffer(
        publication.surfaceMetadata,
        (publication.surfaceMetadataOffsets.valueVersions + 5) * 4,
        new Uint32Array([0xffffffff])
      );
      extraMaterials[0].appearance_inputs.set("lookupUV", [0.5, 0.5]);
      await runCase(33, 17, false, null, "resource-uniform");
      check(
        reports.at(-1).valueVersions[5] === 0 &&
          reports.at(-1).temporalSample[0] === 255 &&
          reports.at(-1).temporalSample[1] === 0,
        "exhausted version has a complete invalid-history destination"
      );
      await runCase(33, 17, false, null, "resource-uniform");
      check(
        reports.at(-1).valueVersions[5] === 0 && reports.at(-1).temporalSample[0] === 255,
        "version exhaustion never wraps back into valid stale history"
      );
      temporalFixture.destroy();
      temporalFixture = null;
      publication.destroy();
      cameraValues[12] = 0;
      device.queue.writeBuffer(camera, 0, cameraValues);
      texels.set(originalTexels);
      device.queue.writeTexture(
        { texture: residentTexture },
        texels,
        { bytesPerRow: 32, rowsPerImage: 8 },
        { width: 8, height: 8, depthOrArrayLayers: 2 }
      );
    }
    const productBuilder = new AppearanceGraphBuilder();
    const productUv = productBuilder.input("uv0", 2, "surface", undefined, "uv0");
    const scaledUv = productBuilder.operation("multiply", productUv, productBuilder.constant(0.01));
    productBuilder.output("alpha", productBuilder.constant(1));
    productBuilder.output(
      "roughness",
      productBuilder.operation("add", productBuilder.swizzle(scaledUv, [0]), productBuilder.constant(0.3))
    );
    productBuilder.output("emissive", productBuilder.combine(scaledUv, productBuilder.constant(0.2)));
    const productSource = compileAppearanceGraph(productBuilder.build());
    const productRoots = {
      roughness: productSource.outputs.roughness,
      emissive: productSource.outputs.emissive
    };
    productReferenceData = cookAppearanceMipProduct(productSource, productRoots, {
      width: 8,
      height: 8,
      mipCount: 4,
      byteBudget: 65536,
      validationProbeBudget: 65536,
      domainMin: [0, 0],
      domainMax: [1, 1],
      coordinateDomain: "uv0",
      error: { absolute: 0.01, relative: 0 },
      storagePrecision: "float16",
      sample: () => []
    });
    const productAsset = await openAppearanceAssetPackage(
      await writeAppearanceAssetPackage(productReferenceData, {
        uri: "oracle/surface-work-product",
        contentHash: "c".repeat(64),
        dependencies: []
      })
    );
    productReference = bindAppearanceProducts(productSource, [
      { source: productSource, asset: productAsset, roots: productRoots }
    ]);
    const productUpdate = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    publication = new GpuAppearancePublication(
      device,
      registry,
      publicationSources.map((source, index) =>
        index === 2 ? { ...source, program: productReference } : source
      ),
      productUpdate,
      new Map(),
      new Map()
    );
    await publication.ready;
    productUpdate.finish();
    await productUpdate.gpuDone;
    check(
      publication.workPlans[2].fields.filter((field) => field.category === "product-domain").length === 2,
      "legal cooked Product fields use the declared domain read contract"
    );
    await runCase(17, 17, false, null, "appearance-product");
    await runCase(33, 33, true, 0, "appearance-product", 0);
    check(
      reports.at(-1).counters.sampleProductQueries > 0,
      "real nonconstant Product queries reach current consumers"
    );
    publication.destroy();
    const momentBuilder = new AppearanceGraphBuilder();
    const momentUv = momentBuilder.input("uv0", 2, "surface", undefined, "uv0");
    const momentXY = momentBuilder.operation("multiply", momentUv, momentBuilder.constant(0.05));
    momentBuilder.output("alpha", momentBuilder.constant(1));
    momentBuilder.output("baseColor", momentBuilder.constant([0.2, 0.3, 0.4]));
    momentBuilder.output("emissive", momentBuilder.constant([0.03, 0.02, 0.01]));
    momentBuilder.output("normalTS", momentBuilder.combine(momentXY, momentBuilder.constant(1)));
    momentBuilder.output("roughness", momentBuilder.constant(0.4));
    momentBuilder.output(
      "coatNormalTS",
      momentBuilder.combine(momentBuilder.swizzle(momentXY, [0]), momentBuilder.constant([0, 1]))
    );
    momentBuilder.output("coatRoughness", momentBuilder.constant(0.2));
    momentBuilder.output("coatWeight", momentBuilder.constant(0.5));
    const momentSource = compileAppearanceGraph(momentBuilder.build());
    productReferenceData = cookAppearanceNormalProduct(
      momentSource,
      [
        ["baseMoment", "normalTS", "roughness"],
        ["coatMoment", "coatNormalTS", "coatRoughness"]
      ].map(([momentField, normalOutput, roughnessOutput]) => ({
        momentField,
        normalOutput,
        roughnessOutput,
        normal: momentSource.outputs[normalOutput],
        roughness: momentSource.outputs[roughnessOutput],
        maxAngleRadians: 0.01,
        maxRoughnessError: 0.025
      })),
      {
        width: 8,
        height: 8,
        mipCount: 4,
        byteBudget: 65536,
        validationProbeBudget: 65536,
        domainMin: [0, 0],
        domainMax: [1, 1],
        coordinateDomain: "uv0",
        error: { absolute: 0.01, relative: 0 },
        storagePrecision: "float16",
        sample: () => []
      }
    );
    const momentAsset = await openAppearanceAssetPackage(
      await writeAppearanceAssetPackage(productReferenceData, {
        uri: "oracle/surface-work-moments",
        contentHash: "d".repeat(64),
        dependencies: []
      })
    );
    productReference = bindAppearanceProducts(momentSource, [{ source: momentSource, asset: momentAsset }]);
    const momentUpdate = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    publication = new GpuAppearancePublication(
      device,
      registry,
      publicationSources.map((source, index) =>
        index === 2 ? { ...source, program: productReference } : source
      ),
      momentUpdate,
      new Map(),
      new Map()
    );
    await publication.ready;
    momentUpdate.finish();
    await momentUpdate.gpuDone;
    await runCase(17, 17, false, null, "appearance-product");
    await runCase(33, 33, true, 0, "appearance-product", 0);
    const originalInstances = instances.slice();
    const originalCamera = cameraValues.slice();
    // Static reflected/nonuniform instance, with the inverse camera projection
    // keeping the independently known clip plane and UV lattice unchanged.
    new Float32Array(instances.buffer).set(
      [-2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0.5, 0],
      GPU_INSTANCE_RECORD_OFFSETS.current_affine / 4
    );
    new Float32Array(instances.buffer).set(
      [1.5, 0, 0, -3, 0, -1, 0, 0, 0, 0, -6, 0],
      GPU_FRAME_INSTANCE_OFFSETS.normalX / 4
    );
    new DataView(instances.buffer).setUint32(GPU_FRAME_INSTANCE_OFFSETS.generation, 11, true);
    cameraValues.set([-0.5, 0, 0, 0, 0, 1 / 3, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1], 96);
    cameraValues.set([-2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1], 112);
    cameraValues[64] = -0.5;
    cameraValues[69] = 1 / 3;
    cameraValues[74] = 2;
    cameraValues[78] = 200;
    cameraValues[80] = -2;
    cameraValues[85] = 3;
    cameraValues[90] = 0.5;
    cameraValues[94] = -100;
    device.queue.writeBuffer(frameInstances, 0, instances);
    device.queue.writeBuffer(camera, 0, cameraValues);
    const reflectedPrepare = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    frameVertexOwner.encode(reflectedPrepare.gpu_encoder, completeVertices);
    reflectedPrepare.finish();
    await reflectedPrepare.gpuDone;
    guideSigns = [-1, 1, 1];
    await runCase(33, 33, false, null, "appearance-product");
    await runCase(33, 33, true, 0, "appearance-product", 0);
    guideSigns = [1, 1, 1];
    instances.set(originalInstances);
    cameraValues.set(originalCamera);
    device.queue.writeBuffer(frameInstances, 0, instances);
    device.queue.writeBuffer(camera, 0, cameraValues);
    const restoredPrepare = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    frameVertexOwner.encode(restoredPrepare.gpu_encoder, completeVertices);
    restoredPrepare.finish();
    await restoredPrepare.gpuDone;
    publication.destroy();
    extraMaterials[0].appearance_inputs.set("lookupUV", [0.375, 0.625]);
    publication = originalPublication;
    failureSnapshot = null;
    const coverageValues = await checkSurfaceCoverageValues(device, graphics, registry);
    check(apiErrors.length === 0, JSON.stringify(apiErrors));
    return {
      passed: true,
      scope: "current SurfaceWorkRuntime real Geometry Appearance Lighting Reconstruction chain",
      reports,
      geometryBoundaries,
      coverageValues,
      timings,
      apiErrors
    };
  } catch (error) {
    console.error("SurfaceWork failure boundary snapshot: " + JSON.stringify(failureSnapshot?.()));
    console.error("SurfaceWork assertion failure: " + error.stack);
    throw error;
  } finally {
    temporalFixture?.destroy();
    device.createShaderModule = originalModule;
    device.createComputePipeline = originalPipeline;
    device.removeEventListener("uncapturederror", errorListener);
    runtime?.destroy();
    frameVertexOwner?.destroy();
    frameArenaOwner?.destroy();
    publication?.destroy();
    registry.destroy();
    retained.forEach((resource) => resource.destroy());
    graphics.buffer_allocator_main.destroy();
    graphics.buffer_allocator_staging.destroy();
    graphics.allocator_textures.destroy();
  }
}
