import { readFile, readdir } from "node:fs/promises";
import { resolve, relative } from "node:path";
import type { Plugin } from "vite";

/** Dynamic manifest/item fetches are not discovered by Vite's import graph. */
export function helloImageAssetsPlugin(examplesRoot: string): Plugin {
  const root = resolve(examplesRoot, "modules/hello-hdr-gltf/assets");
  return {
    name: "hello-image-assets",
    async generateBundle() {
      const manifest = JSON.parse(await readFile(resolve(root, "cooked/scene.materials.json"), "utf8"));
      if (manifest.schema !== "oengine-image-scene-materials-v2") {
        throw new Error("Static hello assets require the schema4 scene; final recook belongs to E5");
      }
      const emit = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = resolve(directory, entry.name);
          if (entry.isDirectory()) {
            await emit(path);
          } else if (/\.(?:oegpack|oescene|json|avif|png|bin|hdr)$/u.test(entry.name)) {
            this.emitFile({
              type: "asset",
              fileName: "modules/hello-hdr-gltf/assets/" + relative(root, path).replaceAll("\\", "/"),
              source: await readFile(path)
            });
          }
        }
      };
      await emit(root);
    }
  };
}
