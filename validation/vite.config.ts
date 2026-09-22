import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream, existsSync, statSync } from "node:fs";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const formal100mSource = resolve(root, "../.local/validation/web-100m-phase-a-baseline/single-giant-100m.glb");

function formal100mAssetPlugin() {
  return {
    name: "oengine-formal-100m-local-asset",
    configureServer(server: import("vite").ViteDevServer) {
      server.middlewares.use("/assets/web-100m/single-giant-100m.glb", (request, response) => {
        if (!existsSync(formal100mSource)) {
          response.statusCode = 404;
          response.end("formal 100M source is not mounted");
          return;
        }
        const size = statSync(formal100mSource).size;
        response.setHeader("Accept-Ranges", "bytes");
        response.setHeader("Content-Type", "model/gltf-binary");
        if (request.method === "HEAD") {
          response.setHeader("Content-Length", size);
          response.statusCode = 200;
          response.end();
          return;
        }
        const match = /^bytes=(\d+)-(\d*)$/u.exec(request.headers.range ?? "");
        const start = match === null ? 0 : Number(match[1]);
        const end = match === null || match[2] === "" ? size - 1 : Math.min(size - 1, Number(match[2]));
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
          response.statusCode = 416;
          response.setHeader("Content-Range", `bytes */${size}`);
          response.end();
          return;
        }
        response.statusCode = match === null ? 200 : 206;
        response.setHeader("Content-Length", end - start + 1);
        if (match !== null) response.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
        createReadStream(formal100mSource, { start, end }).pipe(response);
      });
    }
  };
}

export default defineConfig({
  root,
  plugins: [formal100mAssetPlugin()],
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
        "web-100m-formal-perf": resolve(root, "cases/web-100m-formal-perf/index.html"),
        "virtual-product-observer": resolve(root, "labs/virtual-product-observer/index.html")
      }
    }
  }
});
