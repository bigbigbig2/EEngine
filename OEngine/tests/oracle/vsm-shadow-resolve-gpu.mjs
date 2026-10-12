import { createNativeSurfaceFixture } from "./native-surface-fixture.mjs";
import { VSM_SAMPLING_WGSL } from "./fixtures/vsm-sampling-s3.mjs";
import { VSM_SHADOW_VISIBILITY_WGSL } from "./reference/s3/vsm_shadow_visibility.mjs";
import { VsmShadowResolvePass } from "./reference/s3/VsmShadowResolvePass.mjs";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import { FrameProfiler } from "../../.test-dist/debug/FrameProfiler.js";
import { GPUBufferAllocator } from "../../.test-dist/gpu/GPUBufferAllocator.js";
import { GPUStagingBufferAllocator } from "../../.test-dist/gpu/GPUStagingBufferAllocator.js";
import { GPUTextureAllocator } from "../../.test-dist/gpu/GPUTextureAllocator.js";
import {
  GPU_FRAME_INSTANCE_STRIDE,
  GPU_FRAME_INSTANCE_OFFSETS,
} from "../../.test-dist/gpu/GpuFrameInstanceAbi.js";
import { GPU_INSTANCE_FLAGS, GPU_INSTANCE_RECORD_OFFSETS } from "../../.test-dist/gpu/GpuInstanceAbi.js";
import { PACKED_CAMERA_TYPE } from "../../.test-dist/shaders/packed_camera.js";

const check = (ok, message) => {
  if (!ok) throw new Error(message);
};

/** Production packed producer and Native decoder vs an analytic plane and
 * the original per-pixel sampler. The sampler itself is separately compared
 * with frozen pre-publication WGSL by vsm-sampling-publication. No tolerances
 * are added: tap bytes and decoded floats must agree exactly. */
export async function runVsmShadowResolveGpuOracle(device) {
  const graphics = {
    device,
    profiler: new FrameProfiler({ enabled: false }),
    buffer_allocator_main: new GPUBufferAllocator(device),
    buffer_allocator_staging: new GPUStagingBufferAllocator(device),
    allocator_textures: new GPUTextureAllocator(device),
    textures: {
      mipmaps: {
        flush() {},
        generateMipmap() {
          throw new Error("No mips in this oracle");
        },
      },
    },
  };
  const fixture = await createNativeSurfaceFixture(device);
  const candidate = new VsmShadowResolvePass(device);
  let assertions = 0;
  const cases = [];
  try {
    const constantsReadback = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const initial = device.createCommandEncoder();
    initial.copyBufferToBuffer(fixture.vsm.constants, 0, constantsReadback, 0, 256);
    device.queue.submit([initial.finish()]);
    await constantsReadback.mapAsync(GPUMapMode.READ);
    const constants = new Float32Array(constantsReadback.getMappedRange().slice(0));
    constantsReadback.unmap();
    constantsReadback.destroy();
    // Avoid analytic-vs-homogeneous rounding landing on an exact page boundary.
    // Signed/world/window/gutter boundary equality is the frozen-query oracle's
    // domain, not a tolerance adjustment in this independent plane fixture.
    constants[12] = 0.0037;
    constants[13] = -0.0073;
    constants.set([1.7, 0.6, 2.2, 0.75], 48);
    const words = new Uint32Array(constants.buffer);
    const sun = fixture.uniform(new Float32Array([0.999, 0, 0.02, 1]), "Shadow oracle/grazing Sun");
    const cameraWords = new Float32Array(PACKED_CAMERA_TYPE.size / 4);
    for (const field of PACKED_CAMERA_TYPE.fields) {
      if (field.type.size === 64) {
        cameraWords.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], field.offset / 4);
      }
    }
    const camera = fixture.uniform(cameraWords, "Shadow oracle/analytic inverse VP");
    const inputs = fixture.uniform(new Uint32Array(4), "Shadow oracle/domain");
    const referenceModule = device.createShaderModule({
      code: /* wgsl */ `
struct GpuPrimitiveTypeTable { direction: vec3f, color: vec3f, }
${VSM_SAMPLING_WGSL}
@group(0) @binding(0) var<uniform> vsm_constants: VsmSamplingConstants;
@group(0) @binding(1) var<storage, read> vsm_sampling_descriptors: array<VsmSamplingDescriptor>;
@group(0) @binding(2) var vsm_atlas_depth: texture_depth_2d;
@group(0) @binding(3) var<uniform> sun: vec4f;
@group(0) @binding(4) var<uniform> domain: vec4u;
@group(0) @binding(5) var<storage, read_write> output: array<vec2u>;
@group(0) @binding(6) var vsm_atlas_sampler: sampler;
${VSM_SHADOW_VISIBILITY_WGSL}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= domain.xy)) { return; }
  let index = id.y * domain.x + id.x;
  var expected = 1.0;
  if (domain.z == 0u && id.x > 0u && id.y > 0u) {
    let position = vec3f((vec2f(id.xy) + vec2f(0.5)) / vec2f(domain.xy) *
      vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.5);
    expected = vsm_sample_directional(position, vec3f(0.0,0.0,1.0),
      GpuPrimitiveTypeTable(normalize(sun.xyz), vec3f(1.0)));
  }
  output[index] = vec2u(bitcast<u32>(expected), bitcast<u32>(directional_shadow_visibility_at(id.xy)));
}`,
    });
    const reference = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module: referenceModule, entryPoint: "main" },
    });
    const activeFlags =
      GPU_INSTANCE_FLAGS.Active |
      GPU_INSTANCE_FLAGS.CastsShadow |
      GPU_INSTANCE_FLAGS.ReceivesShadow |
      (4 << 8);
    const setInstances = (flags, generation) => {
      for (let i = 0; i < fixture.instanceCount; i++) {
        device.queue.writeBuffer(
          fixture.geometry.instances,
          i * GPU_FRAME_INSTANCE_STRIDE + GPU_INSTANCE_RECORD_OFFSETS.flags,
          new Uint32Array([flags]),
        );
        device.queue.writeBuffer(
          fixture.geometry.instances,
          i * GPU_FRAME_INSTANCE_STRIDE + GPU_FRAME_INSTANCE_OFFSETS.generation,
          new Uint32Array([generation]),
        );
      }
    };
    for (const [width, height] of [
      [128, 64],
      [97, 43],
      [9, 7],
      [1, 1],
    ]) {
      const packedWidth = Math.ceil(width / 4);
      const depth = fixture.makeTexture(
        width,
        height,
        "depth32float",
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      );
      const initializeDepth = device.createCommandEncoder();
      initializeDepth
        .beginRenderPass({
          colorAttachments: [],
          depthStencilAttachment: {
            view: depth.createView(),
            depthLoadOp: "clear",
            depthClearValue: 0.5,
            depthStoreOp: "store",
          },
        })
        .end();
      device.queue.submit([initializeDepth.finish()]);
      const visibility = fixture.makeTexture(
        width,
        height,
        "r32uint",
        GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      );
      const output = fixture.makeTexture(
        packedWidth,
        height,
        "r32uint",
        GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.COPY_SRC,
      );
      const keys = new Uint32Array(width * height);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const gx = ((x + 0.5) / width) * fixture.width;
          const gy = ((y + 0.5) / height) * fixture.height;
          const slot = Math.floor(gx / 8) + Math.floor(gy / 8) * (fixture.width / 8);
          const primitive = (gx % 8) + (gy % 8) > 8 ? 1 : 0;
          keys[y * width + x] = x === 0 || y === 0 ? 0xffffffff : (slot | (primitive << 24)) >>> 0;
        }
      device.queue.writeTexture({ texture: visibility }, keys, { bytesPerRow: width * 4 }, [width, height]);
      const expectedAndDecoded = fixture.storage(width * height * 8, "Shadow oracle/reference");
      const readback = device.createBuffer({
        size: width * height * 8,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const rowBytes = Math.ceil((packedWidth * 4) / 256) * 256;
      const maskReadback = device.createBuffer({
        size: rowBytes * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      try {
        const frame = {
          width,
          height,
          cameraPosition: [0, 0, 3],
          geometry: fixture.geometry,
          visibility,
          depth,
          camera,
          constants: fixture.vsm.constants,
          descriptors: fixture.vsm.descriptors,
          atlas: fixture.vsm.atlas.createView(),
          sun,
          output,
        };
        for (const state of ["valid", "no-receive", "unlit", "transparent", "stale", "empty-depth"]) {
          setInstances(
            state === "no-receive"
              ? activeFlags & ~GPU_INSTANCE_FLAGS.ReceivesShadow
              : state === "unlit"
                ? GPU_INSTANCE_FLAGS.Active | GPU_INSTANCE_FLAGS.ReceivesShadow
                : state === "transparent"
                  ? activeFlags | GPU_INSTANCE_FLAGS.Transparent
                  : activeFlags,
            state === "stale" ? (0xf0000000 | fixture.generation) >>> 0 : fixture.generation,
          );
          constants[55] = state === "empty-depth" ? 0 : 1;
          for (let taps = 1; taps <= 4; taps++) {
            words[46] = taps;
            device.queue.writeBuffer(fixture.vsm.constants, 0, constants);
            device.queue.writeBuffer(
              inputs,
              0,
              new Uint32Array([width, height, Number(state !== "valid"), 0]),
            );
            const poison = new Uint32Array(packedWidth * height).fill(0xdeadbeef);
            device.queue.writeTexture({ texture: output }, poison, { bytesPerRow: packedWidth * 4 }, [
              packedWidth,
              height,
            ]);
            if (state === "valid" && taps === 4) {
              const aborted = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
              candidate.encode(aborted, frame);
              aborted.abort(new Error("Intentional unsubmitted Shadow Resolve"));
            }
            const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
            candidate.encode(command, frame);
            const pass = command.beginComputePass();
            pass.setPipeline(reference);
            pass.setBindGroup(
              0,
              device.createBindGroup({
                layout: reference.getBindGroupLayout(0),
                entries: [
                  { binding: 0, resource: { buffer: fixture.vsm.constants } },
                  { binding: 1, resource: { buffer: fixture.vsm.descriptors } },
                  { binding: 2, resource: fixture.vsm.atlas.createView() },
                  { binding: 3, resource: { buffer: sun } },
                  { binding: 4, resource: { buffer: inputs } },
                  { binding: 5, resource: { buffer: expectedAndDecoded } },
                  { binding: 6, resource: device.createSampler() },
                ],
              }),
            );
            pass.setBindGroup(
              1,
              device.createBindGroup({
                layout: reference.getBindGroupLayout(1),
                entries: [{ binding: 10, resource: output.createView() }],
              }),
            );
            pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
            pass.end();
            command.copyBufferToBuffer(expectedAndDecoded, 0, readback, 0, readback.size);
            command.gpu_encoder.copyTextureToBuffer(
              { texture: output },
              { buffer: maskReadback, bytesPerRow: rowBytes },
              [packedWidth, height],
            );
            command.finish();
            await command.gpuDone;
            await readback.mapAsync(GPUMapMode.READ);
            const comparison = new Uint32Array(readback.getMappedRange());
            for (let pixel = 0; pixel < width * height; pixel++) {
              check(
                comparison[pixel * 2] === comparison[pixel * 2 + 1],
                `${width}x${height}/${state}/${taps}: exact shadow ${pixel}`,
              );
              assertions++;
            }
            readback.unmap();
            await maskReadback.mapAsync(GPUMapMode.READ);
            const bytes = new Uint8Array(maskReadback.getMappedRange());
            for (let y = 0; y < height; y++)
              for (let x = 0; x < packedWidth * 4; x++) {
                const value = bytes[y * rowBytes + x];
                if (x >= width || x === 0 || y === 0 || state !== "valid") {
                  check(value === 1, `${width}x${height}/${state}: neutral/tail ${x},${y}`);
                } else {
                  check((value >> 5) + 1 === taps && (value & 31) <= taps * taps, "Exact count encoding");
                }
                assertions++;
              }
            maskReadback.unmap();
            cases.push({ width, height, state, taps });
          }
        }
      } finally {
        readback.destroy();
        maskReadback.destroy();
      }
    }
    candidate.destroy();
    candidate.destroy();
    let rejected = false;
    try {
      candidate.encode(null, {});
    } catch (error) {
      rejected = /destroyed/.test(error.message);
    }
    check(rejected, "Destroyed owner rejects encoding");
    return {
      passed: true,
      assertions,
      cases,
      exactCountAndDecode: true,
      geometryBias: "analytic +Z/grazing Sun/nonzero bias",
      abortRetry: true,
      partialTiles: true,
      staleGeneration: true,
      completeNeutralWrites: true,
      limitations: [
        "Plane fixture and resident provider; dynamic scene/page publication uses separate production oracles.",
      ],
    };
  } finally {
    await device.queue.onSubmittedWorkDone();
    candidate.destroy();
    fixture.destroy();
    graphics.profiler.destroy();
    graphics.buffer_allocator_main.destroy();
    graphics.buffer_allocator_staging.destroy();
    graphics.allocator_textures.destroy();
  }
}
