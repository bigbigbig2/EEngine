import {
  Renderer, PerspectiveCamera, Scene, StandardShadeMaterial, DirectionalLight,
  ShadeImage, ShadeTexture,
  VirtualGeometryResidency
} from "../../../OEngine/src/index.ts";
import { encodeAssetRecordsV3, encodeGeometryProductPageRecordsV1, encodeVertexFormatsV3, type GeometryProductDescriptorV1, type GeometryProductRevisionSourceV1 } from "../../../OEngine/src/assets/geometry-product/GeometryProductV1.ts";
import { createValidationController } from "../../harness/browser.ts";
import { attachGpuErrorCollection, withGpuErrorScopes } from "../../harness/browser.ts";
import { compileSurfaceProgramLayout } from "../../../OEngine/src/render/surface/SurfaceKernelBindingPlan.ts";
import { createSurfaceMaterialProgramWgsl } from "../../../OEngine/src/shaders/surface_material_program.ts";
import { Sampler2D } from "../../../OEngine/src/texture/Sampler2D.ts";
import { evaluateGpuShadingProgramReference } from "../../../OEngine/src/gpu/GpuShadingProgramOracle.ts";
import { projectedSurfaceBarycentricReference } from "../../../OEngine/src/shaders/SurfaceReconstructionOracle.ts";
import { GPU_SHADING_MATERIAL_HEADER_OFFSETS,
  GPU_SHADING_MATERIAL_RECORD_STRIDE } from "../../../OEngine/src/gpu/GpuShadingMaterialAbi.ts";
import { GPU_INSTANCE_RECORD_OFFSETS, GPU_INSTANCE_RECORD_STRIDE } from
  "../../../OEngine/src/gpu/GpuInstanceAbi.ts";

const canvas = document.querySelector<HTMLCanvasElement>("#output")!;
const status = document.querySelector<HTMLElement>("#status")!;
let renderer: Renderer | undefined;
let residency: VirtualGeometryResidency | undefined;
let source: GeometryProductRevisionSourceV1 | undefined;
let complexResidency: VirtualGeometryResidency | undefined;
let complexSource: GeometryProductRevisionSourceV1 | undefined;
let intentionalDestroy = false;
let collector: ReturnType<typeof attachGpuErrorCollection> | undefined;

const controller = createValidationController({
  caseId: "phase1-visibility",
  workloadId: "phase1-visibility-v1"
}, async () => {
  intentionalDestroy = true;
  renderer?.destroy();
  residency?.destroy();
  source?.release();
  complexResidency?.destroy();
  complexSource?.release();
  await collector?.lost;
  collector?.remove();
  status.textContent = "disposed";
  return { devices: 0, listeners: 0, rendererDestroyed: true, residencyDestroyed: true, intentionalDeviceDestroy: intentionalDestroy };
});

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function writeF32(view: DataView, at: number, values: readonly number[]): void {
  values.forEach((value, index) => view.setFloat32(at + index * 4, value, true));
}

/** Validation-only swapchain copy; no production readback or persistent GPU resource. */
async function captureDisplayPixels(
  device: GPUDevice, context: GPUCanvasContext,
  points: readonly (readonly [number, number])[]
): Promise<number[][]> {
  const texture = context.getCurrentTexture();
  const buffer = device.createBuffer({
    label: "Validation/Surface final pixel samples", size: points.length * 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  try {
    const encoder = device.createCommandEncoder({ label: "Validation/Surface final pixel copy" });
    points.forEach(([x, y], index) => encoder.copyTextureToBuffer(
      { texture, origin: [x, y] },
      { buffer, offset: index * 256, bytesPerRow: 256 }, [1, 1, 1]
    ));
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(buffer.getMappedRange());
    const bgra = texture.format.startsWith("bgra");
    const result = points.map((_, index) => {
      const at = index * 256;
      return bgra
        ? [bytes[at + 2]!, bytes[at + 1]!, bytes[at]!, bytes[at + 3]!]
        : [bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!];
    });
    buffer.unmap();
    return result;
  } finally {
    buffer.destroy();
  }
}

function expectedLitTexel(x: number, y: number, color: readonly [number, number, number]): number[] {
  const halfHeight = 4 * Math.tan(Math.PI / 8);
  const halfWidth = halfHeight * (640 / 360);
  const worldX = ((x + 0.5) / 640 * 2 - 1) * halfWidth;
  const worldY = (1 - (y + 0.5) / 360 * 2) * halfHeight;
  const result = evaluateGpuShadingProgramReference({
    programId: 5, outputDependencyMask: 0,
    material: {
      baseColorFactor: [1, 1, 1], metallicFactor: 0, roughnessFactor: 1,
      normalScale: 1, occlusionStrength: 1, emissiveFactor: [0, 0, 0],
      baseSample: [color[0] / 255, color[1] / 255, color[2] / 255, 1],
      shadingNormal: [0, 0, 1], geometricNormal: [0, 0, 1]
    },
    viewDirection: [-worldX, -worldY, 4],
    directLights: [{ direction: [0, 0, 1], radiance: [3, 3, 3], visibility: 1 }],
    preExposure: 1, gradientValid: true
  });
  return result.radiance.map(value => Math.max(0, Math.min(255, Math.round(value * 255))));
}

function requireLitTexel(actual: readonly number[], expected: readonly number[], label: string): void {
  requireValue(actual.slice(0, 3).every((value, channel) => Math.abs(value - expected[channel]!) <= 4),
    `${label} direct-light reference mismatch: actual=${actual}, expected=${expected}`);
}

/** A two-page Product cut: page zero is the bootstrap, page one is a deliberate missing-page demand target. */
async function createProductSource(complex = false): Promise<GeometryProductRevisionSourceV1> {
  const page = new Uint8Array(262144);
  const view = new DataView(page.buffer);
  const boundsMin = [-0.8, -0.8, complex ? -0.3 : -0.1];
  const boundsMax = [0.8, 0.8, complex ? 0.3 : 0.1];
  const sphere = [0, 0, 0, complex ? 1.3 : 1];
  const vertexEnd = complex ? 208 : 176;
  writeF32(view, 0, sphere);
  writeF32(view, 16, boundsMin);
  writeF32(view, 28, boundsMax);
  view.setFloat32(40, 100, true);
  view.setUint16(44, 1, true);
  view.setUint8(46, 0);
  view.setUint8(47, 0);
  view.setUint32(48, 64, true);
  view.setUint32(52, 112, true);
  view.setUint32(56, 128, true);
  view.setUint32(60, vertexEnd, true);
  view.setUint16(64, complex ? 4 : 3, true);
  view.setUint16(66, complex ? 2 : 1, true);
  view.setUint32(68, 128, true);
  view.setUint32(72, 112, true);
  view.setUint32(76, 0xffffffff, true);
  view.setUint32(80, 0, true);
  view.setUint32(84, 1, true);
  writeF32(view, 88, boundsMin);
  writeF32(view, 100, boundsMax);
  page.set(complex ? [0, 1, 2, 2, 1, 3] : [0, 1, 2], 112);
  const positions: readonly (readonly [number, number, number])[] = [
    [-0.8, -0.8, 0], [0.8, -0.8, 0],
    ...(complex ? [[-0.8, 0.8, 0.3], [0.8, 0.8, -0.3]] as const : [[0, 0.8, 0]] as const)
  ];
  positions.forEach((position, index) => {
    const at = 128 + index * (complex ? 20 : 16);
    const q = position.map((value, axis) => {
      const minimum = boundsMin[axis]!;
      const maximum = boundsMax[axis]!;
      return Math.round((value - minimum) * 65535 / (maximum - minimum));
    });
    view.setUint16(at, q[0]!, true); view.setUint16(at + 2, q[1]!, true); view.setUint16(at + 4, q[2]!, true);
    // V3: octahedral +Z normal, then float16 UV0. The UV triangle crosses texture texels.
    const oct = complex ? [[0, 0], [16384, 0], [0, 16384], [11469, 11469]][index]! : [0, 0];
    view.setUint16(at + 6, oct[0]!, true); view.setUint16(at + 8, oct[1]!, true);
    const uv: readonly (readonly [number, number])[] = complex
      ? [[0, 0], [1, 0], [0, 1], [1, 1]] : [[0, 0], [1, 0], [0.5, 1]];
    const half = (value: number) => value === 1 ? 0x3c00 : value === 0.5 ? 0x3800 : 0;
    view.setUint16(at + 10, half(uv[index]![0]), true);
    view.setUint16(at + 12, half(uv[index]![1]), true);
    if (complex) page.set([
      [255, 64, 64, 255], [64, 255, 64, 255],
      [64, 64, 255, 255], [255, 255, 255, 255]
    ][index]!, at + 14);
  });
  const pages = [page, page.slice()];
  const hashes = await Promise.all(pages.map(async (value) => new Uint8Array(await crypto.subtle.digest("SHA-256", value))));
  const descriptor: GeometryProductDescriptorV1 = Object.freeze({
    schemaVersion: 1,
    productId: new Uint8Array(32).fill(complex ? 0x44 : 0x41),
    revision: 0,
    producerKind: "web-runtime",
    producerId: "oengine-nyx-web-runtime",
    producerVersion: "validation-product-v1",
    sourceIdentityKind: "session",
    sourceIdentityHash: new Uint8Array(32).fill(0x42),
    recipeHash: new Uint8Array(32).fill(0x43),
    runtimeProfile: "oengine-vg-v1-v3-decoded",
    decodedPageBytes: 262144,
    assetRecords: encodeAssetRecordsV3([{
      assetId: complex ? "4444444444444444444444444444444444444444444444444444444444444444" : "4141414141414141414141414141414141414141414141414141414141414141",
      boundsSphere: sphere as [number, number, number, number], boundsMin: boundsMin as [number, number, number], boundsMax: boundsMax as [number, number, number],
      rootNodeBegin: 0, rootNodeCount: 1, hierarchyBegin: 0, hierarchyCount: 3,
      groupBegin: 0, groupCount: 2, bootstrapPageBegin: 0, bootstrapPageCount: 1,
      sourceTriangleCount: complex ? 4 : 2, leafMeshletCount: 2, totalMeshletCount: 2, flags: 0
    }]),
    rootNodeIds: new Uint32Array([0]),
  hierarchyNodes: (() => { const bytes = new Uint8Array(48 * 3), node = new DataView(bytes.buffer); for (const at of [0, 48, 96]) { writeF32(node, at, sphere); writeF32(node, at + 16, boundsMin); writeF32(node, at + 28, boundsMax); node.setFloat32(at + 40, 100, true); } node.setUint32(44, (2 << 28) | (1 << 1), true); node.setUint32(48 + 44, 1, true); node.setUint32(96 + 44, 3, true); return bytes; })(),
    groupDirectory: (() => { const bytes = new Uint8Array(32), group = new DataView(bytes.buffer); group.setUint32(0, 0, true); group.setUint32(4, 0, true); group.setUint32(8, vertexEnd, true); group.setUint32(12, 1, true); group.setUint32(16, 1, true); group.setUint32(20, 0, true); group.setUint32(24, vertexEnd, true); return bytes; })(),
    pageRecords: encodeGeometryProductPageRecordsV1([{ decodedHash128: hashes[0]!.subarray(0, 16), firstGroup: 0, groupCount: 1, flags: 0, reserved: 0 }, { decodedHash128: hashes[1]!.subarray(0, 16), firstGroup: 1, groupCount: 1, flags: 0, reserved: 0 }]),
    bootstrapPageIds: new Uint32Array([0]),
    vertexFormats: encodeVertexFormatsV3([{ strideBytes: complex ? 20 : 16, attributeMask: complex ? 43 : 11, positionOffset: 0, normalOffset: 6, tangentOffset: 0xff, uv0Offset: 10, uv1Offset: 0xff, colorOffset: complex ? 14 : 0xff }]),
    activationPageIds: new Uint32Array([0])
  });
  let released = false;
  return Object.freeze({
    descriptor,
    async readPage(pageId: number, signal?: AbortSignal) {
      if (released) throw new Error("Product source has been released");
      if (signal?.aborted) throw signal.reason ?? new Error("Product page read cancelled");
      if (pageId !== 0 && pageId !== 1) throw new RangeError("Product fixture contains two pages");
      return Object.freeze({ productId: descriptor.productId.slice(), revision: descriptor.revision, pageId, decodedHash128: hashes[pageId]!.subarray(0, 16).slice(), decodedPageHash128: hashes[pageId]!.subarray(0, 16).slice(), bytes: pages[pageId]!.slice().buffer });
    },
    release() { released = true; }
  });
}

try {
  controller.transition("negotiating");
  requireValue(navigator.gpu && window.isSecureContext, "WebGPU secure context unavailable");
  renderer = new Renderer({ renderScale: 1 });
  const context = canvas.getContext("webgpu");
  requireValue(context, "WebGPU canvas context unavailable");
  await renderer.initialize({ context });
  for (const profile of [
    { programId: 0, virtualGeometry: false, textureBankMask: 0, classId: 0 },
    { programId: 3, virtualGeometry: false, textureBankMask: 0x1ff, classId: 3 },
    { programId: 4, virtualGeometry: false, textureBankMask: 0, classId: 4 },
    { programId: 15, virtualGeometry: false, textureBankMask: 0x1ff, classId: 15 },
    { programId: 15, virtualGeometry: true, textureBankMask: 0x1ff, classId: 15 }
  ]) {
    const compiled = compileSurfaceProgramLayout({
      kernel: { programId: profile.programId, outputDependencyMask: 0,
        textureBankMask: profile.textureBankMask },
      virtualGeometry: profile.virtualGeometry, lighting: "direct",
      source: "phase2-surface-wgsl", capabilityFingerprint: "validation-adapter",
      formatProfile: "rgba16float"
    }, renderer.device.limits);
    const module = renderer.device.createShaderModule({
      code: createSurfaceMaterialProgramWgsl(compiled.closure, compiled.plan, profile.classId)
    });
    const errors = (await module.getCompilationInfo()).messages.filter(message => message.type === "error");
    requireValue(errors.length === 0,
      `Surface program ${profile.programId} WGSL failed: ${errors.map(error => error.message).join("; ")}`);
  }
  collector = attachGpuErrorCollection(renderer.device, controller, () => intentionalDestroy);
  renderer.resize(1280, 720);
  const scene = new Scene();
  const material = new StandardShadeMaterial();
  material.is_unlit = false;
  const sun = new DirectionalLight();
  sun.intensity = 3;
  sun.casts_shadow = false;
  sun.forward = [0, 0, -1];
  scene.addChild(sun);
  requireValue(scene.lights.elements.includes(sun), "Directional light was not registered in Scene");
  material.texture_albedo = ShadeTexture.from(ShadeImage.fromSampler2D(
    new Sampler2D(new Uint8Array([255, 32, 32, 255, 32, 255, 32, 255,
      32, 32, 255, 255, 255, 255, 32, 255]), 4, 2, 2)
  ));
  const unlit = new StandardShadeMaterial();
  unlit.is_unlit = true;
  unlit.diffuse_color.r = 0.1;
  unlit.diffuse_color.g = 0.7;
  unlit.diffuse_color.b = 0.9;
  const minified = new StandardShadeMaterial();
  minified.texture_albedo = material.texture_albedo;
  // The logical 2x2 image lives in a 256x256 residency bank; 512x UV scale
  // makes the physical-bank footprint reach its final 1x1 mip.
  minified.base_color_uv_scale = [512, 512];
  source = await createProductSource();
  residency = await VirtualGeometryResidency.create(renderer.device, source, 17, 0);
  residency.activatePublication();
  const geometryProfiles = [{ hasAuthoredVertexColor: false, hasUv0: true, hasUv1: false, hasUv2: false, hasNormal: true, hasTangent: false }] as const;
  await renderer.uploadVirtualGeometryScene(scene, {
    materials: [material, unlit, minified], geometryProfiles, assetCount: 1,
    hierarchyMaxDepth: 2, hierarchyTraversalCapacity: 8,
    hierarchyVisibleClusterCapacity: 8, hierarchyRasterWorkCapacity: 8,
    count: 3, geometryIndices: new Uint32Array([0, 0, 0]),
    materialIndices: new Uint32Array([0, 1, 2]),
    currentTransforms: new Float32Array([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1.5, 0, 0, 1,
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1.5, 0, 0, 1
    ]),
    boundsSpheres: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])
  }, residency);
  const camera = new PerspectiveCamera();
  camera.near = 0.05;
  camera.aspect = 1280 / 720;
  camera.transform.position.set(0, 0, 4);
  camera.transform.lookAt({ x: 0, y: 0, z: 0 });
  camera.update();
  controller.transition("ready");
  controller.transition("warming");
  let beforeResizeKey = "";
  let emptyPasses: string[] = [];
  let surfacePixels: Record<string, number[]> = {};
  const scoped = await withGpuErrorScopes(renderer.device, "Phase 1 visibility frame", async () => {
    requireValue(renderer!.render(camera, new Scene(), 1 / 60), "Empty Scene was not presented");
    emptyPasses = renderer!.mainFrameGraphEvidence()?.dump.passes
      .filter(pass => !pass.culled).map(pass => pass.name) ?? [];
    requireValue(emptyPasses.length === 1 && emptyPasses[0] === "Renderer/empty present",
      "Empty Scene retained geometry work");
    for (let frame = 0; frame < 2; frame++) {
      requireValue(renderer!.render(camera, scene, 1 / 60), "Renderer did not submit the visibility frame");
      await nextFrame();
    }
    beforeResizeKey = renderer!.mainFrameGraphEvidence()?.cacheKey ?? "";
    renderer!.resize(640, 360);
    context.configure({ device: renderer!.device, format: navigator.gpu.getPreferredCanvasFormat(),
      alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    camera.aspect = 640 / 360;
    camera.update();
    requireValue(renderer!.render(camera, scene, 1 / 60), "Renderer did not submit after resize");
    const [red, green, blue, yellow, unlitPixel, minifiedPixel, background] = await captureDisplayPixels(renderer!.device, context,
      [[280, 220], [360, 220], [300, 150], [340, 150], [480, 180], [160, 180], [100, 100]]);
    surfacePixels = { red: red!, green: green!, blue: blue!, yellow: yellow!,
      unlit: unlitPixel!, minified: minifiedPixel!, background: background! };
    requireValue(red![0]! > red![1]! * 2 && green![1]! > green![0]! * 2 &&
      blue![2]! > blue![0]! * 2 && yellow![0]! > yellow![2]! * 2 &&
      yellow![1]! > yellow![2]! * 2,
    `Textured lit VG quadrants did not survive Surface shading: ${JSON.stringify(surfacePixels)}`);
    requireLitTexel(red!, expectedLitTexel(280, 220, [255, 32, 32]), "red");
    requireLitTexel(green!, expectedLitTexel(360, 220, [32, 255, 32]), "green");
    requireLitTexel(blue!, expectedLitTexel(300, 150, [32, 32, 255]), "blue");
    requireLitTexel(yellow!, expectedLitTexel(340, 150, [255, 255, 32]), "yellow");
    requireLitTexel(unlitPixel!, [26, 179, 230], "unlit material class");
    // Four source texels contribute to the 1x1 mip. A high UV gradient must not alias to LOD0.
    requireLitTexel(minifiedPixel!, expectedLitTexel(160, 180, [144, 144, 88]),
      "minified PBR gradient");
    await nextFrame();
    await renderer!.device.queue.onSubmittedWorkDone();
  });
  controller.transition("sampling");
  const graph = renderer.mainFrameGraphEvidence();
  requireValue(graph, "Phase 1 FrameGraph evidence is unavailable");
  requireValue(beforeResizeKey !== "" && graph.cacheKey !== beforeResizeKey, "Resize reused the old FrameGraph topology");
  const passes = graph.dump.passes.filter(pass => !pass.culled).map(pass => pass.name);
  requireValue(passes.some(name => name.includes("MeshletWork bucket producer")), "GPU MeshletWork raster was not encoded");
  requireValue(passes.includes("Visibility/build HZB"), "HZB was not built");
  requireValue(passes.includes("Surface/classify visible ShadingWork"), "GPU ShadingWork producer was not encoded");
  requireValue(passes.includes("Surface/plan spatial shading frequency"),
    "Adaptive Surface frequency plan was not GPU-produced");
  requireValue(passes.includes("Surface/finalize ShadingWork indirect"), "GPU ShadingWork indirect finalizer was not encoded");
  requireValue(passes.includes("Surface/scatter ShadingWork by material class"),
    "GPU ShadingWork class ranges were not consumed by scatter");
  requireValue(passes.some(name => name.startsWith("Surface/shade material class ")),
    "GPU Surface material consumer was not encoded");
  requireValue(passes.includes("Surface/shade material class 5"),
    "Textured PBR VG material class was not consumed");
  requireValue(passes.includes("Surface/shade material class 0"),
    "Mixed unlit material class was not consumed");
  requireValue(passes.some(name => name.startsWith("LightCluster/")),
    "Lit material did not consume GPU light clustering");
  requireValue(passes.includes("Surface/present radiance"), "Surface radiance was not presented");
  const frequencyDiagnostic = await renderer.diagnosticShadingFrequency();
  requireValue(frequencyDiagnostic.overflow === 0 && frequencyDiagnostic.attempted === frequencyDiagnostic.written &&
    frequencyDiagnostic.coarse2Blocks > 0 && frequencyDiagnostic.coarse4Blocks > 0 &&
    frequencyDiagnostic.savedEvaluations > 0,
  `Full/2x2/4x4 work closure did not reduce actual GPU evaluations: ${JSON.stringify(frequencyDiagnostic)}`);
  requireValue(renderer.render(camera, scene, 1 / 60),
    "Spatial coverage frame was not submitted after diagnostic buffer readback");
  const unlitGrid = Array.from({ length: 20 * 15 }, (_, index) => [
    416 + (index % 15) * 8, 108 + Math.floor(index / 15) * 8
  ] as [number, number]);
  const unlitClip = [[0.7, -0.8, 0], [2.3, -0.8, 0], [1.5, 0.8, 0]].map(([x, y, z]) =>
    [0, 1, 2, 3].map(row => {
      const matrix = camera.view_projection_matrix;
      return matrix[row]! * x! + matrix[4 + row]! * y! +
        matrix[8 + row]! * z! + matrix[12 + row]!;
    }) as [number, number, number, number]
  ) as [[number, number, number, number], [number, number, number, number], [number, number, number, number]];
  const unlitPixels = await captureDisplayPixels(renderer.device, context, unlitGrid);
  const unlitChecked: [number, number][] = [];
  for (let index = 0; index < unlitGrid.length; index++) {
    const point = unlitGrid[index]!;
    const bary = projectedSurfaceBarycentricReference(
      [point[0] + 0.5, point[1] + 0.5], unlitClip, [640, 360]);
    if (!bary.valid || bary.weights.some(weight => weight < 0.08)) continue;
    requireLitTexel(unlitPixels[index]!, [26, 179, 230], `reconstructed unlit pixel ${point}`);
    unlitChecked.push(point);
  }
  requireValue(unlitChecked.length >= 20,
    `Spatial reconstruction did not cover enough interior samples: ${unlitChecked.length}`);
  requireValue(scoped.errors.length === 0, JSON.stringify(scoped.errors));
  const runtime = renderer.graphics.render_world.runtime(scene);
  requireValue(runtime, "Published mixed-material runtime was not resident");
  const litSlot = runtime.materialBinSlots[5];
  requireValue(litSlot !== undefined && litSlot !== 0xffffffff,
    "Textured PBR material association was not published");
  const materialGenerationOffset = litSlot * GPU_SHADING_MATERIAL_RECORD_STRIDE +
    GPU_SHADING_MATERIAL_HEADER_OFFSETS.materialGeneration;
  renderer.device.queue.writeBuffer(runtime.materialResources.materialRecords,
    materialGenerationOffset, new Uint32Array([0]));
  let faultPixels: number[][] = [];
  const fault = await withGpuErrorScopes(renderer.device, "Phase 2 material identity fault", async () => {
    requireValue(renderer!.render(camera, scene, 1 / 60), "Identity fault frame was not submitted");
    faultPixels = await captureDisplayPixels(renderer!.device, context,
      [[280, 220], [480, 180], [160, 180]]);
  });
  requireValue(fault.errors.length === 0, JSON.stringify(fault.errors));
  requireValue(faultPixels[0]![0] === 255 && faultPixels[0]![1] === 0 &&
    faultPixels[0]![2] === 255, `Corrupt generation did not fail visibly: ${faultPixels[0]}`);
  requireLitTexel(faultPixels[1]!, surfacePixels.unlit!, "unaffected unlit class");
  requireLitTexel(faultPixels[2]!, surfacePixels.minified!, "unaffected second PBR material");
  renderer.device.queue.writeBuffer(runtime.materialResources.materialRecords,
    materialGenerationOffset, new Uint32Array([runtime.materialGeneration]));
  requireValue(renderer.render(camera, scene, 1 / 60), "Restored material frame was not submitted");
  const [restoredPixel] = await captureDisplayPixels(renderer.device, context, [[280, 220]]);
  requireLitTexel(restoredPixel!, surfacePixels.red!, "restored PBR material identity");
  const unlitSlot = runtime.materialBinSlots[64]; // material index 1, class 0
  requireValue(unlitSlot !== undefined && unlitSlot !== 0xffffffff,
    "Coarse unlit material association was not published");
  const unlitGenerationOffset = unlitSlot * GPU_SHADING_MATERIAL_RECORD_STRIDE +
    GPU_SHADING_MATERIAL_HEADER_OFFSETS.materialGeneration;
  renderer.device.queue.writeBuffer(runtime.materialResources.materialRecords,
    unlitGenerationOffset, new Uint32Array([0]));
  requireValue(renderer.render(camera, scene, 1 / 60), "Coarse identity fault frame was not submitted");
  const coarseFaultPixels = await captureDisplayPixels(renderer.device, context, unlitChecked.slice(0, 3));
  requireValue(coarseFaultPixels.every(pixel => pixel[0] === 255 && pixel[1] === 0 && pixel[2] === 255),
    `Coarse reconstruction hid a material identity failure: ${JSON.stringify(coarseFaultPixels)}`);
  renderer.device.queue.writeBuffer(runtime.materialResources.materialRecords,
    unlitGenerationOffset, new Uint32Array([runtime.materialGeneration]));
  // Compare identical scene/camera/resolution on the one production pipeline.
  // This is diagnostic timing, not fixed-condition performance evidence.
  renderer.profiler.configure({ enabled: true, gpuSampleInterval: 1 });
  renderer.profiler.setMode("record");
  const frequencyTimings: Array<{
    mode: "full" | "spatial"; surfaceMedianMs: number | null;
    phaseMediansMs: Record<string, number>; pixels: number[][];
  }> = [];
  const frequencyTimestampAvailable = renderer.device.features.has("timestamp-query");
  for (const mode of ["full", "spatial"] as const) {
    renderer.spatial_shading_frequency_enabled = mode === "spatial";
    const measuredFrames: number[] = [];
    for (let frame = 0; frame < 10; frame++) {
      const index = renderer.frame_count;
      requireValue(renderer.render(camera, scene, 1 / 60), `${mode} comparison frame was not submitted`);
      if (frame >= 2) measuredFrames.push(index);
      if (frame < 9) await nextFrame();
    }
    const names = renderer.mainFrameGraphEvidence()?.dump.passes
      .filter(pass => !pass.culled).map(pass => pass.name) ?? [];
    requireValue(names.includes("Surface/plan spatial shading frequency") === (mode === "spatial"),
      `${mode} comparison retained the wrong frequency topology`);
    const pixels = await captureDisplayPixels(renderer.device, context,
      [[280, 220], [480, 180], [160, 180], [100, 100]]);
    await renderer.device.queue.onSubmittedWorkDone();
    if (frequencyTimestampAvailable) {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (measuredFrames.every(index => renderer!.profiler.getFrame(index)?.gpu.pending === false)) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    const phaseSamples = new Map<string, number[]>();
    for (const index of measuredFrames) {
      const profile = renderer.profiler.getFrame(index);
      if (profile?.gpu.pending || !profile?.gpu.sampled) continue;
      for (const segment of profile.gpu.segments) {
        const surfaceAt = segment.label.indexOf("/Surface/");
        if (surfaceAt < 0) continue;
        const label = segment.label.slice(surfaceAt + 1);
        const samples = phaseSamples.get(label) ?? [];
        samples.push(segment.durationMs);
        phaseSamples.set(label, samples);
      }
      const total = profile.gpu.segments
        .filter(segment => segment.label.includes("/Surface/"))
        .reduce((sum, segment) => sum + segment.durationMs, 0);
      if (total > 0) {
        const samples = phaseSamples.get("total") ?? [];
        samples.push(total);
        phaseSamples.set("total", samples);
      }
    }
    const median = (values: readonly number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)]!;
    };
    frequencyTimings.push({
      mode, surfaceMedianMs: phaseSamples.has("total") ? median(phaseSamples.get("total")!) : null,
      phaseMediansMs: Object.fromEntries([...phaseSamples]
        .filter(([name]) => name !== "total").map(([name, values]) => [name, median(values)])),
      pixels
    });
    if (frequencyTimestampAvailable) {
      requireValue(phaseSamples.get("total")?.length === measuredFrames.length &&
        phaseSamples.has("Surface/present radiance"),
      `${mode} comparison did not capture the complete Surface GPU timing slice`);
    }
  }
  requireValue(frequencyTimings[0]!.pixels.every((pixel, index) =>
    pixel.every((value, channel) => Math.abs(value - frequencyTimings[1]!.pixels[index]![channel]!) <= 1)),
    `Full/spatial scene output differs: ${JSON.stringify(frequencyTimings)}`);
  requireLitTexel(frequencyTimings[1]!.pixels[1]!, surfacePixels.unlit!, "spatial/full unlit equality");
  renderer.profiler.setMode("live");
  renderer.profiler.configure({ enabled: false });
  renderer.spatial_shading_frequency_enabled = true;
  const instanceBuffer = renderer.graphics.gpu_scene.bindings().instances;
  const unlitMotionOffset = (runtime.instanceBegin + 1) * GPU_INSTANCE_RECORD_STRIDE +
    GPU_INSTANCE_RECORD_OFFSETS.previous_from_current_affine;
  renderer.device.queue.writeBuffer(instanceBuffer, unlitMotionOffset,
    new Float32Array([1, 0, 0, 0.2]));
  requireValue(renderer.render(camera, scene, 1 / 60), "Dynamic-boundary frame was not submitted");
  const [dynamicUnlit] = await captureDisplayPixels(renderer.device, context, [[480, 180]]);
  requireLitTexel(dynamicUnlit!, surfacePixels.unlit!, "dynamic full-rate unlit fallback");
  const dynamicFrequency = await renderer.diagnosticShadingFrequency();
  requireValue(dynamicFrequency.overflow === 0 && dynamicFrequency.coarse2Blocks === 0 &&
    dynamicFrequency.coarse4Blocks === 0 &&
    dynamicFrequency.attempted === frequencyDiagnostic.attempted + frequencyDiagnostic.savedEvaluations,
    `Dynamic identity did not restore full-rate work: ${JSON.stringify(dynamicFrequency)}`);
  renderer.device.queue.writeBuffer(instanceBuffer, unlitMotionOffset,
    new Float32Array([1, 0, 0, 0]));
  requireValue(renderer.render(camera, scene, 1 / 60), "Static-frequency restoration frame was not submitted");
  const restoredFrequency = await renderer.diagnosticShadingFrequency();
  requireValue(restoredFrequency.coarse4Blocks > 0 && restoredFrequency.overflow === 0,
    "Restoring instance motion identity did not restore coarse work");
  renderer.resize(639, 359);
  context.configure({ device: renderer.device, format: navigator.gpu.getPreferredCanvasFormat(),
    alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  camera.aspect = 639 / 359;
  camera.update();
  requireValue(renderer.render(camera, scene, 1 / 60), "Odd-extent spatial frame was not submitted");
  const [oddUnlit] = await captureDisplayPixels(renderer.device, context, [[480, 180]]);
  requireLitTexel(oddUnlit!, surfacePixels.unlit!, "odd-extent unlit reconstruction");
  const oddExtentFrequency = await renderer.diagnosticShadingFrequency();
  requireValue(oddExtentFrequency.overflow === 0 && oddExtentFrequency.coarse4Blocks > 0,
    `Odd-extent frequency work did not close: ${JSON.stringify(oddExtentFrequency)}`);
  renderer.resize(640, 360);
  context.configure({ device: renderer.device, format: navigator.gpu.getPreferredCanvasFormat(),
    alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  camera.aspect = 640 / 360;
  camera.update();
  const geometryBeforeLoss = residency.evidence();
  const lostDevice = renderer.device;
  intentionalDestroy = true;
  lostDevice.destroy();
  await lostDevice.lost;
  await collector?.lost;
  collector?.remove();
  renderer = await renderer.recoverAfterDeviceLoss();
  intentionalDestroy = false;
  collector = attachGpuErrorCollection(renderer.device, controller, () => intentionalDestroy);
  context.configure({ device: renderer.device, format: navigator.gpu.getPreferredCanvasFormat(),
    alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  let recoveredPixels: number[][] = [];
  const recovered = await withGpuErrorScopes(renderer.device, "Phase 1 recovered visibility frame", async () => {
    requireValue(renderer!.render(camera, scene, 1 / 60), "Recovered Renderer did not submit visibility");
    recoveredPixels = await captureDisplayPixels(renderer!.device, context,
      [[280, 220], [360, 220], [300, 150], [340, 150], [480, 180], [160, 180]]);
    await renderer!.device.queue.onSubmittedWorkDone();
  });
  for (const [index, expected] of [surfacePixels.red, surfacePixels.green,
    surfacePixels.blue, surfacePixels.yellow, surfacePixels.unlit, surfacePixels.minified].entries()) {
    requireLitTexel(recoveredPixels[index]!, expected, `recovered quadrant ${index}`);
  }
  requireValue(recovered.errors.length === 0, JSON.stringify(recovered.errors));
  requireValue(renderer.mainFrameGraphEvidence()?.dump.passes
    .some(pass => !pass.culled && pass.name.includes("MeshletWork bucket producer")),
    "Recovered Renderer did not consume GPU MeshletWork");
  // The same tilted VG triangle crosses the camera plane (mixed-sign clip w).
  // Changing only the near plane must preserve shading on pixels covered in
  // both frames; it changes the hardware-clipped silhouette, not the authored
  // vertex data or the Surface reconstruction at surviving samples.
  camera.transform.position.set(0, -0.5, 0.7);
  camera.transform.lookAt({ x: 0, y: 1.2, z: 0 });
  const clipGrid = Array.from({ length: 22 * 40 }, (_, index) => [
    8 + (index % 40) * 16, 8 + Math.floor(index / 40) * 16
  ] as [number, number]);
  camera.near = 0.05;
  camera.update();
  const clipW = [[-0.8, -0.8, 0], [0.8, -0.8, 0], [0, 0.8, 0]].map(position => {
    const matrix = camera.view_projection_matrix;
    return matrix[3]! * position[0]! + matrix[7]! * position[1]! +
      matrix[11]! * position[2]! + matrix[15]!;
  });
  requireValue(clipW.some(value => value < 0) && clipW.some(value => value > 0),
    `Tilted VG triangle did not cross the camera plane: ${clipW}`);
  requireValue(renderer.render(camera, scene, 1 / 60), "Mixed-w near-clip frame was not submitted");
  const closeClipPixels = await captureDisplayPixels(renderer.device, context, clipGrid);
  const sourceVertices = [[-0.8, -0.8, 0], [0.8, -0.8, 0], [0, 0.8, 0]] as const;
  const projectInstance = (offsetX: number) => sourceVertices.map(vertex => {
    const matrix = camera.view_projection_matrix;
    const x = vertex[0] + offsetX, y = vertex[1], z = vertex[2];
    return [0, 1, 2, 3].map(row =>
      matrix[row]! * x + matrix[4 + row]! * y + matrix[8 + row]! * z + matrix[12 + row]!
    ) as [number, number, number, number];
  }) as [[number, number, number, number], [number, number, number, number], [number, number, number, number]];
  const projected = [0, 1.5, -1.5].map(projectInstance);
  const inside = (weights: readonly number[]) => weights.every(value => value >= -1e-4 && value <= 1 + 1e-4);
  let mixedWNumericSamples = 0;
  for (let index = 0; index < clipGrid.length; index++) {
    const pixel = clipGrid[index]!;
    const reference = projectedSurfaceBarycentricReference(
      [pixel[0] + 0.5, pixel[1] + 0.5], projected[0]!, [640, 360]);
    if (!reference.valid || !inside(reference.weights) || [1, 2].some(other => {
      const competing = projectedSurfaceBarycentricReference(
        [pixel[0] + 0.5, pixel[1] + 0.5], projected[other]!, [640, 360]);
      return competing.valid && inside(competing.weights);
    })) continue;
    const uvX = reference.weights[1] + reference.weights[2] * 0.5;
    const uvY = reference.weights[2];
    if (Math.abs(uvX - 0.5) < 0.15 || Math.abs(uvY - 0.5) < 0.15) continue;
    const texel = uvY < 0.5
      ? uvX < 0.5 ? [255, 32, 32] : [32, 255, 32]
      : uvX < 0.5 ? [32, 32, 255] : [255, 255, 32];
    const position = sourceVertices[0].map((_, axis) => sourceVertices.reduce((sum, vertex, i) =>
      sum + vertex[axis]! * reference.weights[i]!, 0));
    const lit = evaluateGpuShadingProgramReference({
      programId: 5, outputDependencyMask: 0,
      material: {
        baseColorFactor: [1, 1, 1], metallicFactor: 0, roughnessFactor: 1,
        normalScale: 1, occlusionStrength: 1, emissiveFactor: [0, 0, 0],
        baseSample: [texel[0]! / 255, texel[1]! / 255, texel[2]! / 255, 1],
        shadingNormal: [0, 0, 1], geometricNormal: [0, 0, 1]
      },
      viewDirection: [-position[0]!, -0.5 - position[1]!, 0.7],
      directLights: [{ direction: [0, 0, 1], radiance: [3, 3, 3], visibility: 1 }],
      preExposure: 1, gradientValid: true
    });
    const expected = lit.radiance.map(value => Math.max(0, Math.min(255, Math.round(value * 255))));
    requireLitTexel(closeClipPixels[index]!, expected, `mixed-w projected Surface ${pixel}`);
    mixedWNumericSamples++;
  }
  requireValue(mixedWNumericSamples >= 3,
    `Mixed-w projected Surface found too few exclusive, stable-texel samples: ${mixedWNumericSamples}`);
  camera.near = 1.1;
  camera.update();
  requireValue(renderer.render(camera, scene, 1 / 60), "Farther near-clip frame was not submitted");
  const farClipPixels = await captureDisplayPixels(renderer.device, context, clipGrid);
  const isSurface = (pixel: readonly number[]) => pixel.slice(0, 3).some((value, channel) =>
    Math.abs(value - surfacePixels.background![channel]!) > 12);
  let mixedWOverlap = 0;
  let clippedAway = 0;
  for (let index = 0; index < clipGrid.length; index++) {
    const nearPixel = closeClipPixels[index]!;
    const farPixel = farClipPixels[index]!;
    if (isSurface(nearPixel) && isSurface(farPixel)) {
      mixedWOverlap++;
      requireLitTexel(farPixel, nearPixel, `mixed-w surviving pixel ${clipGrid[index]}`);
    } else if (isSurface(nearPixel) && !isSurface(farPixel)) {
      clippedAway++;
    }
  }
  requireValue(mixedWOverlap >= 8 && clippedAway >= 2,
    `Near clipping had insufficient GPU overlap/change: overlap=${mixedWOverlap}, clipped=${clippedAway}`);
  // A separate Product exercises two non-coplanar primitives, quantized
  // vertex colors/normals, perspective UV gradients and nonuniform scaling.
  complexSource = await createProductSource(true);
  complexResidency = await VirtualGeometryResidency.create(renderer.device, complexSource, 17, 0);
  complexResidency.activatePublication();
  const complexScene = new Scene();
  const complexSun = new DirectionalLight();
  complexSun.intensity = 3;
  complexSun.forward = [0, 0, -1];
  complexScene.addChild(complexSun);
  const complexMaterial = new StandardShadeMaterial();
  complexMaterial.texture_albedo = material.texture_albedo;
  complexMaterial.base_color_uv_scale = [512, 512];
  await renderer.uploadVirtualGeometryScene(complexScene, {
    materials: [complexMaterial],
    geometryProfiles: [{ hasAuthoredVertexColor: true, hasUv0: true, hasUv1: false,
      hasUv2: false, hasNormal: true, hasTangent: false }],
    assetCount: 1, hierarchyMaxDepth: 2, hierarchyTraversalCapacity: 8,
    hierarchyVisibleClusterCapacity: 8, hierarchyRasterWorkCapacity: 8,
    count: 1, geometryIndices: new Uint32Array([0]), materialIndices: new Uint32Array([0]),
    currentTransforms: new Float32Array([
      1.1, 0, 0, 0, 0, 0.8, 0, 0, 0, 0, 1.7, 0, 0, 0, 0, 1
    ]),
    boundsSpheres: new Float32Array([0, 0, 0, 1.3])
  }, complexResidency);
  camera.near = 0.05;
  camera.transform.position.set(0, 0, 4);
  camera.transform.lookAt({ x: 0, y: 0, z: 0 });
  camera.update();
  requireValue(renderer.render(camera, complexScene, 1 / 60), "Complex VG warm frame was not submitted");
  requireValue(renderer.render(camera, complexScene, 1 / 60), "Complex VG Surface frame was not submitted");
  requireValue(!renderer.mainFrameGraphEvidence()?.dump.passes.some(pass =>
    !pass.culled && pass.name === "Surface/plan spatial shading frequency"),
    "A scene without coarse-eligible materials retained the frequency pass");
  const complexGrid = Array.from({ length: 21 * 27 }, (_, index) => [
    216 + (index % 27) * 8, 100 + Math.floor(index / 27) * 8
  ] as [number, number]);
  const complexPixels = await captureDisplayPixels(renderer.device, context, complexGrid);
  const complexWorld = [[-0.88, -0.64, 0], [0.88, -0.64, 0],
    [-0.88, 0.64, 0.51], [0.88, 0.64, -0.51]] as const;
  const triangles = [[0, 1, 2], [2, 1, 3]] as const;
  const oct = [[0, 0], [16384, 0], [0, 16384], [11469, 11469]] as const;
  const colors = [[255, 64, 64], [64, 255, 64], [64, 64, 255], [255, 255, 255]] as const;
  const normalize = (v: readonly number[]): [number, number, number] => {
    const length = Math.hypot(...v);
    return v.map(value => value / length) as [number, number, number];
  };
  const cross = (a: readonly number[], b: readonly number[]): [number, number, number] => [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!
  ];
  const normals = oct.map(([x, y]) => normalize([x / 32767, y / 32767,
    1 - Math.abs(x / 32767) - Math.abs(y / 32767)]));
  const uvs = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;
  const matrix = camera.view_projection_matrix;
  const complexClips = complexWorld.map(([x, y, z]) => [0, 1, 2, 3].map(row =>
    matrix[row]! * x + matrix[4 + row]! * y + matrix[8 + row]! * z + matrix[12 + row]!
  ) as [number, number, number, number]);
  const complexSamples = [0, 0];
  let minimumTextureFootprint = Number.POSITIVE_INFINITY;
  for (let index = 0; index < complexGrid.length; index++) {
    const pixel = complexGrid[index]!;
    for (let triangleIndex = 0; triangleIndex < triangles.length; triangleIndex++) {
      const triangle = triangles[triangleIndex]!;
      const clips = triangle.map(vertex => complexClips[vertex]!) as
        [[number, number, number, number], [number, number, number, number], [number, number, number, number]];
      const bary = projectedSurfaceBarycentricReference(
        [pixel[0] + 0.5, pixel[1] + 0.5], clips, [640, 360]);
      if (!bary.valid || bary.weights.some(value => value < 0.15 || value > 0.7)) continue;
      const uvDerivative = (weights: readonly number[]) => [0, 1].map(axis =>
        triangle.reduce<number>((sum, vertex, corner) =>
          sum + uvs[vertex]![axis]! * weights[corner]!, 0) * 512);
      const dx = uvDerivative(bary.ddx), dy = uvDerivative(bary.ddy);
      const footprint = 256 * Math.max(Math.hypot(...dx), Math.hypot(...dy));
      minimumTextureFootprint = Math.min(minimumTextureFootprint, footprint);
      requireValue(footprint >= 256,
        `Complex VG projected gradient did not reach the final texture mip: ${footprint}`);
      const interpolate = (values: readonly (readonly number[])[]): [number, number, number] =>
        values[0]!.map((_, axis) => triangle.reduce<number>((sum, vertex, corner) =>
          sum + values[vertex]![axis]! * bary.weights[corner]!, 0)) as [number, number, number];
      const position = interpolate(complexWorld);
      const color = interpolate(colors).map(value => value / 255) as
        [number, number, number];
      const localNormal = normalize(interpolate(normals));
      const shadingNormal = normalize([
        localNormal[0]! / 1.1, localNormal[1]! / 0.8, localNormal[2]! / 1.7
      ]);
      const edge0 = complexWorld[triangle[1]]!.map((v, axis) => v - complexWorld[triangle[0]]![axis]!);
      const edge1 = complexWorld[triangle[2]]!.map((v, axis) => v - complexWorld[triangle[0]]![axis]!);
      const result = evaluateGpuShadingProgramReference({
        programId: 5, outputDependencyMask: 0,
        material: {
          baseColorFactor: color, metallicFactor: 0, roughnessFactor: 1,
          normalScale: 1, occlusionStrength: 1, emissiveFactor: [0, 0, 0],
          baseSample: [144 / 255, 144 / 255, 88 / 255, 1],
          shadingNormal, geometricNormal: normalize(cross(edge0, edge1))
        },
        viewDirection: [-position[0]!, -position[1]!, 4 - position[2]!],
        directLights: [{ direction: [0, 0, 1], radiance: [3, 3, 3], visibility: 1 }],
        preExposure: 1, gradientValid: true
      });
      const expected = result.radiance.map(value =>
        Math.max(0, Math.min(255, Math.round(value * 255))));
      requireLitTexel(complexPixels[index]!, expected,
        `complex VG primitive ${triangleIndex} at ${pixel}`);
      complexSamples[triangleIndex]++;
    }
  }
  requireValue(complexSamples.every(count => count >= 5),
    `Complex VG primitives lacked numeric Surface samples: ${complexSamples}`);
  controller.addEvidence("phase1", {
    emptyPasses, passes, surfacePixels, faultPixels, restoredPixel, recoveredPixels,
    clipW, mixedWNumericSamples, mixedWOverlap, clippedAway,
    complexSamples, minimumTextureFootprint, frequencyDiagnostic,
    reconstructedUnlitSamples: unlitChecked.length, coarseFaultPixels,
    frequencyTimings, frequencyTimestampAvailable, dynamicFrequency, restoredFrequency,
    oddExtentFrequency, oddUnlit,
    lightCount: scene.lights.elements.length, frameCount: renderer.frame_count,
    geometry: geometryBeforeLoss, gpuErrors: [...scoped.errors, ...recovered.errors],
    recoveredDevice: renderer.device !== lostDevice
  });
  status.textContent = "passed";
  controller.transition("draining");
  controller.pass();
} catch (error) {
  controller.fail(error instanceof Error ? error.stack ?? error.message : String(error));
}
