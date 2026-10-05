/**
 * Surface domain directory ABI.
 *
 * The design separates five concepts that the current Surface chain conflates
 * (design §4): domain, tile, sample, execution bin and cache address. Before
 * this file the only domain representation was `surface_cell_domain_token`
 * (shaders/surface_cell_domain.ts), a per-lane recipe lookup, plus the pairwise
 * predicate `surface_cell_compatible(plane, a, b)`. A predicate cannot be an
 * entity: equality had to be re-established between every pair of lanes, so a
 * tile that shares one appearance closure across all 64 of its pixels still had
 * no shared record to point at, and "one domain" could not be said once.
 *
 * This directory is that record. It is built at publication time, where the
 * static semantics live (design §5.2), and it is the only authority for:
 *
 *   - domain identity  — the interning key, so equal domains share one record;
 *   - coverage targets — which planes a tile may reference this domain for;
 *   - sample work      — which planes still need real evaluation points, and
 *                        how many.
 *
 * The three are deliberately separate fields. `sampleMask == 0` means the
 * domain's value is published rather than evaluated, and that is the only case
 * where a domain implies a single value for every tile referencing it. A
 * high-frequency texture or normal keeps `sampleMask` bits set, so one domain
 * record never collapses many samples into one (design §5.2, execution §6.1).
 *
 * Layout is length-prefixed words rather than a fixed struct, because the
 * execution plan forbids pre-committing a 32-64 B descriptor ABI before the B1
 * prototype decides it (execution §6.1).
 */

/** `[count, wordsPerRecord, sampleMaskWords]` before the records. */
export const DOMAIN_DIRECTORY_HEADER_WORDS = 3;

/**
 * Words per record:
 *   0  closure    interned equality over program, texture set and inputs
 *   1  planeMask  planes whose sharing this domain is legal for
 *   2  tileEdges  tile edge in pixels the coverage domain was built from
 *   3..           sampleMask, one bit per sample slot actually needed
 */
export const DOMAIN_RECORD_HEADER_WORDS = 3;

/**
 * A domain's identity is its interning key. Two domains are the same entity
 * exactly when every component below agrees, which is the "complete equality"
 * requirement the design states for publication interning (design §5.1):
 * a hash may locate a record but never decides equality.
 */
export interface SurfaceDomainKey {
  /** Publication-stable equality over the appearance closure. */
  readonly closure: number;
  /** Planes this sharing is legal for; 21-bit field/signal plane space. */
  readonly planeMask: number;
  /** Tile edge in pixels; a different coverage unit is a different domain. */
  readonly tileEdges: number;
  /**
   * Sample slots that still require real evaluation points. Bits are sample
   * ordinals, not plane ordinals: several slots may belong to one plane, and a
   * plane whose value is published contributes none.
   */
  readonly sampleMask: number;
  /** Sample bits set in `sampleMask`; kept explicit so count is order-free. */
  readonly sampleCount: number;
}

export interface SurfaceDomainRecord extends SurfaceDomainKey {
  /** Directory index. Stable for one publication, an array position, not a hash. */
  readonly domainId: number;
}

export interface SurfaceDomainDirectory {
  readonly words: Uint32Array<ArrayBuffer>;
  readonly records: readonly SurfaceDomainRecord[];
  /**
   * Plane-count independent of pixel/tile/scene size: a command whose topology
   * follows `planeMask` never scales with the number of tiles referencing it
   * (design §3.1 invariant A).
   */
  readonly planeMaskUnion: number;
  /** Total sample work demanded across all domains — distinct from domain count. */
  readonly sampleSlots: number;
}

function sampleMaskWords(planeCount: number): number {
  // One bit per sample slot; slots are bounded by the plane space so a domain
  // never needs an unbounded mask.
  return Math.max(1, Math.ceil(planeCount / 32));
}

/**
 * Interns domain keys and packs the directory.
 *
 * Ordering is first-seen so a domain's id is a deterministic function of the
 * publication order, which keeps the directory reproducible for a fixed input
 * without tying identity to a hash value.
 */
export class SurfaceDomainDirectoryBuilder {
  readonly #records: SurfaceDomainRecord[] = [];
  readonly #ids = new Map<string, number>();
  readonly #planeCount: number;

  constructor(planeCount: number) {
    if (!Number.isSafeInteger(planeCount) || planeCount < 1 || planeCount > 64) {
      throw new RangeError("Invalid Surface domain plane count");
    }
    this.#planeCount = planeCount;
  }

  get size(): number {
    return this.#records.length;
  }

  /**
   * Returns the id of the domain equal to `key`, adding it when new.
   *
   * Equal keys must intern to one record; that is the whole point of making the
   * domain an entity instead of a per-lane predicate.
   */
  intern(key: SurfaceDomainKey): number {
    if (!Number.isSafeInteger(key.closure) || key.closure < 0 || key.closure > 0xffffffff) {
      throw new RangeError("Invalid Surface domain closure");
    }
    if (!Number.isSafeInteger(key.planeMask) || key.planeMask < 0 || key.planeMask > 0x1fffff) {
      throw new RangeError("Invalid Surface domain plane mask");
    }
    if (!Number.isSafeInteger(key.tileEdges) || key.tileEdges < 1) {
      throw new RangeError("Invalid Surface domain tile edge");
    }
    if (!Number.isSafeInteger(key.sampleMask) || key.sampleMask < 0 || key.sampleMask > 0xffffffff) {
      throw new RangeError("Invalid Surface domain sample mask");
    }
    if (!Number.isSafeInteger(key.sampleCount) || key.sampleCount < 0) {
      throw new RangeError("Invalid Surface domain sample count");
    }
    if (popcount32(key.sampleMask) !== key.sampleCount) {
      throw new RangeError("Surface domain sample count disagrees with its mask");
    }
    const identity = `${key.closure}\u0000${key.planeMask}\u0000${key.tileEdges}\u0000${key.sampleMask}`;
    const existing = this.#ids.get(identity);
    if (existing !== undefined) {
      return existing;
    }
    const domainId = this.#records.length;
    this.#ids.set(identity, domainId);
    this.#records.push(Object.freeze({ ...key, domainId }));
    return domainId;
  }

  /** Packs the directory; records keep their interned order so ids stay valid. */
  build(): SurfaceDomainDirectory {
    const maskWords = sampleMaskWords(this.#planeCount);
    const perRecord = DOMAIN_RECORD_HEADER_WORDS + maskWords;
    const words = new Uint32Array(
      DOMAIN_DIRECTORY_HEADER_WORDS + Math.max(1, this.#records.length) * perRecord,
    );
    words[0] = this.#records.length;
    words[1] = perRecord;
    words[2] = maskWords;
    let planeMaskUnion = 0;
    let sampleSlots = 0;
    for (const record of this.#records) {
      const base = DOMAIN_DIRECTORY_HEADER_WORDS + record.domainId * perRecord;
      words[base] = record.closure;
      words[base + 1] = record.planeMask;
      words[base + 2] = record.tileEdges;
      words[base + DOMAIN_RECORD_HEADER_WORDS] = record.sampleMask;
      planeMaskUnion |= record.planeMask;
      sampleSlots += record.sampleCount;
    }
    return Object.freeze({
      words,
      records: Object.freeze([...this.#records]),
      planeMaskUnion,
      sampleSlots,
    });
  }
}

function popcount32(value: number): number {
  let bits = value >>> 0;
  bits = bits - ((bits >>> 1) & 0x55555555);
  bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
  bits = (bits + (bits >>> 4)) & 0x0f0f0f0f;
  return (bits * 0x01010101) >>> 24;
}

/**
 * Reads a record back from packed words.
 *
 * The packing is the authority; this exists so a consumer and a test read the
 * same bytes the GPU sees instead of a parallel CPU structure that could drift.
 */
export function readSurfaceDomainRecord(
  directory: Uint32Array<ArrayBuffer>,
  domainId: number,
): SurfaceDomainRecord {
  const count = directory[0]!;
  const perRecord = directory[1]!;
  if (!Number.isSafeInteger(domainId) || domainId < 0 || domainId >= count) {
    throw new RangeError("Surface domain id is outside the directory");
  }
  const base = DOMAIN_DIRECTORY_HEADER_WORDS + domainId * perRecord;
  const sampleMask = directory[base + DOMAIN_RECORD_HEADER_WORDS]!;
  return Object.freeze({
    domainId,
    closure: directory[base]!,
    planeMask: directory[base + 1]!,
    tileEdges: directory[base + 2]!,
    sampleMask,
    sampleCount: popcount32(sampleMask),
  });
}
