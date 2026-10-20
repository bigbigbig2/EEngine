// @ts-expect-error Shared build tooling is plain ESM.
import { imageWorkerAssets } from "../OEngine/tools/image-worker-assets-plugin.mjs";
import { imageKernelsPlugin } from "./shared/image-kernels-plugin";
import { helloImageAssetsPlugin } from "./shared/hello-image-assets-plugin";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { bistroLocalModel } from "./integrated/bistro-texture-compression/local-model";
import { dungeonLocalModel } from "./integrated/dungeon-warkarma-texture-compression/local-model";

const examplesRoot = fileURLToPath(new URL(".", import.meta.url));
const integratedRoot = resolve(examplesRoot, "integrated");
const modulesRoot = resolve(examplesRoot, "modules");

/** Every module or integrated example page becomes a build entry and route. */
function collectExamplePages(directory: string): Record<string, string> {
  const pages: Record<string, string> = {};

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === "dist") continue;
    const child = resolve(directory, entry.name);
    const nested = readdirSync(child, { withFileTypes: true });
    if (nested.some((candidate) => candidate.isFile() && candidate.name === "index.html")) {
      const route = child.slice(examplesRoot.length + 1).replaceAll("\\", "/");
      pages[route] = resolve(child, "index.html");
    }
    Object.assign(pages, collectExamplePages(child));
  }

  return pages;
}

export default defineConfig({
  root: examplesRoot,
  worker: { format: "es", plugins: () => [imageWorkerAssets()] },
  plugins: [imageWorkerAssets(), imageKernelsPlugin(examplesRoot), helloImageAssetsPlugin(examplesRoot), bistroLocalModel(examplesRoot), dungeonLocalModel(examplesRoot)],
  server: {
    port: 5173,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp"
    },
    fs: {
      allow: [examplesRoot, resolve(examplesRoot, "../OEngine")]
    }
  },
  build: {
    outDir: resolve(examplesRoot, "examples-static"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        ...collectExamplePages(integratedRoot),
        ...collectExamplePages(modulesRoot)
      },
      output: {
        // Vite names HTML-entry chunks after the input key, which produces a
        // truncated directory name. Name each entry after its example instead.
        entryFileNames: (chunk) => {
          const id = chunk.facadeModuleId?.replaceAll("\\", "/");
          if (id?.endsWith("/index.html")) {
            const example = id.slice(0, -"/index.html".length).split("/").pop();
            return `assets/${example}-[hash].js`;
          }
          return "assets/[name]-[hash].js";
        }
      }
    }
  }
});
