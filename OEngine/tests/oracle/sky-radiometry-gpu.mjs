import {
  GpuRadiometryPass,
  GPU_RADIOMETRY_WGSL,
} from "../../.test-dist/render/temporal/GpuRadiometryPass.js";
import { encodeFloat16 } from "../../.test-dist/core/Float16.js";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const close = (a, b, tolerance, message) => check(Math.abs(a - b) <= tolerance, `${message}: ${a} vs ${b}`);

/** Production histogram/reduce and exposure owner. The fixture produces
 * physical luminance * GPU previous exposure, matching the real frame chain. */
export async function runSkyRadiometryGpuOracle(device) {
  const width = 160,
    height = 32,
    resources = [];
  const texture = (usage) => {
    const t = device.createTexture({ size: [width, height], format: "rgba16float", usage });
    resources.push(t);
    return t;
  };
  const physical = texture(GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
  const scene = texture(GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING);
  const make = (size, usage) => {
    const b = device.createBuffer({ size, usage });
    resources.push(b);
    return b;
  };
  const histogram = make(4096, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const constants = make(64, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  const trace = make(480 * 32, GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
  const upload = (low, high = low, fraction = 0) => {
    const values = new Uint16Array(width * height * 4);
    const lowColumns = Math.round((width * (1 - fraction)) / 2) * 2;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const v = encodeFloat16(x < lowColumns ? low : high);
        const p = (y * width + x) * 4;
        values.set([v, v, v, 0x3c00], p);
      }
    device.queue.writeTexture({ texture: physical }, values, { bytesPerRow: width * 8 }, { width, height });
  };
  const module = device.createShaderModule({ code: GPU_RADIOMETRY_WGSL });
  const meter = device.createComputePipeline({
    layout: "auto",
    compute: { module, entryPoint: "histogram_main" },
  });
  const reduce = device.createComputePipeline({
    layout: "auto",
    compute: { module, entryPoint: "reduce_main" },
  });
  const prepare = device.createComputePipeline({
    layout: "auto",
    compute: {
      entryPoint: "main",
      module: device.createShaderModule({
        code: `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<storage, read> exposure: array<f32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= textureDimensions(source))) { return; }
  textureStore(destination, id.xy, vec4f(textureLoad(source,vec2i(id.xy),0).rgb * exposure[0],1.0));
}`,
      }),
    },
  });
  const group = (pipeline, index, entries) =>
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(index),
      entries: entries.map((resource, binding) => ({ binding, resource })),
    });
  let owner;
  const resetOwner = () => {
    owner?.destroy();
    owner = new GpuRadiometryPass(device);
  };
  const step = (dt = 1 / 60, index = 0, abort = false) => {
    owner.prepareFrame(dt);
    device.queue.writeBuffer(constants, 0, owner.frameSettings(width, height));
    const encoder = device.createCommandEncoder();
    const p = encoder.beginComputePass();
    p.setPipeline(prepare);
    p.setBindGroup(
      0,
      group(prepare, 0, [physical.createView(), scene.createView(), { buffer: owner.readBuffer() }]),
    );
    p.dispatchWorkgroups(width / 8, height / 8);
    p.end();
    const m = encoder.beginComputePass();
    m.setPipeline(meter);
    m.setBindGroup(
      0,
      group(meter, 0, [
        scene.createView(),
        { buffer: histogram },
        { buffer: constants },
        { buffer: owner.readBuffer() },
      ]),
    );
    m.dispatchWorkgroups(Math.ceil(width / 32), Math.ceil(height / 32));
    m.end();
    const r = encoder.beginComputePass();
    r.setPipeline(reduce);
    r.setBindGroup(
      1,
      group(reduce, 1, [
        { buffer: histogram },
        { buffer: owner.readBuffer() },
        { buffer: owner.writeBuffer() },
        { buffer: constants },
      ]),
    );
    r.dispatchWorkgroups(1);
    r.end();
    encoder.copyBufferToBuffer(owner.writeBuffer(), 0, trace, index * 32, 32);
    if (abort) {
      encoder.finish();
      owner.abort();
      return;
    }
    device.queue.submit([encoder.finish()]);
    owner.commit(device.queue.onSubmittedWorkDone());
  };
  const readTrace = async (count) => {
    const b = make(count * 32, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const e = device.createCommandEncoder();
    e.copyBufferToBuffer(trace, 0, b, 0, count * 32);
    device.queue.submit([e.finish()]);
    await b.mapAsync(GPUMapMode.READ);
    const v = Array.from(new Float32Array(b.getMappedRange()));
    b.unmap();
    return v;
  };
  try {
    const hdr = [];
    for (const luminance of [1, 4, 16, 100, 1000]) {
      resetOwner();
      upload(luminance);
      step();
      const result = await owner.readDiagnostics();
      close(result.exposure * luminance, 0.18, 0.003, `HDR ${luminance}`);
      check(result.validSamples === (width * height) / 4, "sample domain");
      hdr.push({ luminance, ...result });
      step();
      const repeated = await owner.readDiagnostics();
      close(repeated.exposure, result.exposure, 0.00003, "meter removes actual previous pre-exposure");
    }
    for (let i = 1; i < hdr.length; i++)
      check(hdr[i].exposure < hdr[i - 1].exposure / 2, "HDR response must continue beyond 4");
    const distributions = [];
    for (const [name, low, high, fraction] of [
      ["dark-majority", 0.01, 1, 0.2],
      ["dark-building-bright-sky", 0.005, 1, 0.1],
      ["firefly", 1, 1000, 0.0125],
      ["black", 0, 0, 0],
    ]) {
      resetOwner();
      upload(low, high, fraction);
      step();
      const result = await owner.readDiagnostics();
      check(Number.isFinite(result.exposure) && result.exposure > 0, `${name} finite`);
      if (name.startsWith("dark"))
        check(
          result.exposure * high <= 0.73,
          "percentile highlight headroom must prevent multi-fold bright-region gain",
        );
      if (name === "firefly") close(result.exposure, 0.18, 0.003, "small HDR outlier excluded");
      if (name === "black") close(result.exposure, 1, 1e-6, "no valid samples retains initial exposure");
      distributions.push({ name, ...result });
    }
    const temporal = [];
    for (const [direction, start, end] of [
      ["dark-bright", 0.01, 1],
      ["bright-dark", 1, 0.01],
    ]) {
      const endpoints = [];
      for (const fps of [30, 60, 120]) {
        resetOwner();
        upload(start);
        step();
        const before = await owner.readDiagnostics();
        upload(end);
        const count = fps * 2;
        for (let frame = 0; frame < count; frame++) step(1 / fps, frame);
        const values = await readTrace(count);
        let previous = before.exposure,
          maxLogStep = 0;
        for (let frame = 0; frame < count; frame++) {
          const exposure = values[frame * 8];
          check(Number.isFinite(exposure) && exposure > 0, "finite temporal exposure");
          check(
            direction === "dark-bright" ? exposure <= previous * 1.0001 : exposure >= previous * 0.9999,
            "monotonic adaptation",
          );
          maxLogStep = Math.max(maxLogStep, Math.abs(Math.log2(exposure / previous)));
          previous = exposure;
        }
        check(maxLogStep < 0.7, "no reset-sized single-frame exposure jump");
        const result = await owner.readDiagnostics();
        endpoints.push(result.adaptedLogLuminance);
        temporal.push({ direction, fps, maxLogStep, ...result });
      }
      check(
        Math.max(...endpoints) - Math.min(...endpoints) < 0.015,
        "30/60/120 FPS adaptation must agree in elapsed time",
      );
    }
    resetOwner();
    upload(16);
    step();
    const before = await owner.readDiagnostics();
    step(1 / 60, 0, true);
    const aborted = await owner.readDiagnostics();
    close(aborted.exposure, before.exposure, 0, "aborted frame does not publish state");
    step();
    const retry = await owner.readDiagnostics();
    close(retry.exposure, before.exposure, 0.00002, "retry retains pre-exposure");
    owner.resetExposure();
    step();
    const reset = await owner.readDiagnostics();
    close(reset.exposure * 16, 0.18, 0.003, "explicit reset initializes from actual meter");
    return {
      hdr,
      distributions,
      temporal,
      lifecycle: { before, aborted, retry, reset },
      settings: owner.settings,
    };
  } finally {
    owner?.destroy();
    resources.forEach((r) => r.destroy());
  }
}
