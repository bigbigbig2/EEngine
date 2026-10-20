import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Plugin } from "vite";

const names = {
  "bc7-rgb": "spark_bc7_rgb.wgsl", "bc7-rgba": "spark_bc7_rgba.wgsl",
  "bc5-rg": "spark_bc5_rg.wgsl", "bc4-r": "spark_bc4_r.wgsl", utils: "utils.wgsl"
};

/** Dev-only evaluation mounting. Static output requires an explicit caller-owned
 * kernel directory and scope; this plugin does not infer redistribution rights. */
export function imageKernelsPlugin(examplesRoot: string): Plugin {
  const configured = process.env.EENGINE_IMAGE_KERNELS_DIR;
  const directory = configured ? resolve(configured)
    : resolve(examplesRoot, "../.local/extreme-web-asset/sources/spark/src/shaders");
  const scope = configured ? process.env.EENGINE_IMAGE_KERNELS_SCOPE : "local-evaluation";
  async function assets() {
    if (!["local-evaluation", "authorized-production"].includes(scope ?? "")) {
      throw new Error("Explicit EENGINE_IMAGE_KERNELS_SCOPE is required with a kernel directory");
    }
    const files: Record<string, Buffer> = {};
    const hashes: Record<string, string> = {};
    const baseline = JSON.parse(await readFile(resolve(examplesRoot,
      "../.local/extreme-web-asset/sources.json"), "utf8")).sources.spark;
    if (baseline.revision !== "b9ea643a08cb9eef3a9ddc64564089bdd6fd0daf") {
      throw new Error("Image kernel baseline revision mismatch");
    }
    for (const [key, name] of Object.entries(names)) {
      const bytes = await readFile(resolve(directory, name));
      files[key + ".wgsl"] = bytes;
      hashes[key] = createHash("sha256").update(bytes).digest("hex");
      if (hashes[key] !== baseline.files["src/shaders/" + name]) {
        throw new Error(`Image kernel differs from pinned upstream: ${name}`);
      }
    }
    files["identity.json"] = Buffer.from(JSON.stringify({
      revision: "b9ea643a08cb9eef3a9ddc64564089bdd6fd0daf", scope, hashes
    }));
    return files;
  }
  return {
    name: "explicit-image-kernels",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const key = request.url?.split("?")[0]?.replace(/^\/__image-kernels\//, "");
        if (!request.url?.startsWith("/__image-kernels/") ||
            !key || !["identity.json", ...Object.keys(names).map((name) => name + ".wgsl")].includes(key)) return next();
        try {
          const file = (await assets())[key]!;
          response.writeHead(200, { "Content-Length": file.length, "Cache-Control": "no-store" });
          response.end(file);
        } catch (error) {
          response.writeHead(503);
          response.end(String(error));
        }
      });
    },
    async generateBundle() {
      // Do not copy local evaluation shaders into public example builds.
      if (!configured || scope !== "authorized-production") return;
      for (const [name, source] of Object.entries(await assets())) {
        this.emitFile({ type: "asset", fileName: "__image-kernels/" + name, source });
      }
    }
  };
}
