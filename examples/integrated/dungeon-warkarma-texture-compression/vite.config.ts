import { imageKernelsPlugin } from "../../shared/image-kernels-plugin";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { dungeonLocalModel } from "./local-model";

const examplesRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  // Explicit diagnostic build only. Ordinary builds erase both switches.
  define: {
    __EENGINE_PERFORMANCE_DIAGNOSTICS__: process.env.EENGINE_PERFORMANCE_DIAGNOSTICS === "1"
  },
  root: examplesRoot,
  plugins: [imageKernelsPlugin(examplesRoot), dungeonLocalModel(examplesRoot)],
  server: {
    port: 5176,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp"
    },
    fs: { allow: [examplesRoot, resolve(examplesRoot, "../OEngine")] }
  },
  build: {
    sourcemap: true,
    outDir: resolve(examplesRoot, "examples-static/integrated/dungeon-warkarma-texture-compression"),
    emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL("./index.html", import.meta.url)) }
  }
});
