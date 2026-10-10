import type { ResourceId } from "../../framegraph/ResourceHandle.js";

/** Finite Surface products. ReflectionGI awaits a real native effect consumer. */
export type NativeSurfaceAuxProfile = "Base" | "Temporal" | "ReflectionGI";

export interface NativeSurfaceAuxAllocation {
  readonly profile: NativeSurfaceAuxProfile;
  readonly width: number;
  readonly height: number;
  readonly opaqueReactive: GPUTexture | null;
  readonly opaqueReactiveView: GPUTextureView | null;
  readonly allocatedBytes: number;
}

function assertProfile(profile: NativeSurfaceAuxProfile): void {
  if (profile === "ReflectionGI") {
    throw new Error("ReflectionGI requires an implemented native effect consumer and precision contract");
  }
  if (profile !== "Base" && profile !== "Temporal") {
    throw new RangeError("Unknown native Surface Aux profile");
  }
}

export function nativeSurfaceAuxLayoutEntries(
  profile: NativeSurfaceAuxProfile,
  startBinding = 8,
): GPUBindGroupLayoutEntry[] {
  assertProfile(profile);
  if (!Number.isSafeInteger(startBinding) || startBinding < 0) {
    throw new RangeError("Invalid native Surface Aux binding");
  }
  if (profile === "Base") {
    return [];
  }
  return [
    {
      binding: startBinding,
      visibility: GPUShaderStage.COMPUTE,
      storageTexture: { access: "write-only", format: "rgba8unorm" },
    },
  ];
}

export function nativeSurfaceAuxEntries(
  allocation: NativeSurfaceAuxAllocation,
  startBinding = 8,
): GPUBindGroupEntry[] {
  nativeSurfaceAuxLayoutEntries(allocation.profile, startBinding);
  if (allocation.opaqueReactiveView === null) {
    return [];
  }
  return [{ binding: startBinding, resource: allocation.opaqueReactiveView }];
}

/**
 * Surface owns only demanded frame-local reactive output, never effect history.
 * Cost: Temporal adds 4 sequential write bytes/pixel (7.91 MiB at 1080p),
 * one storage binding, no sample/atomic/barrier/dispatch. Base adds zero.
 * The opaque winner and background writers must partition the complete extent.
 * Reuse is legal on the frame owner's ordered queue. Resize/abort are candidates;
 * only commit replaces physical ownership, and old textures retire at their fence.
 */
export class NativeSurfaceAuxResources {
  private active: NativeSurfaceAuxAllocation | null = null;
  private prepared: NativeSurfaceAuxAllocation | null = null;
  private lastGpuDone: Promise<void> | null = null;
  private retiredBytes = 0;
  private destroyed = false;

  constructor(private readonly device: GPUDevice) {
    void device.lost.then(() => this.destroy());
  }

  /** Physical live + unsubmitted candidate + fence-retired textures. */
  get allocatedBytes(): number {
    return (
      (this.active?.allocatedBytes ?? 0) +
      this.retiredBytes +
      (this.prepared !== this.active ? (this.prepared?.allocatedBytes ?? 0) : 0)
    );
  }

  prepare(profile: NativeSurfaceAuxProfile, width: number, height: number): NativeSurfaceAuxAllocation {
    if (this.destroyed || this.prepared !== null) {
      throw new Error("Native Surface Aux is unavailable or already prepared");
    }
    assertProfile(profile);
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > this.device.limits.maxTextureDimension2D ||
      height > this.device.limits.maxTextureDimension2D
    ) {
      throw new RangeError("Native Surface Aux extent exceeds negotiated limits");
    }
    if (profile === "Temporal" && this.device.limits.maxStorageTexturesPerShaderStage < 1) {
      throw new RangeError("Native Surface Aux requires one additional storage texture");
    }
    if (this.active?.profile === profile && this.active.width === width && this.active.height === height) {
      this.prepared = this.active;
      return this.prepared;
    }
    let texture: GPUTexture | null = null;
    try {
      if (profile === "Temporal") {
        texture = this.device.createTexture({
          label: "SurfaceV4/opaque reactive",
          size: [width, height],
          format: "rgba8unorm",
          usage:
            GPUTextureUsage.STORAGE_BINDING |
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.RENDER_ATTACHMENT,
        });
      }
      this.prepared = Object.freeze({
        profile,
        width,
        height,
        opaqueReactive: texture,
        opaqueReactiveView: texture?.createView() ?? null,
        allocatedBytes: profile === "Temporal" ? width * height * 4 : 0,
      });
      return this.prepared;
    } catch (error) {
      texture?.destroy();
      throw error;
    }
  }

  commit(gpuDone: Promise<void>): void {
    if (this.prepared === null) {
      throw new Error("Native Surface Aux commit requires a prepared frame");
    }
    if (this.active !== this.prepared) {
      this.retire(this.active, this.lastGpuDone);
      this.active = this.prepared;
    }
    this.prepared = null;
    this.lastGpuDone = gpuDone;
  }

  /** Only for an encoder that was not submitted. A submitted frame must commit. */
  abort(): void {
    if (this.prepared !== this.active) {
      this.prepared?.opaqueReactive?.destroy();
    }
    this.prepared = null;
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.abort();
    this.retire(this.active, this.lastGpuDone);
    this.active = null;
    this.destroyed = true;
  }

  private retire(allocation: NativeSurfaceAuxAllocation | null, fence: Promise<void> | null): void {
    const texture = allocation?.opaqueReactive;
    if (!texture) {
      return;
    }
    if (fence) {
      const bytes = allocation!.allocatedBytes;
      this.retiredBytes += bytes;
      const destroy = () => {
        texture.destroy();
        this.retiredBytes -= bytes;
      };
      void fence.then(destroy, destroy);
    } else {
      texture.destroy();
    }
  }
}

type Clip = readonly [number, number, number, number];

/** Mirrors the native Temporal publication change detector; equal-content
 * slots remain distinct conservatively, never as exact material identity. */
export function nativeSurfaceTemporalMaterialSignature(input: {
  readonly materialHandle: number;
  readonly instanceFlags: number;
  readonly materialSlot: number;
  readonly signature: number;
  readonly valueRevision: number;
}): number {
  let signature = 2166136261;
  for (const word of [
    input.materialHandle,
    input.instanceFlags,
    input.materialSlot,
    input.signature,
    input.valueRevision,
  ]) {
    if (!Number.isInteger(word) || word < 0 || word > 0xffffffff) {
      throw new RangeError("Native Temporal material words must be u32");
    }
    signature = Math.imul(signature ^ word, 16777619) >>> 0;
  }
  return signature;
}

/** Current-minus-previous UV; both clips include their own frame's jitter. */
export function nativeSurfaceMotion(current: Clip, previous: Clip, historyValid: boolean) {
  const invalid = { motion: [0, 0] as readonly [number, number], valid: false };
  if (
    !historyValid ||
    !current.every(Number.isFinite) ||
    !previous.every(Number.isFinite) ||
    current[3] <= 1e-6 ||
    previous[3] <= 1e-6 ||
    current[2] < 0 ||
    current[2] > current[3] ||
    previous[2] < 0 ||
    previous[2] > previous[3]
  ) {
    return invalid;
  }
  const currentUv = [(current[0] / current[3]) * 0.5 + 0.5, (current[1] / current[3]) * -0.5 + 0.5];
  const priorUv = [(previous[0] / previous[3]) * 0.5 + 0.5, (previous[1] / previous[3]) * -0.5 + 0.5];
  if (!currentUv.every((v) => v >= 0 && v < 1) || !priorUv.every((v) => v >= 0 && v < 1)) {
    return invalid;
  }
  return { motion: [currentUv[0]! - priorUv[0]!, currentUv[1]! - priorUv[1]!] as const, valid: true };
}

/** Same four lanes as TemporalFacts; signatures are change detectors, not exact IDs. */
export function nativeSurfaceTemporalMask(
  current: readonly [number, number, number, number],
  previous: readonly [number, number, number, number],
  historyValid: boolean,
  motionValid: boolean,
  opaqueReactive: number,
  responseBits: number,
): readonly [number, number, number, number] {
  if (
    !Number.isFinite(opaqueReactive) ||
    !Number.isInteger(responseBits) ||
    responseBits < 0 ||
    responseBits > 255
  ) {
    throw new RangeError("Invalid native Temporal response");
  }
  let mismatch = false;
  let bits = responseBits;
  motionValid = motionValid && historyValid;
  if (historyValid && motionValid) {
    mismatch =
      current[0] === previous[0] &&
      (current[1] !== previous[1] || (current[3] === previous[3] && current[2] !== previous[2]));
    for (let lane = 0; lane < 4; lane++) {
      if (current[lane] !== previous[lane]) {
        bits |= 1 << lane;
      }
    }
  }
  if (!motionValid) {
    bits |= 16;
  }
  return [Math.min(1, Math.max(0, opaqueReactive)), Number(motionValid), Number(mismatch), bits / 255];
}

/** Direct FSR3UpscalerRuntime.addToGraph input names; no synthesized history facts. */
export function nativeSurfaceAuxFsrInputs(facts: {
  readonly motion: ResourceId;
  readonly mask: ResourceId;
  readonly identity: ResourceId;
}) {
  return { motion: facts.motion, validityMask: facts.mask, reactiveMask: facts.mask };
}
