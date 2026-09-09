import {
  DirectionalLight,
  PerspectiveCamera,
  Renderer,
  Scene,
  type FrameProfileSnapshot,
  type PackedSceneSource
} from "../../../OEngine/src/index.ts";
import { settleRendererForValidationDestroy } from "./runtime-evidence.ts";

export interface CanonicalRuntimeCameraPose {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly near?: number;
  readonly far?: number;
}

export interface CanonicalRuntimeOptions {
  readonly canvas: HTMLCanvasElement;
  readonly camera: CanonicalRuntimeCameraPose;
  readonly source: () => Promise<PackedSceneSource>;
  readonly onDeviceLost: (message: string) => void;
  readonly shadows?: boolean;
}

/** Fixture-owned Renderer/Scene/Camera/RAF runtime shared by canonical cases. */
export class CanonicalPackedRuntime {
  renderer: Renderer | null = null;
  scene: Scene | null = null;
  camera: PerspectiveCamera | null = null;
  private frameRequest = 0;
  private running = false;

  constructor(private readonly options: CanonicalRuntimeOptions) {}

  get frame(): number {
    return this.renderer?.frame_count ?? 0;
  }

  async initialize(): Promise<void> {
    if (this.renderer !== null) throw new Error("Canonical runtime is already initialized");
    if (navigator.gpu === undefined) throw new Error("WebGPU is unavailable in this browser");
    const context = this.options.canvas.getContext("webgpu");
    if (context === null) throw new Error("Unable to create a WebGPU canvas context");

    const renderer = new Renderer();
    await renderer.initialize({ context, pixelRatio: 1 });
    renderer.configure({
      features: {
        shadows: this.options.shadows ?? false,
        ambientOcclusion: false,
        screenSpaceReflections: false,
        temporalAntiAliasing: false,
        bloom: false,
        automaticExposure: false,
        motionBlur: false,
        sharpening: false
      }
    });
    renderer.profiler.configure({
      enabled: true,
      gpuCounterSampleInterval: 1,
      readbackRingSlots: 8
    });
    renderer.profiler.setMode("deep-capture");

    const scene = new Scene();
    addLight(scene, this.options.shadows ?? false);
    await renderer.uploadPackedScene(scene, await this.options.source());

    const camera = new PerspectiveCamera();
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.setCamera(this.options.camera);
    this.resize(this.options.canvas.clientWidth, this.options.canvas.clientHeight);
    this.start();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const renderFrame = (): void => {
      if (!this.running || this.renderer === null || this.scene === null || this.camera === null) return;
      this.camera.aspect = this.renderer.aspect_ratio;
      this.camera.update();
      if (!this.renderer.render(this.camera, this.scene, 1 / 60)) {
        this.running = false;
        this.options.onDeviceLost("Renderer stopped after GPU device loss");
        return;
      }
      this.frameRequest = requestAnimationFrame(renderFrame);
    };
    this.frameRequest = requestAnimationFrame(renderFrame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frameRequest);
    this.frameRequest = 0;
  }

  resize(width: number, height: number): void {
    if (this.renderer === null || this.camera === null) return;
    this.renderer.resize(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
    this.camera.aspect = this.renderer.aspect_ratio;
    this.camera.update();
  }

  setCamera(pose: CanonicalRuntimeCameraPose): void {
    if (this.camera === null) throw new Error("Canonical runtime camera is not initialized");
    this.camera.near = pose.near ?? 0.01;
    this.camera.far = pose.far ?? 200;
    this.camera.transform.position.set(...pose.position);
    this.camera.transform.lookAt({ x: pose.target[0], y: pose.target[1], z: pose.target[2] });
    this.camera.update();
  }

  async replaceScene(source: PackedSceneSource): Promise<void> {
    if (this.renderer === null || this.scene === null) throw new Error("Canonical runtime is not initialized");
    const resume = this.running;
    this.stop();
    const previous = this.scene;
    await this.renderer.releasePackedScene(previous);
    const replacement = new Scene();
    addLight(replacement, this.options.shadows ?? false);
    await this.renderer.uploadPackedScene(replacement, source);
    this.scene = replacement;
    if (resume) this.start();
  }

  async releaseAndReregister(source: PackedSceneSource): Promise<void> {
    if (this.renderer === null || this.scene === null) throw new Error("Canonical runtime is not initialized");
    const resume = this.running;
    this.stop();
    await this.renderer.releasePackedScene(this.scene);
    await this.renderer.uploadPackedScene(this.scene, source);
    if (resume) this.start();
  }

  async recreate(): Promise<void> {
    await this.destroy();
    await this.initialize();
  }

  async destroy(): Promise<void> {
    this.stop();
    const renderer = this.renderer;
    const scene = this.scene;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    if (renderer !== null) {
      if (scene !== null) await renderer.releasePackedScene(scene);
      await settleRendererForValidationDestroy(renderer);
      renderer.destroy();
    }
    this.options.canvas.getContext("webgpu")?.unconfigure();
  }

  waitForFrames(count = 2, timeoutMs = 10_000): Promise<number> {
    const startFrame = this.frame;
    return new Promise((resolve, reject) => {
      const startedAt = performance.now();
      const check = (): void => {
        if (this.frame >= startFrame + count) {
          resolve(this.frame);
          return;
        }
        if (performance.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for ${count} rendered frames after ${startFrame}`));
          return;
        }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
  }

  waitForCounters(afterFrame = this.frame, timeoutMs = 15_000): Promise<FrameProfileSnapshot> {
    const profiler = this.renderer?.profiler;
    if (profiler === undefined) return Promise.reject(new Error("Canonical runtime is not initialized"));
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting for GPU counters after frame ${afterFrame}`));
      }, timeoutMs);
      const unsubscribe = profiler.subscribe((snapshot) => {
        if (
          snapshot.frameIndex <= afterFrame ||
          !snapshot.gpuCounters.sampled ||
          snapshot.gpuCounters.pending ||
          snapshot.gpuCounters.dropped
        ) return;
        clearTimeout(timeout);
        unsubscribe();
        resolve(snapshot);
      });
    });
  }
}

function addLight(scene: Scene, castsShadow: boolean): void {
  const light = new DirectionalLight();
  light.intensity = 2.8;
  light.forward = [-0.45, -0.8, -0.35];
  light.casts_shadow = castsShadow;
  scene.addChild(light);
}
