import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, relative } from "node:path";
import type { Plugin } from "vite";

/** Fixed dev-only routes. Neither asset is copied into the Vite build. */
export function bistroLocalModel(examplesRoot: string): Plugin {
  const routes = new Map([
    [
      "/assets/local-bistro/BistroExterior_static_fixed_occlusion.glb",
      resolve(examplesRoot, "../.local/models/BistroExterior_static_fixed_occlusion.glb")
    ],
    [
      "/assets/local-bistro/smoke.glb",
      resolve(examplesRoot, "../validation/public/assets/oengine/glb-web-product-v1.glb")
    ]
  ]);
  return {
    name: "bistro-local-model",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = request.url?.split("?")[0] ?? "";
        let source = routes.get(url);
        for (const [prefix, directory] of [
          ["/assets/local-bistro/cooked/", "../.local/models/bistro-cooked"],
          ["/assets/local-bistro/cooked-smoke/", "../.local/offline-scene-smoke/cooked"]
        ]) {
          if (!url.startsWith(prefix!)) continue;
          const root = resolve(examplesRoot, directory!);
          const candidate = resolve(root, decodeURIComponent(url.slice(prefix!.length)));
          const path = relative(root, candidate);
          if (
            !path.startsWith("..") &&
            !path.includes(":") &&
            /\.(?:oegpack|oescene|textureproduct|json)$/u.test(path)
          ) {
            source = candidate;
          }
        }
        if (!source || (request.method !== "GET" && request.method !== "HEAD")) {
          next();
          return;
        }
        try {
          const size = (await stat(source)).size;
          const range = request.headers.range;
          const match = range?.match(/^bytes=(\d+)-(\d*)$/u);
          const start = match ? Number(match[1]) : 0;
          const end = match?.[2] ? Number(match[2]) : size - 1;
          if (
            (range && !match) ||
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            end < start ||
            end >= size
          ) {
            response.writeHead(416, { "Content-Range": `bytes */${size}` });
            response.end();
            return;
          }
          response.writeHead(match ? 206 : 200, {
            "Accept-Ranges": "bytes",
            "Content-Type": source.endsWith(".json") ? "application/json" : "application/octet-stream",
            "Content-Length": end - start + 1,
            "Cache-Control": "no-store",
            ...(match ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {})
          });
          if (request.method === "HEAD") {
            response.end();
            return;
          }
          const stream = createReadStream(source, { start, end, highWaterMark: 256 * 1024 });
          response.on("close", () => stream.destroy());
          stream.on("error", (error) => response.destroy(error));
          stream.pipe(response);
        } catch (error) {
          if (response.headersSent) {
            response.destroy(error instanceof Error ? error : new Error(String(error)));
          } else {
            response.statusCode = 404;
            response.end(`Local model unavailable: ${source}`);
          }
        }
      });
    }
  };
}
