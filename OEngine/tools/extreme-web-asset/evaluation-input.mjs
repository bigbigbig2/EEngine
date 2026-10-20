import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cookImageTexture as cook } from "../../.test-dist/assets/codec/ImageTextureCook.js";
import { encodePng } from "./cook.mjs";
import { contentHash } from "./search.mjs";

/** Lossless canonical images feed the same preparation/mip/assembly path.
 * The recorder's pre-BC logical textures provide the reference, not a local
 * replacement mip filter or a BC roundtrip used as its own expected value. */
export async function cookImageTexture(request, directory) {
  await mkdir(directory, { recursive: true });
  const result = await cook(
    { ...request, toolHash: contentHash("canonical-reference-png-v1") },
    {
      imageCodec: "png",
      encodeAvif: async (input) => encodePng(input),
      async put(hash, bytes, kind) {
        const name = hash + (kind === "exact" ? ".bin" : ".png");
        await writeFile(join(directory, name), bytes);
        return name;
      }
    }
  );
  await writeFile(join(directory, "directory.json"), result.bytes);
  return result;
}
