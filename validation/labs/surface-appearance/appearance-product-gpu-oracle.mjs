// Real production components: graph reconnection -> shared static residency -> publication PSO -> GPU consumer.
// Diagnostic only; the frame Surface has not switched to this path.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { AppearanceProgramRegistry } from "../../../OEngine/.test-dist/gpu/AppearanceProgramRegistry.js";
import { AppearanceStaticResidency } from "../../../OEngine/.test-dist/gpu/AppearanceStaticResidency.js";
import { GpuAppearancePublication } from "../../../OEngine/.test-dist/gpu/GpuAppearancePublication.js";
import { AppearanceGraphBuilder, snapshotAppearanceTexture } from "../../../OEngine/.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../../OEngine/.test-dist/material/AppearanceGraphCompiler.js";
import { bindAppearanceProducts } from "../../../OEngine/.test-dist/material/AppearanceProductBinding.js";
import { evaluateCompiledAppearance } from "../../../OEngine/.test-dist/material/AppearanceGraphEvaluation.js";
import { cookAppearanceMipProduct, sampleAppearanceCookedField } from "../../../OEngine/.test-dist/material/AppearanceMipCooker.js";
import { cookAppearanceNormalProduct } from "../../../OEngine/.test-dist/material/AppearanceNormalCooker.js";
import { writeAppearanceAssetPackage, openAppearanceAssetPackage } from "../../../OEngine/.test-dist/assets/AppearanceAssetPackage.js";
import { ShadeTexture } from "../../../OEngine/.test-dist/texture/ShadeTexture.js";
import { StandardShadeMaterial } from "../../../OEngine/.test-dist/material/StandardShadeMaterial.js";
import { AppearanceMaterialDefinition } from "../../../OEngine/.test-dist/material/AppearanceMaterialDefinition.js";
import { GpuMaterialStore } from "../../../OEngine/.test-dist/gpu/GpuMaterialStore.js";

const runtime = process.argv[2];
if (!runtime) throw new Error("Usage: node validation/labs/surface-appearance/appearance-product-gpu-oracle.mjs <external webgpu runtime directory>");
const { create, globals } = createRequire(resolve(runtime, "package.json"))("webgpu"); Object.assign(globalThis, globals);
const gpu = create(["backend=d3d12"]), adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
assert.ok(adapter); assert.equal(adapter.info.isFallbackAdapter, false);
const device = await adapter.requestDevice(), registry = new AppearanceProgramRegistry(device);
const residency = new AppearanceStaticResidency(device, registry), resources = [], errors = [];
const materialStore = new GpuMaterialStore(device);
device.addEventListener("uncapturederror", event => errors.push(event.error.message));
let disposing = false, lost; device.lost.then(info => { if (!disposing) lost = { reason: info.reason, message: info.message }; });
const artifacts = resolve(".local/validation/surface-appearance"); await mkdir(artifacts, { recursive: true });
const summary = { evidenceRole: "diagnostic", component: "bound-appearance-products", passed: false, cases: [],
  adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description } };
const opts = { width: 5, height: 3, mipCount: 3, byteBudget: 8192, validationProbeBudget: 8192,
  domainMin: [0, 0], domainMax: [1, 1], error: { absolute: 0.005, relative: 0 }, storagePrecision: "float16" };
const packageProduct = async product => openAppearanceAssetPackage(await writeAppearanceAssetPackage(product, {
  uri: "diagnostic/bound-product", contentHash: "a".repeat(64), dependencies: [] }));
const products = new Map();
function source(targetGain, retained = false) {
  const g = new AppearanceGraphBuilder(), uv = g.input("uv", 2, "surface", undefined, "uv0");
  const texture = new ShadeTexture(); texture.appearance_content_version = "diagnostic/shared-source-v1";
  const t = g.texture(snapshotAppearanceTexture(texture, "linear-rgb"), uv);
  const value = g.operation("pow", g.operation("multiply", g.swizzle(t, [0]), g.parameter("sourceGain", 2)), g.constant(2));
  g.output("staticRoot", value);
  g.output("target", g.operation("multiply", g.operation("multiply", value, g.parameter("targetGain", targetGain)), g.input("time", 1, "dynamic")));
  if (retained) g.output("sourceFallback", g.swizzle(t, [1]));
  return compileAppearanceGraph(g.build());
}
const originals = [source(0.5), source(1.25)];
const plainProduct = cookAppearanceMipProduct(originals[0], { baked: originals[0].outputs.staticRoot }, { ...opts, sample: () => [0.5, 0.25, 0.8, 1] });
const plainAsset = await packageProduct(plainProduct); products.set(plainAsset.runtime.manifest.assetId, plainProduct);
const bound = originals.map(p => bindAppearanceProducts(p, [{ source: p, asset: plainAsset, roots: { baked: p.outputs.staticRoot } }]));
const retainedSource = source(0.75, true), retained = bindAppearanceProducts(retainedSource,
  [{ source: retainedSource, asset: plainAsset, roots: { baked: retainedSource.outputs.staticRoot } }]);
const ng = new AppearanceGraphBuilder(), nuv = ng.input("uv", 2, "surface", undefined, "uv0");
const ns = ng.texture(snapshotAppearanceTexture(new ShadeTexture(), "linear-rgb"), nuv);
ng.output("normalTS", ng.swizzle(ns, [0, 1, 2])); ng.output("roughness", ng.constant(0.5));
ng.output("coatNormalTS", ng.combine(ng.swizzle(ns, [0]), ng.constant(0), ng.constant(1))); ng.output("coatRoughness", ng.constant(0.5));
const np = compileAppearanceGraph(ng.build()), pairs = [["base", "normalTS", "roughness"], ["coat", "coatNormalTS", "coatRoughness"]]
  .map(([momentField, normalOutput, roughnessOutput]) => ({ momentField, normalOutput, roughnessOutput, normal: np.outputs[normalOutput],
    roughness: np.outputs[roughnessOutput], maxAngleRadians: 0.01, maxRoughnessError: 0.025 }));
const normalProduct = cookAppearanceNormalProduct(np, pairs, { ...opts,
  sample: (_binding, uv) => uv[0] < 0.5 ? [0.6, 0, 0.8, 1] : [-0.6, 0, 0.8, 1] });
const normalAsset = await packageProduct(normalProduct); products.set(normalAsset.runtime.manifest.assetId, normalProduct);
const normalBound = bindAppearanceProducts(np, [{ source: np, asset: normalAsset }]);
const cg = new AppearanceGraphBuilder(); cg.output("hdr", cg.parameter("hdr", [16, -0, 0.25]));
const cp = compileAppearanceGraph(cg.build()), cProduct = cookAppearanceMipProduct(cp, { exact: cp.outputs.hdr }, { ...opts, sample: () => [] });
const cAsset = await packageProduct(cProduct), constantBound = bindAppearanceProducts(cp, [{ source: cp, asset: cAsset, roots: { exact: cp.outputs.hdr } }]);
const dg = new AppearanceGraphBuilder(), duv = dg.input("uv", 2, "surface", undefined, "uv0");
dg.output("field", dg.operation("add", dg.operation("multiply", dg.swizzle(duv, [0]), dg.constant(0.02)), dg.constant(2)));
const dp = compileAppearanceGraph(dg.build()), dProduct = cookAppearanceMipProduct(dp, { mapped: dp.outputs.field },
  { ...opts, domainMin: [2, 4], domainMax: [6, 8], error: { absolute: 0.05, relative: 0 }, sample: () => [] });
const dAsset = await packageProduct(dProduct); products.set(dAsset.runtime.manifest.assetId, dProduct);
const domainBound = bindAppearanceProducts(dp, [{ source: dp, asset: dAsset, roots: { mapped: dp.outputs.field } }]);

const events = () => ({ callbacks: [], addOne(fn) { this.callbacks.push(fn); }, send() { for (const fn of this.callbacks.splice(0)) fn(); } });
function command(encoder) {
  const done = {}; done.promise = new Promise((yes, no) => { done.resolve = yes; done.reject = no; });
  return { device, closed: false, gpuDone: done.promise, onBeforeFinish: events(), onFinished: events(), onAborted: events(),
    allocateTextureUploadBuffer(data) {
      const b = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.COPY_SRC, mappedAtCreation: true });
      new Uint8Array(b.getMappedRange()).set(new Uint8Array(data)); b.unmap(); resources.push(b); return b;
    }, copyBufferToTexture(source, destination, size) { encoder.copyBufferToTexture(source, destination, size); },
    writeBuffer(buffer, offset, data, start, length) {
      const b = this.allocateTextureUploadBuffer(data.slice(start, start + length)); encoder.copyBufferToBuffer(b, 0, buffer, offset, length);
    }, finish() { this.onBeforeFinish.send(); device.queue.submit([encoder.finish()]); this.closed = true; this.onFinished.send();
      device.queue.onSubmittedWorkDone().then(done.resolve, done.reject); }, abort() { this.closed = true; this.onAborted.send(); } };
}
function buffer(data, usage = GPUBufferUsage.STORAGE) {
  const b = device.createBuffer({ size: Math.max(data.byteLength, 16), usage: usage | GPUBufferUsage.COPY_DST });
  if (data.byteLength) device.queue.writeBuffer(b, 0, data); resources.push(b); return b;
}
const sampler = device.createSampler({ addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", minFilter: "linear", magFilter: "linear", mipmapFilter: "linear" });
const dummy = device.createTexture({ size: [1, 1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING }); resources.push(dummy);
const fieldModule = device.createShaderModule({ code: `
@group(0) @binding(0) var<storage, read> fields: array<vec4u>;
@group(0) @binding(1) var<storage, read> directory: array<vec4u>;
@group(0) @binding(2) var<storage, read_write> results: array<vec4u>;
@group(0) @binding(3) var<uniform> count: vec4u;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= count.x { return; }
  let identity = directory[id.x * 2u]; let entry = directory[id.x * 2u + 1u];
  for (var field = 0u; field < entry.z; field++) {
    let value = fields[entry.y + field];
    results[entry.y + field] = vec4u(identity.x, value.y, value.z, value.x);
  }
}` });
const fieldLayout = device.createBindGroupLayout({ entries: [0, 1, 2, 3].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE,
  buffer: { type: binding === 3 ? "uniform" : binding === 2 ? "storage" : "read-only-storage" } })) });
const fieldPipeline = await device.createComputePipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: [fieldLayout] }),
  compute: { module: fieldModule, entryPoint: "main" } });
async function run(name, programs, tolerance, materials) {
  const encoder = device.createCommandEncoder({ label: name }), c = command(encoder);
  let stage;
  if (materials) {
    stage = materialStore.stage(materials.map(material => ({ material, programId: 0, textureBindingSetId: 0 })),
      new Map(materials.map(material => [material, new Map()])), c);
    programs = stage.appearancePrograms;
  }
  const sources = programs.map((program, i) => ({ materialSlot: stage?.associationSlots[i] ?? i + 5, program,
    fieldVersions: stage?.appearanceFieldVersions[i], textureBindingSetId: 0, textureRefs: new Map() }));
  const publication = new GpuAppearancePublication(device, registry, sources, c, new Map(), new Map(), undefined, residency);
  try {
    await publication.ready;
    const first = publication.entries[0], lanes = 256, inputCount = first.kernel.inputVectorCount, outputCount = first.kernel.lowered.outputCount;
    assert.ok(publication.entries.every(entry => entry.programIndex === first.programIndex && entry.resourceSetIndex === first.resourceSetIndex));
    const inputs = new Float32Array(Math.max(lanes * inputCount * 4, 4)), tasks = new Uint32Array(lanes * 4), expected = [];
    for (let lane = 0; lane < lanes; lane++) {
      const entry = publication.entries[lane % programs.length], domain = entry.program.productReads?.find(read => read.uv !== null)?.asset;
      const normalized = [(lane % 37) / 36, (lane % 19) / 18];
      const uv = normalized.map((n, axis) => Math.fround(domain ? domain.domainMin[axis] + n * (domain.domainMax[axis] - domain.domainMin[axis]) : n));
      const time = Math.fround(0.25 + lane / 173), lod = (lane % 9) / 4, values = { uv, time: [time] };
      entry.program.inputs.forEach((input, i) => inputs.set(values[input.name], (lane * inputCount + i) * 4));
      let gradient = entry.program.inputs.length;
      for (const s of entry.program.samples) { inputs.set([0.001, 0, 0, 0, 0, 0.001, 0, 0], (lane * inputCount + gradient) * 4); gradient += 2; }
      for (const read of entry.program.productReads ?? []) {
        if (read.field.constant !== undefined) continue;
        const mip = read.field.mips[0], span = read.asset.domainMax.map((n, i) => n - read.asset.domainMin[i]);
        inputs.set([span[0] * 2 ** lod / mip.width, 0, 0, 0, 0, span[1] * 2 ** lod / mip.height, 0, 0], (lane * inputCount + gradient) * 4); gradient += 2;
      }
      tasks.set([entry.constantBase, entry.routeBase, lane * inputCount, lane * outputCount], lane * 4);
      const result = evaluateCompiledAppearance(entry.program, { inputs: values, sample: binding => binding.fallback,
        sampleProduct(index, coords) { const read = entry.program.productReads[index], mapped = coords.map((n, axis) =>
          (n - read.asset.domainMin[axis]) / (read.asset.domainMax[axis] - read.asset.domainMin[axis]));
          return sampleAppearanceCookedField(products.get(read.asset.runtime.manifest.assetId).fields[read.field.name], ...mapped, lod); } });
      expected.push(...Object.values(result).flat());
    }
    const taskBuffer = buffer(tasks), inputBuffer = buffer(inputs), dispatch = buffer(new Uint32Array([lanes, 0, 0, 0]), GPUBufferUsage.UNIFORM);
    const output = device.createBuffer({ size: lanes * outputCount * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readback = device.createBuffer({ size: output.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }); resources.push(output, readback);
    const compiled = publication.program(first.programIndex), pass = encoder.beginComputePass(); pass.setPipeline(compiled.pipeline);
    pass.setBindGroup(0, device.createBindGroup({ layout: compiled.layouts[0], entries: [publication.constants, publication.routes, taskBuffer, inputBuffer, output, dispatch]
      .map((buffer, binding) => ({ binding, resource: { buffer } })) }));
    if (first.kernel.descriptor.groups[1]?.length) pass.setBindGroup(1, device.createBindGroup({ layout: compiled.layouts[1], entries: first.kernel.descriptor.groups[1]
      .map(entry => ({ binding: entry.binding, resource: entry.binding < 9 ? dummy.createView({ dimension: "2d-array" }) : sampler })) }));
    if (first.productTextures.length) pass.setBindGroup(2, device.createBindGroup({ layout: compiled.layouts[2], entries:
      [...first.productTextures.map((texture, binding) => ({ binding, resource: texture.createView({ dimension: "2d-array" }) })),
        { binding: first.productTextures.length, resource: sampler }] }));
    pass.dispatchWorkgroups(4); pass.end(); encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
    const fieldOutput = device.createBuffer({ size: publication.fields.size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const fieldReadback = device.createBuffer({ size: fieldOutput.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    resources.push(fieldOutput, fieldReadback);
    const fieldCount = buffer(new Uint32Array([sources.length, 0, 0, 0]), GPUBufferUsage.UNIFORM);
    const fieldsPass = encoder.beginComputePass(); fieldsPass.setPipeline(fieldPipeline);
    fieldsPass.setBindGroup(0, device.createBindGroup({ layout: fieldLayout,
      entries: [publication.fields, publication.directory, fieldOutput, fieldCount].map((buffer, binding) => ({ binding, resource: { buffer } })) }));
    fieldsPass.dispatchWorkgroups(Math.ceil(sources.length / 64)); fieldsPass.end();
    encoder.copyBufferToBuffer(fieldOutput, 0, fieldReadback, 0, fieldOutput.size); c.finish(); await c.gpuDone;
    await fieldReadback.mapAsync(GPUMapMode.READ); const actualFields = new Uint32Array(fieldReadback.getMappedRange().slice(0)); fieldReadback.unmap();
    const expectedFields = publication.entries.flatMap((entry, i) => Object.entries(entry.kernel.lowered.outputSlots)
      .flatMap(([name, slots]) => [entry.materialSlot, slots[0], slots.length, sources[i].fieldVersions?.get(name).version ?? 1]));
    assert.deepEqual([...actualFields], expectedFields, "GPU directory/field-version consumer must select each association's exact output versions");
    await readback.mapAsync(GPUMapMode.READ); const actual = new Float32Array(readback.getMappedRange().slice(0)); readback.unmap();
    let maximum = 0;
    expected.forEach((value, i) => { const error = Math.abs(actual[i] - value); maximum = Math.max(maximum, error);
      assert.ok(Number.isFinite(actual[i]) && error <= tolerance, `${name} value ${i}: ${actual[i]} vs ${value}`); });
    summary.cases.push({ name, values: expected.length, instances: programs.length, actualPsoCount: new Set(publication.entries.map(entry => entry.programIndex)).size,
      resourceSetCount: new Set(publication.entries.map(entry => entry.resourceSetIndex)).size, liveSourceSamples: first.program.samples.length,
      productTextures: first.productTextures.length, maxAbsoluteError: maximum, declaredFixtureTolerance: tolerance });
    Object.assign(summary.cases.at(-1), { fieldRecords: expectedFields.length / 4,
      sceneMaterialStage: !!stage, fieldVersions: stage ? stage.appearanceFieldVersions.map(fields => Object.fromEntries([...fields].map(([name, field]) => [name, field.version]))) : undefined });
  } catch (error) { if (!c.closed) c.abort(); throw error; } finally { publication.destroy(); }
}
device.pushErrorScope("validation");
try {
  await run("baked-root-dynamic-target-two-materials-one-pso", bound, 0.00001);
  await run("baked-root-and-retained-source-route", [retained], 0.00001);
  await run("independent-base-coat-filtered-products", [normalBound], 0.01);
  await run("exact-hdr-constant-zero-textures", [constantBound], 0.000001);
  await run("nonunit-authored-domain-npot-mips", [domainBound], 0.001);
  const sceneMaterial = new StandardShadeMaterial(); sceneMaterial.is_unlit = true;
  const define = gain => {
    const g = new AppearanceGraphBuilder(), uv = g.input("uv", 2, "surface", undefined, "uv0");
    const texture = new ShadeTexture(); texture.appearance_content_version = "diagnostic/shared-source-v1";
    const t = g.texture(snapshotAppearanceTexture(texture, "linear-rgb"), uv);
    const field = g.operation("pow", g.operation("multiply", g.swizzle(t, [0]), g.parameter("sourceGain", 2)), g.constant(2));
    const target = g.operation("multiply", g.operation("multiply", field, g.parameter("targetGain", gain)), g.input("time", 1, "dynamic"));
    g.output("baseColor", g.combine(target, target, target)); g.output("alpha", g.constant(1));
    return new AppearanceMaterialDefinition(g.build(), [plainAsset]);
  };
  sceneMaterial.appearance_definition = define(0.5);
  await run("authored-scene-material-product-publication", [], 0.00001, [sceneMaterial]);
  sceneMaterial.appearance_definition = define(0.75);
  await run("authored-scene-material-exact-field-republication", [], 0.00001, [sceneMaterial]);
  assert.equal(summary.cases.at(-1).fieldVersions[0].baseColor, 2);
  assert.equal(summary.cases.at(-1).fieldVersions[0].alpha, 1);
  const scope = await device.popErrorScope(); assert.equal(scope, null, scope?.message); assert.deepEqual(errors, []); assert.equal(lost, undefined);
  Object.assign(summary, { passed: true, totalValues: summary.cases.reduce((n, c) => n + c.values, 0),
    qualityScope: "component fixture only; normal GPU interpolation error is measured, not a production quality default" });
  console.log(JSON.stringify(summary, null, 2));
} catch (error) { summary.error = { name: error.name, message: error.message }; throw error; }
finally {
  summary.uncapturedErrors = errors; summary.deviceLost = lost ?? null;
  await writeFile(resolve(artifacts, "product-gpu-oracle.json"), JSON.stringify(summary, null, 2));
  disposing = true; registry.destroy(); residency.destroy(); materialStore.destroy(); for (const r of resources) r.destroy(); device.destroy();
}
