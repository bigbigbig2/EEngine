import { FinalPixelSeedReference } from "./final-pixel-seed-reference.mjs";
import { GPUCameraState } from "../../.test-dist/render/GPUCameraState.js";
import { GPUViewContext } from "../../.test-dist/render/ViewContext.js";
import { PerspectiveCamera } from "../../.test-dist/camera/PerspectiveCamera.js";
import { runNativeVsmCoverageGpuOracle } from "./native-vsm-coverage-gpu.mjs";
import { nativeFixtureExpectedPixel } from "./native-surface-reference.mjs";
import { createNativeSurfaceFixture, identity } from "./native-surface-fixture.mjs";
import { createNativeMaterialBindingFixture } from "./native-material-bindings-gpu.mjs";
import { SurfaceV4 } from "../../.test-dist/render/surface/SurfaceV4.js";
import { NativeTemporalSeed } from "../../.test-dist/render/temporal/NativeTemporalSeed.js";
import { Fsr3UpscalerRuntime as FrozenPhase3Temporal } from "./reference/phase4/Fsr3UpscalerRuntime.mjs";
import { NativeTemporalV2 } from "../../.test-dist/render/temporal/NativeTemporalV2.js";
import { nativeSurfacePublicationDescriptors } from "../../.test-dist/shaders/native_surface.js";
import { NativeVisibilityPass } from "../../.test-dist/render/surface/NativeVisibilityPass.js";
import { nativeSurfacePhysicalSunEntries } from "../../.test-dist/shaders/native_surface_lighting.js";
import { encodeFloat16, decodeFloat16 } from "../../.test-dist/core/Float16.js";
import { createNativeMaterialBindings } from "../../.test-dist/gpu/NativeMaterialBindings.js";
import {
  lowerNativeMaterial,
  nativeMaterialDynamicInputs
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
import { FinalPixelLightingPublication } from "../../.test-dist/render/lighting/FinalPixelLightingPublication.js";
import { VsmSamplingPublicationPass } from "../../.test-dist/render/vsm/VsmSamplingPublicationPass.js";
import { addFinalPixelSolarPublication } from "../../.test-dist/render/environment/FinalPixelSolarPublication.js";

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
  c[0] * 0.0163916 + c[1] * 0.0880132 + c[2] * 0.895595
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
    phase3Matrix = null,
    perspective = 0,
    physicalSun = false,
    controlledLoss = false,
    productGeometry = false,
    cellPixels = 8
  } = {}
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
        }
      }
    }
  };
  const registry = new AppearanceProgramRegistry(device);
  const localOwner = new LocalLightWorkGenerator(device, 37);
  const lightingOwner = new FinalPixelLightingPublication(device);
  const samplingOwner = new VsmSamplingPublicationPass(device);
  await samplingOwner.preparePipelines();
  await localOwner.ready;
  const surface = new SurfaceV4(device, true, undefined, true);
  const temporal = new NativeTemporalSeed(device),
    fsr = phase3Matrix ? new FrozenPhase3Temporal(device) : new NativeTemporalV2(device);
  await temporal.preparePipelines();
  if (!phase3Matrix) await fsr.preparePipelines();
  await surface.ready;
  const resources = [],
    publications = [],
    materialFixtures = [],
    coverageOwners = [],
    geometryFixtures = [];
  let fixture,
    seedReference = null;
  try {
    for (let variant = 0; variant < 2; variant++)
      materialFixtures.push(
        await createNativeMaterialBindingFixture(device, graphics, {
          variant,
          physicalBindingSetBase: variant,
          packedProducts: productGeometry
        })
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
          ...(fixture.packedOwner ? { packedProducts: fixture.packedOwner } : {})
        })
      );
      if (productGeometry) {
        // Include every real segment view in the fixture tuple. The obsolete
        // fixed nine-bank budget is covered by the new full-material admission test.
        fixture.bindings = fixture.bindings.map((binding) => {
          const layoutEntries = [...binding.layoutEntries],
            entries = [...binding.entries];
          const set = fixture.commonFor(fixture.materials[0]).bindingSet;
          for (let bank = 0; bank < set.textureBanks.length; bank++) {
            if (entries.some((entry) => entry.resource === set.textureBanks[bank])) continue;
            const slot = layoutEntries.length;
            layoutEntries.push({
              binding: slot,
              visibility: GPUShaderStage.COMPUTE,
              texture: { sampleType: "float", viewDimension: "2d-array" }
            });
            entries.push({ binding: slot, resource: set.textureBanks[bank] });
          }
          return { ...binding, layoutEntries, entries };
        });
      }
      fixture.sources = fixture.sources.map((source, index) => ({
        ...source,
        bindings: fixture.bindings[index],
        program: fixture.bindings[index].program
      }));
    }
    fixture = await createNativeSurfaceFixture(device, {
      width: requestedWidth,
      height: requestedHeight,
      materialCount: 8,
      perspective,
      highCoverage: cost,
      cellPixels
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
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC
    );
    const lut = new Uint16Array(256 * 64 * 4);
    for (let i = 0; i < lut.length; i += 4) lut.set([...sunTransmission, encodeFloat16(1)], i);
    device.queue.writeTexture({ texture: sunTexture }, lut, { bytesPerRow: 256 * 8 }, [256, 64]);
    const sunEntries = nativeSurfacePhysicalSunEntries({
      parameters: sunParameters,
      transmittance: sunTexture.createView(),
      sampler: graphics.samplers.obtain({ minFilter: "linear", magFilter: "linear" })
    });
    let exposureValue = 1.25;
    const priorExposure = fixture.storage(new Float32Array([1.25, 0, 0, 0]), "S1/prior GPU exposure");
    const exposureParameters = fixture.uniform(
      new Float32Array([2.5, ...[0.02, 0.04, 0.08].map((v) => decodeFloat16(encodeFloat16(v)))]),
      "S1/exposure update"
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
}`
        })
      }
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
            finalPixel: true,
            physicalSun: physicalSun && index !== 2
          },
          device.limits
        )
      }))
    );
    const publish = async (parameters = {}) => {
      const candidate = new GpuNativeMaterialPublication(
        device,
        registry,
        sources.map((source) => ({
          ...source,
          ...(source.materialSlot === 3 && Object.keys(parameters).length ? { parameters } : {})
        }))
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
          (entry) => entry.executionBin === publication.bins.indexOf(bin)
        );
        const source = sources.find((source) => source.materialSlot === entry.materialSlot);
        return {
          ...bin,
          materialEntries: source.bindings.entries,
          frameInputs: nativeMaterialDynamicInputs(source.program, {}),
          unlit: entry.materialSlot % 4 === 2
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
    const qualityCamera = new PerspectiveCamera();
    qualityCamera.aspect = width / height;
    qualityCamera.near = 0.1;
    qualityCamera.fov = 1;
    qualityCamera.transform.position.set(0, 0, 2);
    qualityCamera.transform.lookAt({ x: 0, y: 0, z: 0.5 });
    const qualityState = phase3Matrix ? new GPUCameraState(device, qualityCamera) : null;
    if (qualityState) resources.push(qualityState);
    const camera = qualityState?.buffer ?? fixture.uniform(cameraWords, "S1/current and previous camera");
    seedReference = phase3Matrix ? new FinalPixelSeedReference(device, width, height) : null;
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
              fixture.geometry.vertexPayload
            ]
          }
        : fixture.geometry;
    const createCoverage = async (publication, commit = true) => {
      const owner = new NativeVisibilityPass(device, {
        geometry: geometry(),
        publication,
        capacity: fixture.workCount,
        generation: fixture.generation,
        view: new Uint8Array(visibilityView),
        ...(phase3Matrix ? { camera } : {})
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
            storeOp: "store"
          }
        ],
        depthStencilAttachment: {
          view: fixture.depth.createView(),
          depthClearValue: 0,
          depthLoadOp: "clear",
          depthStoreOp: "store"
        }
      });
    let probeSize = phase3Matrix ? 16 : width * height * 16 * 4;
    let output = device.createBuffer({
      size: probeSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });
    let readback = device.createBuffer({
      size: probeSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    resources.push(output, readback);
    const inspectLayout = device.createBindGroupLayout({
      entries: [
        ...[0, 1, 2, 3].map((binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: "unfilterable-float" }
        })),
        { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
      ]
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
}`
        })
      }
    });
    const rows = [];
    const frame = async (
      index,
      { aborted = false, fallback = false, reset = false, exposureUpdate = false, exposureTarget = 2.5 } = {}
    ) => {
      const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
      let timingResults = null;
      const timed = cost && !aborted;
      const verifyOutputs = !phase3Matrix && (!cost || index < 2);
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
              }
            )
          )
        : null;
      const seedView = [...identity],
        seedProjection = [...identity],
        seedInverseProjection = [...identity];
      seedView[14] = -2;
      seedProjection[3] = perspective;
      seedProjection[14] = 2;
      seedInverseProjection[3] = -perspective;
      seedInverseProjection[2] = 2 * perspective;
      seedInverseProjection[14] = -2;
      const seedInverseView = [...identity];
      seedInverseView[14] = 2;
      let frameJitter = [0, 0];
      if (qualityState) {
        const phase = index < 64 ? 0 : index < 192 ? index - 64 : 128;
        // Author screen-space speeds, not unexplained world-space increments.
        const worldPerPixel = (3 * Math.tan(qualityCamera.fov / 2)) / height;
        const offset =
          phase3Matrix === "fast-reverse-stop"
            ? (phase < 64 ? phase : 128 - phase) * 8 * worldPerPixel
            : phase * 0.25 * worldPerPixel;
        qualityCamera.transform.position.set(
          offset,
          0,
          2 + (phase3Matrix === "dolly-depth" ? phase * 0.001 : 0)
        );
        qualityCamera.transform.lookAt({ x: offset, y: 0, z: 0.5 });
        frameJitter = [
          [-0.375, -0.375],
          [0.125, 0.375],
          [0.375, -0.125],
          [-0.125, 0.125],
          [0.125, -0.375],
          [-0.375, 0.125],
          [-0.125, -0.125],
          [0.375, 0.375]
        ][index % 8];
        GPUViewContext.prototype.setJitter.call(
          { camera: qualityState, jitter: new Float32Array(2), width, height },
          ...frameJitter
        );
        qualityState.update(command);
      }
      const seedFrame = temporal.prepare(
        width,
        height,
        "native",
        qualityState
          ? {
              view: qualityCamera.view_matrix,
              projection: qualityState.projection_matrix,
              inverseView: qualityState.view_matrix_inverse,
              inverseProjection: qualityState.projection_matrix_inverse,
              jitter: frameJitter,
              preExposure: 1
            }
          : {
              view: seedView,
              projection: seedProjection,
              inverseView: seedInverseView,
              inverseProjection: seedInverseProjection,
              jitter: [0, 0],
              preExposure: 1
            },
        reset
      );
      if (phase3Matrix) {
        temporal.attach(command);
      }
      const finalLighting = lightingOwner.prepare(1, fixture.lightingPlan.descriptorCount, command);
      const localFrame = localOwner.prepare({
        lookupTarget: {
          buffer: finalLighting.buffer,
          offset: finalLighting.plan.lookupOffset,
          size: finalLighting.plan.lookupBytes
        },
        publication: {
          buffer: fixture.lightingEntries[0].resource.buffer,
          revision: 1,
          ids: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7]),
          currentRevision: () => 1
        },
        view: {
          width,
          height,
          near: 0.1,
          far: 100,
          depthConversion: [0, 0.1],
          projection: [1, 1, 0, 0],
          view: identity
        },
        frameIndex: index,
        deviceEpoch: 37,
        mode: 1,
        visibility: fixture.visibility.createView(),
        depth: fixture.depth.createView()
      });
      const lightingEntries = [
        ...localFrame.lightingEntries.filter((entry) => entry.binding !== 2),
        ...fixture.lightingEntries.filter((entry) => entry.binding > 3 && entry.binding !== 9),
        { binding: 2, resource: { buffer: finalLighting.buffer } },
        { binding: 9, resource: { buffer: finalLighting.ranges } },
        ...(physicalSun ? sunEntries : [])
      ];
      await surface.prepareFrame({
        width,
        height,
        generation: fixture.generation,
        frameIndex: index,
        cameraPosition: phase3Matrix
          ? [
              qualityCamera.transform.matrix[12],
              qualityCamera.transform.matrix[13],
              qualityCamera.transform.matrix[14]
            ]
          : [0, 0, 3],
        preExposure: fixture.exposure,
        viewMatrix: phase3Matrix ? qualityCamera.view_matrix : seedView,
        camera,
        visibility: fixture.visibility,
        depth: fixture.depth,
        background: fixture.background,
        geometry: fallback
          ? {
              ...geometry(),
              sourcePayload: [0, 0, 0, (fixture.geometry.sourcePayload[3] | 0x80000000) >>> 0]
            }
          : geometry(),
        publication,
        lightingEntries,
        routes: routeResources(publication),
        reactive: seedFrame.response,
        temporal: { seed: seedFrame.seed, identity: seedFrame.identity, view: seedFrame.view }
      });
      const temporalSettings = {
        renderWidth: width,
        renderHeight: height,
        outputWidth: width,
        outputHeight: height,
        jitter: frameJitter,
        cameraNear: 0.1,
        cameraFar: 100,
        cameraFovY: 1,
        cameraInfiniteFar: !!phase3Matrix,
        frameTimeMs: phase3Matrix ? 1000 / 60 : 16.7,
        reset: phase3Matrix ? !seedFrame.previousValid : reset,
        historyReadIndex: index % 2
      };
      fsr.prepareFrame(
        command,
        phase3Matrix
          ? temporalSettings
          : {
              width,
              height,
              jitter: frameJitter,
              cameraFar: 100,
              cameraInfiniteFar: false,
              frameTimeMs: 16.7,
              reset,
              historyReadIndex: seedFrame.historyReadIndex
            }
      );
      if (!phase3Matrix) {
        fsr.attach(command, temporal);
      }
      seedReference?.prepare(
        command,
        temporalSettings,
        publication,
        qualityState
          ? {
              x: qualityCamera.transform.matrix[12],
              distance: qualityCamera.transform.matrix[14] - 0.5,
              scaleX: qualityState.projection_matrix[0],
              jitterX: qualityState.projection_matrix[8],
              jitterY: qualityState.projection_matrix[9]
            }
          : null
      );
      const cpuPrepareMs = performance.now() - prepareStart;
      const graph = new FrameGraph("SurfaceV4 isolated integration");
      const imported = (name, value, domain) =>
        graph.import_resource(name, { kind: "imported", ...(domain ? { domain } : {}) }, value);
      const vis = imported("winner", fixture.visibility, "internal-full"),
        depth = imported("depth", fixture.depth, "internal-full");
      const foundation = [
        ...Object.values(fixture.geometry).filter((value) => value?.size !== undefined),
        publication.data
      ];
      const dependencies = foundation.map((buffer, index) => imported(`native foundation ${index}`, buffer));
      if (qualityState) {
        const arenaIndex = foundation.indexOf(fixture.geometry.arena);
        const currentGeometry = graph.add("Seed quality/real FrameGeometryVertices", {}, () =>
          fixture.encodeFrameGeometry(command.gpu_encoder, qualityState.view_projection_matrix)
        );
        for (const id of dependencies) currentGeometry.read(id);
        dependencies[arenaIndex] = currentGeometry.write(dependencies[arenaIndex]);
      }
      const exposureResource = imported("GPU exposure", fixture.exposure);
      const backgroundResource = imported("provider background", fixture.background, "internal-full");
      let exposure = exposureResource,
        background = backgroundResource;
      let prior = imported("prior GPU exposure", priorExposure);
      if (exposureUpdate) {
        device.queue.writeBuffer(exposureParameters, 0, new Float32Array([exposureTarget]));
        const update = graph.add("S1/GPU radiometry producer", {}, () => {
          command.gpu_encoder.copyBufferToBuffer(fixture.exposure, 0, priorExposure, 0, 16);
          const group = device.createBindGroup({
            layout: exposurePipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: fixture.exposure } },
              { binding: 1, resource: fixture.background.createView() },
              { binding: 2, resource: { buffer: exposureParameters } }
            ]
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
      let lightingProduct = samplingOwner.addToGraph(graph, {
        pages: 16,
        levels: 1,
        constants: imported("VSM constants", fixture.vsm.constants),
        pageTable: imported("VSM committed page table", fixture.vsm.pageTable),
        contentVersion: imported("VSM committed atlas", fixture.vsm.atlas),
        target: {
          resource: imported("final lighting container", finalLighting.buffer),
          offset: finalLighting.plan.descriptorOffset,
          size: finalLighting.plan.descriptorBytes
        }
      });
      if (physicalSun) {
        lightingProduct = addFinalPixelSolarPublication(graph, {
          transmittance: imported("Sun transmittance provider", sunTexture),
          target: lightingProduct,
          plan: finalLighting.plan
        });
      }
      const localProducts = localFrame
        ? localOwner.addToGraph(graph, { frame: localFrame }, localFrame, {
            visibility: winnerVis,
            depth: winnerDepth,
            database: imported("local database", localFrame.request.publication.buffer),
            lookup: lightingProduct
          })
        : null;
      const seedProducts = temporal.importProducts(graph);
      const previousIdentity = imported(
        "Temporal/previous identity",
        seedFrame.previousIdentity,
        "internal-full"
      );
      const products = surface.addToGraph(
        graph,
        [
          winnerVis,
          winnerDepth,
          exposure,
          background,
          ...dependencies,
          ...(localProducts ? [localProducts.data, localProducts.lookup] : [])
        ],
        seedProducts.response,
        { seed: seedProducts.seed, identity: seedProducts.identity }
      );
      const facts = {
        motion: products.seed,
        identity: products.identity,
        mask: temporal.addClassification(
          graph,
          {
            seed: products.seed,
            response: products.reactive,
            identity: products.identity,
            previousIdentity
          },
          undefined,
          !phase3Matrix
        )
      };
      const fsrOutput = fsr.addToGraph(
        graph,
        phase3Matrix
          ? {
              color: products.hdr,
              depth: winnerDepth,
              motion: facts.motion,
              reactiveMask: facts.mask,
              validityMask: facts.mask,
              preExposure: exposure,
              priorExposure: prior,
              width,
              height,
              outputWidth: width,
              outputHeight: height
            }
          : {
              color: products.hdr,
              seed: products.seed,
              response: products.reactive,
              identity: products.identity,
              previousIdentity,
              preExposure: exposure,
              priorExposure: prior,
              width,
              height
            },
        (_name, resolve) => resolve(fsr)
      );
      if (seedReference) {
        const referenceProducts = seedReference.addToGraph(graph, command, {
          color: products.hdr,
          response: products.reactive,
          visibility: winnerVis,
          depth: winnerDepth,
          camera,
          work: fixture.geometry.meshletWork,
          instances: fixture.sceneInstances,
          preExposure: exposure,
          priorExposure: prior
        });
        seedReference.compare(
          graph,
          command,
          { color: fsrOutput, seed: products.seed, identity: products.identity, mask: facts.mask },
          referenceProducts
        );
      } else {
        const node = graph.add("S1/read all native consumers", {}, (_data, resources) => {
          if (!verifyOutputs) return;
          const group = device.createBindGroup({
            layout: inspect.getBindGroupLayout(0),
            entries: [
              ...[products.hdr, facts.motion, facts.mask, fsrOutput, winnerVis].map((id, binding) => ({
                binding,
                resource: viewOf(resources.get(id))
              })),
              { binding: 5, resource: { buffer: output } }
            ]
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
      }
      const encodeStart = performance.now();
      command.encodeGraph(graph);
      const cpuEncodeMs = performance.now() - encodeStart;
      if (aborted) {
        command.abort();
        surface.abort();
        temporal.abort();
        fsr.abort();
        return null;
      }
      command.finish();
      surface.commit(command.gpuDone);
      if (phase3Matrix) {
        fsr.commit(command.gpuDone);
      }
      await command.gpuDone;
      if (timingReady) await timingReady;
      if (exposureUpdate) exposureValue = exposureTarget;
      if (seedReference) {
        const metrics = await seedReference.measure();
        rows.push({ index, ...metrics });
        // Evaluate every frame before failing the suite, so late replacements,
        // exposure changes and settling retain evidence even after an early fail.
        rows[rows.length - 1].failures = [
          ...(metrics.nonfinite === 0 ? [] : ["nonfinite"]),
          ...(metrics.motionPixelError < 0.1 ? [] : ["motion"]),
          ...(metrics.maskChannels[0] === 0 &&
          metrics.maskChannels[2] === 0 &&
          metrics.identityMismatches === 0 &&
          metrics.unexplainedByte === 0 &&
          metrics.unexplainedValidity === 0 &&
          metrics.wrongHard === 0
            ? []
            : ["identity/mask"]),
          ...(metrics.actualAnalyticRmse <= metrics.referenceAnalyticRmse + 2 ** -10 ? [] : ["HDR"])
        ];
        // Output parity is retained as a diagnostic, not mistaken for quality:
        // two different f32 motions can amplify differently in unchanged T3.
        // Normative peak error is compared to independent analytic-motion T3.
        rows[rows.length - 1].diagnosticParityFailures = [
          ...(metrics.peakRgbComparisonUnits <= 1 ? [] : ["output peak parity"]),
          ...(metrics.normalizedHdrError <= 2 ** -10 ? [] : ["output RMSE parity"])
        ];
        return metrics;
      }
      if (!verifyOutputs) {
        rows.push({
          ...rows[1],
          index,
          verification: "unchanged inputs, initial two full-domain outputs verified",
          cpuEncodeMs,
          cpuPrepareMs,
          timing: timingResults.map((r) => ({ label: r.label, scope: r.scope, durationMs: r.duration_ms }))
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
                sunTransmission: physicalSun ? [0.7998046875, 0.7001953125, 0.60009765625] : null
              }
            );
            pbrSamples++;
            expected.forEach((v, k) => {
              const error = Math.abs(values[at + k] - v);
              pbrMaxError = Math.max(pbrMaxError, error);
              check(
                error <= Math.max(0.001, v * 0.002),
                `Independent PBR pixel${p} material${material} component${k}: ${values[at + k]} vs ${v}`
              );
            });
          }
          if (material % 4 === 2) {
            const expected = working([material >= 4 ? 192 : 128, material >= 4 ? 96 : 64, 32].map(srgb)).map(
              (v) => v * exposureValue
            );
            expected.forEach((v, k) => {
              unlitMaxError = Math.max(unlitMaxError, Math.abs(values[at + k] - v)); // Preserve the original budget in its 1.25 exposure domain: exposure
              // scaling cannot turn the same sRGB decode/half error into a material failure.
              check(
                Math.abs((values[at + k] / exposureValue) * 1.25 - (v / exposureValue) * 1.25) <=
                  0.0004 + (exposureValue < 1e-4 ? (2 ** -24 / exposureValue) * 1.25 : 0),
                `Independent unlit HDR mismatch ${values[at + k]} vs ${v}`
              );
            });
          }
        } else {
          [0.016, 0.032, 0.064]
            .map((v) => v * exposureValue)
            .forEach((v, k) =>
              check(
                Math.abs(values[at + k] - v) < 0.00004,
                `Background exposure frame${index} component${k}: ${values[at + k]} vs ${v}`
              )
            );
        }
      }
      if (exposureValue < 1e-4) {
        check(
          pbrMaxError / exposureValue <= 0.003 + 2 ** -24 / exposureValue,
          "Low P native material must retain its physical radiance, with FP16 storage-conversion ULP budget"
        );
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
        seedScratchBytes: width * height * 20,
        temporalBytes: temporal.allocatedBytes,
        cpuEncodeMs,
        cpuPrepareMs,
        timing: timingResults?.map((r) => ({ label: r.label, scope: r.scope, durationMs: r.duration_ms })),
        exposureValue
      });
      return values;
    };
    if (phase3Matrix) {
      await frame(0, { reset: true });
      for (let index = 1; index < 256; index++) {
        if (phase3Matrix === "replacement-exposure" && [96, 128, 160].includes(index)) {
          const oldPublication = publication,
            oldCoverage = coverage;
          publication = await publish({ gain: [index === 128 ? 0.8 : 0.4] });
          coverage = await createCoverage(publication);
          await oldCoverage.retire(Promise.resolve());
          await oldPublication.retire(Promise.resolve());
          publications.splice(publications.indexOf(oldPublication), 1);
        }
        await frame(index, {
          exposureUpdate: phase3Matrix === "replacement-exposure" && [96, 128].includes(index),
          exposureTarget: index === 96 ? 5 : 0.3125
        });
      }
      return {
        case: phase3Matrix,
        width,
        height,
        frames: 256,
        warmup: 64,
        rows,
        reference: "c71c6d31 Facts + unchanged production T3; same actual Native HDR",
        peakMotionPixelError: Math.max(...rows.map((row) => row.motionPixelError)),
        peakNormalizedHdrError: Math.max(...rows.map((row) => row.normalizedHdrError)),
        peakHalfSteps: Math.max(...rows.map((row) => row.peakHalfSteps))
      };
    }
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
          0.5
        ),
        cpuPrepareP50Ms: percentile(
          measurements.map((row) => row.cpuPrepareMs),
          0.5
        ),
        surfaceBytes: surface.allocatedBytes,
        seedScratchBytes: width * height * 20,
        temporalBytes: temporal.allocatedBytes,
        rasterPartitionBytes: coverage.partitions.allocatedBytes,
        fsrBytes: fsr.allocatedBytes,
        texturePool: graphics.allocator_textures.evidence(),
        bufferPool: graphics.buffer_allocator_main.evidence(),
        readbackExperimentBytes: probeSize * 2,
        discardedWarmups: 3,
        samples: measurements.length,
        rows
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
            new Uint8Array(visibilityView)
          )
        : null;
    check(rows[1].valid > rows[1].visible * 0.9, "Stable frame lost native identity/motion");
    const fallback = await frame(2, { fallback: true });
    let maxFallbackDifference = 0;
    for (let p = 0; p < width * height; p++)
      for (let k = 0; k < 4; k++)
        maxFallbackDifference = Math.max(
          maxFallbackDifference,
          Math.abs(stable[p * 16 + k] - fallback[p * 16 + k])
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
      "Parameter update did not reach native HDR"
    );
    await frame(5, { reset: true });
    fixture = await createNativeSurfaceFixture(device, {
      width,
      height,
      materialCount: 8,
      scale: [-1, 0.8, 1.2],
      perspective
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
              Math.abs(value - transformed[p * 16 + 4 + k]) * [width, height][k]
            ))
        );
        motionSamples++;
      }
    check(
      motionSamples > 0 && maxMotionPixelError < 0.1,
      "Nonuniform/negative determinant motion exceeded 0.1 render pixel"
    );
    await frame(7, { exposureUpdate: true });
    await frame(8);
    const committedBytes = surface.allocatedBytes,
      committedFsrGeneration = fsr.generation;
    fixture = await createNativeSurfaceFixture(device, {
      width: 192,
      height: 96,
      materialCount: 8,
      perspective
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
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });
    readback = device.createBuffer({
      size: probeSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    resources.push(output, readback);
    await frame(9, { aborted: true, reset: true });
    check(
      surface.allocatedBytes === committedBytes && fsr.generation === committedFsrGeneration,
      "Resize abort replaced committed native/FSR ownership"
    );
    await frame(9, { reset: true });
    await frame(10);
    check(rows.at(-1).valid === rows.at(-1).visible, "Resized stable history did not recover");
    // A real independent rgba16float store probe confirms this backend can
    // round subnormals toward zero. New low-P checks budget one 2^-24 storage
    // step; all original normal-P budgets remain unchanged.
    await frame(11, { reset: true, exposureUpdate: true, exposureTarget: 0.00002 });
    check(rows.at(-1).pbrSamples > 0, "Low-P regression requires actual lit material samples");
    const nativeSunContinuations = 0;
    check(!("continuation" in publication), "Retired Sun continuation API survived cutover");
    const lossReport = controlledLoss
      ? await (async () => {
          const ownedBytes = () =>
            (localOwner?.allocatedBytes ?? 0) +
            lightingOwner.allocatedBytes +
            surface.allocatedBytes +
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
            localLightEpochRejected
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
        "No S3 performance or whole-scene visual acceptance claim"
      ]
    };
  } finally {
    if (!controlledLoss) await device.queue.onSubmittedWorkDone();
    surface.destroy();
    lightingOwner.destroy();
    samplingOwner.destroy();
    check(lightingOwner.allocatedBytes === 0, "Final lighting integration teardown residue");
    localOwner?.destroy();
    check(!localOwner || localOwner.allocatedBytes === 0, "Local light integration teardown residue");
    temporal.destroy();
    seedReference?.destroy();
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
      requiredLimits: { maxStorageBuffersPerShaderStage: 16 }
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
    epochs
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
    physicalSun: true
  });

export async function runLocalLightEpochGpuOracle() {
  const epochs = [];
  for (let epoch = 0; epoch < 2; epoch++) {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    check(adapter, "Local light epochs require a hardware adapter");
    const device = await adapter.requestDevice({
      requiredFeatures: ["texture-formats-tier1"],
      requiredLimits: { maxStorageBuffersPerShaderStage: 16 }
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

export async function runFinalPixelSeedQualityGpuOracle(device) {
  const cases = [];
  for (const phase3Matrix of [
    "jitter-slow-pan",
    "fast-reverse-stop",
    "dolly-depth",
    "replacement-exposure"
  ]) {
    cases.push(
      await runNativeSurfaceIntegrationGpuOracle(device, { width: 1920, height: 1080, phase3Matrix })
    );
  }
  check(
    cases.every((item) => item.rows.every((row) => row.failures.length === 0)),
    `Phase3 complete matrix failures: ${JSON.stringify(cases)}`
  );
  for (const item of cases) {
    item.analyticPeakEnvelope = {
      native: Math.max(...item.rows.map((row) => row.actualAnalyticPeak)),
      reference: Math.max(...item.rows.map((row) => row.referenceAnalyticPeak))
    };
    check(
      item.analyticPeakEnvelope.native <= item.analyticPeakEnvelope.reference + 2 ** -10,
      `Phase3 ${item.case}: analytic peak envelope ${JSON.stringify(item.analyticPeakEnvelope)}`
    );
  }
  return {
    cases,
    passed: true,
    scope: "Phase3 full-domain dynamic facts/HDR regression; final architecture matrix remains Phase5/6"
  };
}
