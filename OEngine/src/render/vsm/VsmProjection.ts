import type { VsmResources } from "./VsmResources.js";
import { VSM_DEFAULT_SETTINGS, type VsmSettings } from "./VsmSettings.js";

import {
  VSM_MAX_CLIP_LEVELS,
  VSM_PROJECTION_CONSTANT_BYTES,
  VSM_DEPTH_RANGE_BYTE_OFFSET,
  VSM_IDENTITY_BYTE_OFFSET,
  VSM_SELECTOR_WORD,
  VSM_FOOTPRINT_WORD,
} from "../../gpu/GpuVsmProjectionAbi.js";
export { VSM_PROJECTION_CONSTANT_BYTES, VSM_DEPTH_RANGE_BYTE_OFFSET, VSM_IDENTITY_BYTE_OFFSET };
export const VSM_DEPTH_RANGE_BYTES = 16;

export interface VsmDirectionalFrameConstants {
  readonly generation: number;
  readonly projectionEpoch: number;
  readonly namespace: number;
  readonly lightView: readonly number[];
  readonly clipOriginExtent: readonly (readonly [number, number, number, number])[];
  readonly settings?: Readonly<VsmSettings>;
  readonly cameraPosition: readonly [number, number, number];
}

function normalize3(x: number, y: number, z: number): [number, number, number] {
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length < 1e-6) {
    throw new RangeError("VSM sun direction is degenerate");
  }
  return [x / length, y / length, z / length];
}

/** World-fixed light basis and view-centered integer page window. */
export function buildVsmDirectionalFrameConstants(
  sunDirectionWorld: readonly [number, number, number],
  cameraPosition: readonly [number, number, number],
  cameraFar: number,
  resources: VsmResources,
  generation: number,
  projectionEpoch = generation,
  settings: Readonly<VsmSettings> = VSM_DEFAULT_SETTINGS,
): VsmDirectionalFrameConstants {
  const profile = resources.capabilities;
  if (resources.profile === "shadow-disabled") {
    throw new Error("Cannot build VSM constants for disabled profile");
  }
  // Match VsmGeneration's f32 direction identity before constructing the basis.
  const travel = normalize3(
    -Math.fround(sunDirectionWorld[0]),
    -Math.fround(sunDirectionWorld[1]),
    -Math.fround(sunDirectionWorld[2])
  );
  const upReference: [number, number, number] = Math.abs(travel[1]) > 0.92 ? [1, 0, 0] : [0, 1, 0];
  const right = normalize3(
    upReference[1] * travel[2] - upReference[2] * travel[1],
    upReference[2] * travel[0] - upReference[0] * travel[2],
    upReference[0] * travel[1] - upReference[1] * travel[0]
  );
  const up: [number, number, number] = [
    travel[1] * right[2] - travel[2] * right[1],
    travel[2] * right[0] - travel[0] * right[2],
    travel[0] * right[1] - travel[1] * right[0]
  ];
  // Old finest texel = oldExtent/16384. Donor selects level >= 1, so
  // new level-0 extent = oldExtent/8 gives level-1 extent/4096 equal precision.
  const baseExtent = Math.max(32, Math.min(Math.max(32, cameraFar), 2048) * 0.125) * settings.clipExtentScale / 8;
  const center = cameraPosition;
  const lightView = Object.freeze([
    right[0],
    up[0],
    travel[0],
    0,
    right[1],
    up[1],
    travel[1],
    0,
    right[2],
    up[2],
    travel[2],
    0,
    0,
    0,
    0,
    1
  ]);
  if (!Number.isFinite(cameraFar) || cameraFar <= 0 || !cameraPosition.every(Number.isFinite)) {
    throw new RangeError("VSM camera must be finite with positive far distance");
  }
  const levels = Array.from({ length: profile.clipLevels }, (_, level) => {
    const extent = baseExtent * 2 ** level;
    const texelWorld = extent / (profile.virtualPagesPerAxis * profile.pageSize);
    const pageWorld = texelWorld * profile.pageSize;
    const lightX = right[0] * center[0] + right[1] * center[1] + right[2] * center[2];
    const lightY = up[0] * center[0] + up[1] * center[1] + up[2] * center[2];
    if (Math.max(Math.abs(lightX / pageWorld), Math.abs(lightY / pageWorld)) > 1048576) {
      throw new RangeError("VSM world page exceeds the supported f32 grid domain; use a floating origin");
    }
    const originX = Math.floor(lightX / pageWorld) * pageWorld - extent * 0.5;
    const originY = Math.floor(lightY / pageWorld) * pageWorld - extent * 0.5;
    return Object.freeze([originX, originY, extent, texelWorld] as const);
  });
  return Object.freeze({
    generation,
    projectionEpoch,
    namespace: resources.namespace,
    settings,
    cameraPosition,
    lightView,
    clipOriginExtent: Object.freeze(levels)
  });
}

/** Common projection block; stable depth is copied at the shared ABI offset. */
export function packVsmProjection(frame: VsmDirectionalFrameConstants): ArrayBuffer {
  if (frame.lightView.length !== 16 || !frame.lightView.every(Number.isFinite) ||
      frame.cameraPosition.length !== 3 || !frame.cameraPosition.every(Number.isFinite) ||
      frame.clipOriginExtent.length < 2 || frame.clipOriginExtent.length > VSM_MAX_CLIP_LEVELS ||
      !frame.clipOriginExtent.every((clip) => clip.every(Number.isFinite) && clip[2] > 0)) {
    throw new RangeError("VSM projection requires a finite camera and complete clip domain");
  }
  const data = new ArrayBuffer(VSM_PROJECTION_CONSTANT_BYTES);
  const f = new Float32Array(data);
  const u = new Uint32Array(data);
  f.set(frame.lightView);
  for (let level = 0; level < VSM_MAX_CLIP_LEVELS; level++) {
    f.set(frame.clipOriginExtent[level] ?? [0, 0, 0, 0], 16 + level * 4);
  }
  f.set([...frame.cameraPosition, (frame.settings ?? VSM_DEFAULT_SETTINGS).clipSelectionBias], VSM_SELECTOR_WORD);
  // Future PCSS must publish its maximum footprint here before enabling taps.
  f.set([0, 0, 0, 0], VSM_FOOTPRINT_WORD);
  u.set([frame.projectionEpoch, frame.namespace, 0, 0], VSM_IDENTITY_BYTE_OFFSET / 4);
  return data;
}
