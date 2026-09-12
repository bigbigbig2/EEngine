import {
  BoxGeometry,
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
let resizeObserver: ResizeObserver | undefined;
let animationFrame = 0;
let disposed = false;

async function start(): Promise<void> {
  if (navigator.gpu === undefined) {
    throw new Error("WebGPU is unavailable. Open this page on localhost in a WebGPU-capable browser.");
  }

  const context = canvas.getContext("webgpu");
  if (context === null) throw new Error("Failed to create a WebGPU canvas context");

  renderer = new Renderer({
    debug: false,
    renderSettings: {
      features: {
        shadows: false,
        screenSpaceDiffuseMode: "off",
        screenSpaceReflections: false,
        temporalAntiAliasing: false,
        bloom: false,
        automaticExposure: false,
        motionBlur: false,
        sharpening: false
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
  const recipe = createGeometryCookRecipe();
  const cubeAsset = await cookGeometryAssetPackage(
    buildBoxSourceGeometry(1.5, 1.5, 1.5),
    recipe
  );

  const cubeMaterial = new StandardShadeMaterial();
  cubeMaterial.is_unlit = true;
  cubeMaterial.diffuse_color.set(0.12, 0.52, 0.92, 1);

  const cube = Mesh.from(cubeGeometry, cubeMaterial);
  cube.name = "Unlit Cube";
  scene.add(cube);

  await renderer.uploadScene(scene, [
    { geometry: cubeGeometry, asset: cubeAsset.asset }
  ]);

  const camera = new PerspectiveCamera();
  camera.near = 0.05;
  camera.transform.position.set(0, 0, 4);
  controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0, 0);
  controls.minDistance = 2;
  controls.maxDistance = 12;
  controls.enableDamping = true;
  controls.update(0);

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
  const frame = (time: number): void => {
    if (disposed || renderer === undefined || controls === undefined) return;
    const deltaSeconds = Math.min(0.1, Math.max(0, time - previousTime) / 1000);
    previousTime = time;

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
  if (rendererReady) renderer?.destroy();
}

window.addEventListener("pagehide", dispose, { once: true });

start().catch((error: unknown) => {
  console.error(error);
  status.dataset.state = "error";
  status.textContent = error instanceof Error ? error.message : String(error);
});
