import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { cookImageTexture } from "../../.test-dist/assets/codec/ImageTextureCook.js";
import { validateImageAvif } from "../../.test-dist/assets/codec/ImageTextureAvif.js";
import { nativeAvifArguments, qualityAnchors } from "./native-profiles.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function nativeCook(request, output) {
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
        nativeGlue: hash(await readFile(fileURLToPath(import.meta.url)))
      })
    )
  );
  await mkdir(output, { recursive: true });
  const working = join(output, `.work-${randomUUID()}`);
  await mkdir(working);
  const invocations = [];
  const result = await cookImageTexture(
    { ...request, toolHash },
    {
      async encodeAvif(input, semantic, quality) {
        const key = hash(input.rgba);
        const png = join(working, `${key}.png`);
        const avif = join(working, `${key}.avif`);
        await writeFile(png, encodePng(input));
        const args = [...nativeAvifArguments(semantic, qualityAnchors[quality]), "-j", "2", png, avif];
        const run = spawnSync(encoder, args, { encoding: "utf8", windowsHide: true });
        invocations.push({
          argv: [encoder, ...args],
          status: run.status,
          stdout: run.stdout,
          stderr: run.stderr
        });
        await writeFile(join(working, "commands.json"), JSON.stringify(invocations, null, 2));
        if (run.status !== 0) throw new Error(`Native AVIF failed: ${run.stderr}`);
        const bytes = new Uint8Array(await readFile(avif));
        validateImageAvif(bytes, { ...input }, semantic);
        return bytes;
      },
      async put(identity, bytes, kind) {
        const name = `${identity}.${kind === "image" ? "avif" : "bin"}`;
        const path = join(output, name);
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, bytes, { flag: "wx" });
        // Content-addressed immutable payload; publish directory only after every payload succeeds.
        await rename(temporary, path);
        return name;
      }
    }
  );
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
