import { VSM_RECEIVER_DEMAND_WGSL } from "../../.test-dist/shaders/vsm_receiver_demand.js";
import { packVsmProjection } from "../../.test-dist/render/vsm/VsmProjection.js";

/** Independent discrete receiver oracle: rotated tile corners can all select
 * a coarse clip while an actual interior pixel selects its finer neighbour. */
export async function runVsmReceiverExactGpuOracle(device) {
  const resources = [];
  const make = (size, usage, data) => {
    const buffer = device.createBuffer({ size, usage, mappedAtCreation: data !== undefined });
    if (data !== undefined) {
      new Uint8Array(buffer.getMappedRange()).set(
        new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength),
      );
      buffer.unmap();
    }
    resources.push(buffer);
    return buffer;
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const clips = Array.from({ length: 6 }, (_, level) => {
    const extent = 128 * 2 ** level;
    return [level === 0 ? -63 : -extent / 2, level === 0 ? -63 : -extent / 2, extent, 0];
  });
  const constants = packVsmProjection({
    generation: 7,
    projectionEpoch: 7,
    namespace: 1,
    lightView: identity,
    clipOriginExtent: clips,
  });
  new Uint32Array(constants).set([8, 8, 128, 128, 6, 7, 131072, 0], 40);
  new Float32Array(constants).set([1 / 8, 1 / 8, 1, 0], 48);
  const camera = new Float32Array(156);
  camera.set([2 / 7, -2 / 7, 0, 0, -2 / 7, -2 / 7, 0, 0, 0, 0, 1, 0, 65.1, 65.1, 0, 1], 112);
  const instance = new Uint32Array(44);
  instance[2] = 7 | (4 << 8);
  const work = new Uint32Array(14);
  work.set([1, 1, 1, 1, 0, 7, 0, 0]);
  const depth = device.createTexture({
    label: "Exact receiver/depth",
    size: [8, 8],
    format: "depth32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const keys = device.createTexture({
    label: "Exact receiver/keys",
    size: [8, 8],
    format: "r32uint",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  resources.push(depth, keys);
  device.queue.writeTexture({ texture: keys }, new Uint32Array(64), { bytesPerRow: 32 }, [8, 8]);
  const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
  const requested = make(4096 * 6, storage);
  const output = make(256, storage);
  const staging = make(256 + requested.size, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
  const module = device.createShaderModule({
    label: "Exact receiver/production probe",
    code:
      VSM_RECEIVER_DEMAND_WGSL +
      `
@group(0) @binding(7) var<storage, read_write> oracle_pages: array<u32>;
@compute @workgroup_size(8, 8)
fn receiver_probe(@builtin(global_invocation_id) id: vec3u) {
  oracle_pages[id.y * 8u + id.x] = receiver_page(id);
}`,
  });
  try {
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((message) => message.type === "error");
    if (errors.length) throw new Error(JSON.stringify(errors));
    const buffers = [
      make(624, GPUBufferUsage.UNIFORM, camera),
      null,
      null,
      make(constants.byteLength, GPUBufferUsage.UNIFORM, constants),
      requested,
      make(work.byteLength, GPUBufferUsage.STORAGE, work),
      make(176, GPUBufferUsage.STORAGE, instance),
    ];
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
    for (const entryPoint of ["receiver_probe", "main"]) {
      const pipeline = await device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint },
      });
      const entries = buffers.map((buffer, binding) => ({
        binding,
        resource: binding === 1 ? depth.createView() : binding === 2 ? keys.createView() : { buffer },
      }));
      // The probe has no demand aggregation; main has no probe output binding.
      if (entryPoint === "receiver_probe") entries.splice(4, 1);
      if (entryPoint === "receiver_probe") entries.push({ binding: 7, resource: { buffer: output } });
      const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
    }
    encoder.copyBufferToBuffer(output, 0, staging, 0, 256);
    encoder.copyBufferToBuffer(requested, 0, staging, 256, requested.size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const actual = new Uint32Array(staging.getMappedRange());
    const perLevel = 16384 + 4096 + 1024 + 256 + 64 + 64;
    const expectedBits = new Uint32Array(requested.size / 4);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const xy = [64.6 + (x + y) / 14, 65.1 + (-x + y) / 14];
        let expected;
        for (let level = 0; level < 6; level++) {
          const extent = 128 * 2 ** level;
          const step = extent / 128;
          const minimum = level === 0 ? -63 : -extent / 2;
          const world = xy.map((v) => Math.floor(v / step));
          if (world.every((v) => v >= minimum / step && v < minimum / step + 128)) {
            expected =
              level * perLevel + (((world[1] % 128) + 128) % 128) * 128 + (((world[0] % 128) + 128) % 128);
            break;
          }
        }
        if (actual[y * 8 + x] !== expected)
          throw new Error(`Receiver lane ${y * 8 + x}: ${actual[y * 8 + x]} != ${expected}`);
        expectedBits[expected >>> 5] |= 1 << (expected & 31);
      }
    }
    const bits = actual.subarray(64);
    if (bits.some((v, i) => v !== expectedBits[i]))
      throw new Error("Production receiver demand differs from exact pixel set");
    if (actual[0] === actual[12]) throw new Error("Nested clip regression fixture lost its sensitivity");
    staging.unmap();
    return { pixels: 64, exactRequestSet: true, nestedClipInterior: true, compiledProduction: true };
  } finally {
    if (staging.mapState === "mapped") staging.unmap();
    resources.forEach((resource) => resource.destroy());
  }
}
