import { assertTiledTextureDirectory, type TiledTextureDirectory } from "./TiledTextureProduct.js";
import type { CookedAssetPreparation, TiledTexturePayloadLease } from "./codec/CookedAssetPreparation.js";

/** Device-independent, reopenable tile provider. No GPU objects or payload replay.
 * The session owner must outlive every renderer using this source. */
export class TiledTextureSource {
  readonly identity: string;
  readonly metadata;
  constructor(
    readonly preparation: CookedAssetPreparation,
    readonly session: string,
    readonly directory: TiledTextureDirectory
  ) {
    assertTiledTextureDirectory(directory);
    this.identity = directory.identity;
    this.metadata = directory.metadata.source;
  }

  read(
    ids: readonly number[],
    signal?: AbortSignal,
    priority: 0 | 1 | 2 = 1
  ): Promise<TiledTexturePayloadLease> {
    return this.preparation.readTiledPayloads(this.session, this.directory, ids, signal, priority);
  }
}
