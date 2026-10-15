import type { VirtualTextureRoute } from "./VirtualTextureAbi.js";

export interface TextureSurfacePublication {
  readonly slot: number;
  readonly generation: number;
  readonly revision: number;
  /** Live owner revision; revision above remains the publication snapshot. */
  readonly currentRevision?: number;
  readonly currentMinimumMip?: number;
  /** Exact coverage allocation; its bank is resolved in the material-local tuple. */
  readonly coverage?: Readonly<{ segment: number; layer: number }>;
  /** Immutable address recipe and physical objects. Page updates do not revise
   * material identity, coverage, Temporal history or VSM content. */
  readonly virtual?: VirtualTextureRoute;
}
