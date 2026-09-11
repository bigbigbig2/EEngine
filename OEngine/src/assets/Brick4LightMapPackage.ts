/** Device-independent, validated Brick4 storage package. */

export const BRICK4_LIGHT_MAP_SCHEMA_VERSION = 1;
export const BRICK4_STORAGE_HEADER_BYTES = 32;
export const BRICK4_NODE_PROBE_COUNT = 64;
export const BRICK4_BRANCH_WORDS = 93;
export const BRICK4_PROBE_WORDS = 7;

export interface Brick4LightMapPackageV1 {
  readonly schemaVersion: 1;
  /** Monotonic authored mapping generation; zero is permanently invalid. */
  readonly generation: number;
  /** Exact WGSL Brick4LightMapStorage bytes, including the 32-byte bounds. */
  readonly storage: Uint8Array;
  readonly sourceUri: string;
}

export interface Brick4LightMapPackageValidation {
  readonly generation: number;
  readonly byteLength: number;
  readonly branchNodeCount: number;
  readonly leafNodeCount: number;
  readonly referencedProbeCount: number;
}

/**
 * Copies and validates a complete monolithic Brick4 package. Partial payloads
 * are intentionally rejected: the V1 residency contract publishes every
 * tree node and referenced SH probe atomically as one generation.
 */
export function createBrick4LightMapPackageV1(input: {
  readonly generation: number;
  readonly storage: ArrayBuffer | ArrayBufferView;
  readonly sourceUri: string;
}): Brick4LightMapPackageV1 {
  const source = asBytes(input.storage);
  const storage = new Uint8Array(source.byteLength);
  storage.set(source);
  const result: Brick4LightMapPackageV1 = Object.freeze({
    schemaVersion: BRICK4_LIGHT_MAP_SCHEMA_VERSION,
    generation: input.generation,
    storage,
    sourceUri: input.sourceUri
  });
  validateBrick4LightMapPackageV1(result);
  return result;
}

export function validateBrick4LightMapPackageV1(
  value: Brick4LightMapPackageV1
): Brick4LightMapPackageValidation {
  if (value.schemaVersion !== BRICK4_LIGHT_MAP_SCHEMA_VERSION) {
    throw new RangeError(`Unsupported Brick4 schema ${String(value.schemaVersion)}`);
  }
  if (!Number.isSafeInteger(value.generation) || value.generation <= 0 ||
      value.generation > 0xffffffff) {
    throw new RangeError("Brick4 generation must be a non-zero uint32");
  }
  if (typeof value.sourceUri !== "string" || value.sourceUri.length === 0) {
    throw new TypeError("Brick4 sourceUri must be non-empty");
  }
  const bytes = value.storage;
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("Brick4 storage must be Uint8Array");
  }
  if ((bytes.byteLength & 3) !== 0) {
    throw new RangeError("Brick4 storage byte length must be 4-byte aligned");
  }
  if (bytes.byteLength < BRICK4_STORAGE_HEADER_BYTES + BRICK4_BRANCH_WORDS * 4) {
    throw new RangeError("Brick4 storage cannot contain the root branch node");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bounds = [
    view.getFloat32(0, true), view.getFloat32(4, true), view.getFloat32(8, true),
    view.getFloat32(16, true), view.getFloat32(20, true), view.getFloat32(24, true)
  ];
  if (!bounds.every(Number.isFinite)) {
    throw new RangeError("Brick4 bounds must contain finite float32 values");
  }
  if (!(bounds[0]! < bounds[3]!) || !(bounds[1]! < bounds[4]!) ||
      !(bounds[2]! < bounds[5]!)) {
    throw new RangeError("Brick4 bounds must have positive extent on every axis");
  }

  const words = new Uint32Array(
    bytes.buffer,
    bytes.byteOffset + BRICK4_STORAGE_HEADER_BYTES,
    (bytes.byteLength - BRICK4_STORAGE_HEADER_BYTES) >>> 2
  );
  const pending = [0x80000000];
  const visited = new Set<number>();
  const referencedProbes = new Set<number>();
  let branchNodeCount = 0;
  let leafNodeCount = 0;

  while (pending.length > 0) {
    const pointer = pending.pop()! >>> 0;
    const address = pointer & 0x7fffffff;
    if (visited.has(address)) {
      throw new RangeError(`Brick4 tree contains a cycle or aliased node at word ${address}`);
    }
    visited.add(address);
    if (address + BRICK4_NODE_PROBE_COUNT > words.length) {
      throw new RangeError(`Brick4 node ${address} exceeds storage`);
    }
    for (let local = 0; local < BRICK4_NODE_PROBE_COUNT; local++) {
      const probeAddress = words[address + local]!;
      if (probeAddress + BRICK4_PROBE_WORDS > words.length) {
        throw new RangeError(
          `Brick4 node ${address} references incomplete probe ${probeAddress}`
        );
      }
      referencedProbes.add(probeAddress);
    }

    if ((pointer & 0x80000000) === 0) {
      leafNodeCount++;
      continue;
    }
    branchNodeCount++;
    if (address + BRICK4_BRANCH_WORDS > words.length) {
      throw new RangeError(`Brick4 branch ${address} exceeds storage`);
    }
    const occupancyLow = words[address + 64]!;
    // A 3x3x3 branch uses child bits 0..26; bits 27..31 and the second
    // occupancy word are reserved and must remain zero in schema V1.
    if ((occupancyLow & 0xf8000000) !== 0 || words[address + 65] !== 0) {
      throw new RangeError(`Brick4 branch ${address} has reserved occupancy bits`);
    }
    for (let child = 0; child < 27; child++) {
      if ((occupancyLow & (1 << child)) === 0) continue;
      const childPointer = words[address + 66 + child]!;
      pending.push(childPointer);
    }
    if (visited.size + pending.length > words.length) {
      throw new RangeError("Brick4 tree traversal exceeds the storage-derived bound");
    }
  }

  return Object.freeze({
    generation: value.generation,
    byteLength: bytes.byteLength,
    branchNodeCount,
    leafNodeCount,
    referencedProbeCount: referencedProbes.size
  });
}

function asBytes(source: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}
