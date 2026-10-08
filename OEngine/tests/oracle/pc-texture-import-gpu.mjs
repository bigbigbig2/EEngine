import {
  PcTexturePreparation,
  createPcTextureWorker
} from "../../.test-dist/assets/codec/PcTexturePreparation.js";
import {
  initializePcTextureCodecs,
  decodePcTextureMip
} from "../../.test-dist/assets/codec/PcTextureCook.js";
import { writeTextureProductPlane } from "../../.test-dist/assets/TextureProduct.js";
import { check } from "./texture-baseline-gpu.mjs";

export async function runPcTextureImportGpuOracle(device) {
  const codecs = await initializePcTextureCodecs();
  const service = new PcTexturePreparation({
    createWorker: () =>
      createPcTextureWorker(
        new URL("../../.test-dist/assets/codec/workers/pc-texture-worker.js", import.meta.url)
      )
  });
  const cases = [];
  try {
    for (const name of [
      "rgba-64x64-mipmap-etc1s.ktx2",
      "luminance-alpha-32x32-uastc.ktx2",
      "uastc-zstd.ktx2"
    ]) {
      const response = await fetch(new URL(`../fixtures/texture-codec/${name}`, import.meta.url));
      check(response.ok, `KTX fixture fetch ${name}`);
      const input = await response.arrayBuffer();
      if (name === "uastc-zstd.ktx2") {
        let rejected = false;
        try {
          await service.importKtx(input.slice(0, 80), { semantic: "base-color-srgb", sourceUri: name });
        } catch {
          rejected = true;
        }
        check(rejected, "Truncated KTX was accepted");
      }
      const { product, evidence } = await service.importKtx(input, {
        semantic: "base-color-srgb",
        sourceUri: name
      });
      const plane = product.metadata.planes[0];
      const texture = device.createTexture({
        size: [product.metadata.storageWidth, product.metadata.storageHeight, 2],
        mipLevelCount: plane.mips.length,
        format: plane.format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      });
      let maxError = 0,
        samples = 0;
      try {
        const uploaded = writeTextureProductPlane(device, product, 0, texture, 1);
        check(uploaded === product.evidence.ownedPayloadBytes, "KTX tight upload bytes mismatch");
        const module = device.createShaderModule({
          code: `
@group(0) @binding(0) var source: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read_write> output: array<vec4f>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let extent = textureDimensions(source);
  if any(id.xy >= extent) { return; }
  output[id.y * extent.x + id.x] = textureLoad(source, vec2i(id.xy), 1, 0);
}`
        });
        check(
          !(await module.getCompilationInfo()).messages.some((m) => m.type === "error"),
          "KTX shader compilation failed"
        );
        const pipeline = await device.createComputePipelineAsync({
          layout: "auto",
          compute: { module, entryPoint: "main" }
        });
        for (const mip of plane.mips) {
          const size = mip.width * mip.height * 16;
          const stride = Math.ceil(size / 256) * 256;
          const output = device.createBuffer({
            size: stride * 2,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
          });
          const read = device.createBuffer({
            size: stride * 2,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
          });
          const referenceArray = device.createTexture({
            size: [mip.width, mip.height, 2],
            format: "rgba8unorm-srgb",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
          });
          try {
            const decoded = decodePcTextureMip(
              codecs.basis,
              product.chunks.get(mip.chunkId),
              mip.width,
              mip.height,
              7
            );
            device.queue.writeTexture(
              { texture: referenceArray, origin: [0, 0, 1] },
              decoded,
              { bytesPerRow: mip.width * 4 },
              [mip.width, mip.height]
            );
            const encoder = device.createCommandEncoder();
            for (const [index, source] of [texture, referenceArray].entries()) {
              const group = device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                  {
                    binding: 0,
                    resource: source.createView({
                      dimension: "2d-array",
                      baseMipLevel: index === 0 ? mip.level : 0,
                      mipLevelCount: 1
                    })
                  },
                  { binding: 1, resource: { buffer: output, offset: index * stride, size } }
                ]
              });
              const pass = encoder.beginComputePass();
              pass.setPipeline(pipeline);
              pass.setBindGroup(0, group);
              pass.dispatchWorkgroups(Math.ceil(mip.width / 8), Math.ceil(mip.height / 8));
              pass.end();
            }
            encoder.copyBufferToBuffer(output, 0, read, 0, stride * 2);
            device.queue.submit([encoder.finish()]);
            await read.mapAsync(GPUMapMode.READ);
            const actual = new Float32Array(read.getMappedRange());
            for (let i = 0; i < decoded.length; i++) {
              const expected = actual[i + stride / 4];
              const error = Math.abs(actual[i] - expected);
              check(Number.isFinite(error), "Non-finite KTX GPU sample");
              maxError = Math.max(maxError, error);
            }
            samples += mip.width * mip.height;
            read.unmap();
          } finally {
            output.destroy();
            read.destroy();
            referenceArray.destroy();
          }
        }
        check(maxError <= 0.0001, `KTX hardware decode error ${maxError} exceeds unchanged 1e-4`);
        cases.push({
          name,
          identity: product.identity,
          mips: plane.mips.length,
          uploaded,
          maxError,
          samples,
          worker: evidence
        });
      } finally {
        texture.destroy();
      }
    }
  } finally {
    service.dispose();
  }
  const teardown = service.evidence();
  check(
    teardown.activeWorkers === 0 && teardown.queuedTasks === 0 && teardown.inFlightEstimatedBytes === 0,
    "KTX Worker credits not zero"
  );
  return {
    stage: "T4.1",
    scope:
      "external KTX -> real browser Worker -> Product -> array layer1 -> hardware BC7 decode; no production cutover",
    cases,
    teardown
  };
}
