import assert from "node:assert/strict";
import {
  FrameGraph,
  FrameGraphContext,
  FrameGraphBindingLayout,
} from "../../.test-dist/framegraph/FrameGraph.js";
import { NativeTemporalV2 } from "../../.test-dist/render/temporal/NativeTemporalV2.js";
import {
  NATIVE_TEMPORAL_V2_ANALYZE_WGSL,
  NATIVE_TEMPORAL_V2_RESOLVE_WGSL,
} from "../../.test-dist/shaders/native_temporal_v2.js";
import { floatToHalf } from "../../.test-dist/loaders/float16.js";

async function verifyOutputPixelDomain(device, buffer, texture) {
  const width = 23,
    height = 13,
    count = width * height;
  const constants = buffer(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  const exposure = buffer(16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const color = texture(width, height, "rgba32float");
  const seed = texture(width, height, "rgba32float");
  const previousColor = texture(width, height, "rgba16float");
  const previousState = texture(width, height, "rg32float");
  const response = texture(width, height, "rgba8unorm");
  const identity = texture(width, height, "rgba32uint");
  const previousDepth = texture(width, height, "r32float");
  const analysis = texture(width, height, "rgba16float", GPUTextureUsage.STORAGE_BINDING);
  const currentDepth = texture(width, height, "r32float", GPUTextureUsage.STORAGE_BINDING);
  const sharpenExposure = texture(1, 1, "r32float", GPUTextureUsage.STORAGE_BINDING);
  const outputColor = texture(width, height, "rgba16float", GPUTextureUsage.STORAGE_BINDING);
  const outputState = texture(width, height, "rg32float", GPUTextureUsage.STORAGE_BINDING);
  const analyzed = buffer(count * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const resolved = buffer(count * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const readback = buffer(count * 32, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
  // Instrument actual entry points after reconstruction. No test version of
  // the shared reconstruction, tile indexing or domain conversion is used.
  const analyzeCode = NATIVE_TEMPORAL_V2_ANALYZE_WGSL.replace(
    "@group(0) @binding(14) var sharpen_exposure: texture_storage_2d<r32float, write>;",
    "@group(0) @binding(14) var sharpen_exposure: texture_storage_2d<r32float, write>;\n@group(0) @binding(15) var<storage, read_write> domain: array<vec4f>;",
  ).replace(
    "textureStore(current_depth, p, vec4f(textureLoad(seed, p, 0).w, 0.0, 0.0, 0.0));",
    "textureStore(current_depth, p, vec4f(textureLoad(seed, p, 0).w, 0.0, 0.0, 0.0));\n  domain[id.y * frame.size.x + id.x] = vec4f(luminance[tile_index(at)], change, illumination, gain_trust);",
  );
  const resolveCode = NATIVE_TEMPORAL_V2_RESOLVE_WGSL.replace(
    "@group(0) @binding(9) var output_state: texture_storage_2d<rg32float, write>;",
    "@group(0) @binding(9) var output_state: texture_storage_2d<rg32float, write>;\n@group(0) @binding(10) var<storage, read_write> domain: array<vec4f>;",
  ).replace(
    "textureStore(output_state, p, vec4f(moments, 0.0, 0.0));",
    "textureStore(output_state, p, vec4f(moments, 0.0, 0.0));\n  domain[id.y * frame.size.x + id.x] = vec4f(current_rgb, moments.x);",
  );
  const makePipeline = (code) =>
    device.createComputePipelineAsync({
      layout: "auto",
      compute: { module: device.createShaderModule({ code }), entryPoint: "main" },
    });
  const analyzePipeline = await makePipeline(analyzeCode);
  const resolvePipeline = await makePipeline(resolveCode);
  const common = [constants, color, seed, previousColor, previousState, exposure, exposure];
  const entries = (resources) =>
    resources.map((resource, binding) => ({
      binding,
      resource: [0, 5, 6].includes(binding) ? { buffer: resource } : resource.createView(),
    }));
  const analyzeGroup = device.createBindGroup({
    layout: analyzePipeline.getBindGroupLayout(0),
    entries: [
      ...entries([...common, response, identity, identity, previousDepth]).filter(
        ({ binding }) => binding !== 3 && binding !== 6,
      ),
      { binding: 11, resource: analysis.createView() },
      { binding: 12, resource: currentDepth.createView() },
      { binding: 14, resource: sharpenExposure.createView() },
      { binding: 15, resource: { buffer: analyzed } },
    ],
  });
  const resolveGroup = device.createBindGroup({
    layout: resolvePipeline.getBindGroupLayout(0),
    entries: [
      ...entries([...common, analysis]),
      { binding: 8, resource: outputColor.createView() },
      { binding: 9, resource: outputState.createView() },
      { binding: 10, resource: { buffer: resolved } },
    ],
  });
  let curvature = 0;
  const radiance = (x, y) => 0.4 + 0.006 * x + 0.004 * y + curvature * (0.0002 * x * x + 0.0001 * y * y);
  const phases = [
    [0, 0],
    [0.49, -0.49],
    [-0.49, 0.49],
    [2.7, -1.2],
    [-1.3, 2.4],
  ];
  for (let phase = 0; phase < phases.length * 2; phase++) {
    curvature = phase < phases.length ? 0 : 1;
    const jitter = phases[phase % phases.length],
      preExposure = [1, 0.25, 4, 1, 0.25][phase % phases.length];
    const frame = new ArrayBuffer(32);
    new Uint32Array(frame).set([width, height, 0, 0]);
    new Float32Array(frame).set([...jitter, ...jitter], 4);
    device.queue.writeBuffer(constants, 0, frame);
    device.queue.writeBuffer(exposure, 0, new Float32Array([preExposure, 0, 0, 0]));
    const source = new Float32Array(count * 4);
    let quantizationError = 0,
      maximum = 0;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const value = radiance(x + 0.5 - jitter[0], y + 0.5 - jitter[1]);
        for (let channel = 0; channel < 3; channel++) {
          const exact = value * [1, 0.8, 0.3][channel];
          const encoded = Math.fround(exact * preExposure);
          source[(y * width + x) * 4 + channel] = encoded;
          quantizationError = Math.max(quantizationError, Math.abs(encoded / preExposure - exact));
          maximum = Math.max(maximum, exact);
        }
      }
    device.queue.writeTexture({ texture: color }, source, { bytesPerRow: width * 16 }, [width, height]);
    const encoder = device.createCommandEncoder();
    for (const [pipeline, group] of [
      [analyzePipeline, analyzeGroup],
      [resolvePipeline, resolveGroup],
    ]) {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      pass.end();
    }
    encoder.copyBufferToBuffer(analyzed, 0, readback, 0, count * 16);
    encoder.copyBufferToBuffer(resolved, 0, readback, count * 16, count * 16);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange());
    // Independent antiderivatives give the affine center value and quadratic
    // curvature / 12, independent of jitter. A coefficient-norm bound covers f32 input and
    // accumulation rounding; no runtime weights are used by this reference.
    const tolerance = quantizationError * 16 + maximum * 64 * 2 ** -23;
    for (let y = 4; y < height - 4; y++)
      for (let x = 4; x < width - 4; x++) {
        const i = y * width + x,
          at = (count + i) * 4;
        const expected = radiance(x + 0.5, y + 0.5) + (curvature * 0.0003) / 12;
        let luma = 0;
        for (let channel = 0; channel < 3; channel++) {
          assert.ok(
            Math.abs(values[at + channel] - expected * [1, 0.8, 0.3][channel]) <= tolerance,
            `output-domain integral phase ${phase}, pixel ${x},${y}, channel ${channel}`,
          );
          luma += values[at + channel] * [0.2126, 0.7152, 0.0722][channel];
        }
        assert.ok(
          Math.abs(values[i * 4] - luma) <= maximum * 4 * 2 ** -23,
          `Analyze/Resolve output-domain agreement phase ${phase}, pixel ${x},${y}`,
        );
        assert.ok(
          Math.abs(values[at + 3] - luma) <= maximum * 4 * 2 ** -23,
          `last reconstructed observation phase ${phase}, pixel ${x},${y}`,
        );
      }
    readback.unmap();
  }
  const resultCode = resolveCode.replace(
    "domain[id.y * frame.size.x + id.x] = vec4f(current_rgb, moments.x);",
    "domain[id.y * frame.size.x + id.x] = vec4f(result, moments.x);",
  );
  const resultPipeline = await makePipeline(resultCode);
  const missingVariancePipeline = await makePipeline(
    resultCode.replace(
      "temporal_sigma * temporal_sigma * temporal_support",
      "temporal_sigma * temporal_sigma * 0.0",
    ),
  );
  const resultEntries = [
    ...entries([...common, analysis]),
    { binding: 8, resource: outputColor.createView() },
    { binding: 9, resource: outputState.createView() },
    { binding: 10, resource: { buffer: resolved } },
  ];
  const resultGroups = [resultPipeline, missingVariancePipeline].map((pipeline) =>
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: resultEntries,
    }),
  );
  const upload = (target, components, words, bytesPerElement) => {
    const values = new words.constructor(count * components);
    for (let i = 0; i < count; i++) values.set(words, i * components);
    device.queue.writeTexture(
      { texture: target },
      values,
      { bytesPerRow: width * components * bytesPerElement },
      [width, height],
    );
  };
  const validFrame = new ArrayBuffer(32);
  new Uint32Array(validFrame).set([width, height, 1, 0]);
  device.queue.writeBuffer(constants, 0, validFrame);
  device.queue.writeBuffer(exposure, 0, new Float32Array([1, 0, 0, 0]));
  upload(color, 4, new Float32Array([0.125, 0.125, 0.125, 1]), 4);
  upload(previousColor, 4, Uint16Array.from([2, 2, 2, 1], floatToHalf), 2);
  const rectificationCases = [
    { name: "observed temporal variation", variance: 4, coverage: 1, change: 0, pipeline: 0, retain: true },
    { name: "zero variation rejects stale color", variance: 0, coverage: 1, change: 0, pipeline: 0 },
    { name: "geometry rejection removes temporal support", variance: 4, coverage: 0, change: 0, pipeline: 0 },
    { name: "reactive rejection removes temporal support", variance: 4, coverage: 1, change: 1, pipeline: 0 },
    { name: "negative control: missing temporal support", variance: 4, coverage: 1, change: 0, pipeline: 1 },
  ];
  for (const test of rectificationCases) {
    upload(previousState, 2, new Float32Array([1, test.variance]), 4);
    upload(analysis, 4, Uint16Array.from([test.coverage, test.change, 0, 0], floatToHalf), 2);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline([resultPipeline, missingVariancePipeline][test.pipeline]);
    pass.setBindGroup(0, resultGroups[test.pipeline]);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
    encoder.copyBufferToBuffer(resolved, 0, readback, 0, count * 16);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange());
    for (let i = 0; i < count; i++) {
      for (let channel = 0; channel < 3; channel++) {
        const value = values[i * 4 + channel];
        assert.ok(
          value >= 0.125 - 2 ** -20 && value <= 2 + 2 ** -20,
          `${test.name}: rectification/accumulation cannot invent radiance`,
        );
        if (test.retain) assert.ok(value > 1, `${test.name}: observed history was erased`);
        else
          assert.ok(Math.abs(value - 0.125) < 2 ** -20, `${test.name}: unsupported stale history survives`);
      }
    }
    readback.unmap();
  }
  // The history estimator must use the mass of real observations, rather than
  // becoming mature after a fixed number of frames unrelated to its weights.
  // Isolate accumulation with broad observed variance and no geometry rejection.
  const massPipeline = await makePipeline(
    resultCode.replace(
      "domain[id.y * frame.size.x + id.x] = vec4f(result, moments.x);",
      "domain[id.y * frame.size.x + id.x] = vec4f(result, confidence);",
    ),
  );
  const massGroup = device.createBindGroup({
    layout: massPipeline.getBindGroupLayout(0),
    entries: resultEntries,
  });
  const observations = [0.5, 0.75, 0.25, 1, 0.5, 0.25, 0.75, 1];
  let priorColor = 0;
  let priorMass = 0;
  let observationSum = 0;
  for (let observation = 0; observation < observations.length; observation++) {
    const current = observations[observation];
    upload(color, 4, new Float32Array([current, current, current, 1]), 4);
    upload(
      previousColor,
      4,
      Uint16Array.from([priorColor, priorColor, priorColor, priorMass], floatToHalf),
      2,
    );
    upload(previousState, 2, new Float32Array([0.5, 16]), 4);
    upload(analysis, 4, Uint16Array.from([1, 0, 0, 0], floatToHalf), 2);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(massPipeline);
    pass.setBindGroup(0, massGroup);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
    encoder.copyBufferToBuffer(resolved, 0, readback, 0, count * 16);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange());
    observationSum += current;
    for (let i = 0; i < count; i++) {
      assert.ok(
        Math.abs(values[i * 4] - observationSum / (observation + 1)) < 0.001,
        `equal stationary observations must have equal mass: frame ${observation}`,
      );
      assert.ok(
        Math.abs(values[i * 4 + 3] - ((observation + 1) * 0.74) / 16) < 0.001,
        `confidence must represent accumulated observation mass: frame ${observation}`,
      );
    }
    priorColor = values[0];
    priorMass = values[3];
    readback.unmap();
  }
  // Illumination comes from two consecutive observations. A deliberately stale
  // color estimate must not turn the real 2x transition into a 4x feedback gain.
  upload(color, 4, new Float32Array([1, 1, 1, 1]), 4);
  upload(previousColor, 4, Uint16Array.from([0.25, 0.25, 0.25, 1], floatToHalf), 2);
  upload(seed, 4, new Float32Array([0, 0, 1, 1]), 4);
  upload(response, 4, new Uint8Array([0, 255, 0, 0]), 1);
  upload(identity, 4, new Uint32Array([1, 1, 1, 1]), 4);
  upload(previousDepth, 1, new Float32Array([1]), 4);
  const observedGains = [];
  for (const priorObservation of [0.5, 1, 2]) {
    upload(previousState, 2, new Float32Array([priorObservation, 0]), 4);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(analyzePipeline);
    pass.setBindGroup(0, analyzeGroup);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
    encoder.copyBufferToBuffer(analyzed, 0, readback, 0, count * 16);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange());
    for (let i = 0; i < count; i++) {
      assert.ok(
        Math.abs(values[i * 4 + 2] - Math.log2(1 / priorObservation)) < 2e-6,
        `illumination must use the previous observation ${priorObservation}, not accumulated color`,
      );
    }
    observedGains.push(values[2]);
    readback.unmap();
  }
  return {
    phases: phases.length,
    extent: [width, height],
    preExposure: [1, 0.25, 4],
    rectification: rectificationCases.map((test) => test.name),
    accumulationMass: observations.length,
    integralProfiles: ["affine", "separable quadratic"],
    observedLogGains: observedGains,
  };
}

// Independent semantic checks for the actual candidate helper and cached graph.
// Synthetic Seed inputs do not establish Native Surface writer integration.
export async function runFinalPixelTemporalPullSemanticsGpuOracle(device) {
  const owned = [];
  const buffer = (size, usage) => {
    const result = device.createBuffer({ size, usage });
    owned.push(result);
    return result;
  };
  const texture = (width, height, format, usage = 0) => {
    const result = device.createTexture({
      size: [width, height],
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | usage,
    });
    owned.push(result);
    return result;
  };
  let owner;
  let compiled;
  let releaseRetirement;
  const retirement = new Promise((resolve) => {
    releaseRetirement = resolve;
  });
  try {
    const outputDomain = await verifyOutputPixelDomain(device, buffer, texture);
    // Execute the original state_at helper, not a test reimplementation.
    const prefix = NATIVE_TEMPORAL_V2_ANALYZE_WGSL.slice(
      0,
      NATIVE_TEMPORAL_V2_ANALYZE_WGSL.indexOf("// One output-pixel estimand"),
    );
    const momentsPipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: {
        entryPoint: "test_moments",
        module: device.createShaderModule({
          code:
            prefix +
            `
@group(0) @binding(7) var<storage, read_write> result: array<vec2f>;
@compute @workgroup_size(1) fn test_moments() {
  result[0] = state_at(vec2f(0.5));
  result[1] = state_at(vec2f(0.25));
}`,
        }),
      },
    });
    const frame = buffer(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const state = texture(2, 2, "rg32float");
    const momentOutput = buffer(16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const momentReadback = buffer(16, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(frame, 0, new Uint32Array([2, 2, 1, 0, 0, 0, 0, 0]));
    const runMoments = async (words) => {
      device.queue.writeTexture({ texture: state }, new Float32Array(words), { bytesPerRow: 16 }, [2, 2]);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(momentsPipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: momentsPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: frame } },
            { binding: 4, resource: state.createView() },
            { binding: 7, resource: { buffer: momentOutput } },
          ],
        }),
      );
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(momentOutput, 0, momentReadback, 0, 16);
      device.queue.submit([encoder.finish()]);
      await momentReadback.mapAsync(GPUMapMode.READ);
      const values = new Float32Array(momentReadback.getMappedRange()).slice();
      momentReadback.unmap();
      return [...values];
    };
    // Four static signals with different means have zero temporal variance.
    assert.deepEqual(await runMoments([0, 0, 8192, 0, 0, 0, 8192, 0]), [4096, 0, 0, 0]);
    // Known temporal variances [4, 16, 36, 64] average to 30, while means
    // [2, 4, 6, 8] average to 5. Spatial mixture variance must not be added.
    assert.deepEqual(await runMoments([2, 4, 4, 16, 6, 36, 8, 64]), [5, 30, 2, 4]);
    // Centered variance preserves uncertainty smaller than the f32 ulp of L^2.
    // The retired raw-second encoding would round 8192^2 + 1 to 8192^2.
    assert.equal(Math.fround(8192 ** 2 + 1), Math.fround(8192 ** 2));
    assert.deepEqual(await runMoments([8192, 1, 8192, 1, 8192, 1, 8192, 1]), [8192, 1, 8192, 1]);

    // Independent pixel-domain history probe at the far corner of 1080p.
    // The integer sample must read exactly its texel; the fractional sample
    // is checked against a CPU sinc integral, without running the resolver.
    const historyHelper = NATIVE_TEMPORAL_V2_RESOLVE_WGSL.match(/fn history_at\([\s\S]*?\n}/)?.[0];
    const lanczosHelper = NATIVE_TEMPORAL_V2_RESOLVE_WGSL.match(/fn lanczos\([\s\S]*?\n}/)?.[0];
    assert.ok(historyHelper && lanczosHelper);
    const historyPipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: {
        entryPoint: "test_history",
        module: device.createShaderModule({
          code:
            prefix +
            lanczosHelper +
            historyHelper +
            `
@group(0) @binding(7) var<storage, read_write> result: array<vec4f>;
@compute @workgroup_size(1) fn test_history() {
  result[0] = history_at(vec2f(1900.0, 1060.0));
  result[1] = history_at(vec2f(1899.75, 1060.0));
}`,
        }),
      },
    });
    const history = texture(1920, 1080, "rgba16float");
    const historyOutput = buffer(32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const historyReadback = buffer(32, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(frame, 0, new Uint32Array([1920, 1080, 1, 0, 0, 0, 0, 0]));
    const signal = [8192, 2048, 5736, 1];
    device.queue.writeTexture(
      { texture: history, origin: [1900, 1060] },
      Uint16Array.from(signal, floatToHalf),
      { bytesPerRow: 8 },
      [1, 1],
    );
    const historyEncoder = device.createCommandEncoder();
    const historyPass = historyEncoder.beginComputePass();
    historyPass.setPipeline(historyPipeline);
    historyPass.setBindGroup(
      0,
      device.createBindGroup({
        layout: historyPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: frame } },
          { binding: 3, resource: history.createView() },
          { binding: 7, resource: { buffer: historyOutput } },
        ],
      }),
    );
    historyPass.dispatchWorkgroups(1);
    historyPass.end();
    historyEncoder.copyBufferToBuffer(historyOutput, 0, historyReadback, 0, 32);
    device.queue.submit([historyEncoder.finish()]);
    await historyReadback.mapAsync(GPUMapMode.READ);
    const historyValues = new Float32Array(historyReadback.getMappedRange()).slice();
    historyReadback.unmap();
    assert.deepEqual([...historyValues.slice(0, 4)], signal);
    const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
    const kernel = (x) => (Math.abs(x) >= 2 ? 0 : sinc(x) * sinc(x / 2));
    const normalization = [-1, 0, 1, 2].reduce((sum, x) => sum + kernel(x - 0.75), 0);
    for (let channel = 0; channel < 4; channel++) {
      const expected = (signal[channel] * kernel(0.25)) / normalization;
      assert.ok(
        Math.abs(historyValues[4 + channel] - expected) <= 2 ** -18 * Math.max(1, expected),
        `fractional 1080p history channel ${channel}`,
      );
    }

    const width = 19;
    const height = 13;
    const count = width * height;
    // Instrument the actual Resolve entry point; only its stores change. This
    // observes its primary reprojection rather than duplicating its math.
    const projectionCode = NATIVE_TEMPORAL_V2_RESOLVE_WGSL.replace(
      "@group(0) @binding(8) var output_color: texture_storage_2d<rgba16float, write>;",
      "@group(0) @binding(10) var<storage, read_write> projection: array<vec4f>;",
    )
      .replace("@group(0) @binding(9) var output_state: texture_storage_2d<rg32float, write>;", "")
      .replace(
        "textureStore(output_color, p, vec4f(result * current_p(), confidence));",
        "projection[id.y * frame.size.x + id.x] = vec4f(history_pixel, pixel_motion);",
      )
      .replace("textureStore(output_state, p, vec4f(moments, 0.0, 0.0));", "");
    assert.ok(projectionCode.includes("projection[id.y"));
    const projectionLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        ...[1, 2, 3, 4, 7].map((binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: binding === 3 ? "float" : "unfilterable-float" },
        })),
        ...[5, 6].map((binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" },
        })),
        { binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    const projectionPipeline = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [projectionLayout] }),
      compute: { module: device.createShaderModule({ code: projectionCode }), entryPoint: "main" },
    });
    const color = texture(width, height, "rgba16float");
    const seed = texture(width, height, "rgba32float");
    const response = texture(width, height, "rgba8unorm");
    const identity = texture(width, height, "rgba32uint");
    const previousIdentity = texture(width, height, "rgba32uint");
    const exposure = buffer(16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(exposure, 0, new Float32Array([1, 0, 0, 0]));
    const colors = new Uint16Array(count * 4);
    const identities = new Uint32Array(count * 4);
    for (let i = 0; i < count; i++) {
      colors.set([floatToHalf(0.5), floatToHalf(0.5), floatToHalf(0.5), floatToHalf(1)], i * 4);
      identities.set([1, 1, 1, 1], i * 4);
    }
    device.queue.writeTexture({ texture: color }, colors, { bytesPerRow: width * 8 }, [width, height]);
    for (const target of [identity, previousIdentity]) {
      device.queue.writeTexture({ texture: target }, identities, { bytesPerRow: width * 16 }, [
        width,
        height,
      ]);
    }
    const neighborPixel = 6 * width + 10;
    const uploadSeed = (expectedPrevious, current, valid, neighbor = false) => {
      const words = new Float32Array(count * 4);
      const flags = new Uint8Array(count * 4);
      for (let i = 0; i < count; i++) {
        words.set(
          [neighbor ? 0.25 / width : 0, neighbor ? 0.25 / height : 0, expectedPrevious, current],
          i * 4,
        );
        flags.set([0, valid ? 255 : 0, 0, 0], i * 4);
      }
      if (neighbor) {
        // A nearer contributor has different motion and unavailable history.
        // The adjacent background must retain its own valid depth/identity
        // reprojection, rather than inherit this contributor's motion/flags.
        words.set([24 / width, 0, 4, 4], neighborPixel * 4);
        flags.set([0, 0, 0, 0], neighborPixel * 4);
      }
      device.queue.writeTexture({ texture: seed }, words, { bytesPerRow: width * 16 }, [width, height]);
      device.queue.writeTexture({ texture: response }, flags, { bytesPerRow: width * 4 }, [width, height]);
    };
    owner = new NativeTemporalV2(device);
    const command = { writeBuffer: (target, offset, data) => device.queue.writeBuffer(target, offset, data) };
    owner.prepareFrame(command, { width, height, reset: true, jitter: [0, 0] });
    const graph = new FrameGraph("Native Temporal V2 cached pull semantic fixture");
    const bindings = new FrameGraphBindingLayout();
    const initial = {
      owner,
      readback: buffer(count * 32, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
    };
    const imported = (name, value) => graph.import_resource(name, { kind: "imported" }, value);
    const output = owner.addToGraph(
      graph,
      {
        width,
        height,
        color: imported("color", color),
        seed: imported("seed", seed),
        response: imported("response", response),
        identity: imported("identity", identity),
        previousIdentity: imported("previousIdentity", previousIdentity),
        preExposure: imported("P", exposure),
        priorExposure: imported("previous P", exposure),
      },
      (name, resolve) => bindings.slot(name, initial, (current) => resolve(current.owner)),
    );
    let analysisId = -1;
    let depthId = -1;
    for (let i = 0; i < graph.resourceNodeCount; i++) {
      const node = graph.getResourceNode(i);
      if (node.name === "Native Temporal V2/analysis") analysisId = i;
      if (node.name === "Native Temporal V2/current depth" && node.version > 0) depthId = i;
    }
    assert.ok(analysisId >= 0 && depthId >= 0);
    const projectionIds = [
      "Native Temporal V2/frame",
      "color",
      "seed",
      "Native Temporal V2/previous color",
      "Native Temporal V2/previous state",
      "P",
      "previous P",
      "Native Temporal V2/analysis",
    ].map((name) => {
      for (let i = 0; i < graph.resourceNodeCount; i++) {
        const node = graph.getResourceNode(i);
        if (node.name === name && node.version === 0) return i;
      }
      throw new Error(`Projection probe lost ${name}`);
    });
    const reader = await device.createComputePipelineAsync({
      layout: "auto",
      compute: {
        entryPoint: "main",
        module: device.createShaderModule({
          code: `
@group(0) @binding(0) var analysis: texture_2d<f32>;
@group(0) @binding(1) var depth: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> values: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(analysis);
  if (id.x >= size.x * size.y) { return; }
  let p = vec2i(vec2u(id.x % size.x, id.x / size.x));
  let facts = textureLoad(analysis, p, 0);
  values[id.x] = vec4f(facts.x, textureLoad(depth, p, 0).x, facts.y, facts.z);
}`,
        }),
      },
    });
    const scratch = buffer(count * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const projections = buffer(count * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const readbackId = graph.import_resource(
      "readback",
      { kind: "imported" },
      bindings.slot("readback", initial, (current) => current.readback),
    );
    let writtenReadback = -1;
    const inspect = graph.add("test-only semantic readback", {}, (_data, resources, context) => {
      const pass = context.encoder.beginComputePass();
      pass.setPipeline(reader);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: reader.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: resources.get(analysisId).createView() },
            { binding: 1, resource: resources.get(depthId).createView() },
            { binding: 2, resource: { buffer: scratch } },
          ],
        }),
      );
      pass.dispatchWorkgroups(Math.ceil(count / 64));
      pass.end();
      context.encoder.copyBufferToBuffer(scratch, 0, resources.get(writtenReadback), 0, count * 16);
      const project = context.encoder.beginComputePass({ label: "test-only Resolve primary projection" });
      project.setPipeline(projectionPipeline);
      project.setBindGroup(
        0,
        device.createBindGroup({
          layout: projectionLayout,
          entries: [
            ...projectionIds.map((id, binding) => ({
              binding,
              resource: [0, 5, 6].includes(binding)
                ? { buffer: resources.get(id) }
                : resources.get(id).createView(),
            })),
            { binding: 10, resource: { buffer: projections } },
          ],
        }),
      );
      project.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      project.end();
      context.encoder.copyBufferToBuffer(
        projections,
        0,
        resources.get(writtenReadback),
        count * 16,
        count * 16,
      );
    });
    for (const id of [output, analysisId, depthId]) inspect.read(id);
    for (const id of projectionIds) inspect.read(id);
    writtenReadback = inspect.write(readbackId);
    inspect.make_side_effect();
    compiled = graph.compile();
    assert.deepEqual(
      compiled
        .dump()
        .passes.filter((pass) => !pass.culled)
        .map((pass) => pass.name),
      [
        "Native Temporal V2/Analyze",
        "Native Temporal V2/Resolve",
        "FSR3/RCAS",
        "test-only semantic readback",
      ],
    );
    const submitted = [];
    const cases = [
      { expectedPrevious: 2, current: 2, coverage: 0 },
      { expectedPrevious: 2, current: 3, coverage: 1 },
      { expectedPrevious: 3, current: 1, coverage: 1 },
      { expectedPrevious: 1, current: 4, coverage: 1 },
      { expectedPrevious: 8, current: 8, coverage: 0 },
      { expectedPrevious: 8, current: 10, coverage: 1, neighbor: true },
    ];
    for (let f = 0; f < cases.length; f++) {
      if (f === 3) {
        const role = owner.readIndex;
        owner.prepareFrame(command, { width, height, reset: false, jitter: [0.25, 0.25] });
        owner.abort();
        assert.equal(owner.readIndex, role);
      }
      if (f)
        owner.prepareFrame(command, {
          width,
          height,
          reset: false,
          jitter: cases[f].neighbor ? [0.25, 0.25] : [0, 0],
        });
      uploadSeed(cases[f].expectedPrevious, cases[f].current, f !== 0, cases[f].neighbor);
      const readback = f
        ? buffer(count * 32, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST)
        : initial.readback;
      const encoder = device.createCommandEncoder();
      const gpuCommand = {
        gpu_encoder: encoder,
        beginComputePass: (descriptor) => encoder.beginComputePass(descriptor),
        copyBufferToBuffer: (...args) => encoder.copyBufferToBuffer(...args),
      };
      compiled.execute(new FrameGraphContext({ device, encoder: gpuCommand, completion: retirement }), {
        owner,
        readback,
      });
      device.queue.submit([encoder.finish()]);
      const fence = device.queue.onSubmittedWorkDone();
      owner.commit(fence.then(() => retirement));
      submitted.push({ readback, fence });
      // Deliberately do not wait: queue-ordered ping-pong has three frames in flight.
      if (f === 2) await Promise.all(submitted.map((frame) => frame.fence));
    }
    for (let f = 0; f < submitted.length; f++) {
      const { readback, fence } = submitted[f];
      await fence;
      await readback.mapAsync(GPUMapMode.READ);
      const values = new Float32Array(readback.getMappedRange()).slice();
      readback.unmap();
      for (let i = 0; i < count; i++) {
        const neighbor = cases[f].neighbor && i === neighborPixel;
        const pixel = [i % width, Math.floor(i / width)];
        const motion = neighbor ? [23.75, -0.25] : [0, 0];
        const projection = values.subarray(count * 4 + i * 4, count * 4 + i * 4 + 4);
        for (let axis = 0; axis < 2; axis++) {
          assert.ok(
            Math.abs(projection[axis] - (pixel[axis] - motion[axis])) <= 2 ** -18,
            `frame ${f}, pixel ${i} own-pixel history coordinate`,
          );
          assert.ok(
            Math.abs(projection[2 + axis] - motion[axis]) <= 2 ** -18,
            `frame ${f}, pixel ${i} own-pixel motion`,
          );
        }
        assert.equal(
          Math.abs(values[i * 4]),
          neighbor ? 0 : cases[f].coverage,
          `frame ${f}, pixel ${i} pull coverage`,
        );
        assert.equal(
          values[i * 4 + 1],
          neighbor ? 4 : cases[f].current,
          `frame ${f}, pixel ${i} raw depth history`,
        );
      }
    }
    owner.destroy();
    assert.equal(owner.allocatedBytes, count * 40 + 52, "last consumer fence still owns histories");
    releaseRetirement();
    await retirement;
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(owner.allocatedBytes, 0);
    return {
      status: "passed",
      moments: ["zero-variance HDR edge", "known within-pixel variances"],
      outputDomain,
      reconstruction:
        "actual Analyze/Resolve entry points preserve affine pixel integrals across five jitter/P phases",
      historyFilter: "exact integer and fractional Lanczos at 1080p far corner",
      primaryProjection:
        "actual Resolve entry point uses each pixel's own Seed with a nearer independently moving neighbor",
      cachedGraphSubmissions: cases.length,
      extent: [width, height],
      semantics: [
        "expected previous-view z",
        "raw current depth",
        "nearer prior occluder",
        "nearby foreground motion cannot replace the current pixel's Seed",
        "abort preserves role",
        "three queue-ordered submissions",
        "fence retirement",
      ],
    };
  } finally {
    releaseRetirement();
    owner?.destroy();
    await device.queue.onSubmittedWorkDone();
    compiled?.destroy();
    for (const resource of owned) resource.destroy();
  }
}
