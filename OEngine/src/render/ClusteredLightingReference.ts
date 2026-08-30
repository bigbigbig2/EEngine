export const LIGHT_LIST_HEADER_BYTES = 16;
export const LIGHT_LIST_HEADER_WORDS = 4;

export const CLUSTER_METADATA_FLAG_POINT_OVERFLOW = 1 << 0;
export const CLUSTER_METADATA_FLAG_SPOT_OVERFLOW = 1 << 1;
export const CLUSTER_METADATA_FLAG_DATA_OVERFLOW = 1 << 2;
export const CLUSTER_METADATA_FLAG_FALLBACK = 1 << 3;

export interface BoundedLightList {
  readonly attempted: number;
  readonly written: number;
  readonly capacity: number;
  readonly overflow: number;
  readonly data: readonly number[];
}

export interface ClusterMetadataReference {
  readonly offset: number;
  readonly pointCount: number;
  readonly spotCount: number;
  readonly flags: number;
}

export interface ClusterDepthParameters {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export function assertLightListCapacity(
  required: number,
  capacity: number
): void {
  if (!Number.isInteger(required) || required < 0) {
    throw new RangeError("LightList required count must be a non-negative integer");
  }
  if (!Number.isInteger(capacity) || capacity < 0) {
    throw new RangeError("LightList capacity must be a non-negative integer");
  }
  if (required > capacity) {
    throw new RangeError(
      `Local light count ${required} exceeds the explicit LightList capacity ${capacity}`
    );
  }
}

export function lightSphereDistanceAttenuation(
  distanceToCenter: number,
  radius: number,
  cutoffDistance: number
): number {
  const radiusEffective = Math.max(radius, 1e-2);
  const distanceEffective = Math.max(distanceToCenter, radiusEffective);
  let attenuation = 1 / (distanceEffective * distanceEffective);
  if (cutoffDistance > 0) {
    const surfaceDistance = Math.max(0, distanceToCenter - radius);
    const ratio = surfaceDistance / cutoffDistance;
    const fade = clamp01(1 - ratio * ratio * ratio * ratio);
    attenuation *= fade * fade;
  }
  return attenuation;
}

export function spotLightAttenuation(
  coneCos: number,
  penumbraCos: number,
  angleCos: number
): number {
  if (coneCos === penumbraCos) return angleCos >= penumbraCos ? 1 : 0;
  const t = clamp01((angleCos - coneCos) / (penumbraCos - coneCos));
  return t * t * (3 - 2 * t);
}

export function clusterDepthToSlice(
  depth: number,
  parameters: ClusterDepthParameters,
  limit: number
): number {
  const logarithmInput = depth * parameters.x + parameters.y;
  if (!(logarithmInput > 0) || !(parameters.z > 0)) return 0;
  return Math.min(
    Math.max(0, Math.log2(logarithmInput) * parameters.z),
    limit
  );
}

export function clusterGridIndex(
  position: readonly [number, number, number],
  dimensions: readonly [number, number]
): number {
  return position[0] +
    (position[1] + position[2] * dimensions[1]) * dimensions[0];
}

export function sphereIntersectsFrustum(
  sphere: readonly [number, number, number, number],
  frustum: readonly (readonly [number, number, number, number])[]
): boolean {
  for (const plane of frustum) {
    const distance =
      plane[0] * sphere[0] +
      plane[1] * sphere[1] +
      plane[2] * sphere[2] +
      plane[3];
    if (distance < -sphere[3]) return false;
  }
  return true;
}

export function appendBoundedLightList(
  values: readonly number[],
  capacity: number
): BoundedLightList {
  if (!Number.isInteger(capacity) || capacity < 0) {
    throw new RangeError("LightList capacity must be a non-negative integer");
  }
  const written = Math.min(values.length, capacity);
  return Object.freeze({
    attempted: values.length,
    written,
    capacity,
    overflow: values.length > capacity ? 1 : 0,
    data: Object.freeze(values.slice(0, written))
  });
}

export function resolveClusterLightIndices(
  metadata: ClusterMetadataReference,
  clusterData: readonly number[],
  activeLightList: BoundedLightList
): readonly number[] {
  if ((metadata.flags & CLUSTER_METADATA_FLAG_FALLBACK) !== 0) {
    return activeLightList.data.slice(0, activeLightList.written);
  }
  const count = metadata.pointCount + metadata.spotCount;
  return clusterData.slice(metadata.offset, metadata.offset + count);
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}
