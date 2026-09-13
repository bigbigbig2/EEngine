import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  server: {
    host: "127.0.0.1",
    port: 4178,
    strictPort: true
  },
  build: {
    target: "es2022",
    outDir: resolve(root, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        "protocol-self-test": resolve(root, "src/cases/protocol-self-test/index.html"),
        "webgpu-component": resolve(root, "src/cases/webgpu-component/index.html"),
        "shading-bin-component": resolve(root, "src/cases/shading-bin-component/index.html"),
        "shading-resolve-component": resolve(root, "src/cases/shading-resolve-component/index.html")
      }
    }
  }
});
