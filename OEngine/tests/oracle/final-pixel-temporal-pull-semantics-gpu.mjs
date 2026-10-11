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
    // Execute the original state_at helper, not a test reimplementation.
    const prefix = NATIVE_TEMPORAL_V2_ANALYZE_WGSL.slice(
      0,
      NATIVE_TEMPORAL_V2_ANALYZE_WGSL.indexOf("@group(0) @binding(7)"),
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
    assert.deepEqual(await runMoments([0, 0, 8192, 8192 ** 2, 0, 0, 8192, 8192 ** 2]), [
      4096,
      4096 ** 2,
      0,
      0,
    ]);
    // Known temporal variances [4, 16, 36, 64] average to 30, while means
    // [2, 4, 6, 8] average to 5. Spatial mixture variance must not be added.
    assert.deepEqual(await runMoments([2, 8, 4, 32, 6, 72, 8, 128]), [5, 55, 2, 8]);

    const integralHelper = NATIVE_TEMPORAL_V2_RESOLVE_WGSL.match(
      /fn pixel_integral_weight\([\s\S]*?\n}/,
    )?.[0];
    assert.ok(integralHelper);
    const integralPipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: {
        entryPoint: "main",
        module: device.createShaderModule({
          code:
            integralHelper +
            `
@group(0) @binding(0) var<storage, read_write> values: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let jitter = -0.5 + f32(id.x) / 63.0;
  var sums = vec3f(0.0);
  for (var i = -1; i <= 1; i++) {
    let x = f32(i) - jitter;
    let weight = pixel_integral_weight(i, jitter);
    sums += vec3f(1.0, -7.0 * x + 5.0, 13.0 * x * x - 7.0 * x + 5.0) * weight;
  }
  values[id.x] = vec4f(sums, 0.0);
}`,
        }),
      },
    });
    const integrals = buffer(64 * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const integralReadback = buffer(64 * 16, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const integralEncoder = device.createCommandEncoder();
    const integralPass = integralEncoder.beginComputePass();
    integralPass.setPipeline(integralPipeline);
    integralPass.setBindGroup(
      0,
      device.createBindGroup({
        layout: integralPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: integrals } }],
      }),
    );
    integralPass.dispatchWorkgroups(1);
    integralPass.end();
    integralEncoder.copyBufferToBuffer(integrals, 0, integralReadback, 0, 64 * 16);
    device.queue.submit([integralEncoder.finish()]);
    await integralReadback.mapAsync(GPUMapMode.READ);
    const integralValues = new Float32Array(integralReadback.getMappedRange());
    // The antiderivatives over [-.5,.5] give [1,5,5+13/12], independent
    // of sampling phase. This check never evaluates the shader weight formula.
    for (let i = 0; i < 64; i++)
      for (let channel = 0; channel < 3; channel++) {
        const expected = [1, 5, 5 + 13 / 12][channel];
        assert.ok(
          Math.abs(integralValues[i * 4 + channel] - expected) < 2e-6,
          `quadratic integral phase ${i}, channel ${channel}`,
        );
      }
    integralReadback.unmap();

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
    const uploadSeed = (expectedPrevious, current, valid) => {
      const words = new Float32Array(count * 4);
      const flags = new Uint8Array(count * 4);
      for (let i = 0; i < count; i++) {
        words.set([0, 0, expectedPrevious, current], i * 4);
        flags.set([0, valid ? 255 : 0, 0, 0], i * 4);
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
      readback: buffer(count * 16, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
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
    });
    for (const id of [output, analysisId, depthId]) inspect.read(id);
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
    ];
    for (let f = 0; f < cases.length; f++) {
      if (f === 3) {
        const role = owner.readIndex;
        owner.prepareFrame(command, { width, height, reset: false, jitter: [0.25, 0.25] });
        owner.abort();
        assert.equal(owner.readIndex, role);
      }
      if (f) owner.prepareFrame(command, { width, height, reset: false, jitter: [0, 0] });
      uploadSeed(cases[f].expectedPrevious, cases[f].current, f !== 0);
      const readback = f
        ? buffer(count * 16, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST)
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
        assert.equal(Math.abs(values[i * 4]), cases[f].coverage, `frame ${f}, pixel ${i} pull coverage`);
        assert.equal(values[i * 4 + 1], cases[f].current, `frame ${f}, pixel ${i} raw depth history`);
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
      pixelIntegral: "64 phases of constant, linear and quadratic analytic integrals",
      historyFilter: "exact integer and fractional Lanczos at 1080p far corner",
      cachedGraphSubmissions: cases.length,
      extent: [width, height],
      semantics: [
        "expected previous-view z",
        "raw current depth",
        "nearer prior occluder",
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
