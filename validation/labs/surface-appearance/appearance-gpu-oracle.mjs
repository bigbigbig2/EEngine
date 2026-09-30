// Diagnostic component oracle only. Does not publish accepted browser/performance evidence.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { AppearanceGraphBuilder } from "../../../OEngine/.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../../OEngine/.test-dist/material/AppearanceGraphCompiler.js";
import { evaluateCompiledAppearance } from "../../../OEngine/.test-dist/material/AppearanceGraphEvaluation.js";
import { compileCanonicalMaterial } from "../../../OEngine/.test-dist/material/CanonicalMaterial.js";
import { StandardShadeMaterial } from "../../../OEngine/.test-dist/material/StandardShadeMaterial.js";
import { ShadeTexture } from "../../../OEngine/.test-dist/texture/ShadeTexture.js";
import { ShadeImage } from "../../../OEngine/.test-dist/texture/ShadeImage.js";
import { Sampler2D } from "../../../OEngine/.test-dist/texture/Sampler2D.js";
import { lowerAppearanceWgsl } from "../../../OEngine/.test-dist/shaders/appearance_program.js";

const runtime = process.argv[2];
if (!runtime) throw new Error("Usage: node validation/labs/surface-appearance/appearance-gpu-oracle.mjs <external webgpu runtime directory>");
const requireRuntime = createRequire(resolve(runtime, "package.json"));
const { create, globals } = requireRuntime("webgpu");
Object.assign(globalThis, globals);
const gpu = create(["backend=d3d12"]);
const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
assert.ok(adapter, "real D3D12 hardware adapter required");
assert.equal(adapter.info.isFallbackAdapter, false, "software fallback must not pass a hardware oracle");
const device = await adapter.requestDevice();
const uncaptured = [];
device.addEventListener("uncapturederror", event => uncaptured.push(event.error.message));
let lostDuringRun;
let disposing = false;
device.lost.then(info => { if (!disposing) lostDuringRun = { reason: info.reason, message: info.message }; });
const summary = { evidenceRole: "diagnostic", backend: "d3d12", adapter: {
  vendor: adapter.info.vendor, architecture: adapter.info.architecture,
  device: adapter.info.device, description: adapter.info.description,
  isFallbackAdapter: adapter.info.isFallbackAdapter
}, cases: [], passed: false };
const directory = resolve(".local/validation/surface-appearance");
await mkdir(directory, { recursive: true });

function fixedMaterial(unlit = false) {
  const m = new StandardShadeMaterial();
  m.is_unlit = unlit;
  const texture = () => ShadeTexture.from(ShadeImage.fromSampler2D(
    new Sampler2D(new Uint8Array([51, 102, 179, 153]), 4, 1, 1)));
  for (const role of ["texture_albedo", "texture_normal", "texture_orm", "texture_occlusion", "texture_emissive"])
    m[role] = texture();
  m.diffuse_color.set(0.3, 0.6, 0.9, 0.8); m.metallic_factor = 0.7; m.roughness_factor = 0.4;
  m.normal_scale = 0.3; m.ambient_factors.a = 0.6; m.emissive_factor.set(2, 0.5, 0.1);
  if (!unlit) {
    for (const role of ["texture_specular", "texture_specular_color", "texture_clearcoat", "texture_clearcoat_roughness", "texture_clearcoat_normal"])
      m[role] = texture();
    m.ior_factor = 1.8; m.specular_factor = 0.75; m.specular_color_factor.set(0.4, 0.5, 0.6);
    m.clearcoat_factor = 0.9; m.clearcoat_roughness_factor = 0.5; m.clearcoat_normal_scale = 0.7;
    m.specular_uv_set = 1; m.clearcoat_normal_uv_set = 2;
  }
  return m;
}
function operations() {
  const g = new AppearanceGraphBuilder();
  const x = g.input("x", 4, "dynamic", { low: 0.05, high: 1.5 });
  const y = g.input("y", 1, "view", { low: 0.1, high: 0.9 });
  for (const op of ["add", "subtract", "multiply", "divide", "min", "max", "pow"]) g.output(op, g.operation(op, x, y));
  for (const op of ["sin", "cos", "abs", "sqrt"]) g.output(op, g.operation(op, x));
  g.output("clamp", g.operation("clamp", x, g.constant(0.2), g.constant(1.2)));
  g.output("mix", g.operation("mix", x, g.constant([0.8, 0.3, 0.2, 0.1]), y));
  return compileAppearanceGraph(g.build());
}
const dungeon = new StandardShadeMaterial();
dungeon.texture_orm = dungeon.texture_occlusion = ShadeTexture.from(ShadeImage.fromSampler2D(
  new Sampler2D(new Uint8Array([51, 102, 179, 153]), 4, 1, 1)));
const zero = fixedMaterial(); zero.diffuse_color.set(0, 0, 0, 0.7); zero.normal_scale = 0; zero.clearcoat_factor = 0;
const cases = [
  ["complete-standard-coated", compileCanonicalMaterial(fixedMaterial()).appearance],
  ["unlit", compileCanonicalMaterial(fixedMaterial(true)).appearance],
  ["dungeon-orm-alias", compileCanonicalMaterial(dungeon).appearance],
  ["zero-rgb-alpha-normal-scale", compileCanonicalMaterial(zero).appearance],
  ["all-ir-operations", operations()]
];

function storage(label, data, usage = GPUBufferUsage.STORAGE) {
  const bytes = Math.max(data.byteLength, 4);
  const buffer = device.createBuffer({ label, size: bytes, usage: usage | GPUBufferUsage.COPY_DST });
  if (data.byteLength > 0) device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}
const srgb = value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const sample = binding => [51, 102, 179, 153].map((value, channel) =>
  binding.decode === "srgb-rgb" && channel < 3 ? srgb(value / 255) : value / 255);

async function run(name, program) {
  const lowered = lowerAppearanceWgsl(program), lanes = 256;
  const inputs = new Float32Array(Math.max(lanes * program.inputs.length * 4, 1));
  const contexts = Array.from({ length: lanes }, (_, lane) => {
    const values = { uv0: [0.2 + lane / 1024, 0.7], uv1: [0.3, 0.1], uv2: [0.9, 0.8],
      vertexColor: [0.1 + lane / 300, 0.7, 0.9],
      x: [0.05 + lane / 256, 0.3 + lane / 512, 0.6, 1.3], y: [0.1 + lane / 320] };
    program.inputs.forEach((input, index) => values[input.name].forEach((value, channel) => {
      inputs[(lane * program.inputs.length + index) * 4 + channel] = value;
    }));
    return { inputs: values, sample };
  });
  const inputBuffer = storage(`${name}/inputs`, inputs);
  const constants = storage(`${name}/constants`, new Float32Array(lowered.constants));
  const outputBytes = lanes * lowered.outputCount * 4;
  const outputs = device.createBuffer({ label: `${name}/outputs`, size: outputBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ label: `${name}/readback`, size: outputBytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const sampler = device.createSampler({ minFilter: "nearest", magFilter: "nearest", mipmapFilter: "nearest" });
  const textures = program.samples.map((value, index) => {
    const texture = device.createTexture({ label: `${name}/source-${index}`, size: [1, 1],
      format: value.binding.decode === "srgb-rgb" ? "rgba8unorm-srgb" : "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture }, new Uint8Array([51, 102, 179, 153]), { bytesPerRow: 4 }, [1, 1]);
    return texture;
  });
  const textureCode = program.samples.map((value, index) => `
@group(0) @binding(${4 + index}) var source_${index}: texture_2d<f32>;
fn appearance_sample_${index}(uv: vec2f) -> vec4f {
  return textureSampleLevel(source_${index}, source_sampler, uv, 0.0);
}`).join("\n");
  const source = `
@group(0) @binding(0) var<storage, read> input_values: array<vec4f>;
@group(0) @binding(1) var<storage, read> constant_values: array<f32>;
@group(0) @binding(2) var<storage, read_write> output_values: array<f32>;
${textures.length ? "@group(0) @binding(3) var source_sampler: sampler;" : ""}
var<private> current_lane: u32;
fn appearance_input(index: u32, channel: u32) -> f32 {
  return input_values[current_lane * ${program.inputs.length}u + index][channel];
}
fn appearance_constant(index: u32) -> f32 { return constant_values[index]; }
${textureCode}
${lowered.source}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= ${lanes}u { return; }
  current_lane = id.x;
  let result = appearance_evaluate();
  for (var i = 0u; i < ${lowered.outputCount}u; i++) {
    output_values[id.x * ${lowered.outputCount}u + i] = result[i];
  }
}`;
device.pushErrorScope("validation");
  let scopeOpen = true;
  try {
    const module = device.createShaderModule({ label: name, code: source });
    const messages = (await module.getCompilationInfo()).messages;
    assert.equal(messages.filter(message => message.type === "error").length, 0,
      JSON.stringify(messages.map(message => ({ type: message.type, message: message.message }))));
    const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
    const entries = [inputBuffer, constants, outputs].map((buffer, binding) => ({ binding, resource: { buffer } }));
    if (textures.length) entries.push({ binding: 3, resource: sampler });
    textures.forEach((texture, index) => entries.push({ binding: 4 + index, resource: texture.createView() }));
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(lanes / 64); pass.end();
    encoder.copyBufferToBuffer(outputs, 0, readback, 0, outputBytes);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const actual = new Float32Array(readback.getMappedRange());
    let maxError = 0;
    for (let lane = 0; lane < lanes; lane++) {
      const expected = evaluateCompiledAppearance(program, contexts[lane]);
      for (const [field, slots] of Object.entries(lowered.outputSlots)) slots.forEach((slot, channel) => {
        const wanted = expected[field][channel], found = actual[lane * lowered.outputCount + slot];
        const error = Math.abs(wanted - found); maxError = Math.max(error, maxError);
        // Covers hardware sRGB conversion and WGSL transcendental tolerances. No image quality claim.
        assert.ok(error <= 0.002 * Math.max(1, Math.abs(wanted)), `${name} lane=${lane} ${field}[${channel}]: ${found} != ${wanted}`);
      });
    }
    readback.unmap();
    const validation = await device.popErrorScope();
    scopeOpen = false;
    assert.equal(validation, null, validation?.message);
    summary.cases.push({ name, passed: true, lanes, values: lanes * lowered.outputCount,
      textureSamplesPerLane: textures.length, maxError });
  } finally {
    if (scopeOpen) await device.popErrorScope();
    for (const texture of textures) texture.destroy();
    for (const buffer of [inputBuffer, constants, outputs, readback]) buffer.destroy();
  }
}
try {
  for (const [name, program] of cases) await run(name, program);
  await device.queue.onSubmittedWorkDone();
  assert.deepEqual(uncaptured, []);
  assert.equal(lostDuringRun, undefined, "device loss invalidates numeric evidence");
  summary.passed = true;
} catch (error) {
  summary.error = String(error?.stack ?? error);
  throw error;
} finally {
  disposing = true;
  device.destroy();
  summary.uncaptured = uncaptured;
  summary.deviceLoss = lostDuringRun ?? null;
  await writeFile(resolve(directory, "gpu-oracle.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}
