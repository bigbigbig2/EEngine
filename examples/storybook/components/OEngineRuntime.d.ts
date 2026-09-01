/** Minimal Storybook-facing declarations for the runtime bridge in OEngineRuntime.js. */
export interface AdapterIdentity {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
}

export class Renderer {
  readonly aspect_ratio: number;
  readonly adapter_info: AdapterIdentity | null;
  feature_shadows_enabled: boolean;
  feature_ssr_enabled: boolean;
  feature_ssao_enabled: boolean;
  feature_taa_enabled: boolean;
  feature_bloom_enabled: boolean;
  feature_automatic_exposure_enabled: boolean;
  feature_motion_blur_enabled: boolean;
  feature_sharpening_enabled: boolean;
  initialize(options: {
    readonly context: GPUCanvasContext;
    readonly pixelRatio?: number;
  }): Promise<void>;
  resize(width: number, height: number): void;
  render(camera: PerspectiveCamera, scene: Scene, deltaSeconds: number): boolean;
  destroy(): void;
}

export class Scene {
  readonly lights: { environment: ShadeTexture | undefined };
  add(node: unknown): void;
}

export class PerspectiveCamera {
  aspect: number;
  near: number;
  readonly transform: {
    readonly position: {
      readonly x: number;
      readonly y: number;
      readonly z: number;
      set(x: number, y: number, z: number): void;
    };
    lookAt(target: { readonly x: number; readonly y: number; readonly z: number }): void;
  };
  update(): void;
}

export class BoxGeometry {
  constructor(width?: number, height?: number, depth?: number);
}

export class StandardShadeMaterial {
  readonly diffuse_color: { set(red: number, green: number, blue: number, alpha: number): void };
  roughness_factor: number;
  metallic_factor: number;
}

export class Mesh {
  position: [number, number, number];
  static from(geometry: BoxGeometry, material: StandardShadeMaterial): Mesh;
  updateMatrices(): void;
}

export class DirectionalLight {
  intensity: number;
  casts_shadow: boolean;
  forward: [number, number, number];
}

export class OrbitalCameraController {
  readonly pointer: { stop(): void };
  readonly keyboard: { stop(): void };
  readonly distanceLimits: { min: number; max: number };
  constructor(camera: PerspectiveCamera, element: HTMLElement);
  look(
    from: { readonly x: number; readonly y: number; readonly z: number },
    to: { readonly x: number; readonly y: number; readonly z: number }
  ): void;
  update(): void;
}

export const ShadeDataType: {
  readonly Float16: "float16";
};

export class ShadeImage {
  color_space: number;
  static fromArrayBuffer(
    buffer: ArrayBuffer,
    channels: number,
    dataType: string,
    width: number,
    height: number,
    depth: number
  ): ShadeImage;
}

export class ShadeTexture {
  static from(image: ShadeImage): ShadeTexture;
}
