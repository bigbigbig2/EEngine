import { FrameGraph, FrameGraphContext } from "../../.test-dist/framegraph/FrameGraph.js";
import { NativeTemporalV2 } from "../../.test-dist/render/temporal/NativeTemporalV2.js";
import { Fsr3UpscalerRuntime as BeforeRuntime } from "./reference/phase4/Fsr3UpscalerRuntime.mjs";
import { floatToHalf } from "../../.test-dist/loaders/float16.js";

// Same complete temporal chain and input, ABBA order. Test reference only;
// no renderer runtime selector or second production temporal owner.
export async function runNativeTemporalV2CostGpuOracle(device) {
  const width = 1920,
    height = 1080;
  const owned = [];
  const texture = (format, channels, fill) => {
    const resource = device.createTexture({
      size: [width, height],
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    owned.push(resource);
    const half = format === "rgba16float";
    const bytes = format === "rgba8unorm";
    const data = half
      ? new Uint16Array(width * height * channels)
      : bytes
        ? new Uint8Array(width * height * channels)
        : format === "rgba32uint"
          ? new Uint32Array(width * height * channels)
          : new Float32Array(width * height * channels);
    for (let i = 0; i < width * height; i++)
      for (let k = 0; k < channels; k++) {
        const value = fill(i, k);
        data[i * channels + k] = half ? floatToHalf(value) : value;
      }
    device.queue.writeTexture(
      { texture: resource },
      data,
      { bytesPerRow: width * channels * data.BYTES_PER_ELEMENT },
      [width, height],
    );
    return resource;
  };
  const buffer = (size, usage) => {
    const resource = device.createBuffer({ size, usage });
    owned.push(resource);
    return resource;
  };
  const runtimes = [new BeforeRuntime(device), new NativeTemporalV2(device)];
  await runtimes[1].preparePipelines();
  try {
    const color = texture("rgba16float", 4, (i, k) => (k === 3 ? 1 : 0.2 + (i % 31) / 19));
    const motion = texture("rg32float", 2, (_i, k) => (k === 0 ? -0.7 / width : 0.6 / height));
    const seed = texture("rgba32float", 4, (_i, k) =>
      k === 0 ? -0.7 / width : k === 1 ? 0.6 / height : 0.2,
    );
    const identity = texture("rgba32uint", 4, () => 1);
    const facts = texture("rgba8unorm", 4, (_i, k) => (k === 1 || k === 3 ? 255 : 0));
    const depth = device.createTexture({
      size: [width, height],
      format: "depth32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    owned.push(depth);
    const exposure = buffer(16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(exposure, 0, new Float32Array([1, 0, 0, 0]));
    const query = device.createQuerySet({ type: "timestamp", count: 96 });
    owned.push(query);
    const resolved = buffer(96 * 8, GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC);
    const readback = buffer(96 * 8, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const counters = [0, 0];
    const order = Array.from({ length: 24 }, (_, i) => [0, 1, 1, 0][i % 4]);
    async function encode(index, sampleIndex = null) {
      const runtime = runtimes[index];
      const frame = counters[index]++;
      runtime.prepareFrame(
        { writeBuffer: (...args) => device.queue.writeBuffer(...args) },
        {
          width,
          height,
          renderWidth: width,
          renderHeight: height,
          outputWidth: width,
          outputHeight: height,
          jitter: [0.37, -0.29],
          cameraNear: 0.1,
          cameraFar: 1000,
          cameraFovY: Math.PI / 3,
          cameraInfiniteFar: false,
          frameTimeMs: 1000 / 60,
          reset: frame === 0,
        },
      );
      const graph = new FrameGraph("Native Temporal complete-chain cost");
      const imported = (name, resource) => graph.import_resource(name, { kind: "imported" }, resource);
      const output = runtime.addToGraph(
        graph,
        {
          color: imported("color", color),
          seed: imported("seed", seed),
          response: imported("response", facts),
          identity: imported("identity", identity),
          previousIdentity: imported("previous identity", identity),
          depth: imported("depth", depth),
          motion: imported("motion", motion),
          reactiveMask: imported("facts", facts),
          validityMask: imported("validity", facts),
          preExposure: imported("exposure", exposure),
          priorExposure: imported("prior-exposure", exposure),
          width,
          height,
          outputWidth: width,
          outputHeight: height,
        },
        (_name, resolve) => resolve(runtime),
      );
      const consume = graph.add("output consumer", {}, () => {});
      consume.read(output);
      consume.make_side_effect();
      const compiled = graph.compile();
      const encoder = device.createCommandEncoder();
      encoder
        .beginRenderPass({
          colorAttachments: [],
          depthStencilAttachment: {
            view: depth.createView(),
            depthClearValue: 0.5,
            depthLoadOp: "clear",
            depthStoreOp: "store",
          },
        })
        .end();
      const transientBuffers = [];
      const command = {
        gpu_encoder: encoder,
        beginComputePass: (descriptor) => encoder.beginComputePass(descriptor),
        copyBufferToBuffer: (...args) => encoder.copyBufferToBuffer(...args),
        allocateTransientBufferAndLoad(data, usage) {
          const resource = device.createBuffer({ size: data.byteLength, usage, mappedAtCreation: true });
          new Uint8Array(resource.getMappedRange()).set(new Uint8Array(data));
          resource.unmap();
          transientBuffers.push(resource);
          return resource;
        },
      };
      if (sampleIndex !== null)
        encoder
          .beginComputePass({
            timestampWrites: {
              querySet: query,
              beginningOfPassWriteIndex: sampleIndex * 2,
            },
          })
          .end();
      let finish;
      const completion = new Promise((resolve) => {
        finish = resolve;
      });
      compiled.execute(new FrameGraphContext({ device, encoder: command, completion }));
      if (sampleIndex !== null)
        encoder
          .beginComputePass({
            timestampWrites: {
              querySet: query,
              endOfPassWriteIndex: sampleIndex * 2 + 1,
            },
          })
          .end();
      device.queue.submit([encoder.finish()]);
      const done = device.queue.onSubmittedWorkDone();
      runtime.commit(done);
      await done;
      finish();
      compiled.destroy();
      transientBuffers.forEach((resource) => resource.destroy());
    }
    // Warm both independent histories to the same age before recording.
    for (let f = 0; f < 16; f++) {
      await encode(0);
      await encode(1);
    }
    for (let i = 0; i < order.length; i++) await encode(order[i], i);
    // A separate exact-zero motion case; neither stationary nor fractional
    // motion may be silently replaced by the other in cost reporting.
    device.queue.writeTexture(
      { texture: motion },
      new Float32Array(width * height * 2),
      { bytesPerRow: width * 8 },
      [width, height],
    );
    const stationarySeed = new Float32Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      stationarySeed[i * 4 + 2] = 0.2;
      stationarySeed[i * 4 + 3] = 0.2;
    }
    device.queue.writeTexture({ texture: seed }, stationarySeed, { bytesPerRow: width * 16 }, [
      width,
      height,
    ]);
    counters.fill(0);
    for (let f = 0; f < 16; f++) {
      await encode(0);
      await encode(1);
    }
    for (let i = 0; i < order.length; i++) await encode(order[i], order.length + i);
    const encoder = device.createCommandEncoder();
    encoder.resolveQuerySet(query, 0, 96, resolved, 0);
    encoder.copyBufferToBuffer(resolved, 0, readback, 0, 96 * 8);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const ticks = new BigUint64Array(readback.getMappedRange());
    const samples = [...order, ...order].map((index, i) => ({
      scenario: i < order.length ? "fractional-motion" : "stationary",
      path: index ? "native" : "before",
      ms: Number(ticks[i * 2 + 1] - ticks[i * 2]) / 1e6,
    }));
    readback.unmap();
    return {
      status: "passed",
      domain: [width, height],
      samples,
      note: "Complete actual reconstruction chains, separate synthetic fractional-motion and stationary cases, 16-frame warmup and 12 samples/path ABBA per case; includes inter-pass gaps. Not Dungeon, locked clocks or a gain assertion.",
    };
  } finally {
    runtimes.forEach((runtime) => runtime.destroy());
    await device.queue.onSubmittedWorkDone();
    await Promise.resolve();
    owned.forEach((resource) => resource.destroy());
  }
}
