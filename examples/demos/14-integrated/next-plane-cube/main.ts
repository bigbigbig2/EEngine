import {
  BoxGeometry,
  cookSceneGeometryProductV1,
  createDefaultWebGeometryCookerModule,
  Mesh,
  PerspectiveCamera,
  Renderer,
  Scene,
  StandardShadeMaterial
} from "../../../../OEngine/src/index.ts";
import { Attribute } from "../../../../OEngine/src/geometry/Attribute.ts";
import { MeshletGeometryBase } from "../../../../OEngine/src/geometry/BoxGeometry.ts";
import { Geometry } from "../../../../OEngine/src/geometry/Geometry.ts";
import { MeshletAttrName } from "../../../../OEngine/src/geometry/meshletPackedAttrs.ts";
import { niFromGeometry } from "../../../../OEngine/src/geometry/niMeshlets.ts";

const canvas = document.querySelector<HTMLCanvasElement>("#viewport")!;
const status = document.querySelector<HTMLElement>("#status")!;
const renderButton = document.querySelector<HTMLButtonElement>("#render")!;
let renderer: Renderer | undefined;
let disposed = false;

function makePlane(): MeshletGeometryBase {
  const geometry = new Geometry();
  geometry.name = "Ground plane";
  geometry.index = Attribute.from(new Uint32Array([0, 2, 1, 0, 3, 2]), 1, "index");
  geometry.addAttribute(Attribute.from(new Float32Array([
    -3, 0, -3, 3, 0, -3, 3, 0, 3, -3, 0, 3
  ]), 3, MeshletAttrName.Position));
  geometry.addAttribute(Attribute.from(new Float32Array([
    0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0
  ]), 3, MeshletAttrName.Normal));
  geometry.addAttribute(Attribute.from(new Float32Array([
    0, 0, 1, 0, 1, 1, 0, 1
  ]), 2, MeshletAttrName.Uv0));
  return niFromGeometry(geometry, new MeshletGeometryBase());
}

function setStatus(message: string, state = "ready"): void {
  if (disposed) return;
  status.textContent = message;
  status.dataset.state = state;
}

async function start(): Promise<void> {
  if (!navigator.gpu) throw new Error("当前浏览器没有 WebGPU");
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("无法创建 WebGPU 画布");

  renderer = new Renderer({
    enableVsm: false,
    enablePhysicalEnvironment: false,
    surfaceVirtualUnlitFallback: true,
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 }
  });
  renderer.shadowVisibilityEnabled = false;
  renderer.xe_gtao_enabled = false;
  renderer.packed_visibility_hzb_enabled = false;
  renderer.packed_visibility_cone_enabled = false;
  renderer.packed_meshlet_work_compaction = "portable";
  await renderer.initialize({ context });
  if (disposed) return;

  const scene = new Scene();
  const planeMaterial = new StandardShadeMaterial();
  planeMaterial.is_unlit = true;
  planeMaterial.diffuse_color.set(0.24, 0.43, 0.34, 1);
  scene.add(Mesh.from(makePlane(), planeMaterial));

  const cubeMaterial = new StandardShadeMaterial();
  cubeMaterial.is_unlit = true;
  cubeMaterial.diffuse_color.set(0.94, 0.44, 0.23, 1);
  const cube = Mesh.from(new BoxGeometry(1.5, 1.5, 1.5), cubeMaterial);
  cube.position.set(0, 0.75, 0);
  scene.add(cube);

  setStatus("准备几何");
  const module = await createDefaultWebGeometryCookerModule();
  const product = await cookSceneGeometryProductV1(scene, {
    module,
    producerId: "next-plane-cube",
    producerVersion: "1",
    maxDecodedProductBytes: 64 * 1024 * 1024
  });
  await renderer.uploadCookedSceneProduct(scene, product);
  if (disposed) return;

  const camera = new PerspectiveCamera();
  camera.near = 0.05;
  camera.far = 100;
  camera.aspect = 16 / 9;
  camera.transform.position.set(3.4, 2.7, 4.4);
  camera.transform.lookAt({ x: 0, y: 0.5, z: 0 });
  camera.update();
  renderer.resize(640, 360);

  const renderOnce = (): void => {
    if (!renderer || disposed) return;
    renderButton.disabled = true;
    setStatus("提交渲染帧");
    const submitted = renderer.render(camera, scene, 1 / 60);
    if (!submitted) {
      setStatus("本帧未提交", "error");
      return;
    }
    setStatus("GPU 渲染中");
    let completed = false;
    const pendingTimer = window.setTimeout(() => {
      if (!completed) setStatus("GPU 超过 5 秒未完成", "error");
    }, 5000);
    void renderer.graphics.device.queue.onSubmittedWorkDone().then(() => {
      completed = true;
      window.clearTimeout(pendingTimer);
      setStatus("GPU 已完成");
      if (!disposed) renderButton.disabled = false;
    }, error => {
      completed = true;
      window.clearTimeout(pendingTimer);
      setStatus(`GPU 队列失败：${String(error)}`, "error");
    });
  };

  void renderer.graphics.device.lost.then(info => {
    setStatus(`GPU 设备丢失：${info.reason} ${info.message}`, "error");
    renderButton.disabled = true;
  });
  renderButton.addEventListener("click", renderOnce);
  renderButton.disabled = false;
  setStatus("几何已就绪");
}

window.addEventListener("pagehide", () => {
  disposed = true;
  renderer?.destroy();
}, { once: true });

start().catch(error => {
  console.error(error);
  setStatus(error instanceof Error ? error.message : String(error), "error");
});
