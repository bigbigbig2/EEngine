import {
  Renderer, PerspectiveCamera, Scene, StandardShadeMaterial,
  VirtualGeometryResidency, DirectionalLight
} from "../../../../OEngine/src/index.ts";
import { encodeAssetRecordsV3, encodeGeometryProductPageRecordsV1, encodeVertexFormatsV3, type GeometryProductDescriptorV1, type GeometryProductRevisionSourceV1 } from "../../../../OEngine/src/assets/geometry-product/GeometryProductV1.ts";
import { createValidationController } from "../../host/protocol.ts";
import { attachGpuErrorCollection, withGpuErrorScopes } from "../../host/webgpu.ts";

const canvas = document.querySelector<HTMLCanvasElement>("#output")!;
const status = document.querySelector<HTMLElement>("#status")!;
let renderer: Renderer | undefined;
let residency: VirtualGeometryResidency | undefined;
let source: GeometryProductRevisionSourceV1 | undefined;
let intentionalDestroy = false;
let collector: ReturnType<typeof attachGpuErrorCollection> | undefined;

const controller = createValidationController({
  caseId: "virtual-product-production",
  workloadId: "virtual-product-production-correctness-v1"
}, async () => {
  intentionalDestroy = true;
  renderer?.destroy();
  residency?.destroy();
  source?.release();
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

/** A two-page Product cut: page zero is the bootstrap, page one is a deliberate missing-page demand target. */
async function createProductSource(): Promise<GeometryProductRevisionSourceV1> {
  const page = new Uint8Array(262144);
  const view = new DataView(page.buffer);
  writeF32(view, 0, [0, 0, 0, 1]);
  writeF32(view, 16, [-0.8, -0.8, -0.1]);
  writeF32(view, 28, [0.8, 0.8, 0.1]);
  view.setFloat32(40, 100, true);
  view.setUint16(44, 1, true);
  view.setUint8(46, 0);
  view.setUint8(47, 0);
  view.setUint32(48, 64, true);
  view.setUint32(52, 112, true);
  view.setUint32(56, 128, true);
  view.setUint32(60, 152, true);
  view.setUint16(64, 3, true);
  view.setUint16(66, 1, true);
  view.setUint32(68, 128, true);
  view.setUint32(72, 112, true);
  view.setUint32(76, 0xffffffff, true);
  view.setUint32(80, 0, true);
  view.setUint32(84, 1, true);
  writeF32(view, 88, [-0.8, -0.8, -0.1]);
  writeF32(view, 100, [0.8, 0.8, 0.1]);
  page.set([0, 1, 2], 112);
  const positions: readonly (readonly [number, number, number])[] = [
    [-0.8, -0.8, 0], [0.8, -0.8, 0], [0, 0.8, 0]
  ];
  positions.forEach((position, index) => {
    const at = 128 + index * 8;
    const q = position.map((value, axis) => {
      const minimum = [-0.8, -0.8, -0.1][axis]!;
      const maximum = [0.8, 0.8, 0.1][axis]!;
      return Math.round((value - minimum) * 65535 / (maximum - minimum));
    });
    view.setUint16(at, q[0]!, true); view.setUint16(at + 2, q[1]!, true); view.setUint16(at + 4, q[2]!, true);
  });
  const pages = [page, page.slice()];
  const hashes = await Promise.all(pages.map(async (value) => new Uint8Array(await crypto.subtle.digest("SHA-256", value))));
  const descriptor: GeometryProductDescriptorV1 = Object.freeze({
    schemaVersion: 1,
    productId: new Uint8Array(32).fill(0x41),
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
      assetId: "4141414141414141414141414141414141414141414141414141414141414141",
      boundsSphere: [0, 0, 0, 1], boundsMin: [-0.8, -0.8, -0.1], boundsMax: [0.8, 0.8, 0.1],
      rootNodeBegin: 0, rootNodeCount: 1, hierarchyBegin: 0, hierarchyCount: 3,
      groupBegin: 0, groupCount: 2, bootstrapPageBegin: 0, bootstrapPageCount: 1,
      sourceTriangleCount: 2, leafMeshletCount: 2, totalMeshletCount: 2, flags: 0
    }]),
    rootNodeIds: new Uint32Array([0]),
  hierarchyNodes: (() => { const bytes = new Uint8Array(48 * 3), node = new DataView(bytes.buffer); for (const at of [0, 48, 96]) { writeF32(node, at, [0, 0, 0, 1]); writeF32(node, at + 16, [-0.8, -0.8, -0.1]); writeF32(node, at + 28, [0.8, 0.8, 0.1]); node.setFloat32(at + 40, 100, true); } node.setUint32(44, (2 << 28) | (1 << 1), true); node.setUint32(48 + 44, 1, true); node.setUint32(96 + 44, 3, true); return bytes; })(),
    groupDirectory: (() => { const bytes = new Uint8Array(32), group = new DataView(bytes.buffer); group.setUint32(0, 0, true); group.setUint32(4, 0, true); group.setUint32(8, 152, true); group.setUint32(12, 1, true); group.setUint32(16, 1, true); group.setUint32(20, 0, true); group.setUint32(24, 152, true); return bytes; })(),
    pageRecords: encodeGeometryProductPageRecordsV1([{ decodedHash128: hashes[0]!.subarray(0, 16), firstGroup: 0, groupCount: 1, flags: 0, reserved: 0 }, { decodedHash128: hashes[1]!.subarray(0, 16), firstGroup: 1, groupCount: 1, flags: 0, reserved: 0 }]),
    bootstrapPageIds: new Uint32Array([0]),
    vertexFormats: encodeVertexFormatsV3([{ strideBytes: 8, attributeMask: 3, positionOffset: 0, normalOffset: 0, tangentOffset: 0xff, uv0Offset: 0xff, uv1Offset: 0xff, colorOffset: 0xff }]),
    activationPageIds: new Uint32Array([0])
  });
  let released = false;
  return Object.freeze({
    descriptor,
    async readPage(pageId: number, signal?: AbortSignal) {
      if (released) throw new Error("Product source has been released");
      if (signal?.aborted) throw signal.reason ?? new Error("Product page read cancelled");
      if (pageId !== 0 && pageId !== 1) throw new RangeError("Product fixture contains two pages");
      return Object.freeze({ productId: descriptor.productId.slice(), revision: descriptor.revision, pageId, decodedHash128: hashes[pageId]!.subarray(0, 16).slice(), bytes: pages[pageId]!.slice().buffer });
    },
    release() { released = true; }
  });
}

try {
  controller.transition("negotiating");
  requireValue(navigator.gpu && window.isSecureContext, "WebGPU secure context unavailable");
  renderer = new Renderer({ debug: false, requiredLimits: { maxStorageBuffersPerShaderStage: 16 }, renderSettings: { features: { shadows: false, screenSpaceDiffuseMode: "off", screenSpaceReflections: false, temporalAntiAliasing: false, bloom: false, automaticExposure: false, motionBlur: false, sharpening: false } } });
  const context = canvas.getContext("webgpu"); requireValue(context, "WebGPU canvas context unavailable");
  const configure = context.configure.bind(context); Object.defineProperty(context, "configure", { configurable: true, value: (config: GPUCanvasConfiguration) => configure({ ...config, usage: (config.usage ?? GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.COPY_SRC }) });
  await renderer.initialize({ context, pixelRatio: 1 });
  // Product traversal and shading bind four fixed page banks. The renderer
  // configuration above is the explicit S1 capability gate for that ABI.
  collector = attachGpuErrorCollection(renderer.device, controller, () => intentionalDestroy);
  renderer.profiler.configure({ enabled: true, warmupFrames: 0, gpuSampleInterval: 1, gpuCounterSampleInterval: 1, historyCapacity: 32 });
  renderer.profiler.setMode("deep-capture"); renderer.resize(1280, 720);
  const scene = new Scene(); const material = new StandardShadeMaterial(); material.is_unlit = false; material.diffuse_color.set(0.12, 0.52, 0.92, 1); material.emissive_factor.set(0.12, 0.52, 0.92);
  const light = new DirectionalLight(); light.intensity = 3; scene.add(light);
  source = await createProductSource();
  residency = await VirtualGeometryResidency.create(renderer.device, source, 17, 0);
  residency.activatePublication();
  const openedDescriptor = residency.descriptor;
  const geometryProfiles = [{ hasAuthoredVertexColor: false, hasUv0: false, hasUv1: false, hasUv2: false, hasNormal: true, hasTangent: false }] as const;
  await renderer.uploadVirtualGeometryScene(scene, { materials: [material], geometryProfiles, assetCount: 1, hierarchyMaxDepth: 2, hierarchyTraversalCapacity: 8, hierarchyVisibleClusterCapacity: 8, hierarchyRasterWorkCapacity: 8, count: 1, geometryIndices: new Uint32Array([0]), materialIndices: new Uint32Array([0]), currentTransforms: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), boundsSpheres: new Float32Array([0, 0, 0, 1]) }, residency);
  requireValue(openedDescriptor.activationPageIds.length === 1 && residency.evidence().residentPages === 1, "Product activation cut was not resident");
  const camera = new PerspectiveCamera(); camera.near = 0.05; camera.aspect = 1280 / 720; camera.transform.position.set(0, 0, 4); camera.transform.lookAt({ x: 0, y: 0, z: 0 }); camera.update();
  controller.transition("ready"); controller.transition("warming");
  for (let attempt = 0; attempt < 120 && !renderer.render(camera, scene, 1 / 60); attempt++) await nextFrame();
  controller.transition("sampling");
  const capture = renderer.requestLinearHdrCapture({ x: 636, y: 356, width: 8, height: 8, stage: "lighting" });
  for (let attempt = 0; attempt < 120 && !renderer.render(camera, scene, 1 / 60); attempt++) await nextFrame();
  const scoped = await withGpuErrorScopes(renderer.device, "Product production frame", async () => capture);
  const result = await scoped.value; let maximumError = 0; for (let i = 0; i < result.rgba.length; i++) maximumError = Math.max(maximumError, Math.abs(result.rgba[i]! - [0.12, 0.52, 0.92, 1][i % 4]!));
  const evidence = { residency: residency.evidence(), publication: renderer.sparseShadingPublicationEvidence(), frame: renderer.profiler.latest, graph: renderer.mainFrameGraphEvidence(), gpuErrors: scoped.errors };
  const counters = (evidence.frame as { gpuCounters?: { values?: Record<string, number> } } | null)?.gpuCounters?.values ?? {};
  const demandFrameBytes = ((evidence.frame as { uploads?: { labels?: Record<string, number> } } | null)?.uploads?.labels?.["HierarchicalWorkGenerator/demand-frame"] ?? 0);
  controller.addEvidence("readback", { expected: [0.12, 0.52, 0.92, 1], rgba: [...result.rgba], maximumError, evidence });
  controller.addEvidence("demandFallback", {
    bootstrapResidentPages: evidence.residency.residentPages,
    missingPageId: 1,
    demandFrameBytes,
    hierarchyNodesTested: counters["geometryNodesTested"] ?? 0,
    clustersAccepted: counters["geometryClustersAccepted"] ?? 0,
    traversalQueueReservations: counters["traversalQueueReservations"] ?? 0,
    invalidVisibilityKeys: counters["invalidVisibilityKeys"] ?? 0,
    queueOverflowMask: counters["queueOverflowMask"] ?? 0
  });
  requireValue(maximumError <= 0.01, `Product raster HDR mismatch (${maximumError})`);
  requireValue(evidence.residency.residentPages === 1 && evidence.residency.uploadedBytes === 262144, "Product residency evidence is incomplete");
  requireValue((evidence.publication.activePublicationRevision ?? 0) > 0, "Product shading publication did not commit");
  requireValue((counters["geometryNodesTested"] ?? 0) >= 3, "GPU hierarchy did not test the root and both Group nodes");
  requireValue((counters["geometryClustersAccepted"] ?? 0) >= 1, "GPU hierarchy did not accept the resident bootstrap Group");
  requireValue(evidence.residency.residentPages === 1 && demandFrameBytes >= 4 && (counters["traversalQueueReservations"] ?? 0) >= 2, "missing page demand/ancestor traversal evidence is incomplete");
  requireValue((counters["geometryQueueBytes"] ?? 0) > 0 && (counters["geometryMeshletWorksProduced"] ?? 0) > 0, "GPU meshlet work producer evidence is incomplete");
  requireValue((counters["invalidVisibilityKeys"] ?? 0) === 0, "GPU emitted an invalid primitive VisibilityKey");
  requireValue((counters["queueOverflowMask"] ?? 0) === 0 && (counters["meshletQueueOverflow"] ?? 0) === 0, "bounded GPU queue overflowed unexpectedly");
  requireValue(scoped.errors.length === 0, JSON.stringify(scoped.errors));
  status.textContent = "passed"; controller.transition("draining"); await renderer.device.queue.onSubmittedWorkDone(); controller.pass();
} catch (error) { controller.fail(error instanceof Error ? error.stack ?? error.message : String(error)); }
