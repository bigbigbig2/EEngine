import {
  Renderer, PerspectiveCamera, Scene, StandardShadeMaterial,
  VirtualGeometryResidency
} from "../../../OEngine/src/index.ts";
import { encodeAssetRecordsV3, encodeGeometryProductPageRecordsV1, encodeVertexFormatsV3, type GeometryProductDescriptorV1, type GeometryProductRevisionSourceV1 } from "../../../OEngine/src/assets/geometry-product/GeometryProductV1.ts";
import { createValidationController } from "../../harness/browser.ts";
import { attachGpuErrorCollection, withGpuErrorScopes } from "../../harness/browser.ts";

const canvas = document.querySelector<HTMLCanvasElement>("#output")!;
const status = document.querySelector<HTMLElement>("#status")!;
let renderer: Renderer | undefined;
let residency: VirtualGeometryResidency | undefined;
let source: GeometryProductRevisionSourceV1 | undefined;
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
  collector = attachGpuErrorCollection(renderer.device, controller, () => intentionalDestroy);
  renderer.resize(1280, 720);
  const scene = new Scene();
  const material = new StandardShadeMaterial();
  source = await createProductSource();
  residency = await VirtualGeometryResidency.create(renderer.device, source, 17, 0);
  residency.activatePublication();
  const geometryProfiles = [{ hasAuthoredVertexColor: false, hasUv0: false, hasUv1: false, hasUv2: false, hasNormal: true, hasTangent: false }] as const;
  await renderer.uploadVirtualGeometryScene(scene, {
    materials: [material], geometryProfiles, assetCount: 1,
    hierarchyMaxDepth: 2, hierarchyTraversalCapacity: 8,
    hierarchyVisibleClusterCapacity: 8, hierarchyRasterWorkCapacity: 8,
    count: 1, geometryIndices: new Uint32Array([0]),
    materialIndices: new Uint32Array([0]),
    currentTransforms: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    boundsSpheres: new Float32Array([0, 0, 0, 1])
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
    camera.aspect = 640 / 360;
    camera.update();
    requireValue(renderer!.render(camera, scene, 1 / 60), "Renderer did not submit after resize");
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
  requireValue(passes.includes("Surface/finalize ShadingWork indirect"), "GPU ShadingWork indirect finalizer was not encoded");
  requireValue(passes.includes("Surface/consume ShadingWork material diagnostic"), "GPU ShadingWork consumer was not encoded");
  requireValue(passes.includes("Surface/material diagnostic present"), "Current material publication was not presented");
  requireValue(scoped.errors.length === 0, JSON.stringify(scoped.errors));
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
  const recovered = await withGpuErrorScopes(renderer.device, "Phase 1 recovered visibility frame", async () => {
    requireValue(renderer!.render(camera, scene, 1 / 60), "Recovered Renderer did not submit visibility");
    await renderer!.device.queue.onSubmittedWorkDone();
  });
  requireValue(recovered.errors.length === 0, JSON.stringify(recovered.errors));
  requireValue(renderer.mainFrameGraphEvidence()?.dump.passes
    .some(pass => !pass.culled && pass.name.includes("MeshletWork bucket producer")),
    "Recovered Renderer did not consume GPU MeshletWork");
  controller.addEvidence("phase1", {
    emptyPasses, passes, frameCount: renderer.frame_count,
    geometry: geometryBeforeLoss, gpuErrors: [...scoped.errors, ...recovered.errors],
    recoveredDevice: renderer.device !== lostDevice
  });
  status.textContent = "passed";
  controller.transition("draining");
  controller.pass();
} catch (error) {
  controller.fail(error instanceof Error ? error.stack ?? error.message : String(error));
}
