import assert from "node:assert/strict";
import { FrameGraph, FrameGraphContext } from "../../.test-dist/framegraph/FrameGraph.js";
import { NativeTemporalV2 } from "../../.test-dist/render/temporal/NativeTemporalV2.js";
import { Fsr3UpscalerRuntime as BeforeRuntime } from "./reference/phase4/Fsr3UpscalerRuntime.mjs";
import {
  NATIVE_TEMPORAL_V2_MEASURE_WGSL,
  NATIVE_TEMPORAL_V2_EXPOSURE_WGSL,
  NATIVE_TEMPORAL_V2_ANALYZE_WGSL,
  NATIVE_TEMPORAL_V2_RESOLVE_WGSL,
} from "../../.test-dist/shaders/native_temporal_amd.js";
import { NATIVE_TEMPORAL_RESOLVE_WGSL as BEFORE_RESOLVE } from "./reference/phase4/native_temporal.mjs";
import { floatToHalf } from "../../.test-dist/loaders/float16.js";

// One actual chain per encoder. The reference is test-only; inputs are analytic
// in unjittered screen space and independent of either temporal implementation.
export async function runFinalPixelTemporalPullGpuOracle(device) {
  for (const code of [
    NATIVE_TEMPORAL_V2_MEASURE_WGSL,
    NATIVE_TEMPORAL_V2_EXPOSURE_WGSL,
    NATIVE_TEMPORAL_V2_ANALYZE_WGSL,
    NATIVE_TEMPORAL_V2_RESOLVE_WGSL,
  ]) {
    const info = await device.createShaderModule({ code }).getCompilationInfo();
    assert.deepEqual(
      info.messages.filter((message) => message.type === "error"),
      [],
    );
  }
  const depthPipeline = await device.createRenderPipelineAsync({
    layout: "auto",
    vertex: {
      module: device.createShaderModule({
        code: `
@vertex fn main(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);
}`,
      }),
      entryPoint: "main",
    },
    fragment: {
      module: device.createShaderModule({
        code: `
@group(0) @binding(0) var depth:texture_2d<f32>;
@fragment fn main(@builtin(position) p:vec4f)->@builtin(frag_depth) f32 {
 return textureLoad(depth,vec2i(p.xy),0).x;
}`,
      }),
      entryPoint: "main",
      targets: [],
    },
    depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" },
  });
  const reader = await device.createComputePipelineAsync({
    layout: "auto",
    compute: {
      module: device.createShaderModule({
        code: `
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var<storage,read_write> values:array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 let s=textureDimensions(source);if(id.x>=s.x*s.y){return;}
 values[id.x]=textureLoad(source,vec2i(vec2u(id.x%s.x,id.x/s.x)),0);
}`,
      }),
      entryPoint: "main",
    },
  });
  const cases = [];
  const gateFailures = [];
  const strictGateFailures = [];
  const HALF_COMPARISON_FLOOR = 2 ** -10;
  // User-authorized engineering margins, not a claim of perceptual equivalence.
  // Energy and static stability retain the original floor-only comparison.
  const qualityPolicy = {
    comparisonFloor: HALF_COMPARISON_FLOOR,
    aggregateRmseRelativeMargin: 0.01,
    frameRmseRelativeMargin: 0.03,
    energyAndPhaseRelativeMargin: 0,
  };
  function compareQuality(label, actual, reference, relativeMargin = 0) {
    const strictLimit = reference + HALF_COMPARISON_FLOOR;
    const limit = reference + Math.max(HALF_COMPARISON_FLOOR, reference * relativeMargin);
    if (actual > strictLimit) {
      strictGateFailures.push(`${label}: ${actual} > ${reference}`);
    }
    if (!Number.isFinite(actual) || !Number.isFinite(reference) || actual > limit) {
      gateFailures.push(`${label}: ${actual} > ${reference} (limit ${limit})`);
    }
  }
  const traceCode = NATIVE_TEMPORAL_V2_RESOLVE_WGSL.replace(
    "@group(0) @binding(6) var current_history: texture_storage_2d<rgba16float, write>;",
    "@group(0) @binding(19) var<storage, read_write> trace: array<vec4f>;",
  )
    .replace("@group(0) @binding(13) var output_luma_history: texture_storage_2d<rgba16float, write>;", "")
    .replace("textureStore(output_luma_history, pixel, data.history);", "")
    .replace(
      "textureStore(current_history, pixel, vec4f(result, lock));",
      `
  let index = (id.y * frame.size.x + id.x) * 5u;
  trace[index] = vec4f(ycocg_to_rgb(sampled.color) / exposure(), thin);
  trace[index + 1u] = vec4f(result, lock);
  trace[index + 2u] = vec4f(sampled.box.center, motion.x);
  trace[index + 3u] = vec4f(sampled.box.variance, instability);
  trace[index + 4u] = qualified;`,
    );
  assert.ok(traceCode.includes("trace[index]"));
  const traceLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      ...[1, 2, 3, 4, 9, 10, 11, 14].map((binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: [3, 10, 11, 14].includes(binding) ? "float" : "unfilterable-float" },
      })),
      ...[5, 8].map((binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage" },
      })),
      { binding: 16, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
      { binding: 18, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      { binding: 19, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 17, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
      { binding: 15, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
    ],
  });
  const traceSampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
  const tracer = await device.createComputePipelineAsync({
    layout: device.createPipelineLayout({ bindGroupLayouts: [traceLayout] }),
    compute: { module: device.createShaderModule({ code: traceCode }), entryPoint: "main" },
  });
  const beforeTraceCode = BEFORE_RESOLVE.replace(
    "@group(0) @binding(6) var current_history: texture_storage_2d<rgba16float, write>;",
    "@group(0) @binding(16) var<storage, read_write> trace: array<vec4f>;",
  )
    .replace("@group(0) @binding(13) var output_luma_history: texture_storage_2d<rgba16float, write>;", "")
    .replace("textureStore(output_luma_history, pixel, data.history);", "")
    .replace(
      "textureStore(current_history, pixel, vec4f(result, lock));",
      `
  let index = (id.y * u32(constants.render_size.x) + id.x) * 5u;
  trace[index] = vec4f(ycocg_to_rgb(sampled.color) / exposure(), thin);
  trace[index + 1u] = vec4f(result, lock);
  trace[index + 2u] = vec4f(sampled.box.center, motion.x);
  trace[index + 3u] = vec4f(sampled.box.variance, instability);
  trace[index + 4u] = masks;`,
    );
  const beforeTracer = await device.createComputePipelineAsync({
    layout: "auto",
    compute: {
      module: device.createShaderModule({ code: beforeTraceCode }),
      entryPoint: "main",
    },
  });
  async function sequence(name, width, height, frames, evaluate, controls = () => ({}), integrate = null) {
    const owned = [];
    const tex = (format, usage = 0) => {
      const t = device.createTexture({
        size: [width, height],
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | usage,
      });
      owned.push(t);
      return t;
    };
    const buf = (size, usage) => {
      const b = device.createBuffer({ size, usage });
      owned.push(b);
      return b;
    };
    const color = tex("rgba16float"),
      motion = tex("rg32float"),
      facts = tex("rgba8unorm"),
      sourceDepth = tex("r32float");
    const temporalSeed = tex("rgba32float");
    const nativeResponse = tex("rgba8unorm");
    const currentIdentity = tex("rgba32uint");
    const priorIdentity = tex("rgba32uint");
    const depth = device.createTexture({
      size: [width, height],
      format: "depth32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    owned.push(depth);
    const exposure = buf(16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const priorExposure = buf(16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const values = buf(width * height * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const target = buf(width * height * 16, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const analyzeTarget =
      width <= 65 || width === 1920
        ? buf(width * height * 48 + 16, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
        : null;
    const diagnosticAnalysis = [];
    const beforeAnalysis = [];
    const sourceLumas = [[], []];
    const sourceColors = [[], []];
    const exposureDiagnostics = [[], []];
    const diagnosticTrace = [];
    const beforeTrace = [];
    const traceValues =
      width <= 65 ? buf(width * height * 80, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC) : null;
    const traceTarget = traceValues
      ? buf(width * height * 80, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
      : null;
    const depthGroup = device.createBindGroup({
      layout: depthPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: sourceDepth.createView() }],
    });
    const runtimes = [new BeforeRuntime(device), new NativeTemporalV2(device)];
    const errors = [[], []],
      outputs = [[], []],
      frameSummaries = [],
      golds = [],
      states = [];
    let revision = 1;
    let previousRevision = 1;
    let prior = { jitter: [0, 0], offset: [0, 0], preExposure: 1 };
    try {
      for (let f = 0; f < frames; f++) {
        const state = { jitter: [0, 0], offset: [0, 0], preExposure: 1, ...controls(f) };
        if (state.replacement) revision++;
        const pixels = new Uint16Array(width * height * 4),
          m = new Float32Array(width * height * 2),
          flags = new Uint8Array(width * height * 4),
          depths = new Float32Array(width * height);
        const gold = new Float64Array(width * height * 3);
        const seedWords = new Float32Array(width * height * 4);
        const identityWords = new Uint32Array(width * height * 4);
        const priorWords = new Uint32Array(width * height * 4);
        const responseWords = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            const i = y * width + x;
            const c = evaluate(
              x + 0.5 - state.jitter[0] - state.offset[0],
              y + 0.5 - state.jitter[1] - state.offset[1],
              f,
            );
            pixels.set(
              [
                floatToHalf(c[0] * state.preExposure),
                floatToHalf(c[1] * state.preExposure),
                floatToHalf(c[2] * state.preExposure),
                floatToHalf(1),
              ],
              i * 4,
            );
            const velocity = state.motionAt?.(x + 0.5 - state.jitter[0], y + 0.5 - state.jitter[1]) ?? [
              state.offset[0] - prior.offset[0],
              state.offset[1] - prior.offset[1],
            ];
            m.set(
              [
                (velocity[0] + state.jitter[0] - prior.jitter[0]) / width,
                (velocity[1] + state.jitter[1] - prior.jitter[1]) / height,
              ],
              i * 2,
            );
            flags.set(
              [state.reactive ?? 0, state.invalid ? 0 : 255, state.replacement ? 255 : 0, 255],
              i * 4,
            );
            depths[i] = c[3] ?? 0.5;
            const z = ((1000 / 999.9) * 0.1) / (depths[i] + 0.1 / 999.9);
            seedWords.set([m[i * 2], m[i * 2 + 1], z, z], i * 4);
            identityWords.set([1, 1, revision, 1], i * 4);
            priorWords.set([1, 1, previousRevision, 1], i * 4);
            responseWords.set([state.reactive ?? 0, state.invalid || f === 0 ? 0 : 255, 0, 0], i * 4);
            // Both paths consume jittered point samples; quality always compares
            // against the same independent 8x8 pixel footprint. An optional
            // separable CPU integral accelerates the large analytic fixture.
            const subSamples = 8;
            if (integrate) {
              gold.set(integrate(x - state.offset[0], y - state.offset[1], f), i * 3);
            } else
              for (let sy = 0; sy < subSamples; sy++)
                for (let sx = 0; sx < subSamples; sx++) {
                  const q = evaluate(
                    x + (sx + 0.5) / subSamples - state.offset[0],
                    y + (sy + 0.5) / subSamples - state.offset[1],
                    f,
                  );
                  for (let k = 0; k < 3; k++) gold[i * 3 + k] += q[k] / (subSamples * subSamples);
                }
          }
        device.queue.writeTexture({ texture: color }, pixels, { bytesPerRow: width * 8 }, [width, height]);
        device.queue.writeTexture({ texture: motion }, m, { bytesPerRow: width * 8 }, [width, height]);
        device.queue.writeTexture({ texture: facts }, flags, { bytesPerRow: width * 4 }, [width, height]);
        device.queue.writeTexture({ texture: sourceDepth }, depths, { bytesPerRow: width * 4 }, [
          width,
          height,
        ]);
        device.queue.writeTexture({ texture: temporalSeed }, seedWords, { bytesPerRow: width * 16 }, [
          width,
          height,
        ]);
        device.queue.writeTexture({ texture: currentIdentity }, identityWords, { bytesPerRow: width * 16 }, [
          width,
          height,
        ]);
        device.queue.writeTexture({ texture: priorIdentity }, priorWords, { bytesPerRow: width * 16 }, [
          width,
          height,
        ]);
        device.queue.writeTexture({ texture: nativeResponse }, responseWords, { bytesPerRow: width * 4 }, [
          width,
          height,
        ]);
        device.queue.writeBuffer(exposure, 0, new Float32Array([state.preExposure, 0, 0, 0]));
        device.queue.writeBuffer(priorExposure, 0, new Float32Array([prior.preExposure, 0, 0, 0]));
        for (let r = 0; r < 2; r++) {
          const runtime = runtimes[r];
          runtime.prepareFrame(
            { writeBuffer: (b, o, data) => device.queue.writeBuffer(b, o, data) },
            {
              width,
              height,
              renderWidth: width,
              renderHeight: height,
              outputWidth: width,
              outputHeight: height,
              jitter: state.jitter,
              cameraNear: 0.1,
              cameraFar: 1000,
              cameraFovY: Math.PI / 3,
              cameraInfiniteFar: false,
              frameTimeMs: 1000 / 60,
              reset: f === 0 || state.reset === true,
            },
          );
          const graph = new FrameGraph(`Native Temporal ${name}/${r}/${f}`);
          const imported = (name, resource) => graph.import_resource(name, { kind: "imported" }, resource);
          const candidateResources = new Map();
          const output = runtime.addToGraph(
            graph,
            {
              color: imported("color", color),
              seed: imported("seed", temporalSeed),
              response: imported("response", nativeResponse),
              identity: imported("identity", currentIdentity),
              previousIdentity: imported("previous identity", priorIdentity),
              depth: imported("depth", depth),
              motion: imported("motion", motion),
              reactiveMask: imported("facts", facts),
              validityMask: imported("validity", facts),
              preExposure: imported("pre-exposure", exposure),
              priorExposure: imported("prior-exposure", priorExposure),
              width,
              height,
              outputWidth: width,
              outputHeight: height,
            },
            (name, resolve) => {
              const value = resolve(runtime);
              candidateResources.set(name, value);
              return value;
            },
          );
          const consume = graph.add("read output", {}, (_data, resources, context) => {
            const pass = context.encoder.beginComputePass();
            pass.setPipeline(reader);
            pass.setBindGroup(
              0,
              device.createBindGroup({
                layout: reader.getBindGroupLayout(0),
                entries: [
                  { binding: 0, resource: resources.get(output).createView() },
                  { binding: 1, resource: { buffer: values } },
                ],
              }),
            );
            pass.dispatchWorkgroups(Math.ceil((width * height) / 64));
            pass.end();
            context.encoder.copyBufferToBuffer(values, 0, target, 0, width * height * 16);
          });
          consume.read(output);
          consume.make_side_effect();
          if (analyzeTarget) {
            let analysisId = -1;
            for (let i = 0; i < graph.resourceNodeCount; i++) {
              if (
                graph.getResourceNode(i).name ===
                (r === 1 ? "Native Temporal V2/analysis" : "Native Temporal/classified masks")
              ) {
                analysisId = i;
              }
            }
            assert.ok(analysisId >= 0);
            let infoId = -1;
            for (let i = 0; i < graph.resourceNodeCount; i++) {
              const n = graph.getResourceNode(i);
              if (
                n.name === (r === 1 ? "Native Temporal V2/current frame info" : "FSR3/current frame info") &&
                n.version > 0
              )
                infoId = i;
            }
            assert.ok(infoId >= 0);
            const findProduct = (name) => {
              for (let i = graph.resourceNodeCount - 1; i >= 0; i--) {
                const n = graph.getResourceNode(i);
                if (n.name === name && n.version > 0) return i;
              }
              throw new Error(`Diagnostic lost ${name}`);
            };
            const lumaId = findProduct(r === 1 ? "Native Temporal V2/current luma" : "FSR3/current luma");
            const colorId = findProduct(r === 1 ? "Native Temporal V2/current color" : "FSR3/current color");

            const inspect = graph.add("test-only analysis readback", {}, (_data, resources, context) => {
              const pass = context.encoder.beginComputePass();
              pass.setPipeline(reader);
              pass.setBindGroup(
                0,
                device.createBindGroup({
                  layout: reader.getBindGroupLayout(0),
                  entries: [
                    { binding: 0, resource: resources.get(analysisId).createView() },
                    { binding: 1, resource: { buffer: values } },
                  ],
                }),
              );
              pass.dispatchWorkgroups(Math.ceil((width * height) / 64));
              pass.end();
              context.encoder.copyBufferToBuffer(values, 0, analyzeTarget, 0, width * height * 16);
              const infoPass = context.encoder.beginComputePass();
              infoPass.setPipeline(reader);
              infoPass.setBindGroup(
                0,
                device.createBindGroup({
                  layout: reader.getBindGroupLayout(0),
                  entries: [
                    { binding: 0, resource: resources.get(infoId).createView() },
                    { binding: 1, resource: { buffer: values } },
                  ],
                }),
              );
              infoPass.dispatchWorkgroups(1);
              infoPass.end();
              context.encoder.copyBufferToBuffer(values, 0, analyzeTarget, width * height * 16, 16);
              for (const [product, offset] of [
                [lumaId, width * height * 16 + 16],
                [colorId, width * height * 32 + 16],
              ]) {
                const samplePass = context.encoder.beginComputePass();
                samplePass.setPipeline(reader);
                samplePass.setBindGroup(
                  0,
                  device.createBindGroup({
                    layout: reader.getBindGroupLayout(0),
                    entries: [
                      { binding: 0, resource: resources.get(product).createView() },
                      { binding: 1, resource: { buffer: values } },
                    ],
                  }),
                );
                samplePass.dispatchWorkgroups(Math.ceil((width * height) / 64));
                samplePass.end();
                context.encoder.copyBufferToBuffer(values, 0, analyzeTarget, offset, width * height * 16);
              }
            });
            inspect.read(output);
            inspect.read(analysisId);
            inspect.read(infoId);
            inspect.read(lumaId);
            inspect.read(colorId);
            inspect.make_side_effect();
            if (traceValues) {
              const tracePass = graph.add("test-only Resolve trace", {}, (_data, resources, context) => {
                const find = (name) => {
                  for (let i = 0; i < graph.resourceNodeCount; i++) {
                    const n = graph.getResourceNode(i);
                    if (
                      n.name === `Native Temporal V2/${name}` &&
                      (n.version > 0 || graph.getDescriptor(i)?.kind === "transient_texture")
                    )
                      return resources.get(i);
                  }
                  throw new Error(`Trace lost ${name}`);
                };
                if (r === 0) {
                  const findBefore = (name) => {
                    for (let i = graph.resourceNodeCount - 1; i >= 0; i--) {
                      if (graph.getResourceNode(i).name === name) return resources.get(i);
                    }
                    throw new Error(`Before trace lost ${name}`);
                  };
                  const textures = [
                    [1, color],
                    [2, findBefore("FSR3/dilated motion")],
                    [3, resources.get(analysisId)],
                    [4, candidateResources.get("FSR3/previous color")],
                    [9, resources.get(infoId)],
                    [10, resources.get(lumaId)],
                    [11, candidateResources.get("Native Temporal/previous luma history")],
                    [14, findBefore("FSR3/farthest depth mip1")],
                  ];
                  const pass = context.encoder.beginComputePass();
                  pass.setPipeline(beforeTracer);
                  pass.setBindGroup(
                    0,
                    device.createBindGroup({
                      layout: beforeTracer.getBindGroupLayout(0),
                      entries: [
                        { binding: 0, resource: { buffer: candidateResources.get("constants") } },
                        ...textures.map(([binding, texture]) => ({
                          binding,
                          resource: texture.createView(),
                        })),
                        { binding: 5, resource: traceSampler },
                        {
                          binding: 15,
                          resource: { buffer: findBefore("Native Temporal/current filter weights") },
                        },
                        { binding: 16, resource: { buffer: traceValues } },
                      ],
                    }),
                  );
                  pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
                  pass.end();
                  context.encoder.copyBufferToBuffer(traceValues, 0, traceTarget, 0, width * height * 80);
                  return;
                }
                const textures = [
                  [1, color],
                  [2, temporalSeed],
                  [3, resources.get(analysisId)],
                  [4, candidateResources.get("previous color")],
                  [9, find("current frame info")],
                  [10, find("current luma")],
                  [11, candidateResources.get("previous luma history")],
                  [14, find("farthest box metric")],
                  [16, find("color receivers")],
                  [18, nativeResponse],
                ];
                const pass = context.encoder.beginComputePass();
                pass.setPipeline(tracer);
                pass.setBindGroup(
                  0,
                  device.createBindGroup({
                    layout: traceLayout,
                    entries: [
                      { binding: 0, resource: { buffer: candidateResources.get("frame") } },
                      ...textures.map(([binding, texture]) => ({ binding, resource: texture.createView() })),
                      { binding: 5, resource: { buffer: exposure } },
                      { binding: 8, resource: { buffer: priorExposure } },
                      { binding: 19, resource: { buffer: traceValues } },
                      { binding: 17, resource: traceSampler },
                      { binding: 15, resource: { buffer: candidateResources.get("filter weights") } },
                    ],
                  }),
                );
                pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
                pass.end();
                context.encoder.copyBufferToBuffer(traceValues, 0, traceTarget, 0, width * height * 80);
              });
              tracePass.read(output);
              tracePass.read(analysisId);
              tracePass.read(infoId);
              tracePass.read(lumaId);
              for (let i = 0; i < graph.resourceNodeCount; i++) {
                if (
                  [
                    "Native Temporal V2/filter weights",
                    "Native Temporal V2/current luma",
                    "Native Temporal V2/current frame info",
                    "Native Temporal V2/farthest box metric",
                    "Native Temporal V2/color receivers",
                  ].includes(graph.getResourceNode(i).name) &&
                  (graph.getResourceNode(i).version > 0 ||
                    graph.getDescriptor(i)?.kind === "transient_texture")
                )
                  tracePass.read(i);
              }
              if (r === 0) {
                for (let i = 0; i < graph.resourceNodeCount; i++) {
                  if (
                    [
                      "FSR3/dilated motion",
                      "FSR3/farthest depth mip1",
                      "Native Temporal/current filter weights",
                    ].includes(graph.getResourceNode(i).name)
                  )
                    tracePass.read(i);
                }
              }
              tracePass.make_side_effect();
            }
          }
          const compiled = graph.compile();
          const encoder = device.createCommandEncoder();
          const transients = [];
          const command = {
            gpu_encoder: encoder,
            beginComputePass: (descriptor) => encoder.beginComputePass(descriptor),
            copyBufferToBuffer: (...args) => encoder.copyBufferToBuffer(...args),
            allocateTransientBufferAndLoad(data, usage) {
              const b = device.createBuffer({ size: data.byteLength, usage, mappedAtCreation: true });
              new Uint8Array(b.getMappedRange()).set(new Uint8Array(data));
              b.unmap();
              transients.push(b);
              return b;
            },
          };
          const dp = encoder.beginRenderPass({
            colorAttachments: [],
            depthStencilAttachment: {
              view: depth.createView(),
              depthClearValue: 0,
              depthLoadOp: "clear",
              depthStoreOp: "store",
            },
          });
          dp.setPipeline(depthPipeline);
          dp.setBindGroup(0, depthGroup);
          dp.draw(3);
          dp.end();
          let finish;
          const completion = new Promise((resolve) => {
            finish = resolve;
          });
          compiled.execute(new FrameGraphContext({ device, encoder: command, completion }));
          device.queue.submit([encoder.finish()]);
          const gpuDone = device.queue.onSubmittedWorkDone();
          runtime.commit(gpuDone);
          await gpuDone;
          finish();
          await target.mapAsync(GPUMapMode.READ);
          const result = new Float32Array(target.getMappedRange()).slice();
          target.unmap();
          if (analyzeTarget) {
            await analyzeTarget.mapAsync(GPUMapMode.READ);
            const snapshot = new Float32Array(analyzeTarget.getMappedRange()).slice();
            (r === 1 ? diagnosticAnalysis : beforeAnalysis).push(snapshot.subarray(0, width * height * 4));
            exposureDiagnostics[r].push(
              Array.from(snapshot.subarray(width * height * 4, width * height * 4 + 4)),
            );
            sourceLumas[r].push(snapshot.slice(width * height * 4 + 4, width * height * 8 + 4));
            sourceColors[r].push(snapshot.slice(width * height * 8 + 4));
            analyzeTarget.unmap();
          }
          if (traceTarget) {
            await traceTarget.mapAsync(GPUMapMode.READ);
            (r === 0 ? beforeTrace : diagnosticTrace).push(
              new Float32Array(traceTarget.getMappedRange()).slice(),
            );
            traceTarget.unmap();
          }
          compiled.destroy();
          transients.forEach((b) => b.destroy());
          let sq = 0,
            energy = 0,
            maxError = 0;
          for (let y = 2; y < height - 2; y++)
            for (let x = 2; x < width - 2; x++)
              for (let k = 0; k < 3; k++) {
                const i = y * width + x,
                  actual = result[i * 4 + k] / state.preExposure,
                  expected = gold[i * 3 + k];
                assert.ok(Number.isFinite(actual), `${name} frame ${f} non-finite ${r}/${i}/${k}`);
                const d = actual - expected;
                sq += d * d;
                energy += expected * expected;
                maxError = Math.max(maxError, Math.abs(d));
              }
          errors[r].push(Math.sqrt(sq / Math.max(energy, 1e-20)));
          outputs[r].push(result);
          frameSummaries.push({
            frame: f,
            path: r === 0 ? "before" : "native",
            normalizedRmse: errors[r].at(-1),
            maxError,
          });
        }
        golds.push(gold);
        states.push(state);
        prior = state;
        previousRevision = revision;
      }
      const start = frames > 8 ? 16 : 0;
      const beforeRmse = errors[0].slice(start).reduce((a, b) => a + b) / (frames - start);
      const nativeRmse = errors[1].slice(start).reduce((a, b) => a + b) / (frames - start);
      const samePhase = outputs.map((series) => {
        let sq = 0,
          energy = 0;
        for (let f = Math.max(start, 8); f < frames; f++)
          for (let y = 2; y < height - 2; y++)
            for (let x = 2; x < width - 2; x++)
              for (let k = 0; k < 3; k++) {
                const i = (y * width + x) * 4 + k;
                const d = series[f][i] - series[f - 8][i];
                sq += d * d;
                energy += series[f][i] ** 2;
              }
        return Math.sqrt(sq / Math.max(energy, 1e-20));
      });
      const worstPixels = [];
      for (let f = 0; f < frames; f++) {
        const peaks = [];
        for (let y = 2; y < height - 2; y++)
          for (let x = 2; x < width - 2; x++) {
            const i = y * width + x;
            const expected = golds[f][i * 3];
            const before = outputs[0][f][i * 4] / states[f].preExposure;
            const native = outputs[1][f][i * 4] / states[f].preExposure;
            const regression = (native - expected) ** 2 - (before - expected) ** 2;
            if (regression <= 0 || (peaks.length === 8 && regression <= peaks.at(-1).regression)) continue;
            peaks.push({
              x,
              y,
              before,
              native,
              expected,
              regression,
              beforeAnalysis: beforeAnalysis[f]
                ? Array.from(beforeAnalysis[f].subarray(i * 4, i * 4 + 4))
                : null,
              exposures: [exposureDiagnostics[0][f], exposureDiagnostics[1][f]],
              sourceLocks: sourceColors[0][f]
                ? [sourceColors[0][f][i * 4 + 3], sourceColors[1][f][i * 4 + 3]]
                : null,
              sourceLumas: sourceLumas[0][f]
                ? [-1, 0, 1].flatMap((dy) =>
                    [-1, 0, 1].map((dx) => {
                      const at = ((y + dy) * width + x + dx) * 4;
                      return [sourceLumas[0][f][at], sourceLumas[1][f][at]];
                    }),
                  )
                : null,
              analysis: diagnosticAnalysis[f]
                ? Array.from(diagnosticAnalysis[f].subarray(i * 4, i * 4 + 4))
                : null,
              beforeTrace: beforeTrace[f] ? Array.from(beforeTrace[f].subarray(i * 20, i * 20 + 20)) : null,
              trace: diagnosticTrace[f] ? Array.from(diagnosticTrace[f].subarray(i * 20, i * 20 + 20)) : null,
            });
            peaks.sort((a, b) => b.regression - a.regression);
            if (peaks.length > 8) peaks.pop();
          }
        worstPixels.push({ frame: f, peaks });
      }
      cases.push({
        name,
        width,
        height,
        frames,
        frameSummaries,
        beforeRmse,
        nativeRmse,
        samePhase,
        worstPixels,
        diagnosticPixels:
          width <= 65 || width === 1920
            ? Array.from({ length: frames }, (_, f) => ({
                f,
                pixels: (width <= 65
                  ? [
                      [12, 20],
                      [13, 20],
                      [14, 20],
                      [22, 20],
                      [23, 20],
                      [24, 20],
                      [25, 20],
                      [26, 20],
                      [27, 20],
                      [28, 20],
                      [29, 20],
                      [24, 16],
                      [24, 17],
                      [24, 18],
                      [24, 19],
                    ]
                  : [
                      [1899, 1060],
                      [1900, 1060],
                      [1901, 1060],
                      [1900, 1059],
                      [1900, 1061],
                      [1901, 1061],
                      [1899, 1059],
                    ]
                )
                  .filter(([x, y]) => x < width && y < height)
                  .map(([x, y]) => ({
                    x,
                    y,
                    before: outputs[0][f][(y * width + x) * 4],
                    native: outputs[1][f][(y * width + x) * 4],
                    golden: golds[f][(y * width + x) * 3],
                    analysis: diagnosticAnalysis[f]
                      ? Array.from(
                          diagnosticAnalysis[f].subarray((y * width + x) * 4, (y * width + x) * 4 + 4),
                        )
                      : null,
                  })),
              }))
            : [],
      });
      compareQuality(`${name}: HDR RMSE`, nativeRmse, beforeRmse, qualityPolicy.aggregateRmseRelativeMargin);
      if (name.startsWith("static")) {
        compareQuality(`${name}: static phase residual`, samePhase[1], samePhase[0]);
      }
      const rois =
        width === 1920
          ? [
              ["far-edge-HDR", 1850, 1050, 1919, 1079],
              ["interior", 2, 2, width - 2, height - 2],
            ]
          : name.includes("thin")
            ? [
                ["wire", 22, 2, 27, height - 2],
                ["horizontal-wire", 2, 16, width - 2, 21],
                ["siemens", 34, 4, 60, 44],
              ]
            : name.includes("local-patch")
              ? [
                  ["patch", 22, 18, 28, 24],
                  ["patch-neighborhood", 18, 14, 32, 28],
                ]
              : name.includes("highlight")
                ? [
                    ["emitter", 21, 20, 28, 27],
                    ["dark-neighborhood", 18, 17, 31, 30],
                  ]
                : [["interior", 2, 2, width - 2, height - 2]];
      const roiMetrics = [];
      for (const [roi, x0, y0, x1, y1] of rois) {
        const signedEnergyErrors = [];
        const metrics = [0, 1].map((r) => {
          let sq = 0,
            energy = 0,
            displaySq = 0,
            displayEnergy = 0,
            actualSum = 0,
            goldSum = 0,
            phaseSq = 0,
            phaseEnergy = 0;
          for (let f = start; f < frames; f++)
            for (let y = y0; y < y1; y++)
              for (let x = x0; x < x1; x++)
                for (let k = 0; k < 3; k++) {
                  const i = y * width + x,
                    v = outputs[r][f][i * 4 + k] / states[f].preExposure,
                    g = golds[f][i * 3 + k];
                  sq += (v - g) ** 2;
                  energy += g * g;
                  // Explicit diagnostic display curve; linear HDR remains primary.
                  const dv = v / (1 + v),
                    dg = g / (1 + g);
                  displaySq += (dv - dg) ** 2;
                  displayEnergy += dg * dg;
                  actualSum += v;
                  goldSum += g;
                  if (name.startsWith("static") && f >= start + 8) {
                    const priorV = outputs[r][f - 8][i * 4 + k] / states[f - 8].preExposure;
                    phaseSq += (v - priorV) ** 2;
                    phaseEnergy += v * v;
                  }
                }
          signedEnergyErrors.push((actualSum - goldSum) / Math.max(goldSum, 1e-20));
          return {
            hdrRmse: Math.sqrt(sq / Math.max(energy, 1e-20)),
            displayRmse: Math.sqrt(displaySq / Math.max(displayEnergy, 1e-20)),
            energyError: Math.abs(actualSum - goldSum) / Math.max(goldSum, 1e-20),
            phaseResidual: Math.sqrt(phaseSq / Math.max(phaseEnergy, 1e-20)),
          };
        });
        roiMetrics.push({ roi, before: metrics[0], native: metrics[1], signedEnergyErrors });
        for (const metric of Object.keys(metrics[0])) {
          const relativeMargin =
            metric === "hdrRmse" || metric === "displayRmse"
              ? qualityPolicy.aggregateRmseRelativeMargin
              : qualityPolicy.energyAndPhaseRelativeMargin;
          compareQuality(`${name}/${roi}/${metric}`, metrics[1][metric], metrics[0][metric], relativeMargin);
        }
        // An average cannot hide a single-frame ghost or delayed light response.
        const response = [];
        for (let f = start; f < frames; f++) {
          const perFrame = [0, 1].map((r) => {
            let sq = 0,
              energy = 0;
            for (let y = y0; y < y1; y++)
              for (let x = x0; x < x1; x++)
                for (let k = 0; k < 3; k++) {
                  const i = y * width + x;
                  const actual = outputs[r][f][i * 4 + k] / states[f].preExposure;
                  const expected = golds[f][i * 3 + k];
                  sq += (actual - expected) ** 2;
                  energy += expected ** 2;
                }
            return Math.sqrt(sq / Math.max(energy, 1e-20));
          });
          response.push({ frame: f, before: perFrame[0], native: perFrame[1] });
          compareQuality(
            `${name}/${roi}/frame-${f}`,
            perFrame[1],
            perFrame[0],
            qualityPolicy.frameRmseRelativeMargin,
          );
        }
        roiMetrics.at(-1).response = response;
      }
      cases.at(-1).roiMetrics = roiMetrics;
      if (name.startsWith("uniform")) {
        for (let r = 0; r < 2; r++)
          for (let f = 0; f < frames; f++)
            assert.ok(errors[r][f] < 0.003, `${name}/${r}/${f} uniform error ${errors[r][f]}`);
      }
    } finally {
      runtimes.forEach((r) => r.destroy());
      await device.queue.onSubmittedWorkDone();
      await Promise.resolve();
      owned.forEach((r) => r.destroy());
    }
  }
  for (const [w, h, hdr] of [
    [8, 8, 0.5],
    [17, 9, 128],
    [33, 17, 8192],
  ]) {
    await sequence(
      `uniform-${hdr}`,
      w,
      h,
      4,
      () => [hdr, hdr * 0.25, hdr * 0.7],
      (f) => ({ preExposure: f >= 2 ? 0.25 : 1 }),
    );
  }
  const halton = (b, i) => {
    let v = 0,
      k = 1;
    while (i > 0) {
      k /= b;
      v += (i % b) * k;
      i = Math.floor(i / b);
    }
    return v;
  };
  const jitter = (f) => [halton(2, (f % 8) + 1) - 0.5, halton(3, (f % 8) + 1) - 0.5];
  const grid = (x, y) => {
    const wire = Math.abs(x - 24.25) < 0.23 || Math.abs(y - 17.75) < 0.23;
    const angle = Math.atan2(y - 24, x - 40);
    const radial = x > 32 ? 0.5 + 0.5 * Math.sin(angle * 36) : 0.1;
    const v = wire ? 4 : 0.05 + radial * 0.7;
    return [v, v * 0.65, v * 0.2];
  };
  await sequence("static-thin-siemens", 64, 48, 48, grid, (f) => ({ jitter: jitter(f) }));
  const smooth = (x, y) => {
    const v = 0.4 + 0.25 * Math.sin(x * 0.6) * Math.cos(y * 0.7);
    return [v, v * 0.8, v * 0.3];
  };
  await sequence("motion-slow-stop", 64, 48, 48, smooth, (f) => ({
    jitter: jitter(f),
    offset: [f < 16 ? 0 : f < 32 ? (f - 16) * 0.25 : 4, 0],
  }));
  await sequence("motion-fast-reverse-stop", 64, 48, 48, grid, (f) => ({
    jitter: jitter(f),
    offset: [f < 16 ? 0 : f < 24 ? (f - 16) * 2.1 : f < 32 ? (32 - f) * 2.1 : 0, 0],
  }));
  await sequence(
    "light-step-ramp",
    64,
    48,
    48,
    (x, y, f) => {
      const c = smooth(x, y),
        g = f < 16 ? 1 : f < 24 ? 4 : 4 - (f - 24) * 0.1;
      return c.map((v) => v * g);
    },
    (f) => ({ jitter: jitter(f) }),
  );
  await sequence(
    "light-local-patch-step",
    64,
    48,
    48,
    (x, y, f) => {
      const c = smooth(x, y),
        g = f >= 16 && x > 22 && x < 28 && y > 18 && y < 24 ? 4 : 1;
      return c.map((v) => v * g);
    },
    (f) => ({ jitter: jitter(f) }),
  );
  await sequence("exposure-step", 64, 48, 48, smooth, (f) => ({
    jitter: jitter(f),
    preExposure: f < 16 ? 1 : f < 32 ? 0.125 : 4,
  }));
  await sequence(
    "HDR-isolated-highlight",
    64,
    48,
    48,
    (x, y) => {
      const v = Math.abs(x - 24.25) < 0.6 && Math.abs(y - 23.75) < 0.6 ? 4096 : 0.1;
      return [v, v * 0.25, v * 0.7];
    },
    (f) => ({ jitter: jitter(f) }),
  );
  const fgOffset = (f) => (f < 16 ? 0 : f < 28 ? (f - 16) * 1.5 : 18);
  await sequence(
    "foreground-disocclusion-stop",
    64,
    48,
    48,
    (x, y, f) => {
      const foreground = x > 12 + fgOffset(f) && x < 26 + fgOffset(f) && y > 8 && y < 40;
      return foreground ? [2, 0.15, 0.1, 0.8] : [0.1 + 0.03 * Math.sin(x), 0.15, 0.2, 0.2];
    },
    (f) => ({
      jitter: jitter(f),
      motionAt: (x, y) =>
        x > 12 + fgOffset(f) && x < 26 + fgOffset(f) && y > 8 && y < 40
          ? [fgOffset(f) - fgOffset(Math.max(0, f - 1)), 0]
          : [0, 0],
    }),
  );
  const zoom = (f) => (f < 16 ? 1 : f < 32 ? 1 + (f - 16) * 0.01 : 1.16);
  await sequence(
    "dolly-plane",
    64,
    48,
    48,
    (x, y, f) => smooth(32 + (x - 32) / zoom(f), 24 + (y - 24) / zoom(f)),
    (f) => ({
      jitter: jitter(f),
      motionAt: (x, y) => [
        (x - 32) * (1 - zoom(Math.max(0, f - 1)) / zoom(f)),
        (y - 24) * (1 - zoom(Math.max(0, f - 1)) / zoom(f)),
      ],
    }),
  );
  await sequence("replacement-invalid-reactive-reset", 33, 17, 32, smooth, (f) => ({
    jitter: jitter(f),
    invalid: f === 17,
    replacement: f === 20,
    reactive: f === 23 ? 255 : 0,
    reset: f === 27,
  }));
  await sequence("external-jitter-partial", 17, 9, 4, smooth, (f) => ({
    jitter: f % 2 ? [2.7, -1.2] : [-1.3, 2.4],
  }));
  await sequence("external-jitter-thin-partial", 65, 49, 32, grid, (f) => ({
    jitter: f % 2 ? [2.7, -1.2] : [-1.3, 2.4],
  }));
  // The scene is separable: v = .4 + .25 sin(.6x) cos(.7y),
  // multiplied by 1 + 8191 * Ix * Iy. This is the exact same 8x8
  // quadrature as the generic oracle, including the narrow HDR rectangle.
  const integratedAxis = (length, center, frequency, fn) =>
    Array.from({ length }, (_, p) => {
      let mean = 0,
        maskedMean = 0,
        coverage = 0;
      for (let i = 0; i < 8; i++) {
        const coordinate = p + (i + 0.5) / 8;
        const value = fn(coordinate * frequency) / 8;
        mean += value;
        if (Math.abs(coordinate - center) < 0.6) {
          maskedMean += value;
          coverage += 1 / 8;
        }
      }
      return { mean, maskedMean, coverage };
    });
  const horizontalIntegral = integratedAxis(1920, 1900.25, 0.6, Math.sin);
  const verticalIntegral = integratedAxis(1080, 1060.75, 0.7, Math.cos);
  const hdrIntegral = (x, y) => {
    const a = horizontalIntegral[x],
      b = verticalIntegral[y];
    const v =
      0.4 +
      0.25 * a.mean * b.mean +
      8191 * (0.4 * a.coverage * b.coverage + 0.25 * a.maskedMean * b.maskedMean);
    return [v, v * 0.8, v * 0.3];
  };
  // Validate the acceleration independently at every affected HDR pixel and
  // several distant coordinates; never compare it to a temporal shader.
  for (const x of [2, 129, 1850, 1898, 1899, 1900, 1901, 1917]) {
    for (const y of [2, 127, 1050, 1059, 1060, 1061, 1062, 1077]) {
      let sum = 0;
      for (let sy = 0; sy < 8; sy++)
        for (let sx = 0; sx < 8; sx++) {
          const px = x + (sx + 0.5) / 8,
            py = y + (sy + 0.5) / 8;
          const gain = Math.abs(px - 1900.25) < 0.6 && Math.abs(py - 1060.75) < 0.6 ? 8192 : 1;
          sum += (smooth(px, py)[0] * gain) / 64;
        }
      assert.ok(Math.abs(hdrIntegral(x, y)[0] - sum) <= 2 ** -40 * Math.max(1, sum));
    }
  }
  await sequence(
    "full-resolution-HDR-footprint",
    1920,
    1080,
    4,
    (x, y) => {
      const c = smooth(x, y);
      const gain = Math.abs(x - 1900.25) < 0.6 && Math.abs(y - 1060.75) < 0.6 ? 8192 : 1;
      return c.map((v) => v * gain);
    },
    (f) => ({ jitter: jitter(f) }),
    hdrIntegral,
  );
  // True large-coordinate numeric fixture has no unresolved subpixel signal.
  // P/jitter still vary, including partial/offscreen history footprints.
  await sequence(
    "uniform-full-resolution-numeric-roundoff",
    1920,
    1080,
    4,
    () => [8192, 2048, 5734.4],
    (f) => ({ jitter: jitter(f), preExposure: f >= 2 ? 0.25 : 1 }),
    () => [8192, 2048, 5734.4],
  );
  assert.equal(
    gateFailures.length,
    0,
    JSON.stringify({ gateFailures, strictGateFailures, qualityPolicy, cases }),
  );
  return {
    status: "passed",
    cases,
    strictGateFailures,
    qualityPolicy,
    qualityGate:
      "Analytic 8x8 pixel reference; aggregate/ROI RMSE +1%, frame ROI RMSE +3%, each with max(2^-10, relative margin); energy/static phase remain floor-only. Strict comparisons retained as diagnostics.",
  };
}
