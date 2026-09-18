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
        "protocol-self-test": resolve(root, "src/cases/protocol-self-test/index.html"),
        "webgpu-component": resolve(root, "src/cases/webgpu-component/index.html"),
        "oegpack-v3-component": resolve(root, "src/cases/oegpack-v3-component/index.html"),
        "virtual-geometry-component": resolve(root, "src/cases/virtual-geometry-component/index.html"),
        "shading-bin-component": resolve(root, "src/cases/shading-bin-component/index.html"),
        "shading-resolve-component": resolve(root, "src/cases/shading-resolve-component/index.html"),
        "sparse-shading-candidate": resolve(root, "src/cases/sparse-shading-candidate/index.html"),
        "sparse-shading-production": resolve(root, "src/cases/sparse-shading-production/index.html"),
        "virtual-product-production": resolve(root, "src/cases/virtual-product-production/index.html"),
        "glb-web-product": resolve(root, "src/cases/glb-web-product/index.html"),
        "virtual-product-replacement": resolve(root, "src/cases/virtual-product-replacement/index.html"),
        "virtual-product-device-loss": resolve(root, "src/cases/virtual-product-device-loss/index.html"),
        "virtual-product-offline": resolve(root, "src/cases/virtual-product-offline/index.html")
      }
    }
  }
});
