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
} from "../../.test-dist/shaders/native_temporal_amd.js";
import { floatToHalf } from "../../.test-dist/loaders/float16.js";
import { verifyAmdResolvePort } from "./reference/phase4/amd-resolve-port-gpu.mjs";

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
    const sourcePort = await verifyAmdResolvePort(device, buffer, texture);
    const width = 19;
    const height = 13;
    const count = width * height;
    // Instrument the actual Resolve entry point; only its stores change. This
    // observes its primary reprojection rather than duplicating its math.
    let projectionCode = NATIVE_TEMPORAL_V2_RESOLVE_WGSL.replace(
      "@group(0) @binding(6) var current_history: texture_storage_2d<rgba16float, write>;",
      "@group(0) @binding(16) var<storage, read_write> projection: array<vec4f>;",
    );
    const bodyEnd = projectionCode.indexOf(
      "  let existing = inside(reprojected_uv);",
      projectionCode.indexOf("fn main("),
    );
    assert.ok(bodyEnd > 0);
    projectionCode =
      projectionCode.slice(0, bodyEnd) +
      `
  projection[id.y * frame.size.x + id.x] = vec4f(reprojected_uv * vec2f(frame.size) - 0.5, -motion * vec2f(frame.size));
}`;
    const projectionLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
        { binding: 16, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
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
    const projectionIds = ["Native Temporal V2/frame", "seed"].map((name) => {
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
            { binding: 0, resource: { buffer: resources.get(projectionIds[0]) } },
            { binding: 2, resource: resources.get(projectionIds[1]).createView() },
            { binding: 16, resource: { buffer: projections } },
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
    for (const id of projectionIds) if (id >= 0) inspect.read(id);
    writtenReadback = inspect.write(readbackId);
    inspect.make_side_effect();
    compiled = graph.compile();
    assert.deepEqual(
      compiled
        .dump()
        .passes.filter((pass) => !pass.culled)
        .map((pass) => pass.name),
      [
        "Native Temporal V2/Measure",
        "Native Temporal V2/Exposure",
        "Native Temporal V2/Analyze",
        "Native Temporal V2/Resolve",
        "FSR3/RCAS",
        "test-only semantic readback",
      ],
    );
    const submitted = [];
    // Source separation law: with previous depth 1 and d = 2*Ksep*halfViewport*z,
    // the four equal samples yield confidence 1/2. Exercise the real Analyze
    // writer's soft response, not just its saturated accept/reject endpoints.
    const separationScale = 1.37e-5 * Math.hypot(width * 0.5, height * 0.5);
    const cases = [
      { expectedPrevious: 2, current: 2, coverage: 0 },
      { expectedPrevious: 2, current: 3, coverage: 1 },
      { expectedPrevious: 3, current: 1, coverage: 1 },
      { expectedPrevious: 1 / (1 - 2 * separationScale), current: 1, coverage: 0.5 },
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
        const expectedConfidence = neighbor ? 0 : cases[f].coverage;
        if (expectedConfidence === 0 || expectedConfidence === 1) {
          assert.equal(Math.abs(values[i * 4]), expectedConfidence, `frame ${f}, pixel ${i} pull confidence`);
        } else {
          assert.ok(
            Math.abs(values[i * 4] - expectedConfidence) <= 1 / 255,
            `frame ${f}, pixel ${i} source separation confidence, including RGBA8 quantization`,
          );
        }
        assert.equal(
          values[i * 4 + 1],
          neighbor ? 4 : cases[f].current,
          `frame ${f}, pixel ${i} raw depth history`,
        );
      }
    }
    owner.destroy();
    assert.equal(owner.allocatedBytes, count * 46 + 196, "last consumer fence still owns histories");
    releaseRetirement();
    await retirement;
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(owner.allocatedBytes, 0);
    return {
      status: "passed",
      sourcePort,
      historyFilter:
        "Complete AMD source-profile Resolve versus manual point filtering and CPU radial weights",
      primaryProjection:
        "actual Resolve entry point uses each pixel's own Seed with a nearer independently moving neighbor",
      cachedGraphSubmissions: cases.length,
      extent: [width, height],
      semantics: [
        "expected previous-view z",
        "raw current depth",
        "nearer prior occluder",
        "source depth separation soft confidence at one half",
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
