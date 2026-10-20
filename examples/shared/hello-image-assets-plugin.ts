import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";
// @ts-expect-error Offline Node tooling is intentionally plain ESM.
import { scenePackageFiles } from "../../OEngine/tools/extreme-web-asset/scene-package.mjs";

/** Dynamic manifest/item fetches are not discovered by Vite's import graph. */
export function helloImageAssetsPlugin(examplesRoot: string): Plugin {
  const root = resolve(examplesRoot, "modules/hello-hdr-gltf/assets");
  return {
    name: "hello-image-assets",
    async generateBundle() {
      const { files } = await scenePackageFiles(resolve(root, "cooked"));
      for (const [uri, record] of files) {
        this.emitFile({ type: "asset", fileName: "modules/hello-hdr-gltf/assets/cooked/" + uri,
          source: await readFile(record.path) });
      }
      this.emitFile({ type: "asset", fileName: "modules/hello-hdr-gltf/assets/venice_sunset_1k.hdr",
        source: await readFile(resolve(root, "venice_sunset_1k.hdr")) });
    }
  };
}
