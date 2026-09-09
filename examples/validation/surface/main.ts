import {
  BoxGeometry,
  Mesh,
  ShadeDrawSide,
  ShadeImage,
  ShadeDataType,
  ShadeTexture,
  ShadeTransparencyMode,
  type FrameProfileSnapshot,
  type PackedSceneSource
} from "../../../OEngine/src/index.ts";
import {
  GPU_TEXTURE_REF_ABI_VERSION,
  GPU_TEXTURE_REF_BANK_MASK,
  GPU_TEXTURE_REF_BANK_SHIFT,
  GPU_TEXTURE_REF_LAYER_MASK,
  GPU_TEXTURE_REF_VERSION_MASK,
  GPU_TEXTURE_REF_VERSION_SHIFT,
  GPU_TEXTURE_REF_WGSL,
  decodeGpuTextureRef,
  encodeGpuTextureRef
} from "../../../OEngine/src/gpu/GpuTextureRefAbi.ts";
import {
  VALIDATION_FIXTURE_KEY,
  VALIDATION_PROTOCOL_SCHEMA_VERSION,
  validationAssertion,
  validationError,
  type ValidationAssertion,
  type ValidationFixture,
  type ValidationScenarioRequest,
  type ValidationScenarioResult
} from "../fixture-protocol.ts";
import { CanonicalPackedRuntime } from "../shared/canonical-runtime.ts";
import { packedFrameHasNoLegacyGeometryOwners } from "../shared/packed-owner-evidence.ts";
import { FixtureState } from "../shared/fixture-state.ts";
import { createPackedBoxScene, solidMaterial } from "../shared/packed-scene.ts";
import {
  hasGpuFailure,
  validationAdapter,
  validationDiagnostics
} from "../shared/runtime-evidence.ts";

const canvas = required<HTMLCanvasElement>("gpu-canvas");
const statusElement = required<HTMLElement>("status");
let disposed = false;
const runtime = new CanonicalPackedRuntime({
  canvas,
  camera: { position: [0, 3.5, 15], target: [0, 1, 0], far: 100 },
  source: createSurfaceSource,
  onDeviceLost: (message) => {
    state.deviceLost({ name: "GPUDeviceLost", message });
    showStatus();
  }
});
const state = new FixtureState({
  fixtureId: "surface",
  canvas,
  frame: () => runtime.frame,
  adapter: () => validationAdapter(runtime.renderer?.adapter_info ?? null, runtime.renderer?.device ?? null),
  diagnostics: () => validationDiagnostics(runtime.renderer?.profiler.diagnostics)
});
const fixture: ValidationFixture = { getSnapshot: () => state.snapshot(), runScenario, dispose };
window[VALIDATION_FIXTURE_KEY] = fixture;

void runtime.initialize().then(async () => {
  await runtime.waitForFrames(3);
  state.ready();
  showStatus();
}).catch(failFixture);

async function runScenario(request: ValidationScenarioRequest): Promise<ValidationScenarioResult> {
  const supported = ["basic", "textured", "material-switch", "texture-fallback", "texture-ref-oracle", "transparent", "scene-adapter"];
  if (!supported.includes(request.scenarioId)) {
    return failedScenario(request, new Error(`Unknown surface scenario '${request.scenarioId}'`));
  }
  const startedFrame = runtime.frame;
  state.start(request.runId, request.scenarioId);
  showStatus();
  try {
    const assertions: ValidationAssertion[] = [];
    const evidence: Record<string, unknown> = {};
    let profile: FrameProfileSnapshot;

    if (request.scenarioId === "scene-adapter") {
      const renderer = runtime.renderer;
      const scene = runtime.scene;
      if (renderer === null || scene === null) throw new Error("Surface runtime is not initialized");
      runtime.stop();
      await renderer.releasePackedScene(scene);
      const ordinary = await createOrdinarySurfaceScene(scene);
      await renderer.uploadScene(scene, ordinary.geometryAssets);
      renderer.configure({ features: { temporalAntiAliasing: true } });
      ordinary.meshes[0]!.transform_local.position.set(-4.1, 1.2, 0);
      ordinary.meshes[0]!.material = ordinary.materials[1]!;
      runtime.start();
      profile = await runtime.waitForCounters(startedFrame);
      for (let attempt = 0; attempt < 8 && (
        (profile.gpuCounters.values.transparentRasterWork ?? 0) === 0 ||
        (profile.gpuCounters.values.temporalReactivePixels ?? 0) === 0
      ); attempt++) {
        profile = await runtime.waitForCounters(profile.frameIndex);
      }
      const renderWorld = renderer.gpuRenderWorldEvidence();
      const gpuScene = renderer.gpuSceneEvidence();
      evidence.renderWorld = renderWorld;
      evidence.gpuScene = gpuScene;
      assertions.push(validationAssertion("ordinary-scene-surface-adapter", renderWorld.ordinarySceneAdapterCount === 1 && renderWorld.packedSourceCount === 0 && renderWorld.ordinaryScenePatchCount >= 1, "The ordinary Scene adapter supplied the unified Surface pipeline and consumed its SceneChangeSet patch", renderWorld));
      assertions.push(validationAssertion("ordinary-scene-material-classes", (profile.gpuCounters.values.alphaClusters ?? 0) > 0 && (profile.gpuCounters.values.transparentRasterWork ?? 0) > 0, "Ordinary alpha-tested and transparent instances entered the shared bounded raster work", { alphaClusters: profile.gpuCounters.values.alphaClusters ?? 0, transparentRasterWork: profile.gpuCounters.values.transparentRasterWork ?? 0 }, "> 0"));
      assertions.push(validationAssertion("ordinary-scene-temporal-metadata", (profile.gpuCounters.values.transparentReactivePixels ?? 0) > 0 && (profile.gpuCounters.values.temporalReactivePixels ?? 0) > 0, "Ordinary Scene transparency published reactive metadata consumed by Temporal", { transparentReactivePixels: profile.gpuCounters.values.transparentReactivePixels ?? 0, temporalReactivePixels: profile.gpuCounters.values.temporalReactivePixels ?? 0 }, "> 0"));
    } else if (request.scenarioId === "texture-ref-oracle") {
      const oracle = await runTextureRefOracle();
      Object.assign(evidence, oracle);
      assertions.push(validationAssertion(
        "texture-ref-cpu-wgsl-parity",
        oracle.mismatchCount === 0,
        "The real WebGPU decoder matches the CPU TextureRef ABI for valid and invalid values",
        oracle,
        "mismatchCount = 0"
      ));
      profile = await runtime.waitForCounters(startedFrame);
    } else if (request.scenarioId === "material-switch") {
      const before = await runtime.waitForCounters(startedFrame);
      const renderer = runtime.renderer;
      const scene = runtime.scene;
      if (renderer === null || scene === null) throw new Error("Surface runtime is not initialized");
      const patchedMaterialsBefore = renderer.gpuSceneEvidence().patchedMaterialCount;
      renderer.queuePackedScenePatch(scene, {
        frameId: renderer.frame_count + 1,
        materials: {
          indices: new Uint32Array([0]),
          materialIndices: new Uint32Array([2])
        }
      });
      profile = before;
      let patchedMaterialsAfter = patchedMaterialsBefore;
      for (let attempt = 0; attempt < 6 && patchedMaterialsAfter === patchedMaterialsBefore; attempt++) {
        profile = await runtime.waitForCounters(profile.frameIndex);
        patchedMaterialsAfter = renderer.gpuSceneEvidence().patchedMaterialCount;
      }
      evidence.patchedMaterialsBefore = patchedMaterialsBefore;
      evidence.patchedMaterialsAfter = patchedMaterialsAfter;
      assertions.push(validationAssertion("material-patch-applied", patchedMaterialsAfter === patchedMaterialsBefore + 1, "The explicit material patch was consumed by the GPU Scene", { patchedMaterialsBefore, patchedMaterialsAfter }, "after = before + 1"));
    } else {
      profile = await runtime.waitForCounters(startedFrame);
    }

    const gpu = profile.gpuCounters.values;
    const counted = profile.counters;
    const activeMaterials = gpu.activeMaterials ?? 0;
    const residentTextures = counted["packed.material.residentTextures"] ?? 0;
    const residentTextureBytes = counted["packed.material.residentTextureBytes"] ?? 0;
    const textureFallbacks = counted["packed.material.textureFallbacks"] ?? 0;
    const ownerCreation = runtime.renderer?.gpuOwnerCreationEvidence();
    Object.assign(evidence, {
      activeMaterials,
      shadedPixels: gpu.shadedPixels ?? 0,
      residentTextures,
      residentTextureBytes,
      textureFallbacks,
      queueOverflowMask: gpu.queueOverflowMask ?? 0,
      gpuCounterSchemaVersion: profile.gpuCounters.schemaVersion
    });
    assertions.push(validationAssertion("materials-resolved", activeMaterials >= 4, "All four fixed materials are addressable by Material Resolve", activeMaterials, ">= 4"));
    assertions.push(validationAssertion("surface-pixels-resolved", (gpu.shadedPixels ?? 0) > 0, "Material Resolve produced visible Surface pixels", gpu.shadedPixels, "> 0"));
    assertions.push(validationAssertion("gpu-queue-no-overflow", (gpu.queueOverflowMask ?? 0) === 0, "GPU work queues did not overflow", gpu.queueOverflowMask, 0));
    if (request.scenarioId === "textured") {
      assertions.push(validationAssertion("texture-resident", residentTextures >= 1 && residentTextureBytes > 0, "The generated texture owns a resident GPU layer", { residentTextures, residentTextureBytes }, "residentTextures >= 1 and bytes > 0"));
      assertions.push(validationAssertion("texture-fallback-bounded", textureFallbacks === 1, "Only the intentionally unusable texture fell back", textureFallbacks, 1));
    }
    if (request.scenarioId === "texture-fallback") {
      assertions.push(validationAssertion("texture-fallback-recorded", textureFallbacks >= 1, "An unusable texture was recorded as an explicit material fallback", textureFallbacks, ">= 1"));
    }
    if (request.scenarioId === "transparent") {
      assertions.push(validationAssertion("transparent-work-produced", (gpu.transparentRasterWork ?? 0) > 0 && (gpu.transparentTriangles ?? 0) > 0, "Packed transparency produced bounded raster work and triangle work", { rasterWork: gpu.transparentRasterWork ?? 0, triangles: gpu.transparentTriangles ?? 0 }, "> 0"));
      assertions.push(validationAssertion("transparent-queue-no-overflow", (gpu.transparentQueueOverflowMask ?? 0) === 0, "Packed transparency work did not overflow", gpu.transparentQueueOverflowMask, 0));
    }
    if (request.scenarioId === "scene-adapter") {
      assertions.push(validationAssertion("ordinary-transparent-work-produced", (gpu.transparentRasterWork ?? 0) > 0 && (gpu.transparentTriangles ?? 0) > 0, "Ordinary Scene transparency used the shared bounded raster and MBOIT consumer", { rasterWork: gpu.transparentRasterWork ?? 0, triangles: gpu.transparentTriangles ?? 0 }, "> 0"));
    }
    assertions.push(validationAssertion("legacy-material-owner-absent", ownerCreation !== undefined && !ownerCreation.legacy.materialRegistryCreated && ownerCreation.legacy.materialContextCount === 0 && !ownerCreation.legacy.materialMetadataTableCreated && !ownerCreation.legacy.materialDefaultTexturesCreated && !ownerCreation.legacy.materialDepthPipelineCreated && !ownerCreation.legacy.materialExpandPipelineCreated, "Packed Surface and Transparency did not create the legacy material owner", ownerCreation?.legacy));
    assertions.push(validationAssertion("legacy-geometry-owner-absent", ownerCreation !== undefined && packedFrameHasNoLegacyGeometryOwners(ownerCreation), "Packed Surface, patches and Transparency did not create legacy geometry, SceneDatabase, skinning, or MeshletDrawList owners", ownerCreation?.scene));
    const diagnostics = validationDiagnostics(runtime.renderer?.profiler.diagnostics);
    assertions.push(validationAssertion("gpu-diagnostics-clean", !hasGpuFailure(diagnostics), "WebGPU diagnostics are clean", diagnostics));

    const result: ValidationScenarioResult = {
      schemaVersion: VALIDATION_PROTOCOL_SCHEMA_VERSION,
      fixtureId: "surface",
      runId: request.runId,
      scenarioId: request.scenarioId,
      status: assertions.every((assertion) => assertion.passed) ? "passed" : "failed",
      startedFrame,
      completedFrame: profile.frameIndex,
      evidence,
      assertions,
      diagnostics
    };
    state.finish();
    showStatus();
    return result;
  } catch (error) {
    state.finish();
    showStatus();
    return failedScenario(request, error, startedFrame);
  }
}

async function runTextureRefOracle(): Promise<Readonly<{ sampleCount: number; mismatchCount: number }>> {
  const device = runtime.renderer?.device;
  if (device === undefined) throw new Error("Surface runtime has no WebGPU device for the TextureRef oracle");
  const refs = new Uint32Array([
    ...Array.from({ length: 5 }, (_, bank) => encodeGpuTextureRef(bank, bank + 1)),
    0xffffffff,
    0x00000001,
    0x1f000001,
    0x10000000
  ]);
  const input = device.createBuffer({
    label: "validation/TextureRef oracle input",
    size: refs.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  });
  const outputSize = refs.length * 16;
  const output = device.createBuffer({
    label: "validation/TextureRef oracle output",
    size: outputSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
  });
  const readback = device.createBuffer({
    label: "validation/TextureRef oracle readback",
    size: outputSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  try {
    device.queue.writeBuffer(input, 0, refs);
    const module = device.createShaderModule({
      label: "validation/TextureRef CPU-WGSL oracle",
      code: /* wgsl */ `
${GPU_TEXTURE_REF_WGSL}
@group(0) @binding(0) var<storage, read> refs: array<u32>;
@group(0) @binding(1) var<storage, read_write> decoded: array<vec4u>;
@compute @workgroup_size(32)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= ${refs.length}u { return; }
  let value = refs[id.x];
  decoded[id.x] = vec4u(
    oengine_texture_ref_version(value),
    oengine_texture_ref_bank(value),
    oengine_texture_ref_layer(value),
    select(0u, 1u, oengine_texture_ref_valid(value))
  );
}`
    });
    const pipeline = await device.createComputePipelineAsync({
      label: "validation/TextureRef oracle pipeline",
      layout: "auto",
      compute: { module, entryPoint: "main" }
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: output } }
      ]
    });
    const encoder = device.createCommandEncoder({ label: "validation/TextureRef oracle" });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, outputSize);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const actual = new Uint32Array(readback.getMappedRange());
    let mismatchCount = 0;
    for (let index = 0; index < refs.length; index++) {
      const value = refs[index]!;
      const cpu = decodeGpuTextureRef(value);
      const expected = [
        (value & GPU_TEXTURE_REF_VERSION_MASK) >>> GPU_TEXTURE_REF_VERSION_SHIFT,
        (value & GPU_TEXTURE_REF_BANK_MASK) >>> GPU_TEXTURE_REF_BANK_SHIFT,
        value & GPU_TEXTURE_REF_LAYER_MASK,
        cpu === null ? 0 : 1
      ];
      if (expected[0] !== actual[index * 4] || expected[1] !== actual[index * 4 + 1] ||
        expected[2] !== actual[index * 4 + 2] || expected[3] !== actual[index * 4 + 3]) mismatchCount++;
    }
    if (GPU_TEXTURE_REF_ABI_VERSION !== 1) mismatchCount++;
    readback.unmap();
    return Object.freeze({ sampleCount: refs.length, mismatchCount });
  } finally {
    if (readback.mapState === "mapped") readback.unmap();
    input.destroy();
    output.destroy();
    readback.destroy();
  }
}

async function dispose(): Promise<void> {
  if (disposed) return;
  disposed = true;
  await runtime.destroy();
  state.dispose();
  showStatus();
  delete window[VALIDATION_FIXTURE_KEY];
}

async function createSurfaceSource(): Promise<PackedSceneSource> {
  const red = solidMaterial([0.9, 0.08, 0.06, 1], 0.7, 0);
  const metal = solidMaterial([0.72, 0.76, 0.82, 1], 0.18, 1);
  metal.draw_side = ShadeDrawSide.Double;
  const textured = solidMaterial([1, 1, 1, 1], 0.5, 0);
  textured.texture_albedo = createCheckerTexture();
  const fallback = solidMaterial([0.85, 0.2, 0.85, 1], 0.8, 0);
  fallback.texture_albedo = new ShadeTexture();
  const transparent = solidMaterial([0.1, 0.7, 0.95, 0.5], 0.25, 0);
  transparent.transparency_mode = ShadeTransparencyMode.Transparent;
  const alphaTested = solidMaterial([0.85, 0.8, 0.2, 1], 0.55, 0);
  alphaTested.transparency_mode = ShadeTransparencyMode.AlphaTested;
  alphaTested.texture_albedo = createCheckerTexture();
  return createPackedBoxScene([
    { size: [2.4, 2.4, 2.4], position: [-4.5, 1.2, 0], materialIndex: 0, debugId: 1 },
    { size: [2.4, 2.4, 2.4], position: [-1.5, 1.2, 0], materialIndex: 1, debugId: 2 },
    { size: [2.4, 2.4, 2.4], position: [1.5, 1.2, 0], materialIndex: 2, debugId: 3 },
    { size: [2.4, 2.4, 2.4], position: [4.5, 1.2, 0], materialIndex: 3, debugId: 4 },
    { size: [1.8, 1.8, 1.8], position: [0, 1.2, 2.2], materialIndex: 4, debugId: 5 },
    { size: [1.8, 1.8, 1.8], position: [0, 1.2, -2.2], materialIndex: 5, debugId: 6 }
  ], [red, metal, textured, fallback, transparent, alphaTested]);
}

async function createOrdinarySurfaceScene(scene: NonNullable<typeof runtime.scene>) {
  const source = await createSurfaceSource();
  const sizes: readonly (readonly [number, number, number])[] = [
    [2.4, 2.4, 2.4],
    [2.4, 2.4, 2.4],
    [2.4, 2.4, 2.4],
    [2.4, 2.4, 2.4],
    [1.8, 1.8, 1.8],
    [1.8, 1.8, 1.8]
  ];
  const meshes: Mesh[] = [];
  const geometryAssets = sizes.map((size, index) => {
    const geometry = new BoxGeometry(size[0], size[1], size[2]);
    const materialIndex = source.materialIndices[index]!;
    const mesh = Mesh.from(
      geometry,
      source.materials[materialIndex]!,
      source.currentTransforms.subarray(index * 16, (index + 1) * 16)
    );
    meshes.push(mesh);
    scene.add(mesh);
    return { geometry, asset: source.geometries[index]! };
  });
  return { meshes, materials: source.materials, geometryAssets };
}

function createCheckerTexture(): ShadeTexture {
  const pixels = new Uint8Array([
    255, 255, 255, 255, 25, 80, 230, 255,
    25, 80, 230, 255, 255, 255, 255, 255
  ]);
  const image = ShadeImage.fromArrayBuffer(
    pixels.buffer,
    4,
    ShadeDataType.Uint8,
    2,
    2
  );
  const texture = ShadeTexture.from(image);
  texture.label = "validation-surface-checker";
  return texture;
}

function failedScenario(request: ValidationScenarioRequest, error: unknown, startedFrame = runtime.frame): ValidationScenarioResult {
  const normalized = validationError(error);
  return {
    schemaVersion: VALIDATION_PROTOCOL_SCHEMA_VERSION,
    fixtureId: "surface",
    runId: request.runId,
    scenarioId: request.scenarioId,
    status: "failed",
    startedFrame,
    completedFrame: Math.max(startedFrame + 1, runtime.frame),
    evidence: {},
    assertions: [validationAssertion("scenario-execution", false, normalized.message)],
    diagnostics: validationDiagnostics(runtime.renderer?.profiler.diagnostics),
    error: normalized
  };
}

function failFixture(error: unknown): void {
  state.fail(validationError(error));
  showStatus();
  console.error(error);
}

function showStatus(): void {
  statusElement.dataset.fixtureStatus = state.status;
  statusElement.textContent = state.status;
}

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id}`);
  return element as T;
}
