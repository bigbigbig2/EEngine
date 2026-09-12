import { Pane } from "tweakpane";
import {
  BoxGeometry,
  DirectionalLight,
  Mesh,
  OrbitControls,
  PerspectiveCamera,
  Renderer,
  Scene,
  StandardShadeMaterial,
  buildBoxSourceGeometry,
  cookGeometryAssetPackage,
  createGeometryCookRecipe
} from "../../../../OEngine/src/index.ts";

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`Basic Scene requires ${selector}`);
  return element;
}

const canvas = requireElement<HTMLCanvasElement>("#viewport");
const status = requireElement<HTMLDivElement>("#status");

let renderer: Renderer | undefined;
let rendererReady = false;
let controls: OrbitControls | undefined;
let pane: Pane | undefined;
let resizeObserver: ResizeObserver | undefined;
let animationFrame = 0;
let disposed = false;

const settings = {
  rotate: true,
  rotationSpeed: 0.35,
  renderScale: 1,
  bloom: true,
  exposure: 1,
  fov: 45
};

async function start(): Promise<void> {
  if (navigator.gpu === undefined) {
    throw new Error("WebGPU is unavailable. Open this page on localhost in a WebGPU-capable browser.");
  }

  const context = canvas.getContext("webgpu");
  if (context === null) throw new Error("Failed to create a WebGPU canvas context");

  renderer = new Renderer({
    renderSettings: {
      features: {
        shadows: true,
        screenSpaceDiffuseMode: "gtao",
        screenSpaceReflections: false,
        temporalAntiAliasing: true,
        bloom: true,
        automaticExposure: true,
        motionBlur: false,
        sharpening: true
      }
    }
  });
  await renderer.initialize({
    context,
    pixelRatio: window.devicePixelRatio
  });
  rendererReady = true;

  const scene = new Scene();
  const cubeGeometry = new BoxGeometry(1.5, 1.5, 1.5);
  const groundGeometry = new BoxGeometry(8, 0.2, 8);
  const recipe = createGeometryCookRecipe();
  const [cubeAsset, groundAsset] = await Promise.all([
    cookGeometryAssetPackage(buildBoxSourceGeometry(1.5, 1.5, 1.5), recipe),
    cookGeometryAssetPackage(buildBoxSourceGeometry(8, 0.2, 8), recipe)
  ]);

  const cubeMaterial = new StandardShadeMaterial();
  cubeMaterial.diffuse_color.set(0.12, 0.42, 0.92, 1);
  cubeMaterial.metallic_factor = 0.25;
  cubeMaterial.roughness_factor = 0.28;

  const groundMaterial = new StandardShadeMaterial();
  groundMaterial.diffuse_color.set(0.32, 0.36, 0.42, 1);
  groundMaterial.metallic_factor = 0;
  groundMaterial.roughness_factor = 0.8;

  const cube = Mesh.from(cubeGeometry, cubeMaterial);
  cube.name = "Blue PBR Cube";
  cube.position = [0, 0.8, 0];

  const ground = Mesh.from(groundGeometry, groundMaterial);
  ground.name = "Ground";
  ground.position = [0, -0.1, 0];

  const sun = new DirectionalLight();
  sun.name = "Key Light";
  sun.intensity = 5;
  sun.color.set(1, 0.92, 0.8);
  sun.forward = [-0.55, -1, -0.35];
  scene.add([cube, ground, sun]);

  await renderer.uploadScene(scene, [
    { geometry: cubeGeometry, asset: cubeAsset.asset },
    { geometry: groundGeometry, asset: groundAsset.asset }
  ]);

  const camera = new PerspectiveCamera();
  camera.near = 0.05;
  camera.transform.position.set(4.5, 3.2, 6.2);
  controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0.65, 0);
  controls.minDistance = 2.5;
  controls.maxDistance = 18;
  controls.enableDamping = true;
  controls.update(0);

  pane = new Pane({ title: "Basic Scene" });
  const rendererFolder = pane.addFolder({ title: "Renderer" });
  rendererFolder.addBinding(settings, "renderScale", {
    label: "Resolution",
    options: { "67%": 0.67, "75%": 0.75, "100%": 1 }
  }).on("change", ({ value }) => {
    renderer?.configure({ resolution: { mode: "fixed", internalScale: value } });
  });
  rendererFolder.addBinding(settings, "bloom", { label: "Bloom" })
    .on("change", ({ value }) => renderer?.configure({ features: { bloom: value } }));
  rendererFolder.addBinding(settings, "exposure", {
    label: "Exposure",
    min: 0.25,
    max: 2.5,
    step: 0.05
  }).on("change", ({ value }) => renderer?.configure({ post: { exposureCompensation: value } }));

  const sceneFolder = pane.addFolder({ title: "Scene" });
  sceneFolder.addBinding(settings, "rotate", { label: "Rotate cube" });
  sceneFolder.addBinding(settings, "rotationSpeed", {
    label: "Speed",
    min: 0,
    max: 1.5,
    step: 0.05
  });

  const cameraFolder = pane.addFolder({ title: "Camera" });
  cameraFolder.addBinding(settings, "fov", {
    label: "FOV",
    min: 25,
    max: 80,
    step: 1
  }).on("change", ({ value }) => {
    camera.fov_degrees = value;
  });

  const resize = (): void => {
    if (renderer === undefined) return;
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    renderer.resize(width, height);
    camera.aspect = width / height;
    camera.update();
  };
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resize();

  status.dataset.state = "ready";
  let previousTime = performance.now();
  let rotation = 0;
  const frame = (time: number): void => {
    if (disposed || renderer === undefined || controls === undefined) return;
    const deltaSeconds = Math.min(0.1, Math.max(0, (time - previousTime) / 1000));
    previousTime = time;

    if (settings.rotate) {
      rotation += deltaSeconds * settings.rotationSpeed;
      cube.transform_local.rotation.set(0, Math.sin(rotation * 0.5), 0, Math.cos(rotation * 0.5));
      cube.updateMatrices();
    }
    controls.update(deltaSeconds);
    renderer.render(camera, scene, deltaSeconds);
    animationFrame = requestAnimationFrame(frame);
  };
  animationFrame = requestAnimationFrame(frame);
}

function dispose(): void {
  if (disposed) return;
  disposed = true;
  cancelAnimationFrame(animationFrame);
  resizeObserver?.disconnect();
  controls?.dispose();
  pane?.dispose();
  if (rendererReady) renderer?.destroy();
}

window.addEventListener("pagehide", dispose, { once: true });

start().catch((error: unknown) => {
  console.error(error);
  status.dataset.state = "error";
  status.textContent = error instanceof Error ? error.message : String(error);
});
