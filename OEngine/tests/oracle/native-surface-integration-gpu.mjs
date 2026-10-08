import { runNativeVsmCoverageGpuOracle } from "./native-vsm-coverage-gpu.mjs";
import { nativeFixtureExpectedPixel } from "./native-surface-reference.mjs";
import { createNativeSurfaceFixture, identity } from "./native-surface-fixture.mjs";
import { createNativeMaterialBindingFixture } from "./native-material-bindings-gpu.mjs";
import { SurfaceV4 } from "../../.test-dist/render/surface/SurfaceV4.js";
import {
  NativeSurfaceAuxResources,
  nativeSurfaceAuxFsrInputs,
} from "../../.test-dist/render/surface/NativeSurfaceAux.js";
import { NativeTemporalFactsPass } from "../../.test-dist/render/temporal/NativeTemporalFactsPass.js";
import { Fsr3UpscalerRuntime } from "../../.test-dist/render/passes/fsr3/Fsr3UpscalerRuntime.js";
import { nativeSurfacePublicationDescriptors } from "../../.test-dist/shaders/native_surface.js";
import { NativeVisibilityPass } from "../../.test-dist/render/surface/NativeVisibilityPass.js";
import { nativeSurfacePhysicalSunEntries } from "../../.test-dist/shaders/native_surface_lighting.js";
import { encodeFloat16, decodeFloat16 } from "../../.test-dist/core/Float16.js";
import { createNativeMaterialBindings } from "../../.test-dist/gpu/NativeMaterialBindings.js";
import {
  lowerNativeMaterial,
  nativeMaterialDynamicInputs,
} from "../../.test-dist/shaders/native_material.js";
import { GpuNativeMaterialPublication } from "../../.test-dist/gpu/GpuNativeMaterialPublication.js";
import { AppearanceProgramRegistry } from "../../.test-dist/gpu/AppearanceProgramRegistry.js";
import { FrameGraph } from "../../.test-dist/framegraph/FrameGraph.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import { GPUBufferAllocator } from "../../.test-dist/gpu/GPUBufferAllocator.js";
import { GPUStagingBufferAllocator } from "../../.test-dist/gpu/GPUStagingBufferAllocator.js";
import { GPUTextureAllocator } from "../../.test-dist/gpu/GPUTextureAllocator.js";
import { GPUSamplerCache } from "../../.test-dist/gpu/GPUSamplerCache.js";
import { FrameProfiler } from "../../.test-dist/debug/FrameProfiler.js";
import { PACKED_CAMERA_TYPE } from "../../.test-dist/shaders/packed_camera.js";
import { LocalLightWorkGenerator } from "../../.test-dist/render/lighting/LocalLightWorkGenerator.js";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const viewOf = (value) => value?.view ?? value?.createView();
const srgb = (byte) => {
  const v = byte / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const working = (c) => [
  c[0] * 0.627404 + c[1] * 0.329282 + c[2] * 0.0433136,
  c[0] * 0.069097 + c[1] * 0.91954 + c[2] * 0.0113612,
  c[0] * 0.0163916 + c[1] * 0.0880132 + c[2] * 0.895595,
];

/** Complete isolated native consumer chain. Fixture setup may submit uploads;
 * each tested frame uses exactly one real ShadeGPUCommandContext/submit. No
 * RendererCore/FrameProgram/old Surface owner is constructed or imported. */
export async function runNativeSurfaceIntegrationGpuOracle(
  device,
  {
    width: requestedWidth = 128,
    height: requestedHeight = 64,
    cost = false,
    perspective = 0,
    physicalSun = false,
    controlledLoss = false,
    productGeometry = false,
  } = {},
) {
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
          throw new Error("Expected cooked mips");
        },
      },
    },
  };
  const registry = new AppearanceProgramRegistry(device);
  const localOwner = new LocalLightWorkGenerator(device, 37);
  await localOwner.ready;
  const surface = new SurfaceV4(device, true),
    aux = new NativeSurfaceAuxResources(device);
  const temporal = new NativeTemporalFactsPass(device),
    fsr = new Fsr3UpscalerRuntime(device);
  const resources = [],
    publications = [],
    materialFixtures = [],
    coverageOwners = [],
    geometryFixtures = [];
  let fixture;
  try {
    for (let variant = 0; variant < 2; variant++)
      materialFixtures.push(
        await createNativeMaterialBindingFixture(device, graphics, {
          variant,
          physicalBindingSetBase: variant,
          packedProducts: productGeometry,
        }),
      );
    // Both packages are genuinely different texture owners with binding-set id 0
    // locally; the test scene maps those owners to global sets 0 and 1 explicitly.
    for (const fixture of materialFixtures) {
      const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
      fixture.residency.promote(fixture.materials, command, 0);
      command.finish();
      await command.gpuDone;
      fixture.bindings = fixture.compiledGraphs.map((graph, index) =>
        createNativeMaterialBindings({
          ...fixture.commonFor(fixture.materials[index]),
          graph,
          program: lowerNativeMaterial(graph),
          ...(fixture.packedOwner ? { packedProducts: fixture.packedOwner } : {}),
        }),
      );
      if (productGeometry) {
        // Include every real segment view in the fixture tuple. The obsolete
        // fixed nine-bank budget is covered by the new full-material admission test.
        fixture.bindings = fixture.bindings.map((binding) => {
          const layoutEntries = [...binding.layoutEntries],
            entries = [...binding.entries];
          const set = fixture.commonFor(fixture.materials[0]).bindingSet;
          for (let bank = 0; bank < set.textureBanks.length; bank++) {
            if ((binding.bankMask & (1 << bank)) !== 0) continue;
            const slot = layoutEntries.length;
            layoutEntries.push({
              binding: slot,
              visibility: GPUShaderStage.COMPUTE,
              texture: { sampleType: "float", viewDimension: "2d-array" },
            });
            entries.push({ binding: slot, resource: set.textureBanks[bank] });
          }
          return { ...binding, layoutEntries, entries };
        });
      }
      fixture.sources = fixture.sources.map((source, index) => ({
        ...source,
        bindings: fixture.bindings[index],
        program: fixture.bindings[index].program,
      }));
    }
    fixture = await createNativeSurfaceFixture(device, {
      width: requestedWidth,
      height: requestedHeight,
      materialCount: 8,
      perspective,
      highCoverage: cost,
    });
    geometryFixtures.push(fixture);
    let width = fixture.width,
      height = fixture.height;
    const sunTransmission = [0.8, 0.7, 0.6].map((v) => new Uint16Array([encodeFloat16(v)])[0]);
    const sunValues = new Float32Array(16);
    sunValues.set([0, 0.6, 0.8, 0.001, 1, 1, 1, 1, 1]);
    const sunParameters = fixture.uniform(sunValues, "S1/physical sun parameters");
    const sunTexture = fixture.makeTexture(
      256,
      64,
      "rgba16float",
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    );
    const lut = new Uint16Array(256 * 64 * 4);
    for (let i = 0; i < lut.length; i += 4) lut.set([...sunTransmission, encodeFloat16(1)], i);
    device.queue.writeTexture({ texture: sunTexture }, lut, { bytesPerRow: 256 * 8 }, [256, 64]);
    const sunEntries = nativeSurfacePhysicalSunEntries({
      parameters: sunParameters,
      transmittance: sunTexture.createView(),
      sampler: graphics.samplers.obtain({ minFilter: "linear", magFilter: "linear" }),
    });
    let exposureValue = 1.25;
    const priorExposure = fixture.storage(new Float32Array([1.25, 0, 0, 0]), "S1/prior GPU exposure");
    const exposureParameters = fixture.uniform(
      new Float32Array([2.5, ...[0.02, 0.04, 0.08].map((v) => decodeFloat16(encodeFloat16(v)))]),
      "S1/exposure update",
    );
    const exposurePipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: {
        entryPoint: "main",
        module: device.createShaderModule({
          code: `
@group(0) @binding(0) var<storage,read_write> exposure:array<f32>;
@group(0) @binding(1) var background:texture_storage_2d<rgba16float,write>;
@group(0) @binding(2) var<uniform> desired:vec4f;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=textureDimensions(background))){return;}
 if(all(id.xy==vec2u(0u))){exposure[0]=desired.x;}
 // Re-expose the actual stored half background, not an ideal CPU float.
 textureStore(background,vec2i(id.xy),vec4f(desired.yzw*(desired.x/1.25),1.0));
}`,
        }),
      },
    });
    const sources = materialFixtures.flatMap((material, set) =>
      material.sources.map((source, index) => ({
        ...source,
        materialSlot: set * 4 + index,
        ...nativeSurfacePublicationDescriptors(
          source.program,
          source.bindings.layoutEntries,
          {
            compact: true,
            productGeometry,
            unlit: index === 2,
            reactive: true,
            physicalSun: physicalSun && index !== 2,
          },
          device.limits,
        ),
      })),
    );
    const publish = async (parameters = {}) => {
      const candidate = new GpuNativeMaterialPublication(
        device,
        registry,
        sources.map((source) => ({
          ...source,
          ...(source.materialSlot === 3 && Object.keys(parameters).length ? { parameters } : {}),
        })),
      );
      try {
        await candidate.ready;
        publications.push(candidate);
        return candidate;
      } catch (error) {
        candidate.abort();
        throw error;
      }
    };
    let publication = await publish();
    const routeResources = (publication) =>
      publication.bins.map((bin) => {
        const entry = publication.entries.find(
          (entry) => entry.executionBin === publication.bins.indexOf(bin),
        );
        const source = sources.find((source) => source.materialSlot === entry.materialSlot);
        return {
          ...bin,
          materialEntries: source.bindings.entries,
          frameInputs: nativeMaterialDynamicInputs(source.program, {}),
          unlit: entry.materialSlot % 4 === 2,
        };
      });
    const cameraWords = new Float32Array(PACKED_CAMERA_TYPE.size / 4);
    for (const field of PACKED_CAMERA_TYPE.fields)
      if (field.type.size === 64) {
        const matrix = [...identity];
        if (field.name.includes("projection"))
          matrix[3] = field.name.includes("inverse") ? -perspective : perspective;
        cameraWords.set(matrix, field.offset / 4);
      }
    const camera = fixture.uniform(cameraWords, "S1/current and previous camera");
    const visibilityView = new ArrayBuffer(192);
    const visibilityFloats = new Float32Array(visibilityView);
    visibilityFloats.set(fixture.projection, 0);
    visibilityFloats.set(identity, 16);
    visibilityFloats.set([0, 0, 3, 1], 32);
    new Uint32Array(visibilityView).set([fixture.geometry.sourcePayload[3], 0, fixture.generation, 0], 36);
    new Uint32Array(visibilityView).set(fixture.geometry.source, 40);
    new Uint32Array(visibilityView).set(fixture.geometry.sourcePayload, 44);
    const geometry = () =>
      productGeometry
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
    const createCoverage = async (publication, commit = true) => {
      const owner = new NativeVisibilityPass(device, {
        geometry: geometry(),
        publication,
        routes: routeResources(publication),
        capacity: fixture.workCount,
        generation: fixture.generation,
        view: new Uint8Array(visibilityView),
      });
      coverageOwners.push(owner);
      await owner.ready;
      if (commit) publication.commit();
      return owner;
    };
    let coverage = await createCoverage(publication);
    const encodeWinner = (command) =>
      coverage.encode(command.gpu_encoder, {
        label: "S1/native indirect coverage winner",
        colorAttachments: [
          {
            view: fixture.visibility.createView(),
            clearValue: { r: 0xffffffff, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
        depthStencilAttachment: {
          view: fixture.depth.createView(),
          depthClearValue: 0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });
    let probeSize = width * height * 16 * 4;
    let output = device.createBuffer({
      size: probeSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    let readback = device.createBuffer({
      size: probeSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    resources.push(output, readback);
    const inspectLayout = device.createBindGroupLayout({
      entries: [
        ...[0, 1, 2, 3].map((binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: "unfilterable-float" },
        })),
        { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    const inspect = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [inspectLayout] }),
      compute: {
        entryPoint: "main",
        module: device.createShaderModule({
          code: `
@group(0) @binding(0) var hdr:texture_2d<f32>;
@group(0) @binding(1) var motion:texture_2d<f32>;
@group(0) @binding(2) var mask:texture_2d<f32>;
@group(0) @binding(3) var upscaled:texture_2d<f32>;
@group(0) @binding(4) var winner:texture_2d<u32>;
@group(0) @binding(5) var<storage,read_write> result:array<vec4u>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(hdr);if(any(id.xy>=size)){return;}
 let at=(id.x+id.y*size.x)*4u;let p=vec2i(id.xy);
 result[at]=bitcast<vec4u>(textureLoad(hdr,p,0));result[at+1u]=bitcast<vec4u>(textureLoad(motion,p,0));
 result[at+2u]=bitcast<vec4u>(textureLoad(mask,p,0));result[at+3u]=vec4u(bitcast<vec3u>(textureLoad(upscaled,p,0).rgb),textureLoad(winner,p,0).r);
}`,
        }),
      },
    });
    const rows = [];
    const frame = async (
      index,
      { aborted = false, fallback = false, reset = false, exposureUpdate = false } = {},
    ) => {
      const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
      let timingResults = null;
      const timed = cost && !aborted;
      const verifyOutputs = !cost || index < 2;
      const prepareStart = performance.now();
      const timingReady = timed
        ? new Promise((resolve, reject) =>
            command.enable_debug_timers(
              (results) => {
                timingResults = results;
                resolve();
              },
              (error) => {
                reject(error);
              },
            ),
          )
        : null;
      const allocation = aux.prepare("Temporal", width, height);
      const localFrame = localOwner.prepare({
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
          depthConversion: [0, 0.1],
          projection: [1, 1, 0, 0],
          view: identity,
        },
        frameIndex: index,
        deviceEpoch: 37,
        mode: 1,
        visibility: fixture.visibility.createView(),
        depth: fixture.depth.createView(),
      });
      const lightingEntries = [
        ...localFrame.lightingEntries,
        ...fixture.lightingEntries.filter((entry) => entry.binding > 3),
        ...(physicalSun ? sunEntries : []),
      ];
      await surface.prepareFrame({
        width,
        height,
        generation: fixture.generation,
        frameIndex: index,
        cameraPosition: [0, 0, 3],
        preExposure: fixture.exposure,
        viewMatrix: identity,
        visibility: fixture.visibility,
        depth: fixture.depth,
        background: fixture.background,
        geometry: fallback
          ? {
              ...geometry(),
              sourcePayload: [0, 0, 0, (fixture.geometry.sourcePayload[3] | 0x80000000) >>> 0],
            }
          : geometry(),
        publication,
        lightingEntries,
        routes: routeResources(publication),
        reactive: allocation.opaqueReactive,
      });
      temporal.prepareFrame(width, height, index % 2, (index + 1) % 2, index > 0 && !reset);
      fsr.prepareFrame(command, {
        renderWidth: width,
        renderHeight: height,
        outputWidth: width,
        outputHeight: height,
        jitter: [0, 0],
        cameraNear: 0.1,
        cameraFar: 100,
        cameraFovY: 1,
        cameraInfiniteFar: false,
        frameTimeMs: 16.7,
        reset,
        historyReadIndex: index % 2,
      });
      const cpuPrepareMs = performance.now() - prepareStart;
      const graph = new FrameGraph("SurfaceV4 isolated integration");
      const imported = (name, value, domain) =>
        graph.import_resource(name, { kind: "imported", ...(domain ? { domain } : {}) }, value);
      const vis = imported("winner", fixture.visibility, "internal-full"),
        depth = imported("depth", fixture.depth, "internal-full");
      const foundation = [
        ...Object.values(fixture.geometry).filter((value) => value?.size !== undefined),
        publication.constants,
        publication.directory,
      ];
      const dependencies = foundation.map((buffer, index) => imported(`native foundation ${index}`, buffer));
      const exposureResource = imported("GPU exposure", fixture.exposure);
      const backgroundResource = imported("provider background", fixture.background, "internal-full");
      let exposure = exposureResource,
        background = backgroundResource;
      let prior = imported("prior GPU exposure", priorExposure);
      if (exposureUpdate) {
        const update = graph.add("S1/GPU radiometry producer", {}, () => {
          command.gpu_encoder.copyBufferToBuffer(fixture.exposure, 0, priorExposure, 0, 16);
          const group = device.createBindGroup({
            layout: exposurePipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: fixture.exposure } },
              { binding: 1, resource: fixture.background.createView() },
              { binding: 2, resource: { buffer: exposureParameters } },
            ],
          });
          const pass = command.beginComputePass({ label: "S1/GPU radiometry producer" });
          pass.setPipeline(exposurePipeline);
          pass.setBindGroup(0, group);
          pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
          pass.end();
        });
        update.read(exposureResource);
        exposure = update.write(exposureResource);
        background = update.write(backgroundResource);
        prior = update.write(prior);
      }
      for (const [index, entry] of lightingEntries.entries()) {
        if (localFrame && (entry.binding === 2 || entry.binding === 3)) continue;
        dependencies.push(imported(`lighting provider ${index}`, entry.resource.buffer ?? entry.resource));
      }
      for (const [bin, route] of routeResources(publication).entries())
        for (const entry of route.materialEntries)
          dependencies.push(imported(`material resource ${bin}/${entry.binding}`, entry.resource));
      const winner = graph.add("S1/native visibility", {}, () => encodeWinner(command, publication));
      for (const id of dependencies) winner.read(id);
      const winnerVis = winner.write(vis),
        winnerDepth = winner.write(depth);
      const localProducts = localFrame
        ? localOwner.addToGraph(graph, { frame: localFrame }, localFrame, {
            visibility: winnerVis,
            depth: winnerDepth,
            database: imported("local database", localFrame.request.publication.buffer),
          })
        : null;
      const reactiveResource = imported("opaque reactive", allocation.opaqueReactive, "internal-full");
      const products = surface.addToGraph(
        graph,
        [
          winnerVis,
          winnerDepth,
          exposure,
          background,
          ...dependencies,
          ...(localProducts ? [localProducts.data, localProducts.lookup] : []),
        ],
        reactiveResource,
      );
      const facts = temporal.addToGraph(
        graph,
        {
          width,
          height,
          visibility: winnerVis,
          depth: winnerDepth,
          opaqueReactive: products.reactive,
          meshletWork: imported("work", fixture.geometry.meshletWork),
          instances: imported("scene instances", fixture.sceneInstances),
          materialVersions: imported("native versions", publication.versions),
          materialSlotCount: publication.materialSlotCount,
          currentCamera: imported("camera", camera),
          previousCamera: imported("previous camera", camera),
          assetMetadata: imported("metadata", fixture.sparseShading.assetMetadataHeap),
          vertexPayload: imported("vertices", fixture.geometry.vertexPayload),
          sourceBindings: fixture.sparseShading,
        },
        (_name, resolve) => resolve(temporal),
      );
      const fsrOutput = fsr.addToGraph(
        graph,
        {
          color: products.hdr,
          depth: winnerDepth,
          ...nativeSurfaceAuxFsrInputs(facts),
          preExposure: exposure,
          priorExposure: prior,
          width,
          height,
          outputWidth: width,
          outputHeight: height,
        },
        (_name, resolve) => resolve(fsr),
      );
      const node = graph.add("S1/read all native consumers", {}, (_data, resources) => {
        if (!verifyOutputs) return;
        const group = device.createBindGroup({
          layout: inspect.getBindGroupLayout(0),
          entries: [
            ...[products.hdr, facts.motion, facts.mask, fsrOutput, winnerVis].map((id, binding) => ({
              binding,
              resource: viewOf(resources.get(id)),
            })),
            { binding: 5, resource: { buffer: output } },
          ],
        });
        const pass = command.beginComputePass({ label: "S1/inspect" });
        pass.setPipeline(inspect);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
        pass.end();
        command.gpu_encoder.copyBufferToBuffer(output, 0, readback, 0, probeSize);
      });
      for (const id of [products.hdr, facts.motion, facts.mask, fsrOutput, winnerVis]) node.read(id);
      node.make_side_effect();
      const encodeStart = performance.now();
      command.encodeGraph(graph);
      const cpuEncodeMs = performance.now() - encodeStart;
      if (aborted) {
        command.abort();
        surface.abort();
        aux.abort();
        temporal.abort();
        fsr.abort();
        return null;
      }
      command.finish();
      surface.commit(command.gpuDone);
      aux.commit(command.gpuDone);
      temporal.commit(command.gpuDone);
      fsr.commit(command.gpuDone);
      await command.gpuDone;
      if (timingReady) await timingReady;
      if (exposureUpdate) exposureValue = 2.5;
      if (!verifyOutputs) {
        rows.push({
          ...rows[1],
          index,
          verification: "unchanged inputs, initial two full-domain outputs verified",
          cpuEncodeMs,
          cpuPrepareMs,
          timing: timingResults.map((r) => ({ label: r.label, scope: r.scope, durationMs: r.duration_ms })),
        });
        return null;
      }
      await readback.mapAsync(GPUMapMode.READ);
      const values = new Float32Array(readback.getMappedRange()).slice();
      readback.unmap();
      const words = new Uint32Array(values.buffer);
      let visible = 0,
        valid = 0,
        reactive = 0,
        unlitMaxError = 0,
        pbrMaxError = 0,
        pbrSamples = 0;
      for (let p = 0; p < width * height; p++) {
        const at = p * 16,
          key = words[at + 15];
        for (let k = 0; k < 15; k++)
          check(Number.isFinite(values[at + k]), `Nonfinite frame${index} pixel${p} component${k}`);
        check(values[at + 3] === 1, `HDR writer missed pixel${p}`);
        if (key !== 0xffffffff) {
          visible++;
          valid += values[at + 9] > 0.5;
          reactive += values[at + 8] > 0.1;
          const slot = key & 0xffffff,
            material = cost
              ? [0, 0, 0, 1, 2, 3, 4, 4, 4, 5, 6, 7, 0, 4, 0, 4, 0, 4, 0, 4][slot % 20]
              : slot % 8;
          const ndcX = (((p % width) + 0.5) / width) * 2 - 1,
            ndcY = 1 - ((Math.floor(p / width) + 0.5) / height) * 2;
          const worldX = ndcX / (1 - fixture.perspective * ndcX),
            worldY = ndcY * (1 + fixture.perspective * worldX);
          const u = (worldX / fixture.scale[0] + 1) * 0.5;
          const margin = Math.min(Math.abs(u), Math.abs(u - 0.5), Math.abs(u - 1));
          const pageX = ((worldX + 1) * 8) % 1,
            pageY = ((worldY + 1) * 8) % 1;
          const analyticInterior =
            margin > 0.04 && pageX > 0.15 && pageX < 0.85 && pageY > 0.15 && pageY < 0.85;
          if (
            analyticInterior &&
            (p % width) % 8 === 4 &&
            Math.floor(p / width) % 8 === 2 &&
            material % 4 !== 2
          ) {
            const expected = nativeFixtureExpectedPixel(
              p % width,
              Math.floor(p / width),
              width,
              height,
              material,
              {
                scale: fixture.scale,
                perspective: fixture.perspective,
                preExposure: exposureValue,
                gain: material === 3 && index >= 4 ? 0.4 : 0.7,
                customRoughness: productGeometry ? decodeFloat16(encodeFloat16(0.45)) : 0.45,
                sunTransmission: physicalSun ? [0.7998046875, 0.7001953125, 0.60009765625] : null,
              },
            );
            pbrSamples++;
            expected.forEach((v, k) => {
              const error = Math.abs(values[at + k] - v);
              pbrMaxError = Math.max(pbrMaxError, error);
              check(
                error <= Math.max(0.001, v * 0.002),
                `Independent PBR pixel${p} material${material} component${k}: ${values[at + k]} vs ${v}`,
              );
            });
          }
          if (material % 4 === 2) {
            const expected = working([material >= 4 ? 192 : 128, material >= 4 ? 96 : 64, 32].map(srgb)).map(
              (v) => v * exposureValue,
            );
            expected.forEach((v, k) => {
              unlitMaxError = Math.max(unlitMaxError, Math.abs(values[at + k] - v)); // Preserve the original budget in its 1.25 exposure domain: exposure
              // scaling cannot turn the same sRGB decode/half error into a material failure.
              check(
                Math.abs((values[at + k] / exposureValue) * 1.25 - (v / exposureValue) * 1.25) <= 0.0004,
                `Independent unlit HDR mismatch ${values[at + k]} vs ${v}`,
              );
            });
          }
        } else {
          [0.016, 0.032, 0.064]
            .map((v) => v * exposureValue)
            .forEach((v, k) =>
              check(
                Math.abs(values[at + k] - v) < 0.00004,
                `Background exposure frame${index} component${k}: ${values[at + k]} vs ${v}`,
              ),
            );
        }
      }
      check(pbrSamples > 0, `Frame${index} had no independent PBR numeric samples`);
      check(visible > width * height * 0.6, "Work coverage vanished");
      if (index === 0 || reset) check(valid === 0, "Reset used stale Temporal history");
      rows.push({
        index,
        visible,
        valid,
        reactive,
        unlitMaxError,
        pbrMaxError,
        pbrSamples,
        fallback,
        reset,
        surfaceBytes: surface.allocatedBytes,
        auxBytes: aux.allocatedBytes,
        temporalBytes: temporal.allocatedBytes,
        cpuEncodeMs,
        cpuPrepareMs,
        timing: timingResults?.map((r) => ({ label: r.label, scope: r.scope, durationMs: r.duration_ms })),
        exposureValue,
      });
      return values;
    };
    const first = await frame(0, { reset: true });
    const stable = await frame(1);
    if (cost) {
      for (let i = 2; i < 12; i++) await frame(i);
      const measurements = rows.slice(3);
      const labels = Array.from(new Set(measurements.flatMap((row) => row.timing.map((r) => r.label))));
      const percentile = (values, q) =>
        values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(q * values.length) - 1)];
      const measured = labels.map((label) => {
        const values = measurements.map((row) => row.timing.find((r) => r.label === label)?.durationMs ?? 0);
        return { label, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), samplesMs: values };
      });
      check(rows[1].visible >= width * height * 0.94, "High coverage cost fixture lost expected winners");
      return {
        scope: "S1 isolated complete native chain cost, not production/S3 performance",
        width,
        height,
        visiblePixels: rows[1].visible,
        instances: fixture.instanceCount,
        programs: new Set(publication.bins.map((bin) => bin.programIndex)).size,
        executionBins: publication.bins.length,
        bindingSets: 2,
        measured,
        cpuEncodeP50Ms: percentile(
          measurements.map((row) => row.cpuEncodeMs),
          0.5,
        ),
        cpuPrepareP50Ms: percentile(
          measurements.map((row) => row.cpuPrepareMs),
          0.5,
        ),
        surfaceBytes: surface.allocatedBytes,
        auxBytes: aux.allocatedBytes,
        temporalBytes: temporal.allocatedBytes,
        rasterPartitionBytes: coverage.partitions.allocatedBytes,
        fsrBytes: fsr.allocatedBytes,
        texturePool: graphics.allocator_textures.evidence(),
        bufferPool: graphics.buffer_allocator_main.evidence(),
        readbackExperimentBytes: probeSize * 2,
        discardedWarmups: 3,
        samples: measurements.length,
        rows,
      };
    }
    const vsmCoverage =
      perspective === 0
        ? await runNativeVsmCoverageGpuOracle(
            device,
            graphics,
            fixture,
            publication,
            routeResources(publication),
            stable,
            new Uint8Array(visibilityView),
          )
        : null;
    check(rows[1].valid > rows[1].visible * 0.9, "Stable frame lost native identity/motion");
    const fallback = await frame(2, { fallback: true });
    let maxFallbackDifference = 0;
    for (let p = 0; p < width * height; p++)
      for (let k = 0; k < 4; k++)
        maxFallbackDifference = Math.max(
          maxFallbackDifference,
          Math.abs(stable[p * 16 + k] - fallback[p * 16 + k]),
        );
    check(maxFallbackDifference === 0, "Resident fallback changed HDR");
    await frame(3, { aborted: true });
    await frame(3);
    const previous = publication,
      previousCoverage = coverage;
    publication = await publish({ gain: [0.4] });
    coverage = await createCoverage(publication);
    const changed = await frame(4);
    await previousCoverage.retire(Promise.resolve());
    await previous.retire(Promise.resolve());
    publications.splice(publications.indexOf(previous), 1);
    check(
      changed.some((v, i) => i % 16 < 3 && v !== fallback[i]),
      "Parameter update did not reach native HDR",
    );
    await frame(5, { reset: true });
    fixture = await createNativeSurfaceFixture(device, {
      width,
      height,
      materialCount: 8,
      scale: [-1, 0.8, 1.2],
      perspective,
    });
    geometryFixtures.push(fixture);
    coverage = await createCoverage(publication, false);
    const transformed = await frame(6);
    let maxMotionPixelError = 0,
      motionSamples = 0;
    const transformedWords = new Uint32Array(transformed.buffer);
    for (let p = 0; p < width * height; p++)
      if (transformedWords[p * 16 + 15] !== 0xffffffff && transformed[p * 16 + 9] > 0.5) {
        const uv = [((p % width) + 0.5) / width, (Math.floor(p / width) + 0.5) / height];
        const nx = 2 * uv[0] - 1,
          ny = 1 - 2 * uv[1];
        const worldX = nx / (1 - perspective * nx),
          worldY = ny * (1 + perspective * worldX);
        const priorWorldX = -worldX,
          priorWorldY = worldY / 0.8;
        const priorNdcX = priorWorldX / (1 + perspective * priorWorldX),
          priorNdcY = priorWorldY / (1 + perspective * priorWorldX);
        const expected = [(nx - priorNdcX) * 0.5, (priorNdcY - ny) * 0.5];
        expected.forEach(
          (value, k) =>
            (maxMotionPixelError = Math.max(
              maxMotionPixelError,
              Math.abs(value - transformed[p * 16 + 4 + k]) * [width, height][k],
            )),
        );
        motionSamples++;
      }
    check(
      motionSamples > 0 && maxMotionPixelError < 0.1,
      "Nonuniform/negative determinant motion exceeded 0.1 render pixel",
    );
    await frame(7, { exposureUpdate: true });
    await frame(8);
    const committedBytes = surface.allocatedBytes,
      committedFsrGeneration = fsr.generation;
    fixture = await createNativeSurfaceFixture(device, {
      width: 192,
      height: 96,
      materialCount: 8,
      perspective,
    });
    geometryFixtures.push(fixture);
    width = fixture.width;
    height = fixture.height;
    exposureValue = 1.25;
    new Uint32Array(visibilityView).set([fixture.geometry.sourcePayload[3], 0, fixture.generation, 0], 36);
    new Uint32Array(visibilityView).set(fixture.geometry.source, 40);
    new Uint32Array(visibilityView).set(fixture.geometry.sourcePayload, 44);
    coverage = await createCoverage(publication, false);
    probeSize = width * height * 16 * 4;
    output = device.createBuffer({
      size: probeSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    readback = device.createBuffer({
      size: probeSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    resources.push(output, readback);
    await frame(9, { aborted: true, reset: true });
    check(
      surface.allocatedBytes === committedBytes && fsr.generation === committedFsrGeneration,
      "Resize abort replaced committed native/FSR ownership",
    );
    await frame(9, { reset: true });
    await frame(10);
    check(rows.at(-1).valid === rows.at(-1).visible, "Resized stable history did not recover");
    const nativeSunContinuations = publication.bins.filter(
      (bin) => publication.continuation(bin.programIndex) !== null,
    ).length;
    const lossReport = controlledLoss
      ? await (async () => {
          const ownedBytes = () =>
            (localOwner?.allocatedBytes ?? 0) +
            surface.allocatedBytes +
            aux.allocatedBytes +
            temporal.allocatedBytes +
            fsr.allocatedBytes +
            publications.reduce((sum, owner) => sum + owner.allocatedBytes, 0) +
            coverageOwners.reduce((sum, owner) => sum + owner.allocatedBytes, 0);
          const bytesBefore = ownedBytes();
          device.destroy();
          const loss = await device.lost;
          await Promise.resolve();
          await Promise.resolve();
          check(ownedBytes() === 0, "Destroyed device retained native resource ownership");
          let rejected = false;
          try {
            publication.pipeline(0);
          } catch {
            rejected = true;
          }
          check(rejected, "Old epoch retained native program encoding");
          let localLightEpochRejected = false;
          if (localOwner) {
            try {
              localOwner.prepare({});
            } catch (error) {
              if (!error.message.includes("unavailable or not ready")) throw error;
              localLightEpochRejected = true;
            }
            check(localLightEpochRejected, "Old epoch retained LocalLightWork preparation");
          }
          publications.length = 0;
          return {
            reason: loss.reason,
            bytesBefore,
            bytesAfter: 0,
            oldEpochRejected: true,
            localLightEpochRejected,
          };
        })()
      : null;
    return {
      scope: "S1 isolated integration; production ownership unchanged",
      rows,
      programs: new Set(publication.bins.map((bin) => bin.programIndex)).size,
      executionBins: publication.bins.length,
      instances: fixture.instanceCount,
      perspective,
      physicalSun,
      localLightWork: true,
      productResourceProfile: productGeometry,
      packedCookedMaterial: productGeometry,
      nativeSunContinuations,
      gpuExposureUpdate: true,
      resizeAbortRetry: true,
      lossReport,
      bindingSets: 2,
      rasterPartitionBytes: coverage.partitions.allocatedBytes,
      nativeGpuDrawScheduling: true,
      vsmCoverage,
      maxMotionPixelError,
      motionSamples,
      negativeDeterminant: true,
      nonuniformScale: true,
      nativeWinner: true,
      normalOrm: true,
      coat: true,
      customGraph: true,
      actualFsrChain: true,
      maxFallbackDifference,
      limitations: [
        "Authored LightDatabase records, new DIRECT LocalLightWork and resident VSM page fixtures; not scene producer cost",
        "No S3 performance or whole-scene visual acceptance claim",
      ],
    };
  } finally {
    if (!controlledLoss) await device.queue.onSubmittedWorkDone();
    surface.destroy();
    localOwner?.destroy();
    check(!localOwner || localOwner.allocatedBytes === 0, "Local light integration teardown residue");
    aux.destroy();
    temporal.destroy();
    fsr.destroy();
    await Promise.all(publications.map((pub) => pub.retire(Promise.resolve())));
    for (const owner of coverageOwners) owner.destroy();
    registry.destroy();
    for (const geometry of geometryFixtures) geometry.destroy();
    for (const fixture of materialFixtures) fixture.destroy();
    for (const resource of resources) resource.destroy();
    graphics.profiler.destroy();
    graphics.buffer_allocator_main.destroy();
    graphics.buffer_allocator_staging.destroy();
    graphics.allocator_textures.destroy();
  }
}

export const runNativeSurfaceCostGpuOracle = (device) =>
  runNativeSurfaceIntegrationGpuOracle(device, { width: 1920, height: 1080, cost: true });
export const runNativeSurfacePerspectiveGpuOracle = (device) =>
  runNativeSurfaceIntegrationGpuOracle(device, { perspective: 0.2, physicalSun: true });

/** Explicit test reinitialization after controlled device destruction; no runtime
 * recovery loop and no reuse of the old adapter/device/resources across epochs. */
export async function runNativeSurfaceDeviceEpochGpuOracle() {
  const epochs = [];
  for (let epoch = 0; epoch < 2; epoch++) {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    check(adapter !== null, "Device epoch oracle needs a hardware adapter");
    const device = await adapter.requestDevice({
      requiredFeatures: ["texture-formats-tier1", "texture-compression-bc"],
      requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    });
    const errors = [];
    device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    try {
      epochs.push(await runNativeSurfaceIntegrationGpuOracle(device, { controlledLoss: true }));
      check(errors.length === 0, "Device epoch emitted GPU validation errors");
    } finally {
      device.destroy();
    }
  }
  return {
    scope:
      "Controlled device destruction and complete independent reconstruction, not simulated driver fault recovery",
    epochs,
  };
}

// Negotiated full Product-geometry binding profile, with resident geometry input.
// Actual VG decoding is owned by the shared Geometry math and its independent
// geometry oracles; this entry does not claim a streamed VG scene acceptance.
export const runNativeSurfaceResourceProfileGpuOracle = (device) =>
  runNativeSurfaceIntegrationGpuOracle(device, { productGeometry: true, physicalSun: true });

export const runLocalLightIntegrationGpuOracle = (device) =>
  runNativeSurfaceIntegrationGpuOracle(device, {
    productGeometry: true,
    physicalSun: true,
  });

export async function runLocalLightEpochGpuOracle() {
  const epochs = [];
  for (let epoch = 0; epoch < 2; epoch++) {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    check(adapter, "Local light epochs require a hardware adapter");
    const device = await adapter.requestDevice({
      requiredFeatures: ["texture-formats-tier1"],
      requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    });
    const errors = [];
    device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    try {
      epochs.push(await runNativeSurfaceIntegrationGpuOracle(device, { controlledLoss: true }));
      check(errors.length === 0, `Local light epoch GPU errors: ${errors}`);
    } finally {
      device.destroy();
    }
  }
  return { scope: "L3.1 complete reconstruction on two independently destroyed epochs", epochs };
}
