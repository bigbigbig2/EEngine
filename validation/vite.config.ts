import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  server: {
    host: "127.0.0.1",
    port: 4178,
    strictPort: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp"
    },
    fs: { allow: [root, resolve(root, "../OEngine"), resolve(root, "../examples")] }
  },
  build: {
    target: "es2022",
    outDir: resolve(root, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        "protocol-self-test": resolve(root, "cases/protocol-self-test/index.html"),
        "webgpu-component": resolve(root, "cases/webgpu-component/index.html"),
        "oegpack-v3-component": resolve(root, "cases/oegpack-v3-component/index.html"),
        "virtual-geometry-component": resolve(root, "cases/virtual-geometry-component/index.html"),
        "shading-bin-component": resolve(root, "cases/shading-bin-component/index.html"),
        "shading-resolve-component": resolve(root, "cases/shading-resolve-component/index.html"),
        "sparse-shading-candidate": resolve(root, "cases/sparse-shading-candidate/index.html"),
        "sparse-shading-production": resolve(root, "cases/sparse-shading-production/index.html"),
        "virtual-product-production": resolve(root, "cases/virtual-product-production/index.html"),
        "glb-web-product": resolve(root, "cases/glb-web-product/index.html"),
        "glb-incremental-publication": resolve(root, "cases/glb-incremental-publication/index.html"),
        "virtual-product-replacement": resolve(root, "cases/virtual-product-replacement/index.html"),
        "virtual-product-device-loss": resolve(root, "cases/virtual-product-device-loss/index.html"),
        "virtual-product-offline": resolve(root, "cases/virtual-product-offline/index.html"),
        "virtual-product-observer": resolve(root, "labs/virtual-product-observer/index.html")
      }
    }
  }
});
