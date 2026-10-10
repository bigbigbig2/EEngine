import assert from "node:assert/strict";
import { FrameGraph, FrameGraphContext } from "../../.test-dist/framegraph/FrameGraph.js";
import { Fsr3LumaPyramidPass } from "../../.test-dist/render/passes/fsr3/Fsr3LumaPyramidPass.js";
import {
  SOURCE_WGSL,
  REDUCE_F32_WGSL,
  QUANTIZE_MIP5_WGSL,
  FRAME_INFO_WGSL,
} from "./fixtures/fsr3-luma-reference.mjs";

// Separate old per-mip execution provides bit-exact fp16 format conversion and
// shader-math expectations independently of the new local tile algorithm.
function encodeReference(device, encoder, resources, input) {
  const make = (code, entries) => {
    const layout = device.createBindGroupLayout({ entries });
    return device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module: device.createShaderModule({ code }), entryPoint: "main" },
    });
  };
  const sampled = (binding) => ({ binding, visibility: 4, texture: { sampleType: "unfilterable-float" } });
  const stored = (binding, format) => ({
    binding,
    visibility: 4,
    storageTexture: { access: "write-only", format },
  });
  const uniform = (binding) => ({ binding, visibility: 4, buffer: { type: "uniform" } });
  const texture = (width, height, format) => {
    const t = device.createTexture({
      size: [width, height],
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    resources.push(t);
    return t;
  };
  const dispatch = (pipeline, bindings, width, height) => {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: bindings.map((resource, binding) => ({ binding, resource })),
      }),
    );
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
  };
  let width = Math.ceil(input.width / 2),
    height = Math.ceil(input.height / 2);
  const depth = texture(width, height, "r16float");
  let previous = texture(width, height, "rgba32float");
  dispatch(
    make(SOURCE_WGSL, [sampled(0), sampled(1), uniform(2), stored(3, "rgba32float"), stored(4, "r16float")]),
    [
      input.luma.createView(),
      input.depth.createView(),
      { buffer: input.constants },
      previous.createView(),
      depth.createView(),
    ],
    width,
    height,
  );
  const count = Math.min(12, Math.ceil(Math.log2(Math.max(input.width, input.height))));
  const reducePipeline = make(REDUCE_F32_WGSL, [sampled(0), stored(1, "rgba32float")]);
  for (let mip = 1; mip < count; mip++) {
    width = Math.ceil(width / 2);
    height = Math.ceil(height / 2);
    const next = texture(width, height, "rgba32float");
    dispatch(reducePipeline, [previous.createView(), next.createView()], width, height);
    previous = next;
    if (mip === 5 && mip !== count - 1) {
      const quantized = texture(width, height, "rg16float");
      dispatch(
        make(QUANTIZE_MIP5_WGSL, [sampled(0), stored(1, "rg16float")]),
        [previous.createView(), quantized.createView()],
        width,
        height,
      );
      previous = quantized;
    }
  }
  const info = texture(1, 1, "rgba32float");
  dispatch(
    make(FRAME_INFO_WGSL, [sampled(0), sampled(1), uniform(2), stored(3, "rgba32float")]),
    [previous.createView(), input.previous.createView(), { buffer: input.constants }, info.createView()],
    1,
    1,
  );
  return { depth, info };
}

const f32 = Math.fround;
// Independent IEEE round-to-nearest, ties-to-even reference for positive values.
function half(value) {
  if (value === 0) return 0;
  const step = 2 ** Math.max(-24, Math.floor(Math.log2(value)) - 10);
  const units = value / step,
    low = Math.floor(units),
    fraction = units - low;
  return (low + (fraction > 0.5 || (fraction === 0.5 && low % 2) ? 1 : 0)) * step;
}
function reduce(values, width, height) {
  const w = Math.ceil(width / 2),
    h = Math.ceil(height / 2);
  const out = new Float32Array(w * h * 3);
  const load = (x, y, c) => values[(Math.min(y, height - 1) * width + Math.min(x, width - 1)) * 3 + c];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        out[(y * w + x) * 3 + c] = f32(
          f32(
            f32(f32(load(x * 2, y * 2, c) + load(x * 2, y * 2 + 1, c)) + load(x * 2 + 1, y * 2, c)) +
              load(x * 2 + 1, y * 2 + 1, c),
          ) * 0.25,
        );
      }
  return { values: out, width: w, height: h };
}

/** Runs the production FrameGraph and kernels; CPU expectations independently
 * reduce one level at a time, including the SDK's mip5 texture rounding. */
export async function runFsr3LumaPyramidGpuOracle(device) {
  const owner = new Fsr3LumaPyramidPass(device);
  const results = [];
  const readLayout = device.createBindGroupLayout({
    entries: [
      ...[0, 1].map((binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: "unfilterable-float" },
      })),
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    ],
  });
  const readPipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [readLayout] }),
    compute: {
      entryPoint: "main",
      module: device.createShaderModule({
        code: `
@group(0) @binding(0) var depth: texture_2d<f32>;
@group(0) @binding(1) var info: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> output: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(depth);
  if id.x < size.x * size.y { output[id.x + 4u] = textureLoad(depth, vec2i(vec2u(id.x % size.x, id.x / size.x)), 0).x; }
  if id.x == 0u { let v = textureLoad(info, vec2i(0), 0); output[0] = v.x; output[1] = v.y; output[2] = v.z; output[3] = v.w; }
}`,
      }),
    },
  });
  for (const [width, height] of [
    [2, 2],
    [3, 5],
    [9, 17],
    [65, 33],
    [129, 257],
    [1920, 1080],
  ]) {
    const resources = [];
    const texture = (format, w, h, data) => {
      const t = device.createTexture({
        size: [w, h],
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST,
      });
      resources.push(t);
      if (data)
        device.queue.writeTexture(
          { texture: t },
          data,
          { bytesPerRow: w * (format === "r32float" ? 4 : 16) },
          [w, h],
        );
      return t;
    };
    const buffer = (size, usage) => {
      const b = device.createBuffer({ size, usage });
      resources.push(b);
      return b;
    };
    try {
      const luma = new Float32Array(width * height),
        depth = new Float32Array(width * height);
      let reference = new Float32Array(width * height * 3);
      for (let i = 0; i < luma.length; i++) {
        luma[i] = f32(2 ** (((i * 13) % 121) / 8 - 8));
        depth[i] = f32(((i * 17) % 101) / 100);
        reference[i * 3] = Math.max(f32(0.000061), f32(Math.log(luma[i])));
        reference[i * 3 + 1] = luma[i];
        reference[i * 3 + 2] = depth[i];
      }
      const sourceLuma = texture("r32float", width, height, luma);
      const sourceDepth = texture("r32float", width, height, depth);
      const previous = texture("rgba32float", 1, 1, new Float32Array([0, 10000, 0, 0.75]));
      const current = texture("rgba32float", 1, 1);
      const constants = buffer(160, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      const bytes = new ArrayBuffer(160),
        ints = new Int32Array(bytes),
        floats = new Float32Array(bytes);
      ints[0] = width;
      ints[1] = height;
      floats[28] = 1 / 60;
      device.queue.writeBuffer(constants, 0, bytes);
      const first = reduce(reference, width, height);
      const depthExpected = Array.from({ length: first.width * first.height }, (_, i) =>
        half(first.values[i * 3 + 2]),
      );
      const mipCount = Math.min(12, Math.ceil(Math.log2(Math.max(width, height))));
      let reduced = first;
      for (let mip = 1; mip < mipCount; mip++) {
        reduced = reduce(reduced.values, reduced.width, reduced.height);
        if (mip === 5 && mip !== mipCount - 1)
          for (let i = 0; i < reduced.values.length; i += 3) {
            reduced.values[i] = half(reduced.values[i]);
            reduced.values[i + 1] = half(reduced.values[i + 1]);
          }
      }
      const size = (depthExpected.length + 4) * 4;
      const output = buffer(size, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      const readback = buffer(size, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
      const referenceReadback = buffer(size, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
      for (const previousLog of [10000, 0.7]) {
        device.queue.writeTexture(
          { texture: previous },
          new Float32Array([0, previousLog, 0, 0.75]),
          {},
          [1, 1],
        );
        const graph = new FrameGraph("FSR3 independent luma numeric oracle");
        const imported = (name, resource) => graph.import_resource(name, { kind: "imported" }, resource);
        const products = owner.addToGraph(graph, {
          width,
          height,
          currentLuma: imported("luma", sourceLuma),
          farthestDepth: imported("depth", sourceDepth),
          constants: imported("constants", constants),
          previousFrameInfo: imported("previous", previous),
          currentFrameInfo: imported("current", current),
        });
        const consume = graph.add("read actual products", {}, (_, r, c) => {
          const pass = c.encoder.beginComputePass();
          pass.setPipeline(readPipeline);
          pass.setBindGroup(
            0,
            device.createBindGroup({
              layout: readPipeline.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: r.get(products.farthestDepthMip1).createView() },
                { binding: 1, resource: r.get(products.frameInfo).createView() },
                { binding: 2, resource: { buffer: output } },
              ],
            }),
          );
          pass.dispatchWorkgroups(Math.ceil(depthExpected.length / 64));
          pass.end();
          c.encoder.copyBufferToBuffer(output, 0, readback, 0, size);
        });
        consume.read(products.frameInfo);
        consume.read(products.farthestDepthMip1);
        consume.make_side_effect();
        let complete;
        const completion = new Promise((resolve) => {
          complete = resolve;
        });
        const encoder = device.createCommandEncoder();
        graph.execute(new FrameGraphContext({ device, encoder, completion }));
        const reference = encodeReference(device, encoder, resources, {
          width,
          height,
          luma: sourceLuma,
          depth: sourceDepth,
          constants,
          previous,
        });
        const pass = encoder.beginComputePass();
        pass.setPipeline(readPipeline);
        pass.setBindGroup(
          0,
          device.createBindGroup({
            layout: readLayout,
            entries: [
              { binding: 0, resource: reference.depth.createView() },
              { binding: 1, resource: reference.info.createView() },
              { binding: 2, resource: { buffer: output } },
            ],
          }),
        );
        pass.dispatchWorkgroups(Math.ceil(depthExpected.length / 64));
        pass.end();
        encoder.copyBufferToBuffer(output, 0, referenceReadback, 0, size);
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        complete();
        await readback.mapAsync(GPUMapMode.READ);
        const actual = new Float32Array(readback.getMappedRange()).slice();
        readback.unmap();
        await referenceReadback.mapAsync(GPUMapMode.READ);
        const baseline = new Float32Array(referenceReadback.getMappedRange()).slice();
        referenceReadback.unmap();
        for (let i = 0; i < actual.length; i++)
          assert.equal(actual[i], baseline[i], `per-mip reference ${width}x${height}/${i}`);
        const expectedLog =
          previousLog === 10000
            ? reduced.values[0]
            : Math.max(
                0,
                f32(previousLog) + (reduced.values[0] - f32(previousLog)) * (1 - Math.exp(-floats[28])),
              );
        const expectedExposure = 1 / ((78 / 65) * Math.exp(expectedLog) * 8);
        // Below mip5 no implementation-dependent half-format conversion occurs.
        for (const [i, expected] of mipCount <= 6
          ? [
              [0, expectedExposure],
              [1, expectedLog],
              [2, reduced.values[1]],
              [3, 0.75],
            ]
          : [[3, 0.75]]) {
          assert.ok(
            Math.abs(actual[i] - expected) <= 2e-5 * Math.max(1, Math.abs(expected)),
            `${width}x${height} history=${previousLog} info[${i}]: ${actual[i]} != ${expected}`,
          );
        }
      }
      results.push({ width, height, testedHistoryStates: 2 });
    } finally {
      resources.forEach((resource) => resource.destroy());
    }
  }
  return { status: "passed", cases: results };
}
