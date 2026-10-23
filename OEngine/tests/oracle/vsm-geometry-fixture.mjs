import { GraphicsContext } from "../../.test-dist/gpu/GraphicsContext.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import {
  VsmGeometryRaster,
  vsmGeometryProfile,
  prepareVsmGeometryProfile
} from "../../.test-dist/render/vsm/VsmGeometryRaster.js";
import { VSM_ATLAS_PAGE_CLEAR_WGSL } from "../../.test-dist/shaders/vsm_atlas_raster.js";
import { ShadowMeshletBounds } from "../../.test-dist/render/ShadowMeshletBounds.js";
import { AppearanceGraphBuilder } from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { lowerNativeMaterial } from "../../.test-dist/shaders/native_material.js";
import {
  VSM_PROJECTION_CONSTANT_BYTES,
  VSM_DIMENSIONS_WORD,
  VSM_CONTROL_WORD,
  VSM_DEPTH_RANGE_BYTE_OFFSET
} from "../../.test-dist/gpu/GpuVsmProjectionAbi.js";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// One fixture, two real feature profiles. This is not a benchmark or an image
// golden: CPU barycentrics independently predict depth/alpha at atlas texels.
export async function runVsmGeometryFixture(featureDevice) {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  check(adapter, "No baseline adapter");
  const baseline = await adapter.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: 16 } });
  const results = [];
  try {
    for (const device of [baseline, featureDevice]) {
      const resources = [];
      const graphics = new GraphicsContext(device);
      const make = (size, usage, data) => {
        const buffer = device.createBuffer({ size, usage, mappedAtCreation: !!data });
        if (data) {
          new Uint8Array(buffer.getMappedRange()).set(
            new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          );
          buffer.unmap();
        }
        resources.push(buffer);
        return buffer;
      };
      const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
      const read = async (buffer) => {
        const staging = make(buffer.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(buffer, 0, staging, 0, buffer.size);
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const value = staging.getMappedRange().slice(0);
        staging.unmap();
        return value;
      };
      const builder = new AppearanceGraphBuilder();
      builder.output("alpha", builder.swizzle(builder.input("uv0", 2, "geometry"), [0]));
      const program = lowerNativeMaterial(compileAppearanceGraph(builder.build()));
      const directory = make(48, storage, new Uint32Array([0, 0, 0, 1, 0, 1, 0, 1, 0, 2, 0, 1]));
      const mipTexture = device.createTexture({
        size: [64, 64],
        mipLevelCount: 7,
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      });
      resources.push(mipTexture);
      for (let mip = 0; mip < 7; mip++) {
        const axis = 64 >> mip,
          texels = new Uint8Array(axis * axis * 4).fill(Math.round((mip / 6) * 255));
        device.queue.writeTexture({ texture: mipTexture, mipLevel: mip }, texels, { bytesPerRow: axis * 4 }, [
          axis,
          axis
        ]);
      }
      const gradientProgram = {
        ...program,
        source: `
@group(3) @binding(0) var alpha_texture: texture_2d<f32>;
@group(3) @binding(1) var alpha_sampler: sampler;
struct NativeMaterialInputs {center:array<vec4f,1>,x:array<vec4f,1>,y:array<vec4f,1>,}
fn native_material_evaluate(base:u32,inputs:NativeMaterialInputs)->array<f32,1>{
 return array<f32,1>(textureSampleGrad(alpha_texture,alpha_sampler,inputs.center[0].xy*64.0,
   (inputs.x[0].xy-inputs.center[0].xy)*64.0,(inputs.y[0].xy-inputs.center[0].xy)*64.0).r);
}`
      };
      const publication = {
        rasterDirectory: directory,
        rasterConstants: make(16, storage, new Float32Array([0.35, 1, 0, 0])),
        rasterClasses: [
          { program: null, layoutEntries: [], materialEntries: [], frameInputs: new Float32Array(4) },
          {
            program,
            layoutEntries: [],
            materialEntries: [],
            frameInputs: new Float32Array(Math.max(1, program.inputCount) * 4)
          },
          {
            program: gradientProgram,
            layoutEntries: [
              { binding: 0, visibility: 2, texture: { sampleType: "float" } },
              { binding: 1, visibility: 2, sampler: { type: "filtering" } }
            ],
            materialEntries: [
              { binding: 0, resource: mipTexture.createView() },
              {
                binding: 1,
                resource: device.createSampler({
                  minFilter: "linear",
                  magFilter: "linear",
                  mipmapFilter: "nearest"
                })
              }
            ],
            frameInputs: new Float32Array(4)
          }
        ]
      };
      await prepareVsmGeometryProfile(graphics, publication, false, 2);
      // Product source decoder and complete active-attribute layout compile too.
      await prepareVsmGeometryProfile(graphics, publication, true, 2);
      const allInputs = new AppearanceGraphBuilder();
      let alpha;
      for (const [name, width] of [
        ["worldPosition", 3],
        ["normal", 3],
        ["tangent", 4],
        ["uv0", 2],
        ["uv1", 2],
        ["uv2", 2],
        ["vertexColor", 4]
      ]) {
        const value = allInputs.swizzle(allInputs.input(name, width, "geometry"), [0]);
        alpha = alpha === undefined ? value : allInputs.operation("add", alpha, value);
      }
      allInputs.output("alpha", alpha);
      const allProgram = lowerNativeMaterial(compileAppearanceGraph(allInputs.build()));
      await prepareVsmGeometryProfile(
        graphics,
        {
          ...publication,
          rasterClasses: [
            publication.rasterClasses[0],
            {
              ...publication.rasterClasses[1],
              program: allProgram,
              frameInputs: new Float32Array(allProgram.inputCount * 4)
            }
          ]
        },
        true,
        2
      );
      const shaderModule = device.createShaderModule({ code: VSM_ATLAS_PAGE_CLEAR_WGSL });
      const clearPipeline = await device.createRenderPipelineAsync({
        layout: "auto",
        vertex: { module: shaderModule, entryPoint: "clear_page" },
        fragment: { module: shaderModule, entryPoint: "clear_depth", targets: [] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" }
      });
      const extent = 288,
        pitch = 72;
      const atlas = device.createTexture({
        size: [extent, extent],
        format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
      });
      resources.push(atlas);
      const packed = new ArrayBuffer(VSM_PROJECTION_CONSTANT_BYTES),
        floats = new Float32Array(packed),
        words = new Uint32Array(packed);
      floats.set(identity);
      floats.set([0, 0, 64, 1 / 64], 16);
      words.set([64, 64, 4, extent], VSM_DIMENSIONS_WORD);
      words.set([7, 0, 0, 16], VSM_CONTROL_WORD);
      floats.set([0, 1, 1, 1], VSM_DEPTH_RANGE_BYTE_OFFSET / 4);
      const constants = make(
        packed.byteLength,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        new Uint8Array(packed)
      );
      const allocWords = new Uint32Array([2, 2, 0, 7, 0, 0, 0, 7, 11, 0, 0, 0, 2, 3, 0, 7, 11, 0, 2, 0]);
      const allocation = make(allocWords.byteLength, storage, allocWords),
        status = make(256, storage);
      const cameraWords = new Float32Array(64);
      cameraWords.set(identity, 32);
      cameraWords.set([0, 0, 2], 60);
      const camera = make(256, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_SRC, cameraWords);
      const positions = [
        [-2.13, -1.91, 0.25],
        [5.27, -2.07, 0.25],
        [-2.09, 5.31, 0.25]
      ];
      const metadata = new Uint32Array(92);
      metadata[232 / 4] = 0;
      metadata.set([0, 3, 0, 1], 60);
      const metadataFloats = new Float32Array(metadata.buffer);
      metadataFloats.set([-2.13, -2.07, 0.25, 0], 60 + 8);
      metadataFloats.set([5.27, 5.31, 0.25, 0], 60 + 12);
      const arena = make(metadata.byteLength, storage, metadata);
      const payload = new Float32Array(77);
      positions.forEach((p, i) => {
        payload.set([0, 0, 1, 0], i * 24);
        payload.set([1, 0, 0, 1], i * 24 + 4);
        payload.set([i === 1 ? 1 : 0, i === 2 ? 1 : 0, 0, 0], i * 24 + 8);
        payload.set([...p, 1], i * 24 + 20);
      });
      const payloadWords = new Uint32Array(payload.buffer);
      payloadWords.set([0, 1, 2, 0x020100], 72);
      const vertexPayload = make(payload.byteLength, storage, payload);
      // A single valid Product ABI6 asset/group/raw SoA page; not an alternate decoder.
      const productWords = new Uint32Array(96);
      productWords.set([6, 1, 1, 96, 16, 32, 36, 68, 72, 84, 88, 92, 160, 0, 0, 0]);
      productWords.set([3, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0], 16);
      productWords.set([0, 3, 0, 0], 32);
      productWords.set([0, 1, 0, 1, 0, 1], 36 + 18);
      productWords.set([0, 0, 160, 0], 84);
      productWords.set([4, 0, 3, 160], 88);
      productWords.set([0x80010, 0x0c000000, 0, 0], 92);
      const productHeap = make(productWords.byteLength, storage, productWords),
        productRaw = new Uint32Array(40),
        productFloats = new Float32Array(productRaw.buffer);
      productRaw.set([1, 64, 108, 112, 160], 11);
      productRaw.set([3 | (1 << 8), 112, 108, 0xffffffff, 0], 16);
      productFloats.set([-2.13, -2.07, 0.25], 21);
      productFloats.set([5.27, 5.31, 0.25], 24);
      productRaw[27] = 0x020100;
      for (let axis = 0; axis < 3; axis++)
        for (let vertex = 0; vertex < 3; vertex++)
          productFloats[28 + axis * 3 + vertex] = positions[vertex][axis];
      productRaw.set([0, 0x00003c00, 0x3c000000], 37);
      const productBank = make(160, storage, productRaw),
        productBanks = [productBank, productBank, productBank, productBank];
      const frameInstance = new Float32Array(72),
        instanceWords = new Uint32Array(frameInstance.buffer);
      frameInstance.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], 16);
      frameInstance.set([1, 0, 0, 1], 60);
      frameInstance.set([0, 1, 0], 64);
      frameInstance.set([0, 0, 1, 0], 68);
      instanceWords[67] = 7;
      const instances = make(frameInstance.byteLength, storage, frameInstance),
        sourceInstances = make(176, storage, new Uint8Array(frameInstance.buffer, 0, 176));
      const workWords = new Uint32Array(8 + 3 * 6);
      workWords.set([3, 3, 3, 3, 0, 7, 0, 0]);
      const work = make(workWords.byteLength, storage, workWords);
      const meshletBuffer = make(128, storage, new Uint32Array(metadata.buffer, 240, 32));
      const bounds = new ShadowMeshletBounds(
        device,
        {
          queue: work,
          capacity: 3,
          productMode: true,
          productBindings: { metadata: productHeap },
          productBanks
        },
        sourceInstances,
        meshletBuffer
      );
      await bounds.preparePipelines();
      let raster = new VsmGeometryRaster(graphics, {
        geometry: {
          meshletWork: work,
          arena,
          vertexPayload,
          instances,
          productHeap,
          productBanks,
          source: [0, 60, 72, 75],
          sourcePayload: [0, 0, 0, 0]
        },
        publication,
        constants,
        allocation,
        bounds: bounds.records,
        status,
        workCapacity: 3,
        pageCapacity: 2,
        maxBytes: 12000
      });
      check(raster.plan.chunkCount === 3, "Fixture did not force complete-page multi-chunk accumulation");
      const clearGroup = device.createBindGroup({
        layout: clearPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: constants } },
          { binding: 1, resource: { buffer: allocation } }
        ]
      });
      const begin = (command) =>
        command.beginRenderPass({
          colorAttachments: [],
          depthStencilAttachment: { view: atlas.createView(), depthLoadOp: "load", depthStoreOp: "store" }
        });
      const run = async ({
        mask = false,
        mirror = false,
        backface = false,
        offpage = false,
        abort = false,
        invalid = false,
        product = false,
        gradient = false,
        triangles = 1
      } = {}) => {
        instanceWords[2] = 3 | (mask ? 8 : 0) | (product ? 128 : 0);
        instanceWords[11] = product ? 3 : 0;
        frameInstance[16] = mirror ? -1 : 1;
        frameInstance[19] = (mirror ? 1 : 0) + (offpage ? 100 : 0);
        frameInstance[63] = mirror ? -1 : 1;
        for (let i = 0; i < 3; i++)
          workWords.set([0, 0, 0, gradient ? 2 : mask ? 1 : 0, mask ? 8 : 0, 0], 8 + i * 6);
        workWords[6] = invalid ? 1 : 0;
        payloadWords[75] = backface ? 0x010200 : 0x020100;
        metadata[63] = triangles;
        payloadWords[76] = 0x020100;
        device.queue.writeBuffer(arena, 0, metadata);
        productRaw[27] = payloadWords[75];
        device.queue.writeBuffer(productBank, 0, productRaw);
        device.queue.writeBuffer(work, 0, workWords);
        device.queue.writeBuffer(vertexPayload, 0, payload);
        device.queue.writeBuffer(instances, 0, frameInstance);
        device.queue.writeBuffer(sourceInstances, 0, new Uint8Array(frameInstance.buffer, 0, 176));
        const initialize = device.createCommandEncoder();
        initialize
          .beginRenderPass({
            colorAttachments: [],
            depthStencilAttachment: {
              view: atlas.createView(),
              depthClearValue: 0.125,
              depthLoadOp: "clear",
              depthStoreOp: "store"
            }
          })
          .end();
        device.queue.submit([initialize.finish()]);
        const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
        bounds.encode(command, identity, allocation);
        raster.encode(
          command,
          camera,
          () => begin(command),
          (pass, indirect) => {
            pass.setPipeline(clearPipeline);
            pass.setBindGroup(0, clearGroup);
            pass.drawIndirect(indirect, 48);
          }
        );
        if (abort) {
          command.abort();
        } else {
          command.finish();
          await command.gpuDone;
        }
        const statistics = new Uint32Array(await read(status));
        if (!abort && !invalid) {
          check(statistics[0] === 0, `Raster failed ${[...statistics.slice(0, 12)]}`);
          check(
            statistics[1] === raster.plan.chunkCount && statistics[2] === raster.plan.chunkCount,
            "Incomplete chunk terminal state"
          );
          check(
            statistics[7] === (offpage ? 0 : 9),
            "Unique source vertices were repeated per page or dirty reject failed"
          );
          check(
            statistics[8] === (offpage ? 0 : 3 * (product ? 1 : triangles)),
            "Prepared triangle count changed"
          );
        }
        if (invalid) check(statistics[0] !== 0, "Invalid Geometry was accepted");
        const staging = make(1280 * extent, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
          encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
          { texture: atlas, aspect: "depth-only" },
          { buffer: staging, bytesPerRow: 1280 },
          [extent, extent]
        );
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const depths = new Float32Array(staging.getMappedRange());
        const bary = (x, y) => {
          if (mirror) x = 1 - x;
          x -= offpage ? 100 : 0;
          const a = positions[0],
            b = positions[1],
            c = positions[2],
            ab = [b[0] - a[0], b[1] - a[1]],
            ac = [c[0] - a[0], c[1] - a[1]],
            ap = [x - a[0], y - a[1]],
            d = ab[0] * ac[1] - ab[1] * ac[0];
          return [(ap[0] * ac[1] - ap[1] * ac[0]) / d, (ab[0] * ap[1] - ab[1] * ap[0]) / d];
        };
        for (let y = 0; y < extent; y++)
          for (let x = 0; x < extent; x++) {
            let expected = 0.125;
            const slot = x < pitch && y < pitch ? 0 : x >= 3 * pitch && y < pitch ? 3 : -1;
            if (slot >= 0 && !abort) {
              const lx = (x - slot * pitch + 0.5 - 4) / 64 + (slot === 3 ? 2 : 0),
                ly = (y + 0.5 - 4) / 64;
              const [u, v] = bary(lx, ly);
              const covered =
                !backface && !offpage && u >= 0 && v >= 0 && u + v <= 1 && (!mask || gradient || u >= 0.35);
              expected = covered ? 0.75 : 0;
            }
            if (invalid && !abort) continue; // Commit rejection, not failed-frame atlas contents, is the validity contract.
            // Four clipping intersections plus raster interpolation round f32.
            // Coverage/empty/untouched remain exact; covered depth gets the
            // explicit 8-ULP forward-error bound, not an image tolerance.
            check(
              expected === 0.75
                ? Math.abs(depths[y * 320 + x] - 0.75) <= 2 ** -21
                : depths[y * 320 + x] === expected,
              `Depth ${device.features.has("clip-distances") ? "feature" : "polygon"} ${JSON.stringify({ mask, mirror, backface, offpage, abort })} ${x},${y}: ${depths[y * 320 + x]} != ${expected}`
            );
          }
        staging.unmap();
        return statistics;
      };
      try {
        await run();
        await run({ mask: true });
        await run({ mirror: true });
        await run({ mask: true, mirror: true });
        await run({ backface: true });
        await run({ offpage: true });
        await run({ mask: true, gradient: true });
        await run({ mask: true, gradient: true, mirror: true });
        await run({ product: true });
        await run({ product: true, mask: true });
        await run({ product: true, mask: true, mirror: true });
        const previous = raster;
        raster = new VsmGeometryRaster(
          graphics,
          { ...previous.input, publication: { ...publication } },
          previous
        );
        check(
          raster.indirect === previous.indirect,
          "Publication rebound allocated a duplicate large scratch set"
        );
        const retirement = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
        retirement.destroyAfterGpuDone(previous);
        retirement.abort();
        await device.queue.onSubmittedWorkDone();
        await run({ abort: true });
        await run();
        await run({ invalid: true });
        const chunkCount = raster.plan.chunkCount,
          scratchBytes = raster.allocatedBytes;
        raster.destroy();
        raster = new VsmGeometryRaster(graphics, { ...previous.input, maxBytes: 65536 });
        check(raster.plan.chunkCount === 1, "CSR fixture did not exercise multiple source ranges");
        await run({ triangles: 2 });
        await run({ mask: true, triangles: 2 });
        results.push({
          clipDistances: device.features.has("clip-distances"),
          chunkCount,
          scratchBytes,
          opaqueMaskMirrorGutterLargeTriangle: true,
          productSource: true,
          coverageGradients: true,
          sharedScratchRetirement: true,
          multiSourceTriangleCsr: true,
          abortRetry: true,
          invalidSource: true
        });
      } finally {
        raster.destroy();
        bounds.destroy();
        resources.forEach((r) => r.destroy());
        graphics.destroy();
      }
    }
  } finally {
    baseline.destroy();
  }
  return results;
}
