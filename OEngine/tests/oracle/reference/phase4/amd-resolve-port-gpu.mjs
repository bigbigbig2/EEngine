import assert from "node:assert/strict";
import { NATIVE_TEMPORAL_RESOLVE_WGSL as REFERENCE } from "./native_temporal.mjs";
import { NATIVE_TEMPORAL_V2_RESOLVE_WGSL as CANDIDATE } from "../../../../.test-dist/shaders/native_temporal_amd.js";
import { packFsr3UpscalerConstants } from "../../../../.test-dist/render/passes/fsr3/Fsr3UpscalerConstants.js";
import { floatToHalf, halfToFloat } from "../../../../.test-dist/loaders/float16.js";

// Frozen source-profile Resolve is independent of the new graph, manual
// interpolation and weight generation. No candidate-dependent golden.
export async function verifyAmdResolvePort(device, buffer, texture) {
  const formatBoundary = await verifyFormatBoundary(device, buffer, texture);
  const width = 23,
    height = 13,
    count = width * height;
  const frame = buffer(48, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  const sourceFrame = buffer(160, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  const weights = buffer(96, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  const currentP = buffer(16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const previousP = buffer(16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const color = texture(width, height, "rgba16float");
  const seed = texture(width, height, "rgba32float");
  const motion = texture(width, height, "rg32float");
  const previous = texture(width, height, "rgba16float");
  const rawLuma = texture(width, height, "rgba16float");
  const lumaHistory = texture(width, height, "rgba16float");
  const analysis = texture(width, height, "rgba8unorm");
  const sourceMasks = texture(width, height, "rgba8unorm");
  const exposure = texture(1, 1, "r32float");
  const farthest = texture(Math.ceil(width / 2), Math.ceil(height / 2), "rgba16float");
  const outputs = [0, 1].map(() => texture(width, height, "rgba16float", GPUTextureUsage.STORAGE_BINDING));
  const lumaOutputs = [0, 1].map(() =>
    texture(width, height, "rgba16float", GPUTextureUsage.STORAGE_BINDING),
  );
  const values = buffer(count * 64, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const target = buffer(count * 256, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
  const trace = [0, 1].map(() => buffer(count * 96, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC));
  const instrument = (code) =>
    code
      .replace("  let transformed =", "  let original_history_color = history_color;\n  let transformed =")
      .replace(
        "@compute @workgroup_size(8, 8, 1)",
        "@group(0) @binding(18) var<storage, read_write> trace: array<vec4f>;\n@compute @workgroup_size(8, 8, 1)",
      )
      .replace(
        "textureStore(current_history, pixel, vec4f(result, lock));",
        `
    let base = (id.y * ${width}u + id.x) * 6u;
    trace[base] = vec4f(motion, accumulation, farthest);
    trace[base + 1u] = vec4f(sampled.color, sampled.weight);
    trace[base + 2u] = vec4f(sampled.box.center, sampled.history_weight);
    trace[base + 3u] = vec4f(sampled.box.variance, instability);
    trace[base + 4u] = vec4f(original_history_color, lock);
    trace[base + 5u] = vec4f(result, alpha);
    textureStore(current_history, pixel, vec4f(result, lock));
  `,
      );
  const pipelines = await Promise.all(
    [REFERENCE, CANDIDATE].map(instrument).map((code) =>
      device.createComputePipelineAsync({
        layout: "auto",
        compute: { module: device.createShaderModule({ code }), entryPoint: "main" },
      }),
    ),
  );
  const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
  const tex = (binding, value) => ({ binding, resource: value.createView() });
  const buf = (binding, value) => ({ binding, resource: { buffer: value } });
  const groups = [
    device.createBindGroup({
      layout: pipelines[0].getBindGroupLayout(0),
      entries: [
        buf(0, sourceFrame),
        tex(1, color),
        tex(2, motion),
        tex(3, sourceMasks),
        tex(4, previous),
        { binding: 5, resource: sampler },
        tex(6, outputs[0]),
        tex(9, exposure),
        tex(10, rawLuma),
        tex(11, lumaHistory),
        tex(13, lumaOutputs[0]),
        tex(14, farthest),
        buf(15, weights),
        buf(18, trace[0]),
      ],
    }),
    device.createBindGroup({
      layout: pipelines[1].getBindGroupLayout(0),
      entries: [
        buf(0, frame),
        tex(1, color),
        tex(2, seed),
        tex(3, analysis),
        tex(4, previous),
        buf(5, currentP),
        tex(6, outputs[1]),
        buf(8, previousP),
        tex(9, exposure),
        tex(10, rawLuma),
        tex(11, lumaHistory),
        tex(13, lumaOutputs[1]),
        tex(14, farthest),
        { binding: 17, resource: sampler },
        buf(18, trace[1]),
        buf(15, weights),
      ],
    }),
  ];
  const reader = await device.createComputePipelineAsync({
    layout: "auto",
    compute: {
      entryPoint: "main",
      module: device.createShaderModule({
        code: `
@group(0) @binding(0) var a: texture_2d<f32>;
@group(0) @binding(1) var b: texture_2d<f32>;
@group(0) @binding(2) var c: texture_2d<f32>;
@group(0) @binding(3) var d: texture_2d<f32>;
@group(0) @binding(4) var<storage, read_write> out: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
 let s = textureDimensions(a); if (id.x >= s.x * s.y) { return; }
 let p = vec2i(vec2u(id.x % s.x, id.x / s.x));
 out[id.x * 4u] = textureLoad(a, p, 0); out[id.x * 4u + 1u] = textureLoad(b, p, 0);
 out[id.x * 4u + 2u] = textureLoad(c, p, 0); out[id.x * 4u + 3u] = textureLoad(d, p, 0);
}`,
      }),
    },
  });
  const readGroup = device.createBindGroup({
    layout: reader.getBindGroupLayout(0),
    entries: [
      tex(0, outputs[0]),
      tex(1, outputs[1]),
      tex(2, lumaOutputs[0]),
      tex(3, lumaOutputs[1]),
      buf(4, values),
    ],
  });
  const scenarios = [
    { jitter: [0, 0], motion: [0, 0], p: 1, valid: false, confidence: 0 },
    { jitter: [0.49, -0.49], motion: [0, 0], p: 0.25, valid: true, confidence: 1 },
    { jitter: [-0.49, 0.49], motion: [0.375, -0.25], p: 4, valid: true, confidence: 1 },
    {
      jitter: [0.25, -0.25],
      motion: [-0.375, 0.125],
      p: 1,
      valid: true,
      confidence: 1 / 3,
      reactive: 0.5,
      disocclusion: 0.5,
    },
    { jitter: [2.7, -1.2], motion: [-1.25, 0.75], p: 1, valid: true, confidence: 1, change: 0.7 },
    { jitter: [-1.3, 2.4], motion: [0.5, 0.25], p: 0.25, valid: true, confidence: 1 },
    { jitter: [0.49, 0.49], motion: [0, 0], p: 0.25, valid: true, confidence: 1, uniform: 8192 },
    { jitter: [0, 0], motion: [0, 0], p: 1e-4, valid: false, confidence: 0, uniform: 1e8 },
  ];
  let maximumRelativeError = 0,
    compared = 0;
  for (const test of scenarios) {
    const priorJitter = [-0.125, 0.125];
    const data = new ArrayBuffer(48);
    new Uint32Array(data).set([width, height, Number(test.valid), 0]);
    new Float32Array(data).set([...test.jitter, ...priorJitter, 1 / 60], 4);
    device.queue.writeBuffer(frame, 0, data);
    device.queue.writeBuffer(currentP, 0, new Float32Array([test.p, 0, 0, 0]));
    device.queue.writeBuffer(previousP, 0, new Float32Array([1, 0, 0, 0]));
    device.queue.writeBuffer(
      sourceFrame,
      0,
      packFsr3UpscalerConstants({
        renderSize: [width, height],
        previousFrameRenderSize: [width, height],
        upscaleSize: [width, height],
        previousFrameUpscaleSize: [width, height],
        maxRenderSize: [width, height],
        maxUpscaleSize: [width, height],
        deviceToViewDepth: [0, 0.1, 1, 1],
        jitterOffset: test.jitter,
        previousFrameJitterOffset: priorJitter,
        motionVectorScale: [-1, -1],
        downscaleFactor: [1, 1],
        motionVectorJitterCancellation: [0, 0],
        tanHalfFOV: 1,
        jitterPhaseCount: 8,
        deltaTime: 1 / 60,
        deltaPreExposure: test.p,
        viewSpaceToMetersFactor: 1,
        frameIndex: Number(test.valid),
        velocityFactor: 1,
        reactivenessScale: 1,
        shadingChangeScale: 1,
        accumulationAddedPerFrame: 1 / 3,
        minDisocclusionAccumulation: -1 / 3,
      }),
    );
    const weightData = new Float32Array(24);
    for (let y = -1; y <= 1; y++)
      for (let x = -1; x <= 1; x++) {
        const i = (y + 1) * 3 + x + 1;
        const d = Math.fround(
          Math.fround((x - test.jitter[0]) ** 2) + Math.fround((y - test.jitter[1]) ** 2),
        );
        weightData[i] = Math.exp(-2.3 * d);
        const v = Math.min(d, 4),
          a = 0.4 * v - 1,
          b = 0.25 * v - 1;
        weightData[12 + i] = (1.5625 * a * a - 0.5625) * b * b;
      }
    device.queue.writeBuffer(weights, 0, weightData);
    const colors = new Uint16Array(count * 4),
      histories = new Uint16Array(count * 4),
      luma = new Uint16Array(count * 4),
      lumaHist = new Uint16Array(count * 4);
    const seeds = new Float32Array(count * 4),
      motions = new Float32Array(count * 2),
      masks = new Uint8Array(count * 4),
      qualifications = new Uint8Array(count * 4);
    const lanes = [test.reactive ?? 0, test.disocclusion ?? 0, test.change ?? 0, test.confidence].map((v) =>
      Math.round(v * 255),
    );
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const radiance = test.uniform ?? (x === 11 ? 128 : 0.125 + 0.04 * x + 0.025 * y);
        const rgb = [1, 0.8, 0.3].map((c) => radiance * c * test.p);
        colors.set([...rgb.map(floatToHalf), floatToHalf(1)], i * 4);
        histories.set([0.2 + 0.05 * x, 0.1 + 0.03 * y, 0.3, 1.8].map(floatToHalf), i * 4);
        luma[i * 4] = floatToHalf(rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722);
        lumaHist.set([0.3, 0.2, 0.5, 0.4].map(floatToHalf), i * 4);
        seeds.set(
          [
            (-test.motion[0] + test.jitter[0] - priorJitter[0]) / width,
            (-test.motion[1] + test.jitter[1] - priorJitter[1]) / height,
            2,
            2,
          ],
          i * 4,
        );
        motions.set([test.motion[0] / width, test.motion[1] / height], i * 2);
        masks.set(lanes, i * 4);
        qualifications.set([255 - lanes[1], lanes[0], lanes[2], lanes[3]], i * 4);
      }
    for (const [image, words, stride] of [
      [color, colors, 8],
      [previous, histories, 8],
      [rawLuma, luma, 8],
      [lumaHistory, lumaHist, 8],
      [seed, seeds, 16],
      [motion, motions, 8],
      [sourceMasks, masks, 4],
      [analysis, qualifications, 4],
    ])
      device.queue.writeTexture({ texture: image }, words, { bytesPerRow: width * stride }, [width, height]);
    device.queue.writeTexture({ texture: exposure }, new Float32Array([0.05]), { bytesPerRow: 4 }, [1, 1]);
    const far = new Uint16Array(Math.ceil(width / 2) * Math.ceil(height / 2) * 4);
    for (let i = 0; i < far.length; i += 4) far[i] = floatToHalf(2);
    device.queue.writeTexture({ texture: farthest }, far, { bytesPerRow: Math.ceil(width / 2) * 8 }, [
      Math.ceil(width / 2),
      Math.ceil(height / 2),
    ]);
    const encoder = device.createCommandEncoder();
    for (let i = 0; i < 2; i++) {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipelines[i]);
      pass.setBindGroup(0, groups[i]);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      pass.end();
    }
    const pass = encoder.beginComputePass();
    pass.setPipeline(reader);
    pass.setBindGroup(0, readGroup);
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.end();
    encoder.copyBufferToBuffer(values, 0, target, 0, count * 64);
    for (let i = 0; i < 2; i++)
      encoder.copyBufferToBuffer(trace[i], 0, target, count * 64 + i * count * 96, count * 96);
    device.queue.submit([encoder.finish()]);
    await target.mapAsync(GPUMapMode.READ);
    const actual = new Float32Array(target.getMappedRange());
    for (let i = 0; i < count; i++)
      for (let pair = 0; pair < 2; pair++)
        for (let c = 0; c < 4; c++) {
          const a = actual[i * 16 + pair * 8 + c],
            b = actual[i * 16 + pair * 8 + 4 + c];
          assert.ok(Number.isFinite(a) && Number.isFinite(b));
          const relative = Math.abs(a - b) / Math.max(1e-3, Math.abs(a));
          maximumRelativeError = Math.max(maximumRelativeError, relative);
          assert.ok(
            relative <= 0.003,
            `AMD source profile ${JSON.stringify(test)} pixel ${i}/${pair}/${c}: ${a} vs ${b}; trace ${JSON.stringify([0, 1].map((v) => Array.from(actual.subarray(count * 16 + v * count * 24 + i * 24, count * 16 + v * count * 24 + i * 24 + 24))))}`,
          );
          compared++;
        }
    target.unmap();
  }
  return {
    revision: "c6efa6bf7f2027b3ec94f28578bb5965eabb9e55",
    formatBoundary,
    scenarios: scenarios.length,
    compared,
    maximumRelativeError,
    reference:
      "Frozen complete reconstruction/lock/four-frame luma/rectification/accumulation shader; CPU radial weights; manual point filtering on candidate",
  };
}

// Verify the real storage conversion independently of the elided-boundary
// helper. This is a format profile check, not a TAA threshold adjustment.
async function verifyFormatBoundary(device, buffer, texture) {
  const inputs = new Float32Array([
    0, 0.33333333, 2.7673865, 0.98237574, 1.1, 0.9999916, -0.33333333, -2.7673865, -0.98237574, -1.1,
    -0.9999916, 1e-5, -1e-5, 1e-7, -1e-7, 65504,
  ]);
  const input = buffer(inputs.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  device.queue.writeBuffer(input, 0, inputs);
  const stored = texture(inputs.length, 1, "r16float", GPUTextureUsage.STORAGE_BINDING);
  const output = buffer(inputs.length * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const target = buffer(inputs.length * 16, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
  const helper = CANDIDATE.slice(CANDIDATE.indexOf("fn half_value("), CANDIDATE.indexOf("fn bilinear("));
  const producer = await device.createComputePipelineAsync({
    layout: "auto",
    compute: {
      module: device.createShaderModule({
        code: `
@group(0) @binding(0) var<storage, read> input: array<f32>;
@group(0) @binding(1) var stored: texture_storage_2d<r16float, write>;
@compute @workgroup_size(32) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < arrayLength(&input)) { textureStore(stored, vec2i(i32(id.x), 0), vec4f(input[id.x], 0, 0, 0)); }
}`,
      }),
      entryPoint: "main",
    },
  });
  const consumer = await device.createComputePipelineAsync({
    layout: "auto",
    compute: {
      module: device.createShaderModule({
        code: `
${helper}
@group(0) @binding(0) var<storage, read> input: array<f32>;
@group(0) @binding(1) var stored: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> output: array<vec4f>;
@compute @workgroup_size(32) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < arrayLength(&input)) {
    let v = input[id.x];
    output[id.x] = vec4f(half_value(v), textureLoad(stored, vec2i(i32(id.x), 0), 0).x,
      unpack2x16float(pack2x16float(vec2f(v, 0))).x, v);
  }
}`,
      }),
      entryPoint: "main",
    },
  });
  const encoder = device.createCommandEncoder();
  for (const [pipeline, entries] of [
    [
      producer,
      [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: stored.createView() },
      ],
    ],
    [
      consumer,
      [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: stored.createView() },
        { binding: 2, resource: { buffer: output } },
      ],
    ],
  ]) {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
    pass.dispatchWorkgroups(1);
    pass.end();
  }
  encoder.copyBufferToBuffer(output, 0, target, 0, inputs.length * 16);
  device.queue.submit([encoder.finish()]);
  await target.mapAsync(GPUMapMode.READ);
  const actual = new Float32Array(target.getMappedRange());
  let nearestDifferences = 0;
  let packDifferences = 0;
  for (let i = 0; i < inputs.length; i++) {
    const magnitude = Math.abs(inputs[i]);
    const step = magnitude < 2 ** -14 ? 2 ** -24 : 2 ** (Math.floor(Math.log2(magnitude)) - 10);
    const expected = magnitude === 0 ? 0 : Math.sign(inputs[i]) * Math.floor(magnitude / step) * step;
    assert.equal(actual[i * 4], expected, `Explicit half truncation ${inputs[i]}`);
    assert.equal(actual[i * 4], actual[i * 4 + 1], `Selected source R16 storage boundary ${inputs[i]}`);
    if (actual[i * 4] !== halfToFloat(floatToHalf(inputs[i]))) nearestDifferences++;
    if (actual[i * 4] !== actual[i * 4 + 2]) packDifferences++;
  }
  target.unmap();
  assert.ok(
    nearestDifferences > 0,
    "Negative control must distinguish CPU nearest conversion from source storage",
  );
  return {
    samples: inputs.length,
    nearestDifferences,
    packDifferences,
    profile: "explicit toward-zero half; actual R16 store/load; CPU exponent-step oracle",
  };
}
