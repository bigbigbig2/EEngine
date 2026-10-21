import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { cookImageTexture } from "../../.test-dist/assets/codec/ImageTextureCook.js";
import { validateImageAvif } from "../../.test-dist/assets/codec/ImageTextureAvif.js";
import { nativeAvifArguments, qualityAnchors } from "./native-profiles.mjs";
import { ImageSearchCache } from "./search-cache.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function nativeCook(
  request,
  output,
  candidate = { quality: qualityAnchors[request.quality], speed: 4 }
) {
  const build = JSON.parse(await readFile(join(root, ".local/extreme-web-asset/native-build.json"), "utf8"));
  const encoder = join(root, build.binaries["avifenc.exe"].path);
  if (hash(await readFile(encoder)) !== build.binaries["avifenc.exe"].sha256)
    throw new Error("AVIF encoder identity changed");
  const toolHash = hash(
    Buffer.from(
      JSON.stringify({
        encoder: build.binaries["avifenc.exe"].sha256,
        profiles: hash(await readFile(new URL("./native-profiles.mjs", import.meta.url))),
        cooker: hash(
          await readFile(new URL("../../.test-dist/assets/codec/ImageTextureCook.js", import.meta.url))
        ),
        nativeGlue: hash(await readFile(fileURLToPath(import.meta.url))),
        candidate
      })
    )
  );
  await mkdir(output, { recursive: true });
  const working = join(output, `.work-${randomUUID()}`);
  await mkdir(working);
  const invocations = [];
  const payloadWrites = new Map();
  const pendingEncodes = new Map();
  const concurrency = Number(
    process.env.EENGINE_AVIF_CONCURRENCY ?? Math.min(8, Math.max(1, Math.floor(availableParallelism() / 2)))
  );
  const encodedCache = new ImageSearchCache(
    join(root, ".local/extreme-web-asset/encoded-cache"),
    8 * 1024 * 1024
  );
  const result = await cookImageTexture(
    { ...request, toolHash },
    {
      encodeConcurrency: concurrency,
      async encodeAvif(input, semantic, quality) {
        const key = hash(input.rgba);
        const name = `${key}-${randomUUID()}`;
        const png = join(working, `${name}.png`);
        const avif = join(working, `${name}.avif`);
        const args = [
          ...nativeAvifArguments(semantic, candidate.quality, candidate.speed),
          "-j",
          "2",
          png,
          avif
        ];
        const cacheKey = encodedCache.key(toolHash, {
          input: key,
          width: input.width,
          height: input.height,
          argv: args.slice(0, -2),
          semantic
        });
        const cached = await encodedCache.read(cacheKey);
        if (cached) {
          const bytes = new Uint8Array(Buffer.from(cached.bytes, "base64"));
          if (hash(bytes) !== cached.hash) throw new Error("Encoded cache payload hash mismatch");
          if (!Array.isArray(cached.invocation?.argv) || cached.invocation.status !== 0) {
            throw new Error("Encoded cache is missing its actual native command receipt");
          }
          validateImageAvif(bytes, input, semantic);
          invocations.push({ ...cached.invocation, cacheHit: true });
          return bytes;
        }
        const prior = pendingEncodes.get(cacheKey);
        if (prior) return prior;
        const pending = (async () => {
          await writeFile(png, encodePng(input));
          const run = await new Promise((accept, reject) => {
            const child = spawn(encoder, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
            let stdout = "",
              stderr = "";
            let failure;
            const append = (kind, bytes) => {
              if (failure) return;
              if (kind === "stdout") stdout += bytes;
              else stderr += bytes;
              if (stdout.length + stderr.length > 4 * 1024 * 1024) {
                failure = new Error("Native AVIF diagnostic output exceeded capacity");
                child.kill();
              }
            };
            child.stdout.on("data", (bytes) => append("stdout", bytes));
            child.stderr.on("data", (bytes) => append("stderr", bytes));
            child.once("error", (error) => {
              failure = error;
            });
            child.once("close", (status) => (failure ? reject(failure) : accept({ status, stdout, stderr })));
          });
          const invocation = {
            argv: [encoder, ...args],
            status: run.status,
            stdout: run.stdout,
            stderr: run.stderr
          };
          invocations.push(invocation);
          await writeFile(join(working, `${name}.command.json`), JSON.stringify(invocation, null, 2));
          if (run.status !== 0) throw new Error(`Native AVIF failed: ${run.stderr}`);
          const bytes = new Uint8Array(await readFile(avif));
          validateImageAvif(bytes, { ...input }, semantic);
          await encodedCache.write(cacheKey, {
            hash: hash(bytes),
            bytes: Buffer.from(bytes).toString("base64"),
            invocation
          });
          // Persist diagnostics/cache first; retain the complete native input on failure.
          await unlink(png);
          await unlink(avif);
          return bytes;
        })();
        pendingEncodes.set(cacheKey, pending);
        try {
          return await pending;
        } finally {
          pendingEncodes.delete(cacheKey);
        }
      },
      async put(identity, bytes, kind) {
        const name = `${identity}.${kind === "image" ? "avif" : "bin"}`;
        let pending = payloadWrites.get(name);
        if (!pending) {
          pending = (async () => {
            const path = join(output, name);
            try {
              const existing = await readFile(path);
              if (hash(existing) !== identity) throw new Error("Immutable image payload conflict");
              return;
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
            const temporary = `${path}.${randomUUID()}.tmp`;
            await writeFile(temporary, bytes, { flag: "wx" });
            await rename(temporary, path);
          })();
          payloadWrites.set(name, pending);
        }
        await pending;
        return name;
      }
    }
  );
  await writeFile(join(working, "commands.json"), JSON.stringify(invocations, null, 2));
  await writeFile(join(output, "commands.json"), JSON.stringify(invocations, null, 2));
  const temporary = join(output, `directory-${randomUUID()}.tmp`);
  await writeFile(temporary, result.bytes, { flag: "wx" });
  await rename(temporary, join(output, "directory.json"));
  return result;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const header = Buffer.alloc(8),
    tail = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  header.write(type, 4);
  tail.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])));
  return Buffer.concat([header, data, tail]);
}
export function encodePng({ width, height, rgba }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let row = 0; row < height; row++)
    rows.set(rgba.subarray(row * width * 4, (row + 1) * width * 4), row * (width * 4 + 1) + 1);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}
