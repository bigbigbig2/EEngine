import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeCook, encodePng } from "./cook.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = join(root, ".local/extreme-web-asset/e1-fixtures");
await mkdir(output, { recursive: true });
const cases = [];
for (const semantic of ["color-rgb", "color-rgba", "normal-xy", "data-rgb", "moment-xyz", "scalar-r"]) {
  for (const quality of ["high", "extreme"]) {
    const width = 16,
      height = 16;
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = (y * width + x) * 4;
        rgba.set(
          semantic === "normal-xy"
            ? [112 + x, 112 + y, 250, 255]
            : semantic === "moment-xyz"
              ? [64 + x * 3, 96 + y * 2, 180, 255]
              : [
                  x * 17,
                  y * 17,
                  (x * 17 + y * 31) & 255,
                  semantic === "color-rgba" ? Math.round(((x + y) * 255) / 30) : 255
                ],
          index
        );
      }
    }
    const provided = semantic === "moment-xyz";
    const inputs = [{ width, height, rgba }];
    if (provided) {
      for (let size = 8; size >= 1; size /= 2) {
        const data = new Uint8Array(size * size * 4);
        for (let i = 0; i < data.length; i += 4) data.set([80 + size, 100, 164, 255], i);
        inputs.push({ width: size, height: size, rgba: data });
      }
    }
    const coverage = [];
    for (let size = width; size >= 1; size /= 2) {
      const data = new Uint8Array(size * size * 4);
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          data.set([0, 0, 0, (x + y) % 2 ? 255 : 0], (y * size + x) * 4);
        }
      coverage.push({ width: size, height: size, rgba: data });
    }
    const name = `${semantic}-${quality}`;
    const result = await nativeCook(
      {
        semantic,
        quality,
        mode: "resident",
        mips: provided ? "provided" : "runtime",
        inputs,
        ...(semantic === "scalar-r" ? { scalarChannel: 1 } : {}),
        ...(semantic === "color-rgba" ? { exactCoverage: coverage, alphaScales: [1.1, 1, 1, 1] } : {})
      },
      join(output, name)
    );
    const canonical =
      semantic === "scalar-r"
        ? rgba.map((value, i) => (i % 4 === 3 ? 255 : rgba[Math.floor(i / 4) * 4 + 1]))
        : rgba;
    await writeFile(join(output, name, "original.png"), encodePng({ width, height, rgba: canonical }));
    cases.push({ name, semantic, quality, itemCount: result.directory.items.length });
    console.log(`${name}: ${result.directory.items.length} new schema4 items`);
  }
}
// True NPOT logical dimensions: no rescale, independent physical mip destinations.
for (const [width, height] of [
  [7, 5],
  [1, 1]
]) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set([96, 128, 160, 255], i);
  const name = `npot-${width}x${height}`;
  await nativeCook(
    {
      semantic: "data-rgb",
      quality: "high",
      mode: "resident",
      mips: "runtime",
      inputs: [{ width, height, rgba }]
    },
    join(output, name)
  );
  cases.push({ name, semantic: "data-rgb", quality: "high" });
}
await writeFile(join(output, "cases.json"), JSON.stringify(cases, null, 2));
const alpha = new Uint8Array(16 * 16 * 4);
for (let i = 0; i < alpha.length; i += 4) alpha.set([255, 0, 0, 128], i);
await nativeCook(
  {
    semantic: "color-rgba",
    quality: "high",
    mode: "resident",
    mips: "runtime",
    inputs: [{ width: 16, height: 16, rgba: alpha }]
  },
  join(output, "alpha-constant")
);
console.log(`E1 fixtures: ${cases.length} products, all native AVIF from canonical pixels`);
