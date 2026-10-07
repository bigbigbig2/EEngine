import {
  AppearanceGraphBuilder,
  snapshotAppearanceTexture
} from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { lowerStandardAppearanceGraph } from "../../.test-dist/material/StandardAppearanceGraph.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { lowerNativeMaterial } from "../../.test-dist/shaders/native_material.js";
import { AppearanceProgramRegistry } from "../../.test-dist/gpu/AppearanceProgramRegistry.js";
import {
  GpuNativeMaterialPublication,
  NATIVE_MATERIAL_DIRECTORY_WGSL
} from "../../.test-dist/gpu/GpuNativeMaterialPublication.js";
import { runNativeMaterialBindingsGpuOracle } from "./native-material-bindings-gpu.mjs";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const f = Math.fround;
const count = 32;
const dimension = 32;
const mipCount = 6;

function texel(level, x, y, channel) {
  return ((47 + level * 29 + x * (channel + 1) * 3 + y * (4 - channel) + channel * 37) % 233) / 255;
}

// Independent bilinear/trilinear reference over uploaded UNORM8 texels.
// Clamp, linear min/mag/mips, anisotropy=1. TextureResidency decode is modeled
// by already-linear resource values, never a second RGB/alpha conversion.
function sample(uv, dx, dy) {
  const lod = Math.min(
    mipCount - 1,
    Math.max(0, Math.log2(Math.max(Math.hypot(...dx) * dimension, Math.hypot(...dy) * dimension, 1e-20)))
  );
  const bilinear = (level, channel) => {
    const size = dimension >> level;
    const x = uv[0] * size - 0.5,
      y = uv[1] * size - 0.5;
    const ix = Math.floor(x),
      iy = Math.floor(y),
      ax = x - ix,
      ay = y - iy;
    const read = (x, y) =>
      texel(level, Math.min(size - 1, Math.max(0, x)), Math.min(size - 1, Math.max(0, y)), channel);
    return (
      (read(ix, iy) * (1 - ax) + read(ix + 1, iy) * ax) * (1 - ay) +
      (read(ix, iy + 1) * (1 - ax) + read(ix + 1, iy + 1) * ax) * ay
    );
  };
  return Array.from({ length: 4 }, (_, channel) =>
    f(bilinear(Math.floor(lod), channel) * (1 - (lod % 1)) + bilinear(Math.ceil(lod), channel) * (lod % 1))
  );
}

// Original authored vector graph, deliberately independent of the compiled IR
// and WGSL emitter. All nodes evaluate C/X/Y, including texture-driven UV.
function reference(graph, inputs, edits = {}, bindingSet = 0) {
  const values = [];
  for (const node of graph.nodes) {
    if (node.kind === "constant" || node.kind === "parameter") {
      const value = node.kind === "parameter" ? (edits[node.name] ?? node.value) : node.value;
      values.push(Array.from({ length: 3 }, () => value.map(f)));
    } else if (node.kind === "input") values.push(inputs[node.name]);
    else if (node.kind === "swizzle")
      values.push(values[node.source].map((v) => node.channels.map((c) => v[c])));
    else if (node.kind === "combine")
      values.push(Array.from({ length: 3 }, (_, p) => node.sources.flatMap((ref) => values[ref][p])));
    else if (node.kind === "texture") {
      const coordinates = values[node.uv];
      const binding = node.binding;
      const rotate = (uv) => {
        const u = f(uv[0] * f(binding.scale[0])),
          v = f(uv[1] * f(binding.scale[1]));
        const c = f(Math.cos(binding.rotation)),
          s = f(Math.sin(binding.rotation));
        return [f(f(c * u) - f(s * v)), f(f(s * u) + f(c * v))];
      };
      const dx = rotate(coordinates[1].map((v, c) => f(v - coordinates[0][c])));
      const dy = rotate(coordinates[2].map((v, c) => f(v - coordinates[0][c])));
      values.push(
        coordinates.map((uv) =>
          sample(
            rotate(uv).map((v, c) => f(v + f(binding.offset[c]))),
            dx,
            dy
          ).map((v) => (bindingSet ? f(1 - v) : v))
        )
      );
    } else
      values.push(
        Array.from({ length: 3 }, (_, p) =>
          Array.from({ length: node.width }, (_, channel) => {
            const [a, b, c] = node.args.map(
              (ref) => values[ref][p][graph.nodes[ref].width === 1 ? 0 : channel]
            );
            switch (node.op) {
              case "add":
                return f(a + b);
              case "subtract":
                return f(a - b);
              case "multiply":
                return f(a * b);
              case "divide":
                return f(a / b);
              case "min":
                return Math.min(a, b);
              case "max":
                return Math.max(a, b);
              case "pow":
                return f(a ** b);
              case "sin":
                return f(Math.sin(a));
              case "cos":
                return f(Math.cos(a));
              case "abs":
                return Math.abs(a);
              case "sqrt":
                return f(Math.sqrt(a));
              case "mix":
                return f(f(a * f(1 - c)) + f(b * c));
              case "clamp":
                return Math.min(Math.max(a, b), c);
              default:
                throw new Error("Unhandled reference operation");
            }
          })
        )
      );
  }
  return Object.fromEntries(Object.entries(graph.outputs).map(([name, ref]) => [name, values[ref][0]]));
}

function fixtures() {
  const texture = new ShadeTexture();
  const roles = ["base", "normal", "orm", "emissive", "coat", "coatRoughness", "coatNormal"];
  const samples = roles.map((role) => ({
    role,
    texture,
    colorDecode: "linear-rgb",
    uvSet: 0,
    offset: [0.13, -0.07],
    scale: [1.3, 0.8],
    rotation: 0.29,
    equivalentSample: 0
  }));
  const material = new StandardShadeMaterial();
  material.metallic_factor = 0.7;
  material.roughness_factor = 0.6;
  material.normal_scale = 0.8;
  material.clearcoat_factor = 0.5;
  material.clearcoat_roughness_factor = 0.4;
  material.emissive_factor.r = 0.3;
  const coated = lowerStandardAppearanceGraph(material, samples);
  material.clearcoat_factor = 0;
  const standard = lowerStandardAppearanceGraph(material, samples.slice(0, 4));
  material.is_unlit = true;
  const unlit = lowerStandardAppearanceGraph(material, samples.slice(0, 1));
  const g = new AppearanceGraphBuilder();
  const uv = g.input("uv0", 2, "surface", undefined, "uv0");
  const wave = g.operation("sin", g.operation("multiply", uv, g.parameter("frequency", 3)));
  const distorted = g.operation("add", uv, g.operation("multiply", wave, g.constant(0.06)));
  const binding = snapshotAppearanceTexture(texture, "linear-rgb", [0.11, 0.04], [1.2, 0.7], 0.17);
  const first = g.texture(binding, distorted);
  const nestedUv = g.operation(
    "mix",
    uv,
    g.swizzle(first, [0, 1]),
    g.parameter("warp", 0.2, { low: 0, high: 1 })
  );
  const second = g.texture(binding, nestedUv);
  const gain = g.parameter("gain", 0.6, { low: 0, high: 2 });
  const time = g.input("time", 1, "dynamic", { low: 0, high: 10 });
  g.output("baseColor", g.operation("multiply", g.swizzle(second, [0, 1, 2]), gain));
  g.output("roughness", g.operation("sqrt", g.operation("max", g.swizzle(first, [1]), g.constant(0.01))));
  g.output("emissive", g.operation("pow", g.operation("abs", wave), g.constant(2)));
  g.output(
    "alpha",
    g.operation(
      "clamp",
      g.operation("divide", gain, g.operation("add", time, g.constant(1))),
      g.constant(0),
      g.constant(1)
    )
  );
  for (const op of ["cos", "min", "subtract"])
    g.output(op, op === "cos" ? g.operation(op, wave) : g.operation(op, wave, gain));
  const arithmetic = new AppearanceGraphBuilder();
  const a = arithmetic.input("time", 1, "dynamic", { low: 0, high: 10 });
  const b = arithmetic.parameter("alpha", 0.4, { low: 0, high: 1 });
  for (const op of ["add", "subtract", "multiply", "divide", "min", "max", "pow"])
    arithmetic.output(op, arithmetic.operation(op, a, b));
  for (const op of ["sin", "cos", "abs", "sqrt"]) arithmetic.output(op, arithmetic.operation(op, a));
  arithmetic.output("mix", arithmetic.operation("mix", a, b, arithmetic.constant(0.3)));
  arithmetic.output("clamp", arithmetic.operation("clamp", a, arithmetic.constant(0.1), b));
  return { standard, coated, unlit, custom: g.build(), arithmetic: arithmetic.build() };
}

function inputsFor(program, lane) {
  const scale = [0.007, 0.05, 0.15, 0.35][lane % 4];
  return Object.fromEntries(
    program.inputs.map((input) => {
      if (input.name === "uv0") {
        const c = [f(0.12 + lane * 0.013), f(0.18 + lane * 0.007)];
        return [input.name, [c, [f(c[0] + scale), c[1]], [c[0], f(c[1] + scale * 0.8)]]];
      }
      const value = input.name === "vertexColor" ? [0.4, 0.7, 0.9] : [0.3 + lane * 0.01];
      return [input.name, Array.from({ length: 3 }, () => value.map(f))];
    })
  );
}

// Independent authored VECTOR graph reference: no scalar IR, CSE or native backend.
// Ideal CPU filtering remains diagnostic; hardware LOD/filter rounding is shared
// only through actual textureSampleGrad, not through generated native expressions.
function referenceWgsl(graph, ir, native) {
  const type = (width) => (width === 1 ? "f32" : `vec${width}f`);
  const literal = (value) => (Object.is(f(value), -0) ? "-0.0" : `${f(value).toExponential()}f`);
  const vector = (values) =>
    values.length === 1 ? literal(values[0]) : `${type(values.length)}(${values.map(literal).join(", ")})`;
  const inputSlots = new Map(ir.inputs.map((input, slot) => [input.name, slot]));
  const lines = [];
  for (let id = 0; id < graph.nodes.length; id++) {
    const node = graph.nodes[id];
    for (let point = 0; point < 3; point++) {
      const read = (ref) => `r_${ref}_${point}`;
      let value;
      if (node.kind === "constant") value = vector(node.value);
      else if (node.kind === "parameter") {
        const components = node.value.map((v, channel) => {
          const slot = native.parameterSlots[node.name]?.find((slot) => slot.channel === channel);
          return slot ? `constants[material_base + ${slot.slot}u]` : literal(v);
        });
        value = node.width === 1 ? components[0] : `${type(node.width)}(${components.join(", ")})`;
      } else if (node.kind === "input")
        value = `inputs.${["center", "x", "y"][point]}[${inputSlots.get(node.name)}].${"xyzw".slice(0, node.width)}`;
      else if (node.kind === "swizzle")
        value =
          node.channels.length === 1
            ? `${read(node.source)}.${"xyzw"[node.channels[0]]}`
            : `${type(node.width)}(${node.channels.map((c) => `${read(node.source)}.${"xyzw"[c]}`).join(", ")})`;
      else if (node.kind === "combine") value = `${type(node.width)}(${node.sources.map(read).join(", ")})`;
      else if (node.kind === "texture") {
        const b = node.binding;
        const rotate = (uv) => {
          const scaled = `(${uv} * ${vector(b.scale)})`;
          return `vec2f(${literal(Math.cos(b.rotation))} * ${scaled}.x - ${literal(Math.sin(b.rotation))} * ${scaled}.y, ${literal(Math.sin(b.rotation))} * ${scaled}.x + ${literal(Math.cos(b.rotation))} * ${scaled}.y)`;
        };
        value = `textureSampleGrad(source_texture, source_sampler, ${vector(b.offset)} + ${rotate(read(node.uv))}, ${rotate(`(r_${node.uv}_1 - r_${node.uv}_0)`)}, ${rotate(`(r_${node.uv}_2 - r_${node.uv}_0)`)})`;
      } else {
        const args = node.args.map((ref) =>
          graph.nodes[ref].width === 1 && node.width > 1 ? `${type(node.width)}(${read(ref)})` : read(ref)
        );
        const [a, b, c] = args;
        const symbols = { add: "+", subtract: "-", multiply: "*", divide: "/" };
        value = symbols[node.op]
          ? `(${a} ${symbols[node.op]} ${b})`
          : node.op === "mix"
            ? `((${a} * (${type(node.width)}(1.0) - ${c})) + (${b} * ${c}))`
            : `${node.op}(${args.join(", ")})`;
      }
      lines.push(`  let r_${id}_${point}: ${type(node.width)} = ${value};`);
    }
  }
  const outputs = Object.keys(native.outputs).flatMap((name) => {
    const id = graph.outputs[name];
    return Array.from({ length: graph.nodes[id].width }, (_, c) =>
      graph.nodes[id].width === 1 ? `r_${id}_0` : `r_${id}_0.${"xyzw"[c]}`
    );
  });
  return `fn reference_evaluate(material_base: u32, inputs: NativeMaterialInputs) -> array<f32, ${native.outputCount}> {\n${lines.join("\n")}\n return array<f32, ${native.outputCount}>(${outputs.join(", ")});\n}`;
}

/** S1 component oracle only. Fixture inputs are not winner Geometry or a renderer. */
export async function runNativeMaterialGpuOracle(device) {
  const registry = new AppearanceProgramRegistry(device);
  const retained = [];
  const publications = [];
  const results = [];
  const buffer = (data, usage) => {
    const result = device.createBuffer({ size: Math.max(data.byteLength, 4), usage, mappedAtCreation: true });
    new Uint8Array(result.getMappedRange()).set(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    );
    result.unmap();
    retained.push(result);
    return result;
  };
  const textures = [0, 1].map(() =>
    device.createTexture({
      size: [dimension, dimension],
      mipLevelCount: mipCount,
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    })
  );
  retained.push(...textures);
  for (let level = 0; level < mipCount; level++) {
    const size = dimension >> level;
    const data = Uint8Array.from({ length: size * size * 4 }, (_, i) =>
      Math.round(texel(level, (i >> 2) % size, Math.floor(i / 4 / size), i % 4) * 255)
    );
    textures.forEach((texture, set) =>
      device.queue.writeTexture(
        { texture, mipLevel: level },
        set ? data.map((v) => 255 - v) : data,
        { bytesPerRow: size * 4 },
        [size, size]
      )
    );
  }
  const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear", mipmapFilter: "linear" });
  const selectedSets = [0, 1].map((set) => buffer(new Uint32Array([set, 0, 0, 0]), GPUBufferUsage.UNIFORM));
  try {
    for (const [name, graph] of Object.entries(fixtures())) {
      const ir = compileAppearanceGraph(graph);
      const program = lowerNativeMaterial(ir);
      const inputWidth = Math.max(program.inputCount, 1) * 12;
      const inputs = new Float32Array(count * inputWidth);
      for (let lane = 0; lane < count; lane++) {
        const data = inputsFor(ir, lane);
        ir.inputs.forEach((input, slot) => {
          for (let point = 0; point < 3; point++)
            inputs.set(
              data[input.name][point],
              lane * inputWidth + point * Math.max(program.inputCount, 1) * 4 + slot * 4
            );
        });
      }
      const inputBuffer = buffer(inputs, GPUBufferUsage.STORAGE);
      const outputBytes = count * program.outputCount * 4;
      const output = device.createBuffer({
        size: outputBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
      });
      const readback = device.createBuffer({
        size: outputBytes,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      retained.push(output, readback);
      const callbacks = ir.samples
        .map(
          (_, index) => /* wgsl */ `
fn native_material_sample_${index}(base: u32, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
  return textureSampleGrad(source_texture, source_sampler, uv, dx, dy);
}`
        )
        .join("\n");
      const source = /* wgsl */ `
${NATIVE_MATERIAL_DIRECTORY_WGSL}
@group(0) @binding(0) var<storage, read> constants: array<f32>;
@group(0) @binding(1) var<storage, read> directory: array<NativeMaterialDirectoryEntry>;
@group(0) @binding(2) var<storage, read> input_data: array<NativeMaterialInputs>;
@group(0) @binding(3) var<storage, read_write> output_data: array<f32>;
@group(0) @binding(4) var source_texture: texture_2d<f32>;
@group(0) @binding(5) var source_sampler: sampler;
@group(0) @binding(6) var<uniform> selected_set: vec4u;
fn native_material_constant(base: u32, slot: u32) -> f32 { return constants[base + slot]; }
${callbacks}
${program.source}
${referenceWgsl(graph, ir, program)}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= ${count}u || id.x % 2u != selected_set.x { return; }
  let material = directory[id.x % 2u];
  let values = native_material_evaluate(material.constant_base, input_data[id.x]);
  for (var channel = 0u; channel < ${program.outputCount}u; channel++) {
    output_data[id.x * ${program.outputCount}u + channel] = values[channel];
  }
}
@compute @workgroup_size(64)
fn reference_main(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= ${count}u || id.x % 2u != selected_set.x { return; }
  let values = reference_evaluate(directory[id.x % 2u].constant_base, input_data[id.x]);
  for (var channel = 0u; channel < ${program.outputCount}u; channel++) {
    output_data[id.x * ${program.outputCount}u + channel] = values[channel];
  }
}`;
      const descriptor = {
        source,
        entryPoint: "main",
        workgroupSize: 64,
        groups: [
          [
            ...[0, 1, 2].map((binding) => ({
              binding,
              visibility: GPUShaderStage.COMPUTE,
              buffer: { type: "read-only-storage" }
            })),
            { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
            { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
            { binding: 5, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
            { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }
          ]
        ]
      };
      const initialEdits = name === "custom" ? { gain: [0.4] } : { alpha: [0.4] };
      const updateEdits = name === "custom" ? { gain: [1.2], warp: [0.4] } : { alpha: [0.9] };
      const create = (edits) => {
        const publication = new GpuNativeMaterialPublication(device, registry, [
          { materialSlot: 0, bindingSet: 0, program, descriptor },
          { materialSlot: 1, bindingSet: 1, program, descriptor, parameters: edits }
        ]);
        publications.push(publication);
        return publication;
      };
      const initial = create(initialEdits);
      await initial.ready;
      initial.commit();
      const aborted = create(updateEdits);
      await aborted.ready;
      aborted.abort();
      const run = async (publication, edits) => {
        const { pipeline, layouts } = publication.pipeline(0);
        const referenceLease = registry.acquire({ ...descriptor, entryPoint: "reference_main" });
        const referencePipeline = (await referenceLease.ready).pipeline;
        const bindGroups = textures.map((texture, set) =>
          device.createBindGroup({
            layout: layouts[0],
            entries: [
              ...[publication.constants, publication.directory, inputBuffer, output].map(
                (resource, binding) => ({ binding, resource: { buffer: resource } })
              ),
              { binding: 4, resource: texture.createView() },
              { binding: 5, resource: sampler },
              { binding: 6, resource: { buffer: selectedSets[set] } }
            ]
          })
        );
        const dispatch = async (pipeline) => {
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          for (const bindGroup of bindGroups) {
            pass.setBindGroup(0, bindGroup);
            pass.dispatchWorkgroups(1);
          }
          pass.end();
          encoder.copyBufferToBuffer(output, 0, readback, 0, outputBytes);
          device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);
          const actual = new Float32Array(readback.getMappedRange()).slice();
          readback.unmap();
          return actual;
        };
        let actual, gpuReference;
        try {
          actual = await dispatch(pipeline);
          gpuReference = await dispatch(referencePipeline);
        } finally {
          referenceLease.release();
        }
        let maxError = 0,
          idealFilterDeviation = 0;
        for (let lane = 0; lane < count; lane++) {
          const expected = reference(graph, inputsFor(ir, lane), lane % 2 ? edits : {}, lane % 2);
          for (const [field, slots] of Object.entries(program.outputs))
            slots.forEach((slot, channel) => {
              const at = lane * program.outputCount + slot;
              const error = Math.abs(actual[at] - gpuReference[at]);
              idealFilterDeviation = Math.max(
                idealFilterDeviation,
                Math.abs(gpuReference[at] - expected[field][channel])
              );
              if (ir.samples.length === 0)
                check(
                  Math.abs(actual[at] - expected[field][channel]) <= 0.00002,
                  `${name} CPU arithmetic reference mismatch`
                );
              maxError = Math.max(maxError, error);
              check(
                Number.isFinite(error) && error <= 0.0001 + Math.abs(gpuReference[at]) * 0.0001,
                `${name} ${field}/${channel} lane ${lane}: ${actual[at]} != authored GPU ${gpuReference[at]}`
              );
            });
        }
        if (name === "custom") {
          // Oracle-only faulty shader copy, never a production switch or fallback.
          const wrongSource = descriptor.source.replaceAll(
            "return textureSampleGrad(source_texture, source_sampler, uv, dx, dy);",
            "return textureSampleGrad(source_texture, source_sampler, uv, vec2f(0.0), vec2f(0.0));"
          );
          check(
            wrongSource !== descriptor.source,
            "Gradient negative control did not modify the native sample"
          );
          const wrongLease = registry.acquire({ ...descriptor, source: wrongSource });
          try {
            const wrong = await dispatch((await wrongLease.ready).pipeline);
            check(
              wrong.some((v, i) => Math.abs(v - gpuReference[i]) > 0.01),
              "The oracle cannot distinguish missing gradients from correct native shading"
            );
          } finally {
            wrongLease.release();
          }
        }
        return { actual, maxError, idealFilterDeviation };
      };
      const first = await run(initial, initialEdits);
      const stable = await run(initial, initialEdits);
      check(
        first.actual.every((v, i) => v === stable.actual[i]),
        `${name} abort changed the active snapshot`
      );
      const retry = create(updateEdits);
      await retry.ready;
      retry.commit();
      const updated = await run(retry, updateEdits);
      check(
        updated.actual.some((v, i) => Math.abs(v - stable.actual[i]) > 0.01),
        `${name} update branch did not execute`
      );
      check(
        initial.entries[0].programIndex === initial.entries[1].programIndex,
        "Instance data incorrectly created unique programs"
      );
      await initial.retire(device.queue.onSubmittedWorkDone());
      await retry.retire(device.queue.onSubmittedWorkDone());
      results.push({
        name,
        pixelsPerRun: count,
        outputCount: program.outputCount,
        maxAbsoluteError: Math.max(first.maxError, updated.maxError),
        cpuIdealFilterDeviation: Math.max(first.idealFilterDeviation, updated.idealFilterDeviation),
        nativePrograms: 1,
        physicalBindingSets: 2,
        textureQueries: program.textureQueries,
        publicationBytes: initial.constants.size + initial.directory.size + initial.versions.size,
        verified: ir.samples.length
          ? "native graph, C/X/Y, SampleGrad, two physical texture sets, stable/abort/retry/update/fence"
          : "all scalar operations against independent CPU and GPU, stable/abort/retry/update/fence",
        missingGradientNegativeControl: name === "custom" ? "detected" : "not applicable"
      });
    }
    const filtering = await diagnoseNativeMaterialFiltering(device, textures[0], sampler);
    const bindings = await runNativeMaterialBindingsGpuOracle(device);
    return {
      status: "passed",
      scope: "S1 compiler/publication component; not complete SurfaceV4",
      results,
      filtering,
      bindings
    };
  } finally {
    registry.destroy();
    retained.forEach((resource) => resource.destroy());
  }
}

/** Isolate hardware gradient LOD selection from spatial/mip filtering. Marker mips
 * encode level*32/255 as a spatial constant, so interpolated R reveals effective LOD.
 * Diagnostics retain the original CPU mismatch; no tolerance or production math changes. */
async function diagnoseNativeMaterialFiltering(device, sourceTexture, sampler) {
  const marker = device.createTexture({
    size: [dimension, dimension],
    mipLevelCount: mipCount,
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  });
  for (let level = 0; level < mipCount; level++) {
    const size = dimension >> level;
    device.queue.writeTexture(
      { texture: marker, mipLevel: level },
      new Uint8Array(size * size * 4).fill(level * 32),
      { bytesPerRow: size * 4 },
      [size, size]
    );
  }
  const queries = [];
  const cpu = [];
  for (let lane = 0; lane < count; lane++) {
    const scale = [0.007, 0.05, 0.15, 0.35][lane % 4];
    const c = [f(0.12 + lane * 0.013), f(0.18 + lane * 0.007)];
    const rotate = ([u, v]) => [
      f(f(f(Math.cos(0.29)) * f(u * 1.3)) - f(f(Math.sin(0.29)) * f(v * 0.8))),
      f(f(f(Math.sin(0.29)) * f(u * 1.3)) + f(f(Math.cos(0.29)) * f(v * 0.8)))
    ];
    const uv = rotate(c).map((v, axis) => f(v + [0.13, -0.07][axis]));
    const dx = rotate([f(f(c[0] + scale) - c[0]), 0]);
    const dy = rotate([0, f(f(c[1] + scale * 0.8) - c[1])]);
    queries.push(...uv, ...dx, ...dy, 0, 0);
    cpu.push(sample(uv, dx, dy));
  }
  const makeBuffer = (size, usage, data) => {
    const value = device.createBuffer({ size, usage, mappedAtCreation: data !== undefined });
    if (data !== undefined) {
      new Float32Array(value.getMappedRange()).set(data);
      value.unmap();
    }
    return value;
  };
  const input = makeBuffer(queries.length * 4, GPUBufferUsage.STORAGE, queries);
  const output = makeBuffer(count * 12 * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const readback = makeBuffer(count * 12 * 4, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
  try {
    const module = device.createShaderModule({
      code: /* wgsl */ `
@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var marker_texture: texture_2d<f32>;
@group(0) @binding(2) var source_sampler: sampler;
@group(0) @binding(3) var<storage, read> queries: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> values: array<vec4f>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= ${count}u { return; }
  let a = queries[id.x * 2u];
  let b = queries[id.x * 2u + 1u];
  let uv = a.xy;
  let dx = a.zw;
  let dy = b.xy;
  let lod = clamp(log2(max(max(length(dx), length(dy)) * ${dimension}.0, 1e-20)), 0.0, ${mipCount - 1}.0);
  values[id.x * 3u] = textureSampleGrad(source_texture, source_sampler, uv, dx, dy);
  values[id.x * 3u + 1u] = textureSampleLevel(source_texture, source_sampler, uv, lod);
  let grad_lod = textureSampleGrad(marker_texture, source_sampler, uv, dx, dy).r * (255.0 / 32.0);
  let level_lod = textureSampleLevel(marker_texture, source_sampler, uv, lod).r * (255.0 / 32.0);
  values[id.x * 3u + 2u] = vec4f(lod, grad_lod, level_lod, 0.0);
}`
    });
    const pipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module, entryPoint: "main" }
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sourceTexture.createView() },
        { binding: 1, resource: marker.createView() },
        { binding: 2, resource: sampler },
        { binding: 3, resource: { buffer: input } },
        { binding: 4, resource: { buffer: output } }
      ]
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, count * 12 * 4);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    const records = [];
    for (let lane = 0; lane < count; lane++) {
      const base = lane * 12;
      const gradError = Math.max(
        ...cpu[lane].map((value, channel) => Math.abs(value - values[base + channel]))
      );
      const levelError = Math.max(
        ...cpu[lane].map((value, channel) => Math.abs(value - values[base + 4 + channel]))
      );
      records.push({
        lane,
        cpuLod: values[base + 8],
        gradEffectiveLod: values[base + 9],
        levelEffectiveLod: values[base + 10],
        gradCpuError: gradError,
        explicitLevelCpuError: levelError
      });
    }
    check(values.every(Number.isFinite), "Filter diagnostic returned non-finite values");
    return {
      status: "diagnostic",
      method:
        "spatially constant per-mip markers isolate gradient LOD; direct explicit-level samples isolate filtering precision",
      maxGradientCpuError: Math.max(...records.map((r) => r.gradCpuError)),
      maxExplicitLevelCpuError: Math.max(...records.map((r) => r.explicitLevelCpuError)),
      maxGradientLodDeviation: Math.max(...records.map((r) => Math.abs(r.cpuLod - r.gradEffectiveLod))),
      maxExplicitLodDeviation: Math.max(...records.map((r) => Math.abs(r.cpuLod - r.levelEffectiveLod))),
      records
    };
  } finally {
    marker.destroy();
    input.destroy();
    output.destroy();
    readback.destroy();
  }
}
