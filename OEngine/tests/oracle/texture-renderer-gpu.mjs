import { Renderer } from "../../.test-dist/render/pipeline/RendererCore.js";
import { Scene } from "../../.test-dist/scene/Scene.js";
import { PerspectiveCamera } from "../../.test-dist/camera/PerspectiveCamera.js";
import { load_gltf } from "../../.test-dist/loaders/load_gltf.js";
import { createDefaultWebCookWorker } from "../../.test-dist/assets/web-cook/WebCookWorkerFactory.js";

const check = (value, message) => {
  if (!value) throw new Error(message);
};
const distribution = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
    n: sorted.length,
  };
};

export async function runTextureRendererGpuOracle() {
  const url = "/examples/assets/three/rendering-lab/dungeon_warkarma.glb";
  const bytes = await (await fetch(url)).arrayBuffer();
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  check(
    hash === "cac0fc8c16d107e7ac4e69efde89c2cb6ef4bc66c34456a4dd0923218e5aafb1",
    "Dungeon identity changed",
  );
  const renderer = new Renderer({ autoExposure: false, fixedExposure: 1 });
  const canvas = new OffscreenCanvas(1920, 1080);
  const scene = new Scene();
  const errors = [];
  let asset;
  try {
    await renderer.initialize({ context: canvas.getContext("webgpu") });
    renderer.resize(1920, 1080);
    renderer.device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    const worker = createDefaultWebCookWorker({
      maxCanonicalInputBytes: 128 * 1024 * 1024,
      maxDecodedProductBytes: 256 * 1024 * 1024,
      createWorker: (url) => new Worker(new URL(url.href.replace(/\.ts$/, ".js")), { type: "module" }),
    });
    asset = load_gltf(`${location.origin}${url}`, {
      worker,
      bootstrap: { unitCount: 1024, maxSourceBytes: 128 * 1024 * 1024 },
    });
    const start = performance.now();
    const handles = await renderer.uploadWebCookedMultiProductScene(scene, asset, {
      fitHeight: 8,
      fitBase: [0, 0, 0],
      residency: { configuredCapacityBytes: 512 * 1024 * 1024 },
    });
    await handles.settled();
    const uploadWallMs = performance.now() - start;
    check(
      asset.catalog.primitives.length === 798 && asset.catalog.images.length === 25,
      "Full dungeon catalog missing",
    );
    const runtime = renderer.graphics.render_world.runtime(scene);
    const expectedInstances = asset.catalog.primitives.reduce(
      (sum, item) => sum + item.instanceNodeIndices.length,
      0,
    );
    check(
      runtime.instanceCount === expectedInstances && runtime.materials.length === 25,
      `Full dungeon publication missing: ${runtime.instanceCount}/${expectedInstances} instances, ${runtime.materials.length}/25 materials`,
    );
    const camera = new PerspectiveCamera();
    camera.aspect = 1920 / 1080;
    camera.fov_degrees = 60;
    camera.near = 0.05;
    camera.transform.position.set(10, 7, 12);
    camera.transform.lookAt({ x: 0, y: 3, z: 0 });
    camera.update();
    const cpu = [];
    for (let i = 0; i < 50; i++) {
      const frameStart = performance.now();
      renderer.render(camera, scene, 1 / 60);
      if (i >= 20) cpu.push(performance.now() - frameStart);
      await renderer.device.queue.onSubmittedWorkDone();
    }
    const ledger = renderer.graphics.texture_residency.evidence();
    check(ledger.residentTextureCount === 25, "Full texture catalog missing");
    await renderer.releasePackedScene(scene);
    await renderer.device.queue.onSubmittedWorkDone();
    await Promise.resolve();
    const afterRelease = renderer.graphics.texture_residency.evidence();
    check(
      afterRelease.residentTextureCount === 0 && afterRelease.retiringTextureCount === 0,
      "Residency did not retire",
    );
    check(errors.length === 0, errors.join("\n"));
    return {
      scope: "Full authored dungeon Renderer baseline; not T4.3 acceptance",
      sourceHash: hash,
      sourceBytes: bytes.byteLength,
      resolution: [1920, 1080],
      renderScale: 1,
      camera: [10, 7, 12, 0, 3, 0],
      uploadWallMs,
      cpu: distribution(cpu),
      ledger,
      afterRelease,
      errors,
    };
  } finally {
    if (asset) asset.dispose();
    renderer.destroy();
  }
}
