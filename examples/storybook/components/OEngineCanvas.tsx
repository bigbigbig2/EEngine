import React, { useEffect, useRef, useState, type ReactNode } from "react";
import {
  BoxGeometry,
  DirectionalLight,
  Mesh,
  OrbitControls,
  PerspectiveCamera,
  Renderer,
  Scene,
  ShadeDataType,
  ShadeImage,
  ShadeTexture,
  StandardShadeMaterial
} from "./OEngineRuntime.js";

export type BasicSceneMode = "empty" | "box" | "grid";

export interface OEngineCanvasProps {
  readonly mode: BasicSceneMode;
  readonly color: string;
  readonly interactiveCamera: boolean;
}

type CanvasState = "initializing" | "ready" | "unsupported" | "error";

export function OEngineCanvas({ mode, color, interactiveCamera }: OEngineCanvasProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<CanvasState>("initializing");
  const [detail, setDetail] = useState("Initializing the WebGPU renderer…");

  useEffect(() => {
    const canvasElement = canvasRef.current;
    if (canvasElement === null) return;
    const targetCanvas: HTMLCanvasElement = canvasElement;

    let disposed = false;
    let initialized = false;
    let animationFrame = 0;
    let resizeObserver: ResizeObserver | null = null;
    let renderer: Renderer | null = null;
    let controller: OrbitControls | null = null;
    let context: GPUCanvasContext | null = null;

    setState("initializing");
    setDetail("Initializing the WebGPU renderer…");

    void initialize().catch((error: unknown) => {
      if (disposed) return;
      const message = error instanceof Error ? error.message : String(error);
      setState(message.includes("WebGPU") || message.includes("navigator.gpu") ? "unsupported" : "error");
      setDetail(message);
      console.error(error);
    });

    async function initialize(): Promise<void> {
      if (!("gpu" in navigator)) {
        throw new Error("WebGPU is not available in this browser.");
      }
      context = targetCanvas.getContext("webgpu");
      if (context === null) {
        throw new Error("Unable to create a WebGPU canvas context.");
      }

      renderer = new Renderer();
      await renderer.initialize({ context, pixelRatio: Math.min(window.devicePixelRatio, 2) });
      initialized = true;
      configureBasicPipeline(renderer);

      if (disposed) {
        releaseRenderer();
        return;
      }
      const scene = createBasicScene(mode, color);
      const camera = createCamera(renderer.aspect_ratio, mode);
      if (interactiveCamera) {
        controller = new OrbitControls(camera, targetCanvas);
        controller.look(camera.transform.position, { x: 0, y: 0, z: 0 });
        controller.distanceLimits.min = 2;
        controller.distanceLimits.max = 36;
      }

      resizeObserver = new ResizeObserver(() => {
        if (renderer === null || disposed) return;
        const width = Math.max(1, Math.round(targetCanvas.clientWidth));
        const height = Math.max(1, Math.round(targetCanvas.clientHeight));
        renderer.resize(width, height);
        camera.aspect = renderer.aspect_ratio;
        camera.update();
      });
      resizeObserver.observe(targetCanvas);

      let previousTime = performance.now();
      let presentedFrame = false;
      const frame = (now: number): void => {
        if (disposed || renderer === null) return;
        try {
          const deltaSeconds = Math.min(0.1, Math.max(0, (now - previousTime) / 1000));
          previousTime = now;
          controller?.update();
          camera.aspect = renderer.aspect_ratio;
          camera.update();
          if (!renderer.render(camera, scene, deltaSeconds)) {
            setState("error");
            setDetail("The GPU device was lost and the render loop stopped.");
            return;
          }
          if (!presentedFrame) {
            presentedFrame = true;
            setState("ready");
          }
          animationFrame = requestAnimationFrame(frame);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          setState("error");
          setDetail(message);
          console.error(error);
        }
      };
      animationFrame = requestAnimationFrame(frame);
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      controller?.pointer.stop();
      controller?.keyboard.stop();
      releaseRenderer();
    };

    function releaseRenderer(): void {
      if (initialized && renderer !== null) {
        initialized = false;
        renderer.destroy();
      }
      context?.unconfigure();
    }
  }, [mode, color, interactiveCamera]);

  return (
    <div
      className="oe-runtime-preview"
      data-render-state={state}
      aria-busy={state === "initializing"}
    >
      <canvas ref={canvasRef} width="960" height="540" aria-label="OEngine WebGPU rendered scene" />
      {(state === "unsupported" || state === "error") && (
        <div className="oe-runtime-error" role="alert">
          <strong>{state === "unsupported" ? "WebGPU unavailable" : "Unable to render"}</strong>
          <span>{detail}</span>
        </div>
      )}
    </div>
  );
}

function createBasicScene(mode: BasicSceneMode, color: string): Scene {
  const scene = new Scene();
  scene.lights.environment = createEnvironmentTexture();
  if (mode !== "empty") {
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new StandardShadeMaterial();
    const [red, green, blue] = parseHexColor(color);
    material.diffuse_color.set(red, green, blue, 1);
    material.roughness_factor = 0.68;
    material.metallic_factor = 0.06;
    const gridSize = mode === "grid" ? 7 : 1;
    const center = (gridSize - 1) * 0.5;
    for (let z = 0; z < gridSize; z++) {
      for (let x = 0; x < gridSize; x++) {
        const mesh = Mesh.from(geometry, material);
        mesh.position = [(x - center) * 1.45, Math.sin((x + z) * 0.8) * 0.18, (z - center) * 1.45];
        mesh.updateMatrices();
        scene.add(mesh);
      }
    }
  }

  const sun = new DirectionalLight();
  sun.intensity = 4;
  sun.casts_shadow = false;
  sun.forward = [0.45, -1, -0.35];
  scene.add(sun);
  return scene;
}

function createCamera(aspect: number, mode: BasicSceneMode): PerspectiveCamera {
  const camera = new PerspectiveCamera();
  camera.aspect = aspect;
  camera.near = 0.1;
  camera.transform.position.set(0, mode === "grid" ? 7.5 : 2.8, mode === "grid" ? 12 : 5.5);
  camera.transform.lookAt({ x: 0, y: 0, z: 0 });
  camera.update();
  return camera;
}

function configureBasicPipeline(renderer: Renderer): void {
  renderer.configure({ features: {
    shadows: false, screenSpaceReflections: false, ambientOcclusion: false,
    temporalAntiAliasing: false, bloom: false, automaticExposure: false,
    motionBlur: false, sharpening: false
  } });
}

function createEnvironmentTexture(): ShadeTexture {
  const halfFloatRgba = new Uint16Array([0x2a66, 0x2e66, 0x3266, 0x3c00]);
  const image = ShadeImage.fromArrayBuffer(
    halfFloatRgba.buffer,
    4,
    ShadeDataType.Float16,
    1,
    1,
    1
  );
  image.color_space = 2;
  return ShadeTexture.from(image);
}

function parseHexColor(color: string): [number, number, number] {
  const value = /^#[0-9a-f]{6}$/i.test(color) ? color.slice(1) : "4287f5";
  return [
    Number.parseInt(value.slice(0, 2), 16) / 255,
    Number.parseInt(value.slice(2, 4), 16) / 255,
    Number.parseInt(value.slice(4, 6), 16) / 255
  ];
}
