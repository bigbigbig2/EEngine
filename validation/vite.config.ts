import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const authoredLargeSource = resolve(root, "../.local/validation/web-authored-large/large.glb");

const localAssets = Object.freeze([
  Object.freeze({ route: "/assets/web-authored-large/large.glb", path: authoredLargeSource, label: "authored large source" })
]);

function formalAssetPlugin() {
  const hashes = new Map<string, Promise<string>>();
  const sourceHash = (path: string): Promise<string> => {
    const stat = statSync(path), key = `${path}:${stat.size}:${stat.mtimeMs}`;
    let pending = hashes.get(key);
    if (pending === undefined) {
      pending = (async () => {
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(path)) hash.update(chunk);
        const after = statSync(path);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("Validation source changed during hashing");
        return hash.digest("hex");
      })();
      hashes.set(key, pending);
    }
    return pending;
  };
  return {
    name: "oengine-formal-local-assets",
    configureServer(server: import("vite").ViteDevServer) {
      for (const asset of localAssets) server.middlewares.use(asset.route, async (request, response, next) => {
        if (!existsSync(asset.path)) {
          response.statusCode = 404;
          response.end(`${asset.label} is not mounted`);
          return;
        }
        const size = statSync(asset.path).size;
        try {
          const hash = await sourceHash(asset.path);
          response.setHeader("ETag", `"${hash}"`);
          response.setHeader("X-Source-SHA256", hash);
        } catch (error) { next(error); return; }
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
        createReadStream(asset.path, { start, end }).pipe(response);
      });
    }
  };
}

export default defineConfig({
  root,
  plugins: [formalAssetPlugin()],
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
        "phase1-visibility": resolve(root, "cases/phase1-visibility/index.html"),
        "web-authored-large-cook-k0": resolve(root, "cases/web-authored-large-cook-k0/index.html"),
        "virtual-product-observer": resolve(root, "labs/virtual-product-observer/index.html")
      }
    }
  }
});
