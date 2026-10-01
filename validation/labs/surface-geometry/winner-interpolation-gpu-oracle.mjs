// Diagnostic hardware-raster oracle for the actual winner owner and consumer.
// No renderer cutover or performance/AAA-quality evidence is claimed here.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { WinnerPrimitiveInterpolation } from "../../../OEngine/.test-dist/render/surface/WinnerPrimitiveInterpolation.js";
import { FRAME_GEOMETRY_WGSL } from "../../../OEngine/.test-dist/gpu/GpuWinnerInterpolationAbi.js";
import { winnerPrimitiveConsumerWgsl } from "../../../OEngine/.test-dist/shaders/winner_primitive_work.js";
import { WINNER_INTERPOLATION_WGSL } from "../../../OEngine/.test-dist/shaders/winner_interpolation.js";
import { homogeneousInterpolationReference, transformPosition, winnerHash } from "../../../OEngine/tests/helpers/homogeneous-interpolation-reference.mjs";

if (!process.argv[2]) throw new Error("Usage: node validation/labs/surface-geometry/winner-interpolation-gpu-oracle.mjs <external webgpu runtime directory>");
const { create, globals } = createRequire(resolve(process.argv[2], "package.json"))("webgpu"); Object.assign(globalThis, globals);
const gpu = create(["backend=d3d12"]), adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
assert.ok(adapter); assert.equal(adapter.info.isFallbackAdapter, false);
const device = await adapter.requestDevice(), resources = [], errors = [];
device.addEventListener("uncapturederror", event => errors.push(event.error.message));
let disposing = false, lost;
void device.lost.then(info => { if (!disposing) lost = { reason: info.reason, message: info.message }; });
const artifacts = resolve(".local/validation/surface-geometry"); await mkdir(artifacts, { recursive: true });
const summary = { evidenceRole: "diagnostic", component: "HomogeneousWinnerInterpolation", passed: false, cases: [],
  adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description } };
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function buffer(dataOrSize, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC) {
  const size = typeof dataOrSize === "number" ? dataOrSize : dataOrSize.byteLength;
  const b = device.createBuffer({ size: Math.max(4, size), usage }); resources.push(b);
  if (typeof dataOrSize !== "number") device.queue.writeBuffer(b, 0, dataOrSize);
  return b;
}
function texture(width, height, format) {
  const t = device.createTexture({ size: [width, height], format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
  resources.push(t); return t;
}
const readback = size => buffer(size, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
async function mapped(b, TypedArray) { await b.mapAsync(GPUMapMode.READ); const a = new TypedArray(b.getMappedRange().slice(0)); b.unmap(); return a; }
async function compute(code, entryPoint = "main") {
  const module = device.createShaderModule({ code });
  const info = await module.getCompilationInfo(); assert.deepEqual(info.messages.filter(m => m.type === "error"), []);
  return device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint } });
}
const preparePipeline = await compute(`
${FRAME_GEOMETRY_WGSL}
struct FramePrepare { matrix: mat4x4f, count: u32, work_count: u32, generation: u32, unused: u32, }
@group(0) @binding(0) var<uniform> settings: FramePrepare;
@group(0) @binding(1) var<storage, read> source: array<vec4f>;
@group(0) @binding(2) var<storage, read> directories: array<FrameGeometryMeshlet>;
@group(0) @binding(3) var<storage, read_write> clips: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> geometry: FrameGeometryDirectory;
@group(0) @binding(5) var<storage, read> triangles: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if id.x < settings.count { clips[id.x] = settings.matrix * source[id.x]; }
  if id.x < settings.work_count { geometry.meshlets[id.x] = directories[id.x]; }
  if id.x == 0u { geometry.work_count = settings.work_count; geometry.generation = settings.generation;
    geometry.vertex_count = settings.count; geometry.triangle_count = arrayLength(&triangles); }
}`);
const consumer = await compute(`${winnerPrimitiveConsumerWgsl()}
struct Output { weights: vec4f, dx: vec4f, dy: vec4f, }
@group(1) @binding(0) var visibility: texture_2d<u32>;
@group(1) @binding(1) var<storage, read_write> output: array<Output>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if any(id.xy >= winner_settings.viewport) { return; }
  let key = textureLoad(visibility, vec2i(id.xy), 0).x;
  let value = winner_interpolate_key(key, vec2f(id.xy) + vec2f(0.5));
  let cached = winner_coefficient_slot(key) != OENGINE_VISIBILITY_KEY_EMPTY;
  output[id.y * winner_settings.viewport.x + id.x] = Output(vec4f(value.weights, f32(value.flags)),
    vec4f(value.dx, select(0.0, 1.0, cached)), vec4f(value.dy, 0.0));
}`);
const rasterModule = device.createShaderModule({ code: `
@group(0) @binding(0) var<storage, read> clips: array<vec4f>;
@group(0) @binding(1) var<storage, read> keys: array<u32>;
struct Vertex { @builtin(position) position: vec4f, @location(0) basis: vec3f,
  @location(1) @interpolate(flat) key: u32, }
@vertex fn vertex(@builtin(vertex_index) id: u32) -> Vertex {
  var basis = vec3f(0.0); basis[id % 3u] = 1.0;
  return Vertex(clips[id], basis, keys[id / 3u]);
}
struct Fragment { @location(0) key: u32, @location(1) basis: vec4f, }
@fragment fn fragment(v: Vertex) -> Fragment { return Fragment(v.key, vec4f(v.basis, 1.0)); }
` });
const raster = await device.createRenderPipelineAsync({ layout: "auto", vertex: { module: rasterModule, entryPoint: "vertex" },
  fragment: { module: rasterModule, entryPoint: "fragment", targets: [{ format: "r32uint" }, { format: "rgba32float" }] },
  primitive: { topology: "triangle-list", cullMode: "none" } });
let owner;
async function run(name, triangles, budget = { dictionaryCapacity: 64, coefficientCapacity: 32, probeLimit: 16, maxBytes: 16384 }, matrix = identity, options = {}) {
  const width = 96, height = 64, positions = new Float32Array(triangles.flatMap(t => t.clips.flat()));
  const keys = new Uint32Array(triangles.map(t => t.key ?? 0)), workCount = Math.max(1, ...Array.from(keys, key => (key & 0xffffff) + 1));
  const directories = new Uint32Array(workCount * 4);
  const packedTriangles = [];
  triangles.forEach((t, i) => {
    const count = (keys[i] >>> 24) + 1;
    directories.set([i * 3, packedTriangles.length, 3, count], (keys[i] & 0xffffff) * 4);
    for (let primitive = 0; primitive < count; primitive++) packedTriangles.push(0x020100);
  });
  const prepareSettings = new ArrayBuffer(80); new Float32Array(prepareSettings, 0, 16).set(matrix);
  new Uint32Array(prepareSettings, 64).set([positions.length / 4, workCount, options.generation ?? 1, 0]);
  const source = buffer(positions), dirs = buffer(directories), settings = buffer(new Uint8Array(prepareSettings), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  const geometry = { directory: buffer(16 + directories.byteLength), clips: buffer(positions.byteLength),
    triangles: buffer(new Uint32Array(packedTriangles)) };
  const visibility = texture(width, height, "r32uint"), basis = texture(width, height, "rgba32float");
  const allocation = owner.prepare({ geometry, visibility: visibility.createView(), width, height, budget });
  const output = buffer(width * height * 48), outputRead = readback(output.size), controlRead = readback(allocation.control.size),
    dictionaryRead = readback(allocation.dictionary.size), coefficientRead = readback(allocation.coefficients.size), clipRead = readback(geometry.clips.size);
  const keyRow = Math.ceil(width * 4 / 256) * 256, basisRow = width * 16;
  const keyRead = readback(keyRow * height), basisRead = readback(basisRow * height);
  const prepareGroup = device.createBindGroup({ layout: preparePipeline.getBindGroupLayout(0), entries:
    [settings, source, dirs, geometry.clips, geometry.directory, geometry.triangles].map((b, binding) => ({ binding, resource: { buffer: b } })) });
  const rasterGroup = device.createBindGroup({ layout: raster.getBindGroupLayout(0), entries:
    [geometry.clips, buffer(keys)].map((b, binding) => ({ binding, resource: { buffer: b } })) });
  const consumerGroup = device.createBindGroup({ layout: consumer.getBindGroupLayout(0), entries:
    [allocation.settings, geometry.directory, geometry.clips, geometry.triangles, allocation.dictionary, allocation.coefficients]
      .map((b, i) => ({ binding: [0, 2, 3, 4, 5, 7][i], resource: { buffer: b } })) });
  const consumerOutput = device.createBindGroup({ layout: consumer.getBindGroupLayout(1), entries: [
    { binding: 0, resource: visibility.createView() }, { binding: 1, resource: { buffer: output } } ] });
  let last;
  device.pushErrorScope("validation");
  for (let frame = 0; frame < (options.frames ?? 1); frame++) {
    const encoder = device.createCommandEncoder({ label: name });
    const prepare = encoder.beginComputePass(); prepare.setPipeline(preparePipeline); prepare.setBindGroup(0, prepareGroup);
    prepare.dispatchWorkgroups(Math.ceil(Math.max(workCount, positions.length / 4) / 64)); prepare.end();
    const pass = encoder.beginRenderPass({ colorAttachments: [
      { view: visibility.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0xffffffff, g: 0, b: 0, a: 0 } },
      { view: basis.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } } ] });
    if (!(options.emptyAfterFirst && frame > 0)) { pass.setPipeline(raster); pass.setBindGroup(0, rasterGroup); pass.draw(positions.length / 4); }
    pass.end(); owner.encode(encoder, allocation);
    const consume = encoder.beginComputePass(); consume.setPipeline(consumer); consume.setBindGroup(0, consumerGroup); consume.setBindGroup(1, consumerOutput);
    consume.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); consume.end();
    for (const [a, b] of [[output, outputRead], [allocation.control, controlRead], [allocation.dictionary, dictionaryRead],
      [allocation.coefficients, coefficientRead], [geometry.clips, clipRead]]) encoder.copyBufferToBuffer(a, 0, b, 0, a.size);
    encoder.copyTextureToBuffer({ texture: visibility }, { buffer: keyRead, bytesPerRow: keyRow }, [width, height]);
    encoder.copyTextureToBuffer({ texture: basis }, { buffer: basisRead, bytesPerRow: basisRow }, [width, height]);
    device.queue.submit([encoder.finish()]);
    const [values, counts, table, coefficients, clips, visibleKeys, hardware] = await Promise.all([
      mapped(outputRead, Float32Array), mapped(controlRead, Uint32Array), mapped(dictionaryRead, Uint32Array),
      mapped(coefficientRead, Float32Array), mapped(clipRead, Float32Array), mapped(keyRead, Uint32Array), mapped(basisRead, Float32Array)]);
    const expectedClips = triangles.map(t => t.clips.map(p => transformPosition(matrix, p.map(Math.fround))));
    const byKey = new Map(triangles.map((t, i) => [keys[i], i]));
    let pixels = 0, cached = 0, maxHardwareError = 0, maxSolveError = 0, maxGradientError = 0, maxSnappedHardwareError = 0;
    const snappedClips = options.checkRasterSnap ? expectedClips.map(triangle => triangle.map(p => {
      const sx = Math.round((p[0] / p[3] * 0.5 + 0.5) * width * 256) / 256;
      const sy = Math.round((0.5 - p[1] / p[3] * 0.5) * height * 256) / 256;
      return [(sx / width * 2 - 1) * p[3], (1 - sy / height * 2) * p[3], p[2], p[3]];
    })) : null;
    expectedClips.flat().forEach((p, i) => p.forEach((v, c) => assert.ok(Math.abs(clips[i * 4 + c] - v) <= 0.000002, `${name} shared transform`)));
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const key = visibleKeys[y * keyRow / 4 + x], base = (y * width + x) * 12, hb = (y * width + x) * 4;
      if (key === 0xffffffff) { assert.equal(values[base + 3], 0); assert.equal(values[base + 7], 0); continue; }
      pixels++;
      if (options.generation === 0) { assert.equal(values[base + 3], 0); continue; }
      const reference = homogeneousInterpolationReference(expectedClips[byKey.get(key)], [x + 0.5, y + 0.5], [width, height]);
      const snappedReference = snappedClips && homogeneousInterpolationReference(snappedClips[byKey.get(key)], [x + 0.5, y + 0.5], [width, height]);
      assert.equal(values[base + 3], reference.flags, `${name} validity at ${x},${y}`);
      cached += values[base + 7];
      for (let c = 0; c < 3; c++) {
        const herror = Math.abs(values[base + c] - hardware[hb + c]), serror = Math.abs(values[base + c] - reference.weights[c]);
        maxHardwareError = Math.max(maxHardwareError, herror); maxSolveError = Math.max(maxSolveError, serror);
        if (snappedReference) {
          const snappedError = Math.abs(hardware[hb + c] - snappedReference.weights[c]);
          maxSnappedHardwareError = Math.max(maxSnappedHardwareError, snappedError);
          assert.ok(snappedError < 0.000002, `${name} hardware must match the independently snapped raster reference: ${snappedError}`);
        }
        // Hardware raster snaps projected vertices to its subpixel grid. This
        // fixture's 2.5e-4 raster budget is independent of the 1e-5 analytic budget.
        assert.ok(herror <= 0.00025 && serror <= 0.00001, `${name} weights at ${x},${y}: hardware ${herror}, solve ${serror}`);
        for (const [offset, derivative] of [[4, reference.dx], [8, reference.dy]]) {
          const error = Math.abs(values[base + offset + c] - derivative[c]); maxGradientError = Math.max(maxGradientError, error);
          assert.ok(error <= 0.000015, `${name} gradient ${error} at ${x},${y}`);
        }
      }
    }
    const occupied = [];
    for (let i = 0; i < table.length; i += 2) if (table[i] !== 0xffffffff) occupied.push(table[i]);
    assert.equal(new Set(occupied).size, occupied.length, "a key must be inserted at most once even under contention");
    assert.equal(counts[0], occupied.length); assert.ok(counts[0] <= budget.dictionaryCapacity);
    const count = Math.min(counts[0], budget.coefficientCapacity);
    assert.equal(counts[2] + counts[3], count); assert.equal(counts[4], Math.ceil(count / 64));
    for (let i = 0; i < table.length; i += 2) if (table[i + 1] !== 0xffffffff) {
      assert.ok(table[i + 1] < count); assert.equal(coefficients[table[i + 1] * 12 + 3], options.generation === 0 ? 0 : 1);
    }
    if (options.expectedEmpty || (options.emptyAfterFirst && frame > 0)) assert.equal(pixels, 0);
    else assert.ok(pixels > 20, `${name} must cover real hardware pixels`);
    if (options.expectDirect) assert.ok(pixels > cached, "pressure must actually consume direct coefficients");
    if (options.expectedUnique !== undefined && pixels) assert.equal(counts[0], options.expectedUnique);
    last = { frame, pixels, cachedPixels: cached, uniquePrimitives: counts[0], requestFailures: counts[1], built: counts[2], invalid: counts[3],
      maxHardwareError, maxSolveError, maxGradientError, maxSnappedHardwareError: snappedClips ? maxSnappedHardwareError : null, bytes: allocation.byteLength };
    summary.cases.push({ name, ...last });
  }
  const scope = await device.popErrorScope(); assert.equal(scope, null, scope?.message); assert.deepEqual(errors, []); assert.equal(lost, undefined);
  owner.release(allocation); return last;
}

async function mathCases() {
  const fixtures = [
    { name: "neighbor-pole", clips: [[-1, -1, 0, 0], [-1, 1, 0, 0], [1, 0, 0, 2]], pixel: [1, 1], viewport: [2, 2], flags: 5 },
    { name: "degenerate", clips: [[0, 0, 0, 1], [0.5, 0.5, 0, 1], [1, 1, 0, 1]], pixel: [32, 32], viewport: [64, 64], flags: 0 },
    { name: "nonfinite", clips: [[NaN, 0, 0, 1], [1, 0, 0, 1], [0, 1, 0, 1]], pixel: [32, 32], viewport: [64, 64], flags: 0 }
  ];
  const regular = [[-0.8, -0.5, 0, 1], [0.7, -0.4, 0, 1.5], [0.2, 0.8, 0, 2]];
  for (const scale of [1e-30, 1e-15, 1, 1e15, 1e30]) fixtures.push({ name: `scale-${scale}`, clips: regular.map(p => p.map(n => Math.fround(n * scale))), pixel: [32, 32], viewport: [64, 64], flags: 7 });
  const inputs = new Float32Array(fixtures.flatMap(f => [...f.clips.flat(), ...f.pixel, ...f.viewport]));
  const pipeline = await compute(`${WINNER_INTERPOLATION_WGSL}
struct Input { a: vec4f, b: vec4f, c: vec4f, point: vec4f, }
struct Output { weights: vec4f, dx: vec4f, dy: vec4f, }
@group(0) @binding(0) var<storage, read> inputs: array<Input>;
@group(0) @binding(1) var<storage, read_write> outputs: array<Output>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= arrayLength(&inputs) { return; }
  let i = inputs[id.x]; let v = winner_interpolate(winner_build_coefficients(i.a, i.b, i.c), i.point.xy, i.point.zw);
  outputs[id.x] = Output(vec4f(v.weights, f32(v.flags)), vec4f(v.dx, 0.0), vec4f(v.dy, 0.0));
}`);
  const output = buffer(fixtures.length * 48), rb = readback(output.size), input = buffer(inputs);
  const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [input, output].map((b, binding) => ({ binding, resource: { buffer: b } })) });
  const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end();
  encoder.copyBufferToBuffer(output, 0, rb, 0, output.size); device.queue.submit([encoder.finish()]); const actual = await mapped(rb, Float32Array);
  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i]; assert.equal(actual[i * 12 + 3], f.flags, f.name);
    if (f.flags) {
      const ref = homogeneousInterpolationReference(f.clips, f.pixel, f.viewport);
      for (const [offset, field] of [[0, "weights"], [4, "dx"], [8, "dy"]]) for (let c = 0; c < 3; c++)
        assert.ok(Math.abs(actual[i * 12 + offset + c] - ref[field][c]) < 0.000002, `${f.name} ${field}`);
    }
    summary.cases.push({ name: f.name, mathValues: 12, flags: f.flags });
  }
}

device.pushErrorScope("validation");
try {
  owner = await WinnerPrimitiveInterpolation.create(device, { observe: true });
  const base = [[-0.8, -0.7, 0.2, 1], [0.9, -0.5, 0.5, 1.5], [-0.1, 1.3, 0.9, 2]];
  await run("perspective", [{ clips: base }], undefined, identity, { frames: 3, expectedUnique: 1, checkRasterSnap: true });
  await run("near-clip", [{ clips: [[-0.8, -0.7, -0.5, 1], ...base.slice(1)] }]);
  await run("side-clip", [{ clips: [[-3, -0.7, 0.2, 1], ...base.slice(1)] }]);
  await run("zero-w", [{ clips: [[-0.5, -0.4, -0.5, 0], ...base.slice(1)] }]);
  await run("negative-w", [{ clips: [[-0.5, -0.4, -0.8, -0.3], ...base.slice(1)] }]);
  await run("mirrored-nonuniform", [{ clips: base }], undefined, [-1.4, 0, 0, 0, 0.2, 0.65, 0, 0, 0, 0, 0.9, 0, 0.1, 0.1, 0, 1]);
  await run("primitive-127", [{ clips: base, key: (127 << 24) | 5 }], undefined, identity, { expectedUnique: 1 });
  await run("winner-only", [{ clips: base, key: 0 }, { clips: base, key: 5 }], undefined, identity, { expectedUnique: 1 });
  await run("generation-zero", [{ clips: base }], undefined, identity, { generation: 0 });
  await run("empty-next-frame", [{ clips: base }], undefined, identity, { frames: 2, emptyAfterFirst: true });
  await run("fully-clipped", [{ clips: base.map(p => [p[0], p[1], -1, p[3]]) }], undefined, identity, { expectedEmpty: true });
  const slots = []; for (let key = 0; slots.length < 6; key++) if ((winnerHash(key) & 15) === 0) slots.push(key);
  const tiled = slots.map((key, i) => ({ key, clips: [[-0.95 + i * 0.3, -0.7, 0.2, 1], [-0.72 + i * 0.3, -0.7, 0.2, 1], [-0.85 + i * 0.3, 0.7, 0.2, 1]] }));
  await run("collision-dedup", tiled, { dictionaryCapacity: 16, coefficientCapacity: 8, probeLimit: 8, maxBytes: 8192 }, identity, { expectedUnique: 6 });
  await run("coefficient-overflow", tiled, { dictionaryCapacity: 16, coefficientCapacity: 2, probeLimit: 8, maxBytes: 8192 }, identity, { expectedUnique: 6, expectDirect: true });
  await run("probe-overflow", tiled, { dictionaryCapacity: 16, coefficientCapacity: 8, probeLimit: 1, maxBytes: 8192 }, identity, { expectedUnique: 1, expectDirect: true });
  await run("dictionary-full", tiled, { dictionaryCapacity: 4, coefficientCapacity: 4, probeLimit: 4, maxBytes: 8192 }, identity, { expectedUnique: 4, expectDirect: true });
  await mathCases();
  const scope = await device.popErrorScope(); assert.equal(scope, null, scope?.message); assert.deepEqual(errors, []); assert.equal(lost, undefined);
  summary.passed = true; console.log(JSON.stringify(summary, null, 2));
} catch (error) { summary.error = { name: error.name, message: error.message }; throw error; }
finally {
  summary.uncapturedErrors = errors; summary.deviceLost = lost ?? null;
  await writeFile(resolve(artifacts, "winner-interpolation-gpu-oracle.json"), JSON.stringify(summary, null, 2));
  disposing = true; owner?.destroy(); for (const resource of resources) resource.destroy(); device.destroy();
}
