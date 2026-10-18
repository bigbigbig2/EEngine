import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const examplesRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  root: examplesRoot,
  publicDir: false,
  server: {
    port: 5175,
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
      input: fileURLToPath(new URL("./index.html", import.meta.url))
    }
  }
});
