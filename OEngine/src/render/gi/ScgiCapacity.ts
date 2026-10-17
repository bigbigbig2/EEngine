import { FINAL_PIXEL_SOLAR_BYTES } from "../../gpu/FinalPixelAbi.js";
import { nativeSurfaceBindingGroups } from "../../shaders/native_surface.js";
import type { NativeSurfaceShaderProfile } from "../../shaders/native_surface.js";
import { SCGI_ABI, SCGI_MAX_CASCADES } from "./ScgiAbi.js";
import { scgiCacheScratchParts, SCGI_CACHE_WORKGROUP_SIZE } from "./ScgiCacheLayout.js";

export interface ScgiAllocationProfile {
  readonly width: number;
  readonly height: number;
  readonly resolution: number;
  readonly cascades: number;
  readonly patches: number;
  readonly requests: number;
  readonly bounceRequests: number;
  readonly updates: number;
  readonly rayBatch: number;
}

export interface ScgiRange {
  readonly offset: number;
  readonly bytes: number;
  readonly count: number;
  readonly stride: number;
}

export interface ScgiArenaPlan {
  readonly bytes: number;
  readonly ranges: Readonly<Record<string, ScgiRange>>;
}

export type ScgiBufferLimits = Pick<
  GPUSupportedLimits,
  "maxBufferSize" | "maxStorageBufferBindingSize" | "minStorageBufferOffsetAlignment"
>;

export function scgiInteger(value: number, name: string, minimum = 1, maximum = 0xffffffff): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`SCGI ${name} is outside [${minimum}, ${maximum}]`);
  }
  return value;
}

export function scgiAlign(bytes: number, alignment: number): number {
  return Math.ceil(bytes / alignment) * alignment;
}

/** Each arena is a single binding; disjoint producers can also bind aligned subranges. */
export function planScgiArena(
  limits: ScgiBufferLimits,
  parts: readonly (readonly [name: string, count: number, stride: number])[],
): ScgiArenaPlan {
  const alignment = scgiInteger(limits.minStorageBufferOffsetAlignment, "storage alignment", 4);
  if (alignment % 4 !== 0) {
    throw new RangeError("SCGI storage offset alignment must be a multiple of 4");
  }
  let bytes = 0;
  const ranges: Record<string, ScgiRange> = {};
  for (const [name, count, stride] of parts) {
    scgiInteger(count, `${name} count`, 0);
    scgiInteger(stride, `${name} stride`, 4);
    if (ranges[name] !== undefined || stride % 4 !== 0) {
      throw new RangeError("SCGI duplicate range or unaligned stride");
    }
    const offset = scgiAlign(bytes, alignment);
    const length = count * stride;
    ranges[name] = Object.freeze({ offset, bytes: length, count, stride });
    bytes = offset + length;
  }
  bytes = Math.max(4, scgiAlign(bytes, 4));
  if (
    !Number.isSafeInteger(bytes) ||
    bytes / 4 > 0xffffffff ||
    bytes > Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize)
  ) {
    throw new RangeError("SCGI complete arena exceeds buffer/binding capacity");
  }
  return Object.freeze({ bytes, ranges: Object.freeze(ranges) });
}

export function planScgiAllocation(limits: ScgiBufferLimits, profile: ScgiAllocationProfile) {
  for (const [name, count] of Object.entries(profile)) {
    scgiInteger(count, name, 1);
  }
  scgiInteger(profile.cascades, "cascades", 1, SCGI_MAX_CASCADES);
  if (
    profile.updates > profile.patches ||
    (profile.requests + profile.bounceRequests) * 2 >= 0xffffffff ||
    profile.patches >= 0xfffffffe
  ) {
    throw new RangeError("SCGI update/patch/sentinel capacity is not representable");
  }
  const pixels = scgiInteger(profile.width * profile.height, "source pixel domain");
  const halfWidth = Math.ceil(profile.width / 2);
  const halfHeight = Math.ceil(profile.height / 2);
  const halfPixels = halfWidth * halfHeight;
  const cells = scgiInteger(profile.resolution ** 3 * 16 * profile.cascades, "cell domain");
  const world = planScgiArena(limits, [
    ["header", 1, SCGI_ABI.worldHeader.stride],
    ["map", cells, SCGI_ABI.cell.stride],
    ["patches", profile.patches, SCGI_ABI.patch.stride],
    ["cacheState", profile.patches, SCGI_ABI.cacheState.stride],
    ["freeSlots", profile.patches, 4],
    ["bounceRequests", profile.bounceRequests, SCGI_ABI.request.stride],
  ]);
  const scratch = planScgiArena(limits, [
    ["a1", profile.patches, 48],
    ["raw", profile.updates, SCGI_ABI.raw.stride],
    ["requests", profile.requests, SCGI_ABI.request.stride],
    ["updateList", profile.updates, 4],
    ["countersArgs", 16, 4],
    ["seedSources", profile.patches, 4],
    ["filterValidity", profile.patches, 4],
    ...scgiCacheScratchParts(cells, profile.patches, profile.requests, profile.bounceRequests),
    ["filterControl", 16 + profile.patches, 4],
  ]);
  const batch = planScgiArena(limits, [
    ["rays", profile.rayBatch, SCGI_ABI.ray.stride],
    ["results", profile.rayBatch, SCGI_ABI.result.stride],
    ["payloads", profile.rayBatch, SCGI_ABI.payload.stride],
    ["cacheIndirect", 16, 4],
  ]);
  const fieldStride = SCGI_ABI.halfField.stride;
  const pixelsPerSegment = Math.floor(
    Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize) /
      Math.max(fieldStride, SCGI_ABI.anchor.stride),
  );
  scgiInteger(pixelsPerSegment, "field pixels per segment");
  const screen: ScgiArenaPlan[] = [];
  for (let firstPixel = 0; firstPixel < halfPixels; firstPixel += pixelsPerSegment) {
    screen.push(
      planScgiArena(limits, [
        ["worldField", Math.min(pixelsPerSegment, halfPixels - firstPixel), fieldStride],
      ]),
    );
  }
  const anchors = screen.map((segment) =>
    planScgiArena(limits, [["anchors", segment.ranges.worldField!.count, SCGI_ABI.anchor.stride]]),
  );
  const anchorBytes = anchors.reduce((sum, segment) => sum + segment.bytes, 0);
  const screenRoleBytes = screen.reduce((bytes, segment) => bytes + segment.bytes, 0);
  const worldBytes = world.bytes * 2;
  const screenHistoryBytes = screenRoleBytes * 2;
  const privateScratchBytes = scratch.bytes + batch.bytes + anchorBytes;
  const totalBytes = worldBytes + screenHistoryBytes + privateScratchBytes;
  scgiInteger(totalBytes, "allocation total", 1, Number.MAX_SAFE_INTEGER);
  return Object.freeze({
    profile: Object.freeze({ ...profile }),
    pixels,
    halfWidth,
    halfHeight,
    halfPixels,
    cells,
    world,
    scratch,
    batch,
    screen: Object.freeze(screen),
    anchors: Object.freeze(anchors),
    anchorBytes,
    screenRoleBytes,
    pixelsPerSegment,
    worldBytes,
    screenHistoryBytes,
    privateScratchBytes,
    totalBytes,
    // These are external directory slots, not three extra GI-owned histories.
    externalFieldDirectoryPeakBytes: screenRoleBytes * 3,
    copyBytesPerFrame: world.bytes,
  });
}

export type ScgiAllocationPlan = ReturnType<typeof planScgiAllocation>;

/** Mixed ordinary/Product geometry is the SCGI profile, negotiated before any
 * world/screen allocation. Optional shader features are not required. */
export function assertScgiAnchorCapabilities(limits: GPUSupportedLimits, plan: ScgiAllocationPlan): void {
  if (
    limits.maxStorageBuffersPerShaderStage < 13 ||
    limits.maxUniformBuffersPerShaderStage < 1 ||
    limits.maxSampledTexturesPerShaderStage < 1 ||
    limits.maxBindGroups < 2 ||
    limits.maxBindingsPerBindGroup < 10 ||
    limits.maxUniformBufferBindingSize < 368 ||
    Math.ceil(Math.max(plan.profile.patches, Math.min(plan.pixelsPerSegment, plan.halfPixels)) / 64) >
      limits.maxComputeWorkgroupsPerDimension
  ) {
    throw new RangeError("SCGI anchor/seed exceeds negotiated geometry bindings or dispatch capacity");
  }
}

/** Validate physical cache dispatches before the runtime allocates any arenas. */
export function assertScgiCacheCapabilities(limits: GPUSupportedLimits, plan: ScgiAllocationPlan): void {
  const size = SCGI_CACHE_WORKGROUP_SIZE;
  if (
    limits.maxStorageBuffersPerShaderStage < 4 ||
    limits.maxBindGroups < 1 ||
    limits.maxComputeInvocationsPerWorkgroup < size ||
    limits.maxComputeWorkgroupSizeX < size ||
    limits.maxComputeWorkgroupStorageSize < size * 4 ||
    Math.ceil(
      Math.max(plan.cells, plan.profile.patches, plan.profile.requests + plan.profile.bounceRequests) / size,
    ) > limits.maxComputeWorkgroupsPerDimension ||
    plan.world.bytes > limits.maxStorageBufferBindingSize ||
    plan.scratch.bytes > limits.maxStorageBufferBindingSize
  ) {
    throw new RangeError("SCGI cache physical arenas/dispatch exceed negotiated capabilities");
  }
}

export interface ScgiLightingWindowInput {
  readonly width: number;
  readonly height: number;
  readonly oldDirectoryBytes: number;
  readonly filterNoiseBytes: number;
  readonly residual: boolean;
  readonly haloHalfRows: number;
  readonly tileHeight: number;
  /** Proven worst-case complete VSM receiver tap/fallback page footprint per
   * full-resolution work tile. Caller must derive this from the VSM projection. */
  readonly descriptorCountPerTile: number;
  readonly tileWidth: number;
}

/** Full route or a finite complete work-tile window. No new Native binding.
 * A rectangle tile route handles a row too wide to fit a horizontal stripe. */
export function planScgiLightingWindow(limits: ScgiBufferLimits, input: ScgiLightingWindowInput) {
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === "number") {
      scgiInteger(value, name, ["haloHalfRows", "filterNoiseBytes"].includes(name) ? 0 : 1);
    }
  }
  scgiInteger(input.width * input.height, "window source pixels");
  const halfWidth = Math.ceil(input.width / 2);
  const halfHeight = Math.ceil(input.height / 2);
  const stride = SCGI_ABI.halfField.stride + (input.residual ? 32 : 0);
  const alignment = limits.minStorageBufferOffsetAlignment;
  scgiInteger(alignment, "window storage alignment", 4);
  if (alignment % 4 !== 0) {
    throw new RangeError("SCGI window storage alignment must be a multiple of 4");
  }
  const fieldOffset = scgiAlign(input.oldDirectoryBytes, alignment);
  const fullBytes = fieldOffset + halfWidth * halfHeight * stride;
  const limit = Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize);
  if (fullBytes <= limit && fullBytes / 4 <= 0xffffffff) {
    return Object.freeze({
      route: "full" as const,
      bytes: fullBytes,
      fieldOffset,
      fieldBytes: halfWidth * halfHeight * stride,
      windowWidth: input.width,
      windowHeight: input.height,
      columns: 1,
      rows: 1,
      windows: 1,
      slots: 3,
      directoryPeakBytes: fullBytes * 3,
      remapLighting: false,
    });
  }
  const fit = (width: number, height: number, remap: boolean) => {
    const tiles = Math.ceil(width / input.tileWidth) * Math.ceil(height / input.tileHeight);
    const descriptors = tiles * input.descriptorCountPerTile;
    const localLookup = tiles * 8;
    const base = remap
      ? FINAL_PIXEL_SOLAR_BYTES + input.filterNoiseBytes + descriptors * 16 + localLookup
      : input.oldDirectoryBytes;
    const offset = scgiAlign(base, alignment);
    // Halo on all sides is conservative at image boundaries; never drops a tap.
    const fieldWidth = Math.ceil(width / 2) + 2 * input.haloHalfRows;
    const fieldHeight = Math.ceil(height / 2) + 2 * input.haloHalfRows;
    const fieldBytes = fieldWidth * fieldHeight * stride;
    return { bytes: offset + fieldBytes, fieldOffset: offset, fieldBytes };
  };
  for (const remap of [false, true]) {
    const maxColumns = Math.ceil(input.width / input.tileWidth);
    const maxRows = Math.ceil(input.height / input.tileHeight);
    for (const columns of [maxColumns, 1]) {
      let low = 1;
      let high = maxRows;
      let best = 0;
      while (low <= high) {
        const rows = Math.floor((low + high) / 2);
        const candidate = fit(
          Math.min(input.width, columns * input.tileWidth),
          Math.min(input.height, rows * input.tileHeight),
          remap,
        );
        if (candidate.bytes <= limit && candidate.bytes / 4 <= 0xffffffff) {
          best = rows;
          low = rows + 1;
        } else {
          high = rows - 1;
        }
      }
      if (best === 0) {
        continue;
      }
      const windowWidth = Math.min(input.width, columns * input.tileWidth);
      const windowHeight = Math.min(input.height, best * input.tileHeight);
      const range = fit(windowWidth, windowHeight, remap);
      const windowColumns = Math.ceil(input.width / windowWidth);
      const windowRows = Math.ceil(input.height / windowHeight);
      return Object.freeze({
        route: "window" as const,
        ...range,
        windowWidth,
        windowHeight,
        columns: windowColumns,
        rows: windowRows,
        windows: windowColumns * windowRows,
        slots: 3,
        directoryPeakBytes: range.bytes * 3,
        remapLighting: remap,
      });
    }
  }
  throw new RangeError("SCGI complete work tile with halo and lighting cannot fit the directory");
}

/** Finite shards share one physical scratch batch. Oversized assets must split
 * at Product cluster boundaries before this planner, never truncate references. */
export function planScgiShards(
  limits: ScgiBufferLimits,
  clusters: readonly { readonly nodes: number; readonly triangles: number }[],
  maxShards: number,
) {
  scgiInteger(maxShards, "max shards");
  const shards: { firstCluster: number; clusterCount: number; arena: ScgiArenaPlan }[] = [];
  let firstCluster = 0;
  let nodes = 0;
  let triangles = 0;
  const arena = (n: number, t: number) =>
    planScgiArena(limits, [
      ["nodes", n, 64],
      ["links", n, 8],
      ["references", t, 16],
    ]);
  for (let index = 0; index < clusters.length; index++) {
    const cluster = clusters[index]!;
    scgiInteger(cluster.nodes, "cluster nodes");
    scgiInteger(cluster.triangles, "cluster triangles");
    // A single cluster must fit independently; this is not an allocation failure.
    arena(cluster.nodes, cluster.triangles);
    let next: ScgiArenaPlan | undefined;
    try {
      next = arena(nodes + cluster.nodes, triangles + cluster.triangles);
    } catch (cause) {
      if (!(cause instanceof RangeError)) {
        throw cause;
      }
    }
    if (next === undefined) {
      shards.push({ firstCluster, clusterCount: index - firstCluster, arena: arena(nodes, triangles) });
      firstCluster = index;
      nodes = 0;
      triangles = 0;
    }
    nodes += cluster.nodes;
    triangles += cluster.triangles;
  }
  if (nodes > 0) {
    shards.push({
      firstCluster,
      clusterCount: clusters.length - firstCluster,
      arena: arena(nodes, triangles),
    });
  }
  if (shards.length > maxShards) {
    throw new RangeError("SCGI finite AS shard admission exceeded");
  }
  return Object.freeze(shards);
}

export function validateScgiDescriptors(
  limits: GPUSupportedLimits,
  groups: readonly (readonly GPUBindGroupLayoutEntry[])[],
) {
  const counts = { storage: 0, uniform: 0, sampled: 0, storageTexture: 0, sampler: 0 };
  if (groups.length > limits.maxBindGroups) {
    throw new RangeError("SCGI bind-group limit exceeded");
  }
  for (const entries of groups) {
    if (entries.length > limits.maxBindingsPerBindGroup) {
      throw new RangeError("SCGI per-group binding limit exceeded");
    }
    const bindings = new Set<number>();
    for (const entry of entries) {
      if (
        !Number.isInteger(entry.binding) ||
        entry.binding < 0 ||
        entry.binding >= limits.maxBindingsPerBindGroup ||
        bindings.has(entry.binding)
      ) {
        throw new RangeError("SCGI duplicate binding");
      }
      bindings.add(entry.binding);
      if ((entry.visibility & GPUShaderStage.COMPUTE) === 0) {
        continue;
      }
      if (entry.buffer !== undefined) {
        counts[entry.buffer.type === undefined || entry.buffer.type === "uniform" ? "uniform" : "storage"]++;
      }
      if (entry.texture !== undefined) {
        counts.sampled++;
      }
      if (entry.storageTexture !== undefined) {
        counts.storageTexture++;
      }
      if (entry.sampler !== undefined) {
        counts.sampler++;
      }
    }
  }
  if (
    counts.storage > limits.maxStorageBuffersPerShaderStage ||
    counts.uniform > limits.maxUniformBuffersPerShaderStage ||
    counts.sampled > limits.maxSampledTexturesPerShaderStage ||
    counts.storageTexture > limits.maxStorageTexturesPerShaderStage ||
    counts.sampler > limits.maxSamplersPerShaderStage
  ) {
    throw new RangeError("SCGI complete shader descriptor footprint exceeds limits");
  }
  return Object.freeze(counts);
}

export function planScgiNativeDescriptors(
  limits: GPUSupportedLimits,
  profile: NativeSurfaceShaderProfile,
  materialEntries: readonly GPUBindGroupLayoutEntry[],
) {
  const groups = nativeSurfaceBindingGroups(materialEntries, profile);
  const counts = validateScgiDescriptors(limits, groups);
  return Object.freeze({ groups, counts, addedGiBindings: 0 });
}

/** Coverage tail inventory from design §19.3. Actual material constants/textures
 * remain their existing Native descriptors; SCGI adds no sampled texture. */
export function scgiExecutionProfile(device: Pick<GPUDevice, "features" | "limits">) {
  if (
    device.limits.maxComputeInvocationsPerWorkgroup < 128 ||
    device.limits.maxComputeWorkgroupSizeX < 128 ||
    device.limits.maxComputeWorkgroupStorageSize < 4096
  ) {
    throw new RangeError("SCGI portable kernel requires 128 invocations and 4KiB workgroup storage");
  }
  return Object.freeze({
    scan: "portable",
    arithmetic: "f32",
    halfStorage: "pack2x16float",
    workgroupSize: 128,
  });
}
