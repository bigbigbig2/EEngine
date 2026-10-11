import { NativeExecutionBins as S3Bins } from "./reference/s3/NativeExecutionBins.mjs";
import { SurfaceV4 as S3Surface } from "./reference/s3/SurfaceV4.mjs";
import { GpuNativeMaterialPublication as S3Publication } from "./reference/s3/GpuNativeMaterialPublication.mjs";
import { nativeSurfacePublicationDescriptors as s3Descriptors } from "./reference/s3/native_surface.mjs";
import { nativeSurfacePhysicalSunEntries as s3SunEntries } from "./reference/s3/native_surface_lighting.mjs";
import { createNativeSurfaceFixture, identity } from "./native-surface-fixture.mjs";
import { createNativeMaterialBindingFixture } from "./native-material-bindings-gpu.mjs";
import { nativeMaterialDynamicInputs } from "../../.test-dist/shaders/native_material.js";
import { GPUSamplerCache } from "../../.test-dist/gpu/GPUSamplerCache.js";
import {
  createNativeMaterialBindings,
  createNativeCoverageBindings,
} from "../../.test-dist/gpu/NativeMaterialBindings.js";
import { SurfaceV4 } from "../../.test-dist/render/surface/SurfaceV4.js";
import { NativeExecutionBins } from "../../.test-dist/render/surface/NativeExecutionBins.js";
import { NativeVisibilityPass } from "../../.test-dist/render/surface/NativeVisibilityPass.js";
import { NativeTemporalSeed } from "../../.test-dist/render/temporal/NativeTemporalSeed.js";
import { NATIVE_TEMPORAL_BACKGROUND_WGSL } from "../../.test-dist/shaders/native_temporal_seed.js";
import { LocalLightWorkGenerator } from "../../.test-dist/render/lighting/LocalLightWorkGenerator.js";
import { VsmSamplingPublicationPass } from "../../.test-dist/render/vsm/VsmSamplingPublicationPass.js";
import { addFinalPixelSolarPublication } from "../../.test-dist/render/environment/FinalPixelSolarPublication.js";
import { planFinalPixelLightingDirectory } from "../../.test-dist/gpu/FinalPixelAbi.js";
import { AppearanceGraphBuilder } from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { lowerNativeMaterial } from "../../.test-dist/shaders/native_material.js";
import {
  nativeSurfaceDescriptor,
  nativeSurfacePublicationDescriptors,
} from "../../.test-dist/shaders/native_surface.js";
import { GpuNativeMaterialPublication } from "../../.test-dist/gpu/GpuNativeMaterialPublication.js";
import { AppearanceProgramRegistry } from "../../.test-dist/gpu/AppearanceProgramRegistry.js";
import { FrameGraph } from "../../.test-dist/framegraph/FrameGraph.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import { GPUBufferAllocator } from "../../.test-dist/gpu/GPUBufferAllocator.js";
import { GPUStagingBufferAllocator } from "../../.test-dist/gpu/GPUStagingBufferAllocator.js";
import { GPUTextureAllocator } from "../../.test-dist/gpu/GPUTextureAllocator.js";
import { FrameProfiler } from "../../.test-dist/debug/FrameProfiler.js";
import { PACKED_CAMERA_TYPE } from "../../.test-dist/shaders/packed_camera.js";
import { GPU_INSTANCE_FLAGS, GPU_INSTANCE_RECORD_OFFSETS } from "../../.test-dist/gpu/GpuInstanceAbi.js";
import { encodeFloat16 } from "../../.test-dist/core/Float16.js";

const check = (value, message) => {
  if (!value) throw new Error(message);
};
const viewOf = (value) => value.view ?? value.createView();
const hash = (value, word) => Math.imul(value ^ word, 16777619) >>> 0;
const geometrySignature = (generation) => hash(hash(hash(2166136261, generation), 3), 0);
const flags =
  GPU_INSTANCE_FLAGS.Active | GPU_INSTANCE_FLAGS.CastsShadow | GPU_INSTANCE_FLAGS.ReceivesShadow | (4 << 8);

/** Controlled device destruction, not a claim to reproduce a driver fault. */
export async function runFinalPixelSeedEpochGpuOracle() {
  const epochs = [];
  for (let epoch = 0; epoch < 2; epoch++) {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    check(adapter && !adapter.info.isFallbackAdapter, "Seed epoch requires a hardware adapter");
    const device = await adapter.requestDevice();
    const graphics = {
      device,
      profiler: new FrameProfiler({ enabled: false }),
      buffer_allocator_main: new GPUBufferAllocator(device),
      buffer_allocator_staging: new GPUStagingBufferAllocator(device),
      allocator_textures: new GPUTextureAllocator(device),
    };
    const errors = [];
    device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    const owner = new NativeTemporalSeed(device);
    const resources = [];
    try {
      const camera = {
        view: identity,
        projection: identity,
        inverseView: identity,
        inverseProjection: identity,
        jitter: [0, 0],
        preExposure: 1,
      };
      const frame = owner.prepare(19, 13, "native", camera);
      check(!frame.previousValid, "New device epoch reused history");
      const view = device.createBuffer({
        size: frame.view.byteLength,
        usage: GPUBufferUsage.UNIFORM,
        mappedAtCreation: true,
      });
      new Uint8Array(view.getMappedRange()).set(frame.view);
      view.unmap();
      resources.push(view);
      const visibility = device.createTexture({
        size: [19, 13],
        format: "r32uint",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      resources.push(visibility);
      device.queue.writeTexture(
        { texture: visibility },
        new Uint32Array(19 * 13).fill(0xffffffff),
        { bytesPerRow: 19 * 4 },
        [19, 13],
      );
      const pipeline = await device.createComputePipelineAsync({
        layout: "auto",
        compute: {
          entryPoint: "main",
          module: device.createShaderModule({ code: NATIVE_TEMPORAL_BACKGROUND_WGSL }),
        },
      });
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: view } },
          ...[frame.seed, frame.response, frame.identity, visibility].map((texture, index) => ({
            binding: index + 1,
            resource: texture.createView(),
          })),
        ],
      });
      const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
      owner.attach(command);
      const graph = new FrameGraph("Seed device epoch");
      const products = owner.importProducts(graph);
      const producer = graph.add("Native sky Seed", {}, () => {
        const pass = command.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(3, 2);
        pass.end();
      });
      products.seed = producer.write(products.seed);
      products.response = producer.write(products.response);
      products.identity = producer.write(products.identity);
      const classified = owner.addClassification(graph, products);
      const consume = graph.add("Epoch final consumer", {}, () => {});
      consume.read(classified);
      consume.make_side_effect();
      command.encodeGraph(graph);
      command.finish();
      await command.gpuDone;
      const next = owner.prepare(21, 15, "upscale", camera);
      check(!next.previousValid, "Resize/domain candidate inherited history");
      const retainedBeforeLoss = owner.allocatedBytes;
      device.destroy();
      await device.lost;
      await Promise.resolve();
      await Promise.resolve();
      check(owner.allocatedBytes === 0, "Device loss retained active or candidate Seed resources");
      check(errors.length === 0, `Seed epoch validation errors: ${errors}`);
      epochs.push({
        epoch,
        successfulSubmit: true,
        pendingResizeBeforeLoss: true,
        retainedBeforeLoss,
        bytesAfterLoss: owner.allocatedBytes,
        controlledDestruction: true,
        freshHistoryInvalid: true,
      });
    } finally {
      owner.destroy();
      for (const value of resources) value.destroy();
      graphics.buffer_allocator_main.destroy();
      graphics.buffer_allocator_staging.destroy();
      graphics.allocator_textures.destroy();
      device.destroy();
    }
  }
  return { epochs, scope: "two real device epochs; controlled destruction, not arbitrary hardware loss" };
}

/** The old layout counterexample must compile fused at the minimum limit. */
export async function runFinalPixelBindingBoundaryGpuOracle(device) {
  const builder = new AppearanceGraphBuilder();
  builder.output("baseColor", builder.constant([0.4, 0.25, 0.1]));
  const program = lowerNativeMaterial(compileAppearanceGraph(builder.build()));
  const limit = device.limits.maxSampledTexturesPerShaderStage;
  const material = Array.from({ length: limit - 6 }, (_, binding) => ({
    binding,
    visibility: 4,
    texture: { sampleType: "float" },
  }));
  const profile = { compact: true, productGeometry: true, unlit: false, reactive: true, physicalSun: true };
  const before = s3Descriptors(program, material, profile, device.limits);
  check(before.continuation, "Boundary fixture must exercise a supported old continuation");
  const registry = new AppearanceProgramRegistry(device);
  const leases = [];
  try {
    for (const descriptor of [before.descriptor, before.continuation]) {
      const lease = registry.acquire(descriptor);
      leases.push(lease);
      await lease.ready;
    }
    const target = nativeSurfacePublicationDescriptors(
      program,
      material,
      { ...profile, finalPixel: true },
      device.limits,
    );
    check(!target.continuation, "Target must not retain continuation");
    const fused = registry.acquire(target.descriptor);
    leases.push(fused);
    await fused.ready;
    const count = (descriptor) => descriptor.groups.flat().filter((entry) => entry.texture).length;
    return {
      bindingCounterexampleResolved: true,
      negotiatedSampledLimit: limit,
      materialTextureCount: material.length,
      currentPrimary: count(before.descriptor),
      currentContinuation: count(before.continuation),
      targetFootprint: count(nativeSurfaceDescriptor(program, material, { ...profile, finalPixel: true })),
      currentLayoutsGpuCompiled: true,
      targetLayoutGpuCompiled: true,
      targetContinuation: false,
    };
  } finally {
    for (const lease of leases) lease.release();
    registry.destroy();
  }
}

/** Test-only double graph is a quality reference, never a production selector.
 * Uses actual visibility, bins, material publication, direct local/VSM directory
 * producers, Native shader and Temporal consumer. No renderer route is changed. */
export async function runFinalPixelPhase1GpuOracle(device) {
  const graphics = {
    device,
    profiler: new FrameProfiler({ enabled: false }),
    buffer_allocator_main: new GPUBufferAllocator(device),
    buffer_allocator_staging: new GPUStagingBufferAllocator(device),
    allocator_textures: new GPUTextureAllocator(device),
    samplers: new GPUSamplerCache(device),
    textures: {
      mipmaps: {
        flush() {},
        generateMipmap() {
          throw new Error("Fixture requires cooked mips");
        },
      },
    },
  };
  const registry = new AppearanceProgramRegistry(device);
  const reports = [];
  const owners = [],
    resources = [],
    fixtures = [];
  const storage = (bytes, label) => {
    const buffer = device.createBuffer({
      size: bytes,
      label,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    resources.push(buffer);
    return buffer;
  };
  const readback = (bytes) => {
    const buffer = device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    resources.push(buffer);
    return buffer;
  };
  try {
    // The complete Product+compact footprint uses 16 storage buffers
    // (15 + Bm=1) and the negotiated sampled limit (6 + material textures).
    // These are actual pipeline compilations under the negotiated limits.
    const builder = new AppearanceGraphBuilder();
    builder.output("baseColor", builder.constant([0.4, 0.25, 0.1]));
    const program = lowerNativeMaterial(compileAppearanceGraph(builder.build()));
    for (const unlit of [false, true])
      for (const compact of [false, true])
        for (const productGeometry of [false, true]) {
          const materialLayout = [
            ...Array.from({ length: device.limits.maxSampledTexturesPerShaderStage - 6 }, (_, binding) => ({
              binding,
              visibility: 4,
              texture: { sampleType: "float" },
            })),
            {
              binding: device.limits.maxSampledTexturesPerShaderStage - 6,
              visibility: 4,
              buffer: { type: "read-only-storage" },
            },
          ];
          const descriptor = nativeSurfaceDescriptor(program, materialLayout, {
            unlit,
            compact,
            productGeometry,
            physicalSun: !unlit,
            reactive: true,
            finalPixel: true,
          });
          const lease = registry.acquire(descriptor);
          await lease.ready;
          lease.release();
        }
    for (const spec of [
      { name: "dense", width: 32, height: 24, count: 1 },
      { name: "shadow-only-cutover-seam", width: 19, height: 13, count: 2, product: true, sunOnlySeam: true },
      {
        name: "manual-max-texture-consumers",
        width: 19,
        height: 13,
        count: 2,
        product: true,
        manualTextures: true,
      },
      { name: "compact-partial", width: 19, height: 13, count: 2 },
      { name: "compact-product-layout", width: 19, height: 13, count: 2, product: true },
      { name: "unlit-partial", width: 19, height: 13, count: 1, unlit: true },
      { name: "empty-domain", width: 19, height: 13, count: 0, unlit: true },
      { name: "textured-mask-coat-product", width: 19, height: 13, count: 4, product: true, textured: true },
      {
        name: "perspective-sky-rotation",
        width: 19,
        height: 13,
        count: 0,
        unlit: true,
        skyPerspective: true,
      },
      {
        name: "resident-product-geometry",
        width: 19,
        height: 13,
        count: 2,
        product: true,
        residentProduct: true,
      },
    ]) {
      const fixture = await createNativeSurfaceFixture(device, {
        width: 32,
        height: 24,
        materialCount: Math.max(1, spec.count),
        instanceCount: 1,
      });
      fixtures.push(fixture);
      let { width, height } = spec;
      let pixels = width * height;
      const geometry = spec.product
        ? {
            ...fixture.geometry,
            productHeap: fixture.geometry.arena,
            productBanks: [
              fixture.geometry.vertexPayload,
              fixture.geometry.vertexPayload,
              fixture.geometry.vertexPayload,
              fixture.geometry.vertexPayload,
            ],
          }
        : fixture.geometry;
      const instanceFlags = flags | (spec.residentProduct ? GPU_INSTANCE_FLAGS.VirtualGeometry : 0);
      if (spec.residentProduct) {
        // Analytic resident-Product provider: reuse the actual FrameGeometry
        // producer's clips/triangles, publish per-meshlet resident addresses.
        // Tests Product's real cached decoder branch, not streaming/admission.
        device.queue.writeBuffer(
          geometry.instances,
          GPU_INSTANCE_RECORD_OFFSETS.flags,
          new Uint32Array([instanceFlags]),
        );
        for (let slot = 0; slot < fixture.workCount; slot++) {
          const at = fixture.frameGeometryLayout.sourceDirectory.offset + 16 + slot * 24 + 16;
          device.queue.writeBuffer(
            geometry.arena,
            at,
            new Uint32Array([fixture.residentPayloadBase + slot * 4 * 24]),
          );
        }
      }
      let visibility = fixture.makeTexture(
        width,
        height,
        "r32uint",
        GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.COPY_SRC,
      );
      let depth = fixture.makeTexture(
        width,
        height,
        "depth32float",
        GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      );
      let hdr = fixture.makeTexture(
        width,
        height,
        "rgba16float",
        GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.COPY_DST,
      );
      const sunValues = new Float32Array([0, 0.6, 0.8, 0.001, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
      const sun = fixture.uniform(sunValues, "Final Pixel/physical Sun");
      const transmission = fixture.makeTexture(
        256,
        64,
        "rgba16float",
        GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
      );
      const lut = new Uint16Array(256 * 64 * 4);
      for (let i = 0; i < lut.length; i += 4) lut.set([0.8, 0.7, 0.6, 1].map(encodeFloat16), i);
      device.queue.writeTexture({ texture: transmission }, lut, { bytesPerRow: 256 * 8 }, [256, 64]);
      const sunEntries = [
        { binding: 12, resource: { buffer: sun } },
        { binding: 13, resource: transmission.createView() },
        { binding: 14, resource: device.createSampler({ minFilter: "linear", magFilter: "linear" }) },
      ];
      device.queue.writeBuffer(fixture.vsm.constants, 46 * 4, new Uint32Array([4]));
      device.queue.writeBuffer(fixture.vsm.constants, 48 * 4, new Float32Array([0.2, 0.7, 0.08, 1.5]));
      const sampler = device.createSampler({ minFilter: "nearest", magFilter: "nearest" });
      const materialPrograms = [];
      for (let slot = 0; slot < spec.count; slot++) {
        const graph = new AppearanceGraphBuilder();
        graph.output("baseColor", graph.constant([0.4 + slot * 0.1, 0.25, 0.1]));
        if (slot === 1) graph.output("roughness", graph.constant(0.3));
        materialPrograms.push(lowerNativeMaterial(compileAppearanceGraph(graph.build())));
      }
      let materialFixture;
      if (spec.manualTextures) {
        const textureCount = device.limits.maxSampledTexturesPerShaderStage - 6;
        const selector = storage(4, "Final Pixel/manual material selector");
        device.queue.writeBuffer(selector, 0, new Uint32Array([1]));
        const textures = Array.from({ length: textureCount }, (_, index) => {
          const texture = fixture.makeTexture(
            1,
            1,
            "rgba8unorm",
            GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          );
          device.queue.writeTexture(
            { texture },
            new Uint8Array([20 + index, 35, 50, 255]),
            { bytesPerRow: 4 },
            [1, 1],
          );
          return texture;
        });
        const layoutEntries = [
          ...textures.map((_, binding) => ({ binding, visibility: 4, texture: { sampleType: "float" } })),
          { binding: textureCount, visibility: 4, buffer: { type: "read-only-storage" } },
        ];
        const entries = [
          ...textures.map((texture, binding) => ({ binding, resource: texture.createView() })),
          { binding: textureCount, resource: { buffer: selector } },
        ];
        materialFixture = {
          sources: materialPrograms.map((base, materialSlot) => {
            const declarations = textures
              .map(
                (_, binding) =>
                  `@group(3) @binding(${binding}) var test_material_${binding}: texture_2d<f32>;`,
              )
              .join("\n");
            const loads = textures
              .map((_, binding) => `  signal += textureLoad(test_material_${binding}, vec2i(0), 0).r;`)
              .join("\n");
            const source = `${declarations}
@group(3) @binding(${textureCount}) var<storage, read> test_selector: array<u32>;
${base.source.replace("fn native_material_evaluate(", "fn test_material_base(")}
fn native_material_evaluate(material_base: u32, inputs: NativeMaterialInputs) -> array<f32, ${base.outputCount}> {
  var values = test_material_base(material_base, inputs);
  var signal = f32(test_selector[0]);
${loads}
  values[${base.outputs.baseColor[0]}] += signal * 0.01;
  return values;
}`;
            return {
              materialSlot,
              bindingSet: materialSlot,
              program: { ...base, source, key: JSON.stringify([base.key, source]) },
              bindings: { layoutEntries, entries },
            };
          }),
        };
      }
      if (spec.textured) {
        materialFixture = await createNativeMaterialBindingFixture(device, graphics, {
          packedProducts: true,
        });
        fixtures.push(materialFixture);
        const promote = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
        materialFixture.residency.promote(materialFixture.materials, promote, 0);
        promote.finish();
        await promote.gpuDone;
        materialFixture.sources = materialFixture.sources.map((source, slot) => {
          const input = {
            ...materialFixture.commonFor(materialFixture.materials[slot]),
            graph: materialFixture.compiledGraphs[slot],
            program: lowerNativeMaterial(materialFixture.compiledGraphs[slot]),
            packedProducts: materialFixture.packedOwner,
          };
          const bindings = createNativeMaterialBindings(input);
          const coverage = source.raster.alphaMask ? createNativeCoverageBindings(input) : null;
          return {
            ...source,
            program: bindings.program,
            bindings,
            ...(coverage
              ? {
                  coverage: {
                    program: coverage.program,
                    layoutEntries: coverage.layoutEntries,
                    materialEntries: coverage.entries,
                  },
                }
              : {}),
          };
        });
      }
      const isUnlit = (slot) => (spec.textured ? slot === 2 : !!spec.unlit);
      const sources = (finalPixel, revision = 1) =>
        materialPrograms.map((program, materialSlot) => ({
          ...(materialFixture
            ? materialFixture.sources[materialSlot]
            : { materialSlot, bindingSet: 0, program }),
          valueRevision: revision,
          ...(finalPixel ? nativeSurfacePublicationDescriptors : s3Descriptors)(
            materialFixture?.sources[materialSlot].program ?? program,
            materialFixture?.sources[materialSlot].bindings.layoutEntries ?? [],
            {
              compact: spec.count > 1,
              productGeometry: !!spec.product,
              unlit: isUnlit(materialSlot),
              physicalSun: !isUnlit(materialSlot),
              reactive: true,
              finalPixel,
              fusedSun: !!spec.sunOnlySeam && !finalPixel,
            },
            device.limits,
          ),
        }));
      const publication = new GpuNativeMaterialPublication(device, registry, sources(true), undefined, true);
      const referencePublication = new S3Publication(device, registry, sources(false));
      owners.push(publication, referencePublication);
      await publication.ready;
      await referencePublication.ready;
      publication.commit();
      referencePublication.commit();
      check(publication.directory.size === Math.max(1, spec.count) * 32, "Target directory is not 32B/slot");
      check(
        publication.rasterDirectory.size === Math.max(1, spec.count) * 16,
        "Raster-specific directory ABI changed",
      );
      const surface = new SurfaceV4(device, true, undefined, true);
      const referenceSurface = new S3Surface(device, true);
      const temporal = new NativeTemporalSeed(device);
      const localOwner = new LocalLightWorkGenerator(device, 51);
      const vsmOwner = new VsmSamplingPublicationPass(device);
      owners.push(surface, referenceSurface, temporal, localOwner, vsmOwner);
      await localOwner.ready;
      let bins = new NativeExecutionBins(device, { width, height, bins: publication.bins, finalPixel: true });
      await bins.ready;
      const visibilityView = new ArrayBuffer(192);
      const visibilityFloats = new Float32Array(visibilityView);
      visibilityFloats.set(identity);
      visibilityFloats.set(identity, 16);
      visibilityFloats.set([0, 0, 3, 1], 32);
      new Uint32Array(visibilityView).set([fixture.geometry.sourcePayload[3], 0, fixture.generation, 0], 36);
      new Uint32Array(visibilityView).set(fixture.geometry.source, 40);
      new Uint32Array(visibilityView).set(fixture.geometry.sourcePayload, 44);
      const coverage = new NativeVisibilityPass(device, {
        geometry,
        publication,
        capacity: fixture.workCount,
        generation: fixture.generation,
        view: new Uint8Array(visibilityView),
      });
      owners.push(coverage);
      await coverage.ready;
      const camera = fixture.uniform(
        new Float32Array(PACKED_CAMERA_TYPE.size / 4),
        "Final Pixel/reference camera",
      );
      const localCount = Math.ceil(width / 32) * Math.ceil(height / 32) * 24;
      const plan = planFinalPixelLightingDirectory(device.limits, localCount, 260);
      const ranges = fixture.uniform(plan.words, "Final Pixel/directory ranges");
      const inspect = await device.createComputePipelineAsync({
        layout: "auto",
        compute: {
          entryPoint: "main",
          module: device.createShaderModule({
            code: `
@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var seed: texture_2d<f32>;
@group(0) @binding(2) var response: texture_2d<f32>;
@group(0) @binding(3) var identity: texture_2d<u32>;
@group(0) @binding(4) var mask: texture_2d<f32>;
@group(0) @binding(5) var winner: texture_2d<u32>;
@group(0) @binding(6) var reference: texture_2d<f32>;
@group(0) @binding(7) var<storage, read_write> output: array<vec4u>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(seed);
  if (any(id.xy >= size)) { return; }
  let pixel = vec2i(id.xy); let at = (id.y * size.x + id.x) * 7u;
  output[at] = bitcast<vec4u>(textureLoad(hdr, pixel, 0));
  output[at + 1u] = bitcast<vec4u>(textureLoad(seed, pixel, 0));
  output[at + 2u] = bitcast<vec4u>(textureLoad(response, pixel, 0));
  output[at + 3u] = textureLoad(identity, pixel, 0);
  output[at + 4u] = bitcast<vec4u>(textureLoad(mask, pixel, 0));
  output[at + 5u] = vec4u(textureLoad(winner, pixel, 0).r, 0u, 0u, 0u);
  output[at + 6u] = bitcast<vec4u>(textureLoad(reference, pixel, 0));
}`,
          }),
        },
      });
      const routes = (publication) =>
        publication.bins.map((bin, index) => {
          const entry = publication.entries.find((entry) => entry.executionBin === index);
          const source = materialFixture?.sources[entry.materialSlot];
          return {
            ...bin,
            materialEntries: source?.bindings.entries ?? [],
            frameInputs: nativeMaterialDynamicInputs(source?.program ?? entry.program, {}),
            unlit: isUnlit(entry.materialSlot),
          };
        });
      let referenceReactive = fixture.makeTexture(
        width,
        height,
        "rgba8unorm",
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      );
      let referenceShadow = fixture.makeTexture(
        Math.ceil(width / 4),
        height,
        "r32uint",
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      );
      const frameReports = [];
      let previousTranslation = 0;
      const frame = async (
        index,
        {
          abort = false,
          queued = false,
          translation = 0,
          rigid = 0,
          generation = 7,
          invalidMotion = false,
          holes = false,
          completionFail = false,
          policy = "native",
          cut = false,
          fallback = false,
        } = {},
      ) => {
        if (spec.residentProduct) fallback = false;
        const previousTranslationAtPrepare = previousTranslation;
        const view = [...identity],
          inverseView = [...identity],
          projection = [...identity],
          inverseProjection = [...identity];
        view[14] = -2 + translation;
        inverseView[14] = 2 - translation;
        projection[14] = 2;
        inverseProjection[14] = -2;
        if (spec.skyPerspective) {
          const c = Math.cos(translation),
            s = Math.sin(translation);
          view.splice(0, 16, c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, -2, 1);
          inverseView.splice(0, 16, c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, -2 * s, 0, 2 * c, 1);
          projection.splice(0, 16, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, -1, 0, 0, 0.1, 0);
          inverseProjection.splice(0, 16, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 10, 0, 0, -1, 0);
        }
        const inputCamera = {
          view,
          projection,
          inverseView,
          inverseProjection,
          jitter: [0, 0],
          preExposure: 1.25,
        };
        const seedFrame = temporal.prepare(width, height, policy, inputCamera, cut);
        // Poison all outputs before the producer; a missing lane cannot pass
        // because allocation zeros happen to look like invalid facts.
        device.queue.writeTexture(
          { texture: seedFrame.seed },
          new Float32Array(pixels * 4).fill(NaN),
          { bytesPerRow: width * 16 },
          [width, height],
        );
        device.queue.writeTexture(
          { texture: seedFrame.response },
          new Uint8Array(pixels * 4).fill(211),
          { bytesPerRow: width * 4 },
          [width, height],
        );
        device.queue.writeTexture(
          { texture: seedFrame.identity },
          new Uint32Array(pixels * 4).fill(0xdeadbeef),
          { bytesPerRow: width * 16 },
          [width, height],
        );
        const cameraWords = new Float32Array(PACKED_CAMERA_TYPE.size / 4);
        for (const field of PACKED_CAMERA_TYPE.fields) {
          if (field.type.size !== 64) continue;
          const value =
            field.name === "view_matrix"
              ? view
              : field.name === "view_matrix_inverse"
                ? inverseView
                : field.name === "projection_matrix"
                  ? projection
                  : field.name === "projection_matrix_inverse"
                    ? inverseProjection
                    : identity;
          cameraWords.set(value, field.offset / 4);
        }
        device.queue.writeBuffer(camera, 0, cameraWords);
        // Full-generation replacement and deformation validity are authored
        // fixture stimuli, not GPU→CPU control or renderer publication claims.
        device.queue.writeBuffer(
          geometry.instances,
          GPU_INSTANCE_RECORD_OFFSETS.instance_set_generation,
          new Uint32Array([generation]),
        );
        device.queue.writeBuffer(
          geometry.instances,
          GPU_INSTANCE_RECORD_OFFSETS.motion_flags,
          new Uint32Array([invalidMotion ? GPU_INSTANCE_FLAGS.MotionInvalid : 0]),
        );
        device.queue.writeBuffer(
          geometry.instances,
          GPU_INSTANCE_RECORD_OFFSETS.previous_from_current_affine,
          new Float32Array([1, 0, 0, rigid, 0, 1, 0, 0, 0, 0, 1, 0]),
        );
        const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
        temporal.attach(command);
        command.onFinished.addOne(() => surface.commit(command.gpuDone));
        command.onAborted.addOne(() => surface.abort());
        const graph = new FrameGraph("V5 Final Pixel nonproduction closure");
        const imported = (name, value) => graph.import_resource(name, { kind: "imported" }, value);
        let winner = imported("Visibility", visibility),
          depthResource = imported("Depth", depth);
        const visibilityPass = graph.add("Native visibility", {}, () => {
          coverage.encode(command.gpu_encoder, {
            colorAttachments: [
              {
                view: visibility.createView(),
                clearValue: { r: 0xffffffff, g: 0, b: 0, a: 0 },
                loadOp: "clear",
                storeOp: "store",
              },
            ],
            depthStencilAttachment: {
              view: depth.createView(),
              depthClearValue: 0,
              depthLoadOp: "clear",
              depthStoreOp: "store",
            },
          });
          if (holes) {
            // queue texture upload before encode cannot override this raster;
            // an explicit copy after raster creates sky/malformed winner stimuli.
            const values = new Uint32Array(width * height).fill(0xffffffff);
            values[1] = 0xfffffffe;
            const row = Math.ceil((width * 4) / 256) * 256;
            const padded = new Uint8Array(row * height);
            for (let y = 0; y < height; y++)
              padded.set(new Uint8Array(values.buffer, y * width * 4, width * 4), y * row);
            const upload = fixture.storage(padded, "V5/invalid and sky winners");
            command.gpu_encoder.copyBufferToTexture(
              { buffer: upload, bytesPerRow: row },
              { texture: visibility },
              [width, height],
            );
          }
          if (completionFail) {
            // A valid work/material/bin with an out-of-range local primitive.
            // Classification assigns it; the Native completion failure must
            // write invalid facts itself, rather than rely on background init.
            const upload = fixture.storage(new Uint32Array([3 << 24]), "V5/assigned completion failure");
            command.gpu_encoder.copyBufferToTexture(
              { buffer: upload, bytesPerRow: 256 },
              { texture: visibility },
              [1, 1],
            );
          }
        });
        winner = visibilityPass.write(winner);
        depthResource = visibilityPass.write(depthResource);
        let localFrame, lightingDirectory;
        let directoryId = -1,
          localDataId = -1;
        const localPass = graph.add(
          "Local lighting/direct final directory producer",
          {},
          (_data, resolved) => {
            lightingDirectory = resolved.get(directoryId);
            localFrame = localOwner.prepare({
              publication: {
                buffer: fixture.lightingEntries[0].resource.buffer,
                revision: 1,
                ids: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7]),
                currentRevision: () => 1,
              },
              view: {
                width,
                height,
                near: 0.1,
                far: 100,
                depthConversion: [0, (1.5 - translation) * 0.5],
                projection: [1, 1, 0, 0],
                view,
              },
              frameIndex: index,
              deviceEpoch: 51,
              mode: 2,
              indexCapacity: 4096,
              lookupTarget: { buffer: lightingDirectory, offset: plan.lookupOffset, size: plan.lookupBytes },
            });
            localOwner.encode(command, localFrame, {
              visibility: visibility.createView(),
              depth: depth.createView(),
            });
          },
        );
        localPass.read(winner);
        localPass.read(depthResource);
        directoryId = localPass.create("Final Pixel lighting directory", {
          kind: "transient_buffer",
          size: plan.bytes,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
        localDataId = localPass.create("Local lighting readiness", { kind: "opaque" });
        const descriptorId = vsmOwner.addToGraph(graph, {
          pages: 16,
          levels: 1,
          constants: imported("VSM constants", fixture.vsm.constants),
          pageTable: imported("VSM page table", fixture.vsm.pageTable),
          contentVersion: imported("VSM committed content", fixture.vsm.atlas),
          target: { resource: directoryId, offset: plan.descriptorOffset, size: plan.descriptorBytes },
        });
        const lightingId = addFinalPixelSolarPublication(graph, {
          transmittance: imported("Physical Sun/transmittance", transmission),
          target: descriptorId,
          plan,
        });
        const products = temporal.importProducts(graph);
        let hdrId = imported("Native HDR", hdr);
        let referenceId = -1;
        const native = graph.add("Native geometry once/Sun/Seed", {}, () => {
          const common = {
            width,
            height,
            generation: fixture.generation,
            frameIndex: index,
            cameraPosition: [0, 0, 3],
            camera,
            preExposure: fixture.exposure,
            viewMatrix: view,
            visibility,
            depth,
            geometry: fallback
              ? { ...geometry, sourcePayload: [0, 0, 0, (geometry.sourcePayload[3] | 0x80000000) >>> 0] }
              : geometry,
          };
          const lighting = [
            ...localFrame.lightingEntries.filter((entry) => entry.binding !== 2),
            ...fixture.lightingEntries.filter((entry) => [4, 5, 6, 7, 11, 15].includes(entry.binding)),
            { binding: 2, resource: { buffer: lightingDirectory } },
            { binding: 9, resource: { buffer: ranges } },
            { binding: 8, resource: { buffer: fixture.vsm.constants } },
            { binding: 10, resource: fixture.vsm.atlas.createView() },
            { binding: 16, resource: sampler },
            ...sunEntries.filter((entry) => entry.binding === 12),
          ];
          surface.prepareFrameNow(
            {
              ...common,
              output: hdr,
              publication,
              lightingEntries: lighting,
              routes: routes(publication),
              reactive: seedFrame.response,
              temporal: { seed: seedFrame.seed, identity: seedFrame.identity, view: seedFrame.view },
            },
            bins,
          );
          surface.encode(command.gpu_encoder);
        });
        native.read(winner);
        native.read(lightingId);
        native.read(localDataId);
        products.seed = native.write(products.seed);
        products.response = native.write(products.response);
        products.identity = native.write(products.identity);
        hdrId = native.write(hdrId);
        // Reference S3 uses the real standalone receiver and existing Native.
        // Reference owner preparation needs finalized local frame bindings;
        // compile/admit beforehand, then synchronous prepare using ready bins.
        const refBins = new S3Bins(device, { width, height, bins: referencePublication.bins });
        let usedRefBins = false;
        await refBins.ready;
        const referenceOutput = fixture.makeTexture(
          width,
          height,
          "rgba16float",
          GPUTextureUsage.STORAGE_BINDING |
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.RENDER_ATTACHMENT |
            GPUTextureUsage.COPY_DST,
        );
        referenceId = imported("Reference HDR", referenceOutput);
        const refPass = graph.add("Test-only S3 Shadow and Native", {}, () => {
          if (!spec.unlit && !spec.sunOnlySeam)
            fixture.vsm.shadowResolve.encode(command, {
              width,
              height,
              cameraPosition: [0, 0, 3],
              geometry,
              visibility,
              depth,
              camera,
              constants: fixture.vsm.constants,
              descriptors: fixture.vsm.descriptors,
              atlas: fixture.vsm.atlas.createView(),
              sun,
              output: referenceShadow,
            });
          referenceSurface.prepareFrameNow(
            {
              width,
              height,
              generation: fixture.generation,
              frameIndex: index,
              cameraPosition: [0, 0, 3],
              preExposure: fixture.exposure,
              viewMatrix: view,
              visibility,
              depth,
              geometry,
              output: referenceOutput,
              publication: referencePublication,
              lightingEntries: spec.sunOnlySeam
                ? [
                    ...localFrame.lightingEntries.filter((entry) => entry.binding !== 2),
                    ...fixture.lightingEntries.filter((entry) =>
                      [4, 5, 6, 7, 11, 15].includes(entry.binding),
                    ),
                    { binding: 2, resource: { buffer: lightingDirectory } },
                    { binding: 9, resource: { buffer: ranges } },
                    { binding: 8, resource: { buffer: fixture.vsm.constants } },
                    { binding: 10, resource: fixture.vsm.atlas.createView() },
                    { binding: 16, resource: sampler },
                    ...sunEntries.filter((entry) => entry.binding === 12),
                  ]
                : [
                    ...localFrame.lightingEntries,
                    ...fixture.legacyLightingEntries.filter((entry) => entry.binding > 3 && entry.binding !== 10),
                    { binding: 10, resource: referenceShadow.createView() },
                    ...sunEntries,
                  ],
              routes: routes(referencePublication),
              reactive: referenceReactive,
            },
            refBins,
          );
          referenceSurface.encode(command.gpu_encoder);
          usedRefBins = referenceSurface.executionBins === refBins;
        });
        refPass.read(winner);
        refPass.read(lightingId);
        refPass.read(localDataId);
        referenceId = refPass.write(referenceId);
        const mask = temporal.addClassification(graph, products);
        const output = storage(pixels * 7 * 16, "Final Pixel/diagnostic outputs"),
          staging = readback(output.size);
        const inspectPass = graph.add("All Final Pixel direct consumers", {}, (_data, resolved) => {
          const group = device.createBindGroup({
            layout: inspect.getBindGroupLayout(0),
            entries: [
              ...[hdrId, products.seed, products.response, products.identity, mask, winner, referenceId].map(
                (id, binding) => ({ binding, resource: viewOf(resolved.get(id)) }),
              ),
              { binding: 7, resource: { buffer: output } },
            ],
          });
          const pass = command.beginComputePass();
          pass.setPipeline(inspect);
          pass.setBindGroup(0, group);
          pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
          pass.end();
          command.gpu_encoder.copyBufferToBuffer(output, 0, staging, 0, output.size);
        });
        for (const id of [
          hdrId,
          products.seed,
          products.response,
          products.identity,
          mask,
          winner,
          referenceId,
        ])
          inspectPass.read(id);
        inspectPass.make_side_effect();
        command.encodeGraph(graph);
        if (abort) {
          command.abort();
          referenceSurface.abort();
          if (!usedRefBins) refBins.destroy();
          return { aborted: true, previousValid: seedFrame.previousValid };
        }
        command.finish();
        referenceSurface.commit(command.gpuDone);
        previousTranslation = translation;
        const verify = async () => {
          // Any unused prepared reference bins are fixture resources; the Surface
          // owns the first admitted set and reuses it. Destruction is fence-bound.
          await command.gpuDone;
          if (!usedRefBins) refBins.destroy();
          await staging.mapAsync(GPUMapMode.READ);
          const words = new Uint32Array(staging.getMappedRange()).slice();
          staging.unmap();
          const floats = new Float32Array(words.buffer);
          let shaded = 0,
            sky = 0,
            malformed = 0,
            hard = 0,
            maxHdrError = 0,
            maxMotionError = 0,
            hdrWorst = null;
          let boundaryDifferences = 0,
            maxInteriorHdrError = 0;
          for (let p = 0; p < pixels; p++) {
            const at = p * 28,
              key = words[at + 20],
              id = words.slice(at + 12, at + 16);
            for (const lane of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 16, 17, 18, 19])
              check(Number.isFinite(floats[at + lane]), `${spec.name}/${index}/${p} nonfinite ${lane}`);
            check(floats[at + 3] === 1, "HDR incomplete alpha write");
            hard += floats[at + 18] > 0.5;
            if (key === 0xffffffff) {
              sky++;
              check(
                id[0] === 0xffffffff && id[1] === 0 && id[2] === 0 && id[3] === 0,
                "Sky identity not fully written",
              );
              check(floats[at + 6] === 0 && floats[at + 7] === 0, "Sky depth sentinel changed");
              if (spec.skyPerspective) {
                const nx = (((p % width) + 0.5) / width) * 2 - 1,
                  ny = 1 - ((Math.floor(p / width) + 0.5) / height) * 2;
                const angle =
                  (seedFrame.previousValid ? previousTranslationAtPrepare : translation) - translation;
                const px = Math.cos(angle) * nx - Math.sin(angle),
                  pz = -Math.sin(angle) * nx - Math.cos(angle);
                const u = (px / -pz) * 0.5 + 0.5,
                  v = (ny / -pz) * -0.5 + 0.5;
                const valid = seedFrame.previousValid && -pz > 1e-6 && u >= 0 && v >= 0 && u < 1 && v < 1;
                check(
                  floats[at + 9] > 0.5 === valid,
                  "Perspective sky rotation validity disagrees with independent ray oracle",
                );
                maxMotionError = Math.max(
                  maxMotionError,
                  Math.abs(floats[at + 4] - (valid ? (nx + 1) * 0.5 - u : 0)),
                  Math.abs(floats[at + 5] - (valid ? (1 - ny) * 0.5 - v : 0)),
                );
                check(
                  maxMotionError < 1e-5,
                  "Sky rotation/jitter motion includes translation or wrong projection",
                );
              }
            } else if (key === 0xfffffffe || (completionFail && p === 0)) {
              malformed++;
              check(
                id.every((value) => value === 0) &&
                  floats[at + 9] === 0 &&
                  Math.round(floats[at + 11] * 255) === 16,
                `Invalid/assigned failure did not fully write facts (${spec.name}/${index}: ${[...id]}, ${floats[at + 9]})`,
              );
            } else {
              shaded++;
              const slot = (key & 0xffffff) % Math.max(1, spec.count);
              const entry = publication.entries.find((entry) => entry.materialSlot === slot);
              const signature = hash(
                hash(hash(hash(hash(2166136261, 0), instanceFlags), slot), entry.signature),
                entry.valueRevision,
              );
              check(
                id[0] === 1 &&
                  id[1] === geometrySignature(generation) &&
                  id[2] === signature &&
                  id[3] === slot + 1,
                `Identity differs from original full-u32 algorithm (${spec.name}/${p})`,
              );
              check(
                Math.abs(
                  floats[at + 6] -
                    (1.5 - (seedFrame.previousValid ? previousTranslationAtPrepare : translation)),
                ) < 1e-5,
                "Expected depth is not in previous view space",
              );
              check(
                Math.abs(floats[at + 7] - (1.5 - translation)) < 1e-5,
                "Current positive view depth wrong",
              );
              const expectedMotion = seedFrame.previousValid && !invalidMotion ? -rigid * 0.5 : 0;
              maxMotionError = Math.max(
                maxMotionError,
                Math.abs(floats[at + 4] - expectedMotion),
                Math.abs(floats[at + 5]),
              );
              if (!invalidMotion)
                check(maxMotionError < 1e-5, "Rigid jittered UV motion sign/precision changed");
              check(
                floats[at + 9] > 0.5 ===
                  (seedFrame.previousValid && !invalidMotion && Math.abs(rigid) < 0.01),
                "Motion availability wrong",
              );
            }
            for (let c = 0; c < 3; c++) {
              const error = Math.abs(floats[at + c] - floats[at + 24 + c]);
              if (error > maxHdrError) {
                maxHdrError = error;
                hdrWorst = {
                  p,
                  c,
                  target: [...floats.slice(at, at + 4)],
                  reference: [...floats.slice(at + 24, at + 28)],
                  key,
                };
              }
              // Analytic orthographic plane: reconstruct/interpolate may land on
              // opposite sides of an exact page boundary within f32 roundoff.
              // This is the explicitly changed receiver arithmetic in Design 6.1,
              // not a PCF tolerance. Report it and require all other pixels to
              // retain the existing half-HDR gate; Phase2 owns dynamic boundary QA.
              const x = ((((p % width) + 0.5) / width) * 2 - 1) * 8;
              const y = (1 - ((Math.floor(p / width) + 0.5) / height) * 2) * 8;
              const boundary =
                Math.min(Math.abs(x - Math.round(x)), Math.abs(y - Math.round(y))) <= 32 * 2 ** -23;
              if (boundary && error >= 0.003) boundaryDifferences++;
              if (!boundary) maxInteriorHdrError = Math.max(maxInteriorHdrError, error);
            }
          }
          check(
            maxInteriorHdrError < 0.003,
            `Fused Sun/late attributes differ away from analytic page boundaries (${maxInteriorHdrError}): ${JSON.stringify(hdrWorst)}`,
          );
          if (generation !== 7 && seedFrame.previousValid && !holes)
            check(hard === shaded, "Full generation replacement must hard-reject only its owner");
          if (invalidMotion)
            check(
              hard === 0,
              "Unavailable deformation must invalidate motion without inventing hard replacement",
            );
          const row = {
            index,
            previousValid: seedFrame.previousValid,
            shaded,
            sky,
            malformed,
            hard,
            maxHdrError,
            maxInteriorHdrError,
            boundaryDifferences,
            maxMotionError,
          };
          frameReports.push(row);
          return row;
        };
        return queued ? { fence: command.gpuDone, verify } : verify();
      };
      await frame(0);
      await frame(1, { fallback: true });
      const rejected = await frame(2, { abort: true, translation: 0.25 });
      check(rejected.aborted, "Abort fixture was submitted");
      await frame(3, { translation: 0.1 });
      await frame(4, { translation: 0.2, rigid: 0.001 });
      await frame(5, { generation: 0xf1234567 });
      await frame(6, { invalidMotion: true });
      await frame(7, { holes: true });
      temporal.invalidate();
      await frame(8, { cut: true });
      await frame(9, { policy: "upscale" });
      await frame(10, { policy: "upscale" });
      await frame(11, { policy: "native" });
      const pendingFrames = [];
      for (let i = 12; i < 15; i++)
        pendingFrames.push(await frame(i, { queued: true, translation: (i - 11) * 0.01 }));
      await Promise.all(pendingFrames.map((frame) => frame.fence));
      for (const submitted of pendingFrames) await submitted.verify();
      const rollback = temporal.prepare(width + 1, height + 1, "native", {
        view: identity,
        projection: identity,
        inverseView: identity,
        inverseProjection: identity,
        jitter: [0, 0],
        preExposure: 1,
      });
      check(!rollback.previousValid, "Resize candidate incorrectly reads old-domain history");
      temporal.abort();
      await frame(15);
      // Real GPU resize on the same Surface/Temporal owners, with partial tiles.
      width -= 1;
      height -= 1;
      pixels = width * height;
      visibility = fixture.makeTexture(
        width,
        height,
        "r32uint",
        GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.COPY_SRC,
      );
      depth = fixture.makeTexture(
        width,
        height,
        "depth32float",
        GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      );
      hdr = fixture.makeTexture(
        width,
        height,
        "rgba16float",
        GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.COPY_DST,
      );
      referenceReactive = fixture.makeTexture(
        width,
        height,
        "rgba8unorm",
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      );
      referenceShadow = fixture.makeTexture(
        Math.ceil(width / 4),
        height,
        "r32uint",
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      );
      bins = new NativeExecutionBins(device, { width, height, bins: publication.bins, finalPixel: true });
      await bins.ready;
      const resized = await frame(16);
      check(!resized.previousValid, "Submitted resize failed to reset history");
      await frame(17);
      await frame(18, { completionFail: true });
      temporal.destroy();
      surface.destroy();
      referenceSurface.destroy();
      await device.queue.onSubmittedWorkDone();
      await Promise.resolve();
      check(
        temporal.allocatedBytes === 0 &&
          surface.allocatedBytes === 0 &&
          referenceSurface.allocatedBytes === 0,
        "Fence retirement leaked Final Pixel resources",
      );
      reports.push({
        ...spec,
        directoryBytes: plan.bytes,
        directoryPadding: plan.lookupOffset - plan.descriptorBytes - plan.solarBytes,
        solarPublicationBytes: plan.solarBytes,
        frames: frameReports,
      });
    }
    return {
      profile: "V5 Phase1 nonproduction closure",
      adapterLimits: {
        storageBuffers: device.limits.maxStorageBuffersPerShaderStage,
        sampledTextures: device.limits.maxSampledTexturesPerShaderStage,
        storageTextures: device.limits.maxStorageTexturesPerShaderStage,
      },
      compiledProfiles: 8,
      reports,
    };
  } finally {
    await device.queue.onSubmittedWorkDone();
    for (const owner of owners.reverse()) owner.destroy?.();
    for (const fixture of fixtures) fixture.destroy();
    for (const resource of resources) resource.destroy();
    registry.destroy();
    graphics.buffer_allocator_main.destroy();
    graphics.buffer_allocator_staging.destroy();
    graphics.allocator_textures.destroy();
  }
}
