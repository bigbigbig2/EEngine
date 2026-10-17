import type { FrameGraphBindingLayout } from "../../framegraph/FrameGraph.js";
import { SCGI_ABI } from "./ScgiAbi.js";
import type { ScgiArenaPlan } from "./ScgiCapacity.js";

export interface ScgiBufferProduct {
  readonly buffer: GPUBuffer;
  readonly plan: ScgiArenaPlan;
}

export interface ScgiFieldProduct {
  /** Ordered segments partition the linear half-pixel domain without overlap. */
  readonly segments: readonly ScgiBufferProduct[];
}

/** An encoded semantic publication is not a GPU-completion certificate. */
export interface ScgiFramePublication {
  readonly deviceEpoch: number;
  readonly sceneEpoch: number;
  readonly viewEpoch: number;
  readonly addressGeneration: number;
  readonly generation: number;
  readonly sampleSerial: number;
  readonly extent: readonly [number, number];
  readonly halfExtent: readonly [number, number];
  readonly radianceDomain: "linear-rec709-unexposed";
  coefficientScale: number;
  readonly previousCoefficientScale: number;
  readonly activeWorld: ScgiBufferProduct | null;
  readonly candidateWorld: ScgiBufferProduct;
  readonly previousWorldField: ScgiFieldProduct | null;
  readonly candidateWorldField: ScgiFieldProduct;
  readonly privateScratch: ScgiBufferProduct;
  readonly queryBatch: ScgiBufferProduct;
  readonly anchors: readonly ScgiBufferProduct[];
  status: "prepared" | "encoded" | "submitted" | "aborted" | "poisoned";
  /** Declared by the real producer after its complete write domain is encoded. */
  fieldComplete: boolean;
  cacheComplete: boolean;
}

export interface ScgiCompoundFact {
  readonly generation: number;
  readonly halfExtent: readonly [number, number];
  readonly fieldStride: 112;
  readonly identityBytes: 64;
  readonly completeWrite: boolean;
  readonly domain: "linear-rec709-unexposed";
}

export function assertScgiCompoundFact(publication: ScgiFramePublication, fact: ScgiCompoundFact): void {
  if (
    publication.status === "aborted" ||
    publication.status === "poisoned" ||
    publication.status === "prepared" ||
    !publication.fieldComplete ||
    !fact.completeWrite ||
    fact.generation !== publication.generation ||
    fact.domain !== publication.radianceDomain ||
    fact.fieldStride !== SCGI_ABI.halfField.stride ||
    fact.identityBytes !== SCGI_ABI.identity.stride ||
    !Number.isFinite(publication.coefficientScale) ||
    publication.coefficientScale <= 0 ||
    fact.halfExtent[0] !== publication.halfExtent[0] ||
    fact.halfExtent[1] !== publication.halfExtent[1]
  ) {
    throw new Error("SCGI compound field/guide/identity is incomplete or incompatible");
  }
  const count = publication.halfExtent[0] * publication.halfExtent[1];
  let covered = 0;
  for (const segment of publication.candidateWorldField.segments) {
    const range = segment.plan.ranges.worldField;
    if (
      range === undefined ||
      range.stride !== SCGI_ABI.halfField.stride ||
      range.bytes !== range.count * SCGI_ABI.halfField.stride ||
      range.offset + range.bytes > segment.buffer.size
    ) {
      throw new Error("SCGI field/guide/identity buffer does not cover its complete extent");
    }
    covered += range.count;
  }
  if (covered !== count) {
    throw new Error("SCGI field segments do not partition their half-pixel domain");
  }
}

/** Cached graphs use the existing FrameGraph slot mechanism. No first-frame
 * GPU object is captured in a future graph execution. SCGI-8 supplies the fact. */
export function bindScgiPublication<TBindings>(
  layout: FrameGraphBindingLayout<TBindings>,
  initial: TBindings,
  resolve: (bindings: TBindings) => ScgiFramePublication,
): ScgiFramePublication {
  return layout.slot("scgi-publication", initial, resolve);
}
