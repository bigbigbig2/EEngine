import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { dungeonLocalModel } from "./local-model";

const examplesRoot = fileURLToPath(new URL("../../../", import.meta.url));
export default defineConfig({
  root: examplesRoot,
  plugins: [dungeonLocalModel(examplesRoot)],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp"
    },
    fs: { allow: [examplesRoot, resolve(examplesRoot, "../OEngine")] }
  },
  build: {
    sourcemap: true,
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL("./index.html", import.meta.url)) }
  }
});
