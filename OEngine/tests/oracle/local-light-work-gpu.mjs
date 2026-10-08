import { LocalLightWorkGenerator } from "../../.test-dist/render/lighting/LocalLightWorkGenerator.js";
import { LOCAL_LIGHT_MODE, localLightId } from "../../.test-dist/gpu/GpuLocalLightWorkAbi.js";
import { GPULightCollection } from "../../.test-dist/gpu/LightDatabase.js";
import { Scene } from "../../.test-dist/scene/Scene.js";
import { PointLight } from "../../.test-dist/light/PointLight.js";
import { SpotLight } from "../../.test-dist/light/SpotLight.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import { FrameProfiler } from "../../.test-dist/debug/FrameProfiler.js";
import { GraphicsContext } from "../../.test-dist/gpu/GraphicsContext.js";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export async function runLocalLightWorkGpuOracle(device) {
  const graphics = new GraphicsContext(device, new FrameProfiler({ enabled: false }));
  const scene = new Scene();
  const lights = new GPULightCollection(graphics, scene.lights);
  const owner = new LocalLightWorkGenerator(device, 17);
  const width = 256,
    height = 128;
  const visibility = device.createTexture({
    size: [width, height],
    format: "r32uint",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
  });
  const depth = device.createTexture({
    size: [width, height],
    format: "depth32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
  });
  const view = {
    width,
    height,
    near: 0.1,
    far: 100,
    depthConversion: [0, 0.1],
    projection: [1, 1, 0, 0],
    view: identity
  };
  const read = async (buffer) => {
    const download = device.createBuffer({
      size: buffer.size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    try {
      const command = device.createCommandEncoder();
      command.copyBufferToBuffer(buffer, 0, download, 0, buffer.size);
      device.queue.submit([command.finish()]);
      await download.mapAsync(GPUMapMode.READ);
      return new Uint32Array(download.getMappedRange().slice(0));
    } finally {
      if (download.mapState === "mapped") download.unmap();
      download.destroy();
    }
  };
  let frameIndex = 0,
    authored = [];
  const run = async (
    count,
    {
      empty = false,
      indexCapacity,
      taskBudget,
      mode = 2,
      mutate = false,
      abort = false,
      mismatch = false,
      dispatchWidth,
      invalidSlot = false,
      sampleDepth = 3
    } = {}
  ) => {
    scene.remove(authored);
    authored = Array.from({ length: count }, (_, index) => {
      const light = index % 2 ? new SpotLight() : new PointLight();
      light.position.set(((index % 7) - 3) * 0.35, ((index % 3) - 1) * 0.4, 0.5 - sampleDepth);
      light.distance = index % 11 === 0 ? 0 : 0.8;
      light.radius = 0.1;
      if (light.isSpotLight) {
        light.forward = [0, 0, -1];
        light.angle = 1;
      }
      scene.add(light);
      return light;
    });
    const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    lights.build(command);
    const pointCount = lights.pointLights.count,
      spotCount = lights.spotLights.count;
    const ids = new Uint32Array(pointCount + spotCount);
    for (let index = 0; index < pointCount; index++) ids[index] = localLightId(index, 0);
    for (let index = 0; index < spotCount; index++) ids[pointCount + index] = localLightId(index, 1);
    if (invalidSlot) ids[0] = localLightId(16000, 0);
    const revision = lights.publicationRevision;
    const request = {
      publication: {
        buffer: lights.buffer_data,
        revision,
        ids,
        currentRevision: () => lights.publicationRevision
      },
      view,
      frameIndex: frameIndex++,
      deviceEpoch: 17,
      visibility: visibility.createView(),
      depth: depth.createView(),
      mode: count ? mode : 0,
      indexCapacity,
      taskBudget
    };
    const frame = owner.prepare(request);
    const state = owner.frames.get(frame);
    if (dispatchWidth)
      device.queue.writeBuffer(state.allocation.settings, 24, new Uint32Array([dispatchWidth]));
    if (mismatch) {
      const encoder = command.gpu_encoder;
      Object.defineProperty(command, "gpu_encoder", {
        value: new Proxy(encoder, {
          get(target, key) {
            if (key === "beginComputePass")
              return (descriptor) => {
                if (descriptor.label === "LocalLightWork/finalize") {
                  target.clearBuffer(
                    state.allocation.scratch,
                    (10 * count + state.clusters) * 4,
                    state.clusters * 4
                  );
                }
                return target.beginComputePass(descriptor);
              };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
        })
      });
    }
    const pass = command.gpu_encoder.beginRenderPass({
      colorAttachments: [
        {
          view: visibility.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: empty ? 0xffffffff : 0, g: 0, b: 0, a: 0 }
        }
      ],
      depthStencilAttachment: {
        view: depth.createView(),
        depthLoadOp: "clear",
        depthStoreOp: "store",
        depthClearValue: 0.1 / sampleDepth
      }
    });
    pass.end();
    owner.encode(command, frame);
    if (mutate) {
      // Fault injection after count/scatter, before finalize: required failure signal, not a relaxed assertion.
      const corrupt = device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
      });
      device.queue.writeBuffer(corrupt, 0, new Uint32Array([0]));
      command.gpu_encoder.copyBufferToBuffer(corrupt, 0, frame.data, 0, 4);
      command.onFinished.addOne(() => void command.gpuDone.then(() => corrupt.destroy()));
    }
    if (abort) {
      command.abort();
      check(lights.publicationRevision !== revision, "Aborted DB revision remained published");
      return { aborted: true };
    }
    command.finish();
    check(owner.inFlightBytes > 0, "Submitted light product lost fence ownership");
    await command.gpuDone;
    await Promise.resolve();
    const data = await read(frame.data),
      lookup = await read(frame.lookup);
    check(data[0] === (mutate ? 0 : 1), "Header ABI initialization/fault was hidden");
    check(
      data[3] === 17 && data[4] === request.frameIndex && data[5] === revision && data[6] === count,
      "Stale GPU header"
    );
    check(
      data.slice(16, 32).every((value) => value === 0),
      "Reserved header domain not initialized"
    );
    check(
      ids.every((tuple, index) => data[32 + index] === tuple),
      "Complete fallback IDs missing/reordered"
    );
    if (mismatch)
      check(data[1] === 1 && data[2] & 4, "Count/scatter mismatch was not a flagged DIRECT fallback");
    if (invalidSlot) check(data[1] === 1 && data[2] & 8, "Invalid DB slot was not a correctness failure");
    if (data[1] === 2) {
      const global = new Set(data.slice(32 + data[9], 32 + data[9] + data[8]));
      check(global.size === data[8], "Global tail duplicates");
      const finiteAuthored = authored.filter((light) => light.distance > 0);
      const pointIndices = authored.filter((light) => light.isPointLight),
        spotIndices = authored.filter((light) => light.isSpotLight);
      const slice = Math.max(
        0,
        Math.min(23, Math.floor((Math.log(sampleDepth / 0.1) / Math.log(100 / 0.1)) * 23))
      );
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const cluster =
            Math.floor(x / 32) +
            (Math.floor(y / 32) + slice * Math.ceil(height / 32)) * Math.ceil(width / 32);
          const offset = lookup[cluster * 2],
            length = lookup[cluster * 2 + 1];
          const tuples = data.slice(32 + data[12] + offset, 32 + data[12] + offset + length);
          check(new Set(tuples).size === length, "Duplicate cluster light");
          check(!tuples.some((tuple) => global.has(tuple)), "Finite/global overlap");
          if (empty) {
            check(length === 0, "Empty winner generated light work");
            continue;
          }
          const position = [
            (((x + 0.5) / width) * 2 - 1) * sampleDepth,
            (1 - ((y + 0.5) / height) * 2) * sampleDepth,
            -sampleDepth
          ];
          for (const light of finiteAuthored) {
            const distance = Math.hypot(
              light.position.x - position[0],
              light.position.y - position[1],
              light.position.z - position[2]
            );
            if (distance < light.distance + light.radius) {
              const tuple = localLightId(
                (light.isSpotLight ? spotIndices : pointIndices).indexOf(light),
                light.isSpotLight ? 1 : 0
              );
              check(tuples.includes(tuple), `Missing sphere-supported light at ${x},${y}`);
            }
          }
        }
      check(data[2] === 0, "Unexpected new-work correctness flags");
    }
    check(
      frame.reservedBytes <= 6 * 1024 * 1024 && owner.allocatedBytes <= 18 * 1024 * 1024,
      "Physical light budget exceeded"
    );
    return {
      count,
      sampleDepth,
      empty,
      mode: data[1],
      flags: data[2],
      indices: data[13],
      paddedRegions: data[14],
      global: data[8],
      bytes: frame.reservedBytes
    };
  };
  try {
    await owner.ready;
    const rows = [];
    for (const count of [0, 1, 4, 8, 32, 257]) rows.push(await run(count));
    rows.push(await run(32, { empty: true }));
    for (const sampleDepth of [0.1, 100, 10000]) rows.push(await run(32, { sampleDepth }));
    rows.push(await run(32, { dispatchWidth: 2 }));
    rows.push(await run(32, { mismatch: true }));
    rows.push(await run(32, { invalidSlot: true }));
    rows.push(await run(8, { mutate: true }));
    rows.push(await run(5500, { indexCapacity: 1 }));
    const indexOverflow = await run(32, { indexCapacity: 1 });
    check(
      indexOverflow.mode === 1 && indexOverflow.flags & 2,
      "Index overflow did not select complete DIRECT"
    );
    rows.push(indexOverflow);
    const taskOverflow = await run(32, { taskBudget: 0 });
    check(
      taskOverflow.mode === 1 && taskOverflow.flags & 1,
      "Region overflow did not select complete DIRECT"
    );
    rows.push(taskOverflow);
    await run(8, { abort: true });
    rows.push(await run(8));
    const bad = {
      publication: {
        buffer: lights.buffer_data,
        revision: 0,
        ids: new Uint32Array(),
        currentRevision: () => 1
      },
      view,
      frameIndex: 0,
      deviceEpoch: 17,
      visibility: visibility.createView(),
      depth: depth.createView(),
      mode: 0
    };
    let stale = false;
    try {
      owner.prepare(bad);
    } catch {
      stale = true;
    }
    check(stale, "Stale CPU publication was admitted");
    owner.destroy();
    check(owner.allocatedBytes === 0 && owner.inFlightBytes === 0, "Light owner teardown residue");
    return {
      scope: "L3.1 isolated real GPU count/scan/scatter and independent sphere coverage",
      rows,
      staleRejected: stale,
      abortRetry: true,
      teardownBytes: owner.allocatedBytes
    };
  } finally {
    await device.queue.onSubmittedWorkDone();
    owner.destroy();
    lights.destroy();
    visibility.destroy();
    depth.destroy();
    graphics.profiler.destroy();
    graphics.destroy();
  }
}
