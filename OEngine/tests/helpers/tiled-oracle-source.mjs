import { CookedAssetPreparation } from "../../.test-dist/assets/codec/CookedAssetPreparation.js";
import { TiledTextureSource } from "../../.test-dist/assets/TiledTextureSource.js";
import { textureProductHash } from "../../.test-dist/assets/TextureProduct.js";

/** Static offline products, real HTTP/Worker/decompression/lease path. */
export async function openTiledOracleFixture(name) {
  const base = new URL(`../fixtures/tiled-zstd/${name}/`, import.meta.url);
  const manifestResponse = await fetch(new URL("fixture.json", base));
  if (!manifestResponse.ok) throw new Error("Missing offline tiled oracle fixture");
  const manifest = await manifestResponse.json();
  const preparation = new CookedAssetPreparation({ maxWorkers: 1, maxTileCacheBytes: 0 });
  try {
    const session = preparation.openSession();
    const directory = await preparation.readTiledDirectory(
      session,
      new URL("texture.vtdirectory", base).href,
      manifest.identity,
      manifest.directoryBytes,
    );
    // Independent native BC cold bytes are reference-only, never fed to production IO.
    const response = await fetch(new URL("reference.bin", base));
    if (!response.ok) throw new Error("Missing independent native tile reference");
    const reference = new Uint8Array(await response.arrayBuffer());
    if ((await textureProductHash(reference)) !== manifest.referenceHash) {
      throw new Error("Native tile reference hash mismatch");
    }
    const payloads = [];
    let offset = 0;
    for (const p of directory.metadata.payloads) {
      payloads.push(reference.subarray(offset, offset + p.nativeByteLength));
      offset += p.nativeByteLength;
    }
    if (offset !== reference.length) throw new Error("Native tile reference extent mismatch");
    return {
      source: new TiledTextureSource(preparation, session, directory),
      preparation,
      payloads,
      product: { metadata: directory.metadata.source },
    };
  } catch (error) {
    preparation.dispose();
    throw error;
  }
}
