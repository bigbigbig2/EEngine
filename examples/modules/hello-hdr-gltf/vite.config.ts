// @ts-expect-error Shared build tooling is plain ESM.
import { imageWorkerAssets } from "../../../OEngine/tools/image-worker-assets-plugin.mjs";
import { imageKernelsPlugin } from "../../shared/image-kernels-plugin";
import { helloImageAssetsPlugin } from "../../shared/hello-image-assets-plugin";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const examplesRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  root: examplesRoot,
  worker: { format: "es", plugins: () => [imageWorkerAssets()] },
  plugins: [imageWorkerAssets(), imageKernelsPlugin(examplesRoot), helloImageAssetsPlugin(examplesRoot)],
  publicDir: false,
  server: {
    port: 5178,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp"
    },
    fs: { allow: [examplesRoot, resolve(examplesRoot, "../OEngine")] }
  },
  build: {
    outDir: resolve(examplesRoot, "examples-static"),
    emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL("./index.html", import.meta.url)) }
  }
});
