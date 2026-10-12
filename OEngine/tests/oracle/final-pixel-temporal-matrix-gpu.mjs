import assert from "node:assert/strict";
import { FrameGraph, FrameGraphContext } from "../../.test-dist/framegraph/FrameGraph.js";
import { NATIVE_TEMPORAL_SEED_CLASSIFY_WGSL } from "../../.test-dist/shaders/native_temporal_seed.js";
import { NativeTemporalV2 } from "../../.test-dist/render/temporal/NativeTemporalV2.js";
import { Fsr3UpscalerRuntime as Reference } from "./reference/phase4/Fsr3UpscalerRuntime.mjs";

// Frozen, algorithm-independent scene stimuli. Analytic box integrals are used
// for axis-aligned coverage and sine; only the small Siemens disk needs 8x8
// quadrature. The same scene functions feed both chains, never either estimator.
const SCENE = `
struct Fixture { size: vec2u, family: u32, frame: u32, jitter: vec2f, previous_jitter: vec2f, exposure: f32, previous_exposure: f32, pad: vec2f };
@group(0) @binding(0) var<uniform> fixture: Fixture;
fn phase(f: u32) -> f32 { return clamp(f32(f) - 64.0, 0.0, 128.0); }
fn movement(f: u32) -> f32 {
  let t = phase(f);
  return select(t, 128.0 - t, t > 64.0) * 8.0;
}
fn coverage(p: vec2f, lo: vec2f, hi: vec2f, integral: bool) -> f32 {
  if (!integral) { return select(0.0, 1.0, all(p >= lo) && all(p < hi)); }
  let overlap = max(vec2f(0.0), min(p + 0.5, hi) - max(p - 0.5, lo));
  return overlap.x * overlap.y;
}
fn wave(p: vec2f, integral: bool) -> f32 {
  let mean = select(1.0, sin(0.3) / 0.3 * sin(0.35) / 0.35, integral);
  return 0.4 + 0.25 * sin(0.6 * p.x) * cos(0.7 * p.y) * mean;
}
fn revision(f: u32) -> u32 { return select(select(select(1u, 2u, f >= 96u), 3u, f >= 128u), 4u, f >= 160u); }
fn scene(p: vec2f, f: u32, integral: bool) -> vec3f {
  var value = vec3f(wave(p, integral));
  let family = fixture.family;
  if (family == 0u) {
    let wire = max(coverage(p, vec2f(601.2, 2.0), vec2f(601.65, 1078.0), integral), coverage(p, vec2f(2.0, 430.2), vec2f(1918.0, 430.8), integral));
    value = mix(value, vec3f(4.0, 2.6, 0.8), wire);
    if (distance(p, vec2f(1200.0, 540.0)) < 49.0) {
      var sum = 0.0;
      let count = select(1u, 8u, integral);
      for (var y = 0u; y < count; y++) { for (var x = 0u; x < count; x++) {
        let d = p + (vec2f(f32(x), f32(y)) + 0.5) / f32(count) - 0.5 - vec2f(1200.0, 540.0);
        sum += select(0.1, 3.0, sin(atan2(d.y, d.x) * 16.0) > 0.0);
      } }
      value = vec3f(sum / f32(count * count));
    }
    // Analytic MASK coverage boundary, distinct from thin/Siemens fixtures.
    let mask = coverage(p, vec2f(1450.3, 280.4), vec2f(1650.7, 700.6), integral);
    value = mix(value, vec3f(2.0, 0.4, 0.1), mask);
  } else if (family == 1u) {
    let fast = coverage(p, vec2f(300.3 + movement(f), 300.2), vec2f(400.7 + movement(f), 700.6), integral);
    let slow = coverage(p, vec2f(1100.2 - phase(f) * 0.25, 350.3), vec2f(1250.6 - phase(f) * 0.25, 650.7), integral);
    value = mix(value, vec3f(2.0, 0.15, 0.1), fast);
    value = mix(value, vec3f(0.1, 1.5, 0.2), slow);
  } else if (family == 2u) {
    let mask = coverage(p, vec2f(500.2, 300.3), vec2f(1000.7, 800.6), integral);
    let edit = select(select(select(0.5, 2.0, f >= 96u), 0.25, f >= 128u), 0.5, f >= 160u);
    value = mix(value, vec3f(edit, 0.3, 0.1), mask);
  } else if (family == 3u) {
    let light = select(1.0, select(4.0, 4.0 - clamp(f32(f) - 128.0, 0.0, 32.0) * 3.0 / 32.0, f >= 128u), f >= 96u);
    let shadow = coverage(p, vec2f(500.2 + movement(f) * 0.5, 250.3), vec2f(700.7 + movement(f) * 0.5, 850.7), integral);
    value *= light * mix(1.0, 0.2, shadow);
  } else if (family == 4u) {
    // High dynamic range plateaus, isolated highlight and oscillating grazing
    // specular/coat-like radiance. Material/normal evaluation is tested by the
    // actual Native writer oracle; this fixture tests their temporal input.
    value = vec3f(select(select(0.5, 128.0, p.x >= 640.0), 8192.0, p.x >= 1280.0));
    let point = coverage(p, vec2f(1858.2, 1058.3), vec2f(1859.3, 1059.4), integral);
    value = mix(value, vec3f(4096.0, 1024.0, 2867.2), point);
    let edge = coverage(p, vec2f(400.2, 520.3), vec2f(900.8, 523.6), integral);
    value += edge * vec3f(32.0 * (1.0 + sin(phase(f) * 0.03)), 16.0, 24.0);
  } else {
    let cut = select(0.0, 7.25, f >= 160u);
    value = vec3f(wave(p - cut, integral));
  }
  return value;
}
fn linear_depth(p: vec2f, f: u32) -> f32 {
  if (fixture.family == 1u && coverage(p, vec2f(300.3 + movement(f), 300.2), vec2f(400.7 + movement(f), 700.6), false) > 0.0) { return 0.125; }
  return 0.5;
}
fn raw_motion(p: vec2f) -> vec2f {
  var motion = vec2f(0.0);
  let f = fixture.frame;
  if (fixture.family == 1u && linear_depth(p, f) < 0.5) { motion.x = movement(f) - movement(max(f, 1u) - 1u); }
  if (fixture.family == 1u && coverage(p, vec2f(1100.2 - phase(f) * 0.25, 350.3), vec2f(1250.6 - phase(f) * 0.25, 650.7), false) > 0.0) { motion.x = -(phase(f) - phase(max(f, 1u) - 1u)) * 0.25; }
  return (motion + fixture.jitter - fixture.previous_jitter) / vec2f(fixture.size);
}
`;
const WRITER =
  SCENE +
  `
@group(0) @binding(1) var color: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var seed: texture_storage_2d<rgba32float, write>;
@group(0) @binding(3) var response: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var identity: texture_storage_2d<rgba32uint, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= fixture.size)) { return; }
  let pixel = vec2i(id.xy); let p = vec2f(id.xy) + 0.5 - fixture.jitter;
  let depth = linear_depth(p, fixture.frame);
  textureStore(color, pixel, vec4f(scene(p, fixture.frame, false) * fixture.exposure, 1.0));
  textureStore(seed, pixel, vec4f(raw_motion(p), depth, depth));
  let invalid = fixture.family == 5u && fixture.frame == 128u && p.x < 960.0;
  textureStore(response, pixel, vec4f(0.0, select(1.0, 0.0, invalid), 0.0, 0.0));
  let replacement_owner = fixture.family == 2u && all(p > vec2f(500.0, 300.0)) && all(p < vec2f(1001.0, 801.0));
  let owner = select(1u, 2u, depth < 0.5 || replacement_owner);
  let rev = select(1u, revision(fixture.frame), replacement_owner);
  textureStore(identity, pixel, vec4u(owner, rev, rev, 1u));
}
`;
const METRICS =
  SCENE +
  `
@group(0) @binding(1) var output: texture_2d<f32>;
@group(0) @binding(2) var previous_phase: texture_2d<f32>;
struct Metric { a: vec4f, b: vec4f, c: vec4f };
@group(0) @binding(3) var<storage, read_write> metrics: array<Metric>;
var<workgroup> a: array<vec4f, 256>;
var<workgroup> b: array<vec4f, 256>;
var<workgroup> c: array<vec4f, 256>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3u) {
  let coord = vec2u(id.x % fixture.size.x, id.x / fixture.size.x);
  let interior = coord.x >= 2u && coord.x < fixture.size.x - 2u && coord.y >= 2u && coord.y < fixture.size.y - 2u;
  let p = vec2f(coord) + 0.5;
  let gold = scene(p, fixture.frame, true);
  let actual = textureLoad(output, vec2i(coord), 0).rgb / fixture.exposure;
  let delta = actual - gold;
  let old = textureLoad(previous_phase, vec2i(coord), 0).rgb;
  let phase_error = (actual - old) - (gold - scene(p, max(fixture.frame, 8u) - 8u, true));
  let display = actual / (vec3f(1.0) + max(actual, vec3f(0.0)));
  let display_gold = gold / (vec3f(1.0) + gold);
  for (var roi = 0u; roi < 8u; roi++) {
    var selected = interior;
    if (roi == 1u) { selected = selected && p.x >= 280.0 && p.x < 1670.0 && p.y >= 230.0 && p.y < 870.0; }
    if (roi == 2u) { selected = selected && p.x >= 20.0 && p.x < 250.0 && p.y >= 20.0 && p.y < 220.0; }
    if (roi == 3u) { selected = selected && p.x >= 1850.0 && p.y >= 1050.0; }
    // Family-specific tight regions supplement broad and unchanged ROIs.
    // Bounds are defined from analytic stimuli, independently of either result.
    if (roi >= 4u) {
      var tight = false;
      if (fixture.family == 0u) {
        if (roi == 4u) { tight = p.x >= 599.2 && p.x < 603.65; }
        if (roi == 5u) { tight = p.y >= 428.2 && p.y < 432.8; }
        if (roi == 6u) { tight = distance(p, vec2f(1200.0, 540.0)) < 51.0; }
        if (roi == 7u) {
          tight = coverage(p, vec2f(1448.3, 278.4), vec2f(1652.7, 702.6), false) > 0.0 &&
            coverage(p, vec2f(1452.3, 282.4), vec2f(1648.7, 698.6), false) == 0.0;
        }
      } else if (fixture.family == 1u) {
        let now = movement(fixture.frame); let before = movement(max(fixture.frame, 1u) - 1u);
        let fast_lo = vec2f(300.3 + min(now, before), 300.2); let fast_hi = vec2f(400.7 + max(now, before), 700.6);
        if (roi == 4u) { tight = coverage(p, fast_lo - 16.0, fast_hi + 16.0, false) > 0.0; }
        let slow_lo = vec2f(1100.2 - phase(fixture.frame) * 0.25, 350.3); let slow_hi = vec2f(1250.6 - phase(fixture.frame) * 0.25, 650.7);
        if (roi == 5u) { tight = coverage(p, slow_lo - 16.0, slow_hi + 16.0, false) > 0.0; }
        if (roi == 6u) {
          tight = coverage(p, fast_lo - 2.0, fast_hi + 2.0, false) > 0.0 &&
            coverage(p, vec2f(302.3 + now, 302.2), vec2f(398.7 + now, 698.6), false) == 0.0;
        }
        if (roi == 7u) { tight = coverage(p, slow_lo - 2.0, slow_hi + 2.0, false) > 0.0 && coverage(p, slow_lo + 2.0, slow_hi - 2.0, false) == 0.0; }
      } else if (fixture.family == 2u) {
        let changed = coverage(p, vec2f(498.2, 298.3), vec2f(1002.7, 802.6), false) > 0.0;
        if (roi == 4u) { tight = changed; }
        if (roi == 5u) { tight = !changed; }
        if (roi == 6u) { tight = changed && coverage(p, vec2f(502.2, 302.3), vec2f(998.7, 798.6), false) == 0.0; }
        if (roi == 7u) { tight = coverage(p, vec2f(502.2, 302.3), vec2f(998.7, 798.6), false) > 0.0; }
      } else if (fixture.family == 3u) {
        let lo = vec2f(500.2 + movement(fixture.frame) * 0.5, 250.3); let hi = vec2f(700.7 + movement(fixture.frame) * 0.5, 850.7);
        if (roi == 4u) { tight = coverage(p, lo - 4.0, hi + 4.0, false) > 0.0 && coverage(p, lo + 4.0, hi - 4.0, false) == 0.0; }
        if (roi == 5u) { tight = p.x < 480.0; }
        if (roi == 6u) { tight = coverage(p, lo + 4.0, hi - 4.0, false) > 0.0; }
        if (roi == 7u) { tight = p.x >= 970.0; }
      } else if (fixture.family == 4u) {
        if (roi == 4u) { tight = coverage(p, vec2f(392.2, 512.3), vec2f(908.8, 531.6), false) > 0.0; }
        if (roi == 5u) { tight = coverage(p, vec2f(1850.2, 1050.3), vec2f(1867.3, 1067.4), false) > 0.0; }
        if (roi == 6u) { tight = p.x < 630.0 && p.y < 500.0; }
        if (roi == 7u) { tight = p.x >= 1290.0 && p.y < 500.0; }
      } else {
        if (roi == 4u) { tight = p.x < 960.0; }
        if (roi == 5u) { tight = p.x >= 960.0; }
        if (roi == 6u) { tight = p.x < 10.0; }
        if (roi == 7u) { tight = p.x >= 1910.0; }
      }
      selected = interior && tight;
    }
    a[lane] = select(vec4f(0.0), vec4f(dot(delta, delta), dot(gold, gold), max(abs(delta.x), max(abs(delta.y), abs(delta.z))), select(0.0, dot(phase_error, phase_error), fixture.frame >= 8u)), selected);
    b[lane] = select(vec4f(0.0), vec4f(dot(gold, vec3f(1.0)), dot(actual, vec3f(1.0)), dot(max(delta, vec3f(0.0)), max(delta, vec3f(0.0))), dot(display - display_gold, display - display_gold)), selected);
    c[lane] = select(vec4f(0.0), vec4f(dot(display_gold, display_gold), 1.0, max(gold.x, max(gold.y, gold.z)), 0.0), selected);
    workgroupBarrier();
    for (var stride = 128u; stride > 0u; stride /= 2u) {
      if (lane < stride) {
        let peak = max(a[lane].z, a[lane + stride].z); let gold_peak = max(c[lane].z, c[lane + stride].z);
        a[lane] += a[lane + stride]; a[lane].z = peak;
        b[lane] += b[lane + stride]; c[lane] += c[lane + stride]; c[lane].z = gold_peak;
      }
      workgroupBarrier();
    }
    if (lane == 0u) { metrics[group.x * 8u + roi] = Metric(a[0], b[0], c[0]); }
    workgroupBarrier();
  }
}
`;
const CAPTURE =
  SCENE +
  `
@group(0) @binding(1) var output: texture_2d<f32>;
@group(0) @binding(2) var phase_output: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
 if (any(id.xy >= fixture.size)) { return; }
 textureStore(phase_output, vec2i(id.xy), vec4f(textureLoad(output, vec2i(id.xy), 0).rgb / fixture.exposure, 1.0));
}
`;

export async function runFinalPixelTemporalMatrixGpuOracle(device, diagnostic = false, NativeRuntime = NativeTemporalV2) {
  const width = 1920,
    height = 1080,
    frames = diagnostic ? 80 : 256;
  const owned = [];
  const texture = (format, usage = 0) => {
    const resource = device.createTexture({
      size: [width, height],
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | usage,
    });
    owned.push(resource);
    return resource;
  };
  const buffer = (size, usage) => {
    const resource = device.createBuffer({ size, usage });
    owned.push(resource);
    return resource;
  };
  const pipeline = async (code) =>
    device.createComputePipelineAsync({
      layout: "auto",
      compute: { module: device.createShaderModule({ code }), entryPoint: "main" },
    });
  const [writer, measure, capture] = await Promise.all([
    pipeline(WRITER),
    pipeline(METRICS),
    pipeline(CAPTURE),
  ]);
  const uniform = buffer(48, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  const exposure = buffer(16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const priorExposure = buffer(16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const color = texture("rgba16float", GPUTextureUsage.STORAGE_BINDING);
  const seed = texture("rgba32float", GPUTextureUsage.STORAGE_BINDING);
  const response = texture("rgba8unorm", GPUTextureUsage.STORAGE_BINDING);
  const classified = texture("rgba8unorm", GPUTextureUsage.STORAGE_BINDING);
  const classifyLayout = device.createBindGroupLayout({
    entries: [
      ...[0, 1].map((binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: "unfilterable-float" },
      })),
      ...[2, 3].map((binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: "uint" },
      })),
      {
        binding: 4,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { format: "rgba8unorm", access: "write-only" },
      },
    ],
  });
  const classifier = await device.createComputePipelineAsync({
    layout: device.createPipelineLayout({ bindGroupLayouts: [classifyLayout] }),
    compute: {
      module: device.createShaderModule({ code: NATIVE_TEMPORAL_SEED_CLASSIFY_WGSL }),
      entryPoint: "main",
    },
  });
  const identities = [
    texture("rgba32uint", GPUTextureUsage.STORAGE_BINDING),
    texture("rgba32uint", GPUTextureUsage.STORAGE_BINDING),
  ];
  const phaseHistories = [0, 1].map(() =>
    Array.from({ length: 8 }, () => texture("rgba16float", GPUTextureUsage.STORAGE_BINDING)),
  );
  const depth = texture("depth32float", GPUTextureUsage.RENDER_ATTACHMENT);
  const groups = Math.ceil((width * height) / 256),
    metricBytes = groups * 8 * 48;
  const values = buffer(metricBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const readback = buffer(metricBytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
  const depthPipeline = await device.createRenderPipelineAsync({
    layout: "auto",
    vertex: {
      module: device.createShaderModule({
        code: `@vertex fn main(@builtin(vertex_index) i:u32)->@builtin(position) vec4f { let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1); }`,
      }),
      entryPoint: "main",
    },
    fragment: {
      module: device.createShaderModule({
        code: `@group(0) @binding(0) var seed:texture_2d<f32>; @fragment fn main(@builtin(position) p:vec4f)->@builtin(frag_depth) f32 { let z=textureLoad(seed,vec2i(p.xy),0).w; return ((1000.0/999.9)*0.1)/z - 0.1/999.9; }`,
      }),
      entryPoint: "main",
      targets: [],
    },
    depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" },
  });
  const binding = (binding, resource) => ({
    binding,
    resource: resource.createView ? resource.createView() : { buffer: resource },
  });
  const depthGroup = device.createBindGroup({
    layout: depthPipeline.getBindGroupLayout(0),
    entries: [binding(0, seed)],
  });
  const families = [
    "static-thin-Siemens-MASK",
    "independent-fast-reverse-slow-stop",
    "owner-replacement-slot-reuse",
    "light-ramp-moving-shadow",
    "HDR-highlight-specular-radiance",
    "exposure-invalid-cut",
  ];
  const cases = [],
    failures = [],
    probes = [];
  const probeValues = buffer(8 * 8 * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const probeReadback = buffer(8 * 8 * 16, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
  let unormConversion = null;
  let filterFractions = null;
  if (diagnostic) {
    const encoded = device.createTexture({
      size: [256, 1],
      format: "r8unorm",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    owned.push(encoded);
    const encodePipeline = await pipeline(
      `@group(0) @binding(0) var image:texture_storage_2d<r8unorm,write>; @compute @workgroup_size(256) fn main(@builtin(local_invocation_index) i:u32) {textureStore(image,vec2i(i32(i),0),vec4f((f32(i%64u)+f32(i/64u)*0.25)/255.0,0,0,0));}`,
    );
    const decodePipeline = await pipeline(
      `@group(0) @binding(0) var image:texture_2d<f32>; @group(0) @binding(1) var<storage,read_write> result:array<f32>; @compute @workgroup_size(256) fn main(@builtin(local_invocation_index) i:u32){result[i]=textureLoad(image,vec2i(i32(i),0),0).x*255.0;}`,
    );
    const enc = device.createCommandEncoder();
    for (const [pipe, entries] of [
      [encodePipeline, [{ binding: 0, resource: encoded.createView() }]],
      [
        decodePipeline,
        [
          { binding: 0, resource: encoded.createView() },
          { binding: 1, resource: { buffer: probeValues } },
        ],
      ],
    ]) {
      const pass = enc.beginComputePass();
      pass.setPipeline(pipe);
      pass.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries }));
      pass.dispatchWorkgroups(1);
      pass.end();
    }
    enc.copyBufferToBuffer(probeValues, 0, probeReadback, 0, 1024);
    device.queue.submit([enc.finish()]);
    await probeReadback.mapAsync(GPUMapMode.READ);
    unormConversion = Array.from(new Float32Array(probeReadback.getMappedRange(0, 1024)));
    probeReadback.unmap();
  }
  if (diagnostic) {
    const encoded = device.createTexture({
      size: [2, 1],
      format: "r8unorm",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    owned.push(encoded);
    const writer = await pipeline(
      `@group(0) @binding(0) var image:texture_storage_2d<r8unorm,write>; @compute @workgroup_size(2) fn main(@builtin(local_invocation_index) i:u32){textureStore(image,vec2i(i32(i),0),vec4f(f32(i),0,0,0));}`,
    );
    const reader = await pipeline(
      `@group(0) @binding(0) var image:texture_2d<f32>; @group(0) @binding(1) var linear_clamp:sampler; @group(0) @binding(2) var<storage,read_write> result:array<f32>; @compute @workgroup_size(256) fn main(@builtin(local_invocation_index) i:u32){ result[i]=textureSampleLevel(image,linear_clamp,vec2f((0.5+f32(i)/255.0)/2.0,0.5),0.0).x;}`,
    );
    const enc = device.createCommandEncoder();
    for (const [pipe, entries] of [
      [writer, [{ binding: 0, resource: encoded.createView() }]],
      [
        reader,
        [
          { binding: 0, resource: encoded.createView() },
          { binding: 1, resource: device.createSampler({ minFilter: "linear", magFilter: "linear" }) },
          { binding: 2, resource: { buffer: probeValues } },
        ],
      ],
    ]) {
      const pass = enc.beginComputePass();
      pass.setPipeline(pipe);
      pass.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries }));
      pass.dispatchWorkgroups(1);
      pass.end();
    }
    enc.copyBufferToBuffer(probeValues, 0, probeReadback, 0, 1024);
    device.queue.submit([enc.finish()]);
    await probeReadback.mapAsync(GPUMapMode.READ);
    filterFractions = Array.from(new Float32Array(probeReadback.getMappedRange(0, 1024)));
    probeReadback.unmap();
  }
  const probe = await pipeline(`
@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> samples: array<vec4f>;
@compute @workgroup_size(8) fn main(@builtin(local_invocation_index) i:u32) {
 let points = array<vec2i,8>(vec2i(600,540),vec2i(601,540),vec2i(602,540),vec2i(603,540),vec2i(800,429),vec2i(800,430),vec2i(800,431),vec2i(800,432));
 let p = min(points[i] * vec2i(textureDimensions(image)) / vec2i(1920,1080), vec2i(textureDimensions(image)) - 1);
 samples[i] = textureLoad(image,p,0);
}
`);
  let runtimes = [];
  try {
    for (let family = 0; family < (diagnostic ? 1 : families.length); family++) {
      runtimes = [new Reference(device), new NativeRuntime(device)];
      const series = [[], []];
      let previousJitter = [0, 0],
        previousExposure = 1;
      for (let frame = 0; frame < frames; frame++) {
        const radical = (value, base) => {
          let result = 0,
            factor = 1 / base;
          while (value) {
            result += (value % base) * factor;
            value = Math.floor(value / base);
            factor /= base;
          }
          return result;
        };
        const jitter = [radical((frame % 8) + 1, 2) - 0.5, radical((frame % 8) + 1, 3) - 0.5];
        const p = family === 5 ? (frame >= 128 ? 0.25 : frame >= 96 ? 4 : 1) : 1;
        const bytes = new ArrayBuffer(48);
        new Uint32Array(bytes).set([width, height, family, frame]);
        new Float32Array(bytes).set([...jitter, ...previousJitter, p, previousExposure], 4);
        device.queue.writeBuffer(uniform, 0, bytes);
        device.queue.writeBuffer(exposure, 0, new Float32Array([p, 0, 0, 0]));
        device.queue.writeBuffer(priorExposure, 0, new Float32Array([previousExposure, 0, 0, 0]));
        const inputEncoder = device.createCommandEncoder();
        const input = inputEncoder.beginComputePass();
        input.setPipeline(writer);
        input.setBindGroup(
          0,
          device.createBindGroup({
            layout: writer.getBindGroupLayout(0),
            entries: [
              binding(0, uniform),
              binding(1, color),
              binding(2, seed),
              binding(3, response),
              binding(4, identities[frame % 2]),
            ],
          }),
        );
        input.dispatchWorkgroups(width / 8, height / 8);
        input.end();
        const depthPass = inputEncoder.beginRenderPass({
          colorAttachments: [],
          depthStencilAttachment: {
            view: depth.createView(),
            depthClearValue: 0,
            depthLoadOp: "clear",
            depthStoreOp: "store",
          },
        });
        depthPass.setPipeline(depthPipeline);
        depthPass.setBindGroup(0, depthGroup);
        depthPass.draw(3);
        depthPass.end();
        const classifyPass = inputEncoder.beginComputePass();
        classifyPass.setPipeline(classifier);
        classifyPass.setBindGroup(
          0,
          device.createBindGroup({
            layout: classifyLayout,
            entries: [
              binding(0, seed),
              binding(1, response),
              binding(2, identities[frame % 2]),
              binding(3, identities[1 - (frame % 2)]),
              binding(4, classified),
            ],
          }),
        );
        classifyPass.dispatchWorkgroups(width / 8, height / 8);
        classifyPass.end();
        device.queue.submit([inputEncoder.finish()]);
        for (let path = 0; path < 2; path++) {
          const runtime = runtimes[path];
          const reset = frame === 0 || (family === 5 && frame === 160);
          runtime.prepareFrame(
            { writeBuffer: (...args) => device.queue.writeBuffer(...args) },
            {
              width,
              height,
              renderWidth: width,
              renderHeight: height,
              outputWidth: width,
              outputHeight: height,
              jitter,
              cameraNear: 0.1,
              cameraFar: 1000,
              cameraFovY: Math.PI / 3,
              cameraInfiniteFar: false,
              frameTimeMs: 1000 / 60,
              reset,
            },
          );
          const graph = new FrameGraph(`matrix/${family}/${frame}/${path}`);
          const imported = (name, resource) => graph.import_resource(name, { kind: "imported" }, resource);
          const output = runtime.addToGraph(
            graph,
            {
              color: imported("color", color),
              seed: imported("seed", seed),
              response: imported("response", response),
              identity: imported("identity", identities[frame % 2]),
              previousIdentity: imported("previous identity", identities[1 - (frame % 2)]),
              depth: imported("depth", depth),
              motion: imported("motion", seed),
              reactiveMask: imported("reactive", classified),
              validityMask: imported("validity", classified),
              preExposure: imported("exposure", exposure),
              priorExposure: imported("prior exposure", priorExposure),
              width,
              height,
              outputWidth: width,
              outputHeight: height,
            },
            (_name, resolve) => resolve(runtime),
          );
          if (diagnostic) {
            const names = path
              ? [
                  "Native Temporal V2/analysis",
                  "Native Temporal V2/current frame info",
                  "Native Temporal V2/current color",
                  "Native Temporal V2/current luma",
                  "Native Temporal V2/current luma history",
                  "Native Temporal V2/shading mip 2",
                  "Native Temporal V2/shading mip 4",
                  "Native Temporal V2/shading mip 8",
                ]
              : [
                  "Native Temporal/classified masks",
                  "FSR3/current frame info",
                  "FSR3/current color",
                  "FSR3/current luma",
                  "Native Temporal/current luma history",
                  "FSR3/shading SPD mip0",
                  "FSR3/shading SPD mip1",
                  "FSR3/shading SPD mip2",
                ];
            const ids = names.map((name) => {
              for (let i = graph.resourceNodeCount - 1; i >= 0; i--)
                if (graph.getResourceNode(i).name === name) return i;
              throw new Error(`Probe lost ${name}`);
            });
            const probePass = graph.add("diagnostic/probe", {}, (_data, resources, context) => {
              for (let k = 0; k < ids.length; k++) {
                const pass = context.encoder.beginComputePass();
                pass.setPipeline(probe);
                pass.setBindGroup(
                  0,
                  device.createBindGroup({
                    layout: probe.getBindGroupLayout(0),
                    entries: [binding(0, resources.get(ids[k])), binding(1, probeValues)],
                  }),
                );
                pass.dispatchWorkgroups(1);
                pass.end();
                context.encoder.copyBufferToBuffer(probeValues, 0, probeReadback, k * 8 * 16, 8 * 16);
              }
            });
            ids.forEach((id) => probePass.read(id));
            probePass.make_side_effect();
          }
          const phaseImage = phaseHistories[path][frame % 8];
          const observe = graph.add("independent frame metrics", {}, (_data, resources, context) => {
            const encoder = context.encoder.gpu_encoder;
            const pass = encoder.beginComputePass();
            pass.setPipeline(measure);
            pass.setBindGroup(
              0,
              device.createBindGroup({
                layout: measure.getBindGroupLayout(0),
                entries: [
                  binding(0, uniform),
                  binding(1, resources.get(output)),
                  binding(2, phaseImage),
                  binding(3, values),
                ],
              }),
            );
            pass.dispatchWorkgroups(groups);
            pass.end();
            const copy = encoder.beginComputePass();
            copy.setPipeline(capture);
            copy.setBindGroup(
              0,
              device.createBindGroup({
                layout: capture.getBindGroupLayout(0),
                entries: [binding(0, uniform), binding(1, resources.get(output)), binding(2, phaseImage)],
              }),
            );
            copy.dispatchWorkgroups(width / 8, height / 8);
            copy.end();
            encoder.copyBufferToBuffer(values, 0, readback, 0, metricBytes);
          });
          observe.read(output);
          observe.make_side_effect();
          const compiled = graph.compile(),
            encoder = device.createCommandEncoder(),
            transient = [];
          let finish;
          const completion = new Promise((resolve) => {
            finish = resolve;
          });
          const command = {
            gpu_encoder: encoder,
            beginComputePass: (descriptor) => encoder.beginComputePass(descriptor),
            copyBufferToBuffer: (...args) => encoder.copyBufferToBuffer(...args),
            allocateTransientBufferAndLoad(data, usage) {
              const b = device.createBuffer({ size: data.byteLength, usage, mappedAtCreation: true });
              new Uint8Array(b.getMappedRange()).set(new Uint8Array(data));
              b.unmap();
              transient.push(b);
              return b;
            },
          };
          compiled.execute(new FrameGraphContext({ device, encoder: command, completion }));
          device.queue.submit([encoder.finish()]);
          const done = device.queue.onSubmittedWorkDone();
          runtime.commit(done);
          await done;
          finish();
          if (diagnostic) {
            await probeReadback.mapAsync(GPUMapMode.READ);
            probes.push({
              frame,
              path,
              values: Array.from(new Float32Array(probeReadback.getMappedRange())),
            });
            probeReadback.unmap();
          }
          await readback.mapAsync(GPUMapMode.READ);
          const records = new Float32Array(readback.getMappedRange());
          const totals = Array.from({ length: 8 }, () => new Float64Array(12));
          for (let group = 0; group < groups; group++)
            for (let roi = 0; roi < 8; roi++)
              for (let k = 0; k < 12; k++) {
                const value = records[(group * 8 + roi) * 12 + k];
                const target = totals[roi];
                assert.ok(Number.isFinite(value), `${families[family]}/${frame}/${path}: non-finite metrics`);
                target[k] = k === 2 || k === 10 ? Math.max(target[k], value) : target[k] + value;
              }
          readback.unmap();
          compiled.destroy();
          transient.forEach((resource) => resource.destroy());
          series[path].push(
            totals.map((t) => ({
              hdr: Math.sqrt(t[0] / Math.max(t[1], 1e-20)),
              peak: t[2] / Math.max(t[10], 1e-20),
              phase: Math.sqrt(t[3] / Math.max(t[1], 1e-20)),
              energy: Math.abs(t[5] - t[4]) / Math.max(t[4], 1e-20),
              trail: Math.sqrt(t[6] / Math.max(t[1], 1e-20)),
              display: Math.sqrt(t[7] / Math.max(t[8], 1e-20)),
              mean: t[5] / (t[9] * 3),
              count: t[9],
            })),
          );
        }
        previousJitter = jitter;
        previousExposure = p;
      }
      if (diagnostic) {
        cases.push({ family: families[family], frames, series });
        break;
      }
      const floor = 2 ** -10;
      for (let roi = 0; roi < 8; roi++)
        for (const metric of ["hdr", "display", "peak", "phase", "energy", "trail"]) {
          const means = series.map((s) => s.slice(64).reduce((sum, f) => sum + f[roi][metric], 0) / 192);
          const margin = metric === "hdr" || metric === "display" ? 0.01 : 0;
          if (means[1] > means[0] + Math.max(floor, means[0] * margin))
            failures.push(`${families[family]}/ROI${roi}/${metric}: ${means[1]} > ${means[0]}`);
          if (metric === "hdr" || metric === "display")
            for (let frame = 64; frame < frames; frame++) {
              const a = series[1][frame][roi][metric],
                b = series[0][frame][roi][metric];
              if (a > b + Math.max(floor, b * 0.03))
                failures.push(`${families[family]}/frame${frame}/ROI${roi}/${metric}: ${a} > ${b}`);
            }
        }
      const settling = series.map((s) =>
        Array.from({ length: 8 }, (_, roi) => {
          const envelope = Math.max(...s.slice(48, 64).map((f) => f[roi].hdr)) + floor;
          for (let f = 192; f <= 248; f++)
            if (s.slice(f, f + 8).every((row) => row[roi].hdr <= envelope)) return f - 192;
          return null;
        }),
      );
      for (let roi = 0; roi < 8; roi++)
        if (
          settling[0][roi] !== null &&
          (settling[1][roi] === null || settling[1][roi] > settling[0][roi] + 8)
        )
          failures.push(`${families[family]}/ROI${roi}: settling ${settling[1][roi]} > ${settling[0][roi]}`);
      cases.push({ family: families[family], frames, series, settling });
      runtimes.forEach((runtime) => runtime.destroy());
      await device.queue.onSubmittedWorkDone();
      await Promise.resolve();
      runtimes = [];
    }
    assert.deepEqual(failures, [], JSON.stringify({ failures, cases }));
    return {
      status: "passed",
      diagnostic,
      probes,
      unormConversion,
      filterFractions,
      domain: [width, height],
      framesPerCase: frames,
      roisPerFamily: 8,
      roiPolicy:
        "interior/broad/unchanged/far-corner plus four analytic family-specific tight regions; frozen independently of outputs",
      successfulFrames: frames * families.length,
      cases,
      failures,
      reference: "frozen 015548 production T3",
      limitations:
        "Synthetic full-resolution color/Seed matrix; actual material/normal/MASK writer and Renderer lifecycle checked separately. Dungeon/manual display and final integration acceptance remain Phase5/6.",
    };
  } finally {
    runtimes.forEach((runtime) => runtime.destroy());
    await device.queue.onSubmittedWorkDone();
    owned.forEach((resource) => resource.destroy());
  }
}

export async function runFinalPixelTemporalProbeGpuOracle(device) {
  return runFinalPixelTemporalMatrixGpuOracle(device, true);
}
