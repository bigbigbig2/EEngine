import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeCook } from "./cook.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = join(root, ".local/extreme-web-asset/e2-page-fixtures");
await mkdir(output, { recursive: true });
const inputs = [];
// Full provided domain. This fixture tests assembly, not a new mip filtering algorithm.
for (let size = 385; ; size = Math.max(1, Math.floor(size / 2))) {
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      rgba.set([x & 255, y & 255, (x * 3 + y * 5) & 255, 255], (y * size + x) * 4);
    }
  }
  inputs.push({ width: size, height: size, rgba });
  if (size === 1) break;
}
const cases = [];
for (const address of ["repeat", "clamp-to-edge", "mirror-repeat"]) {
  const name = `npot-385-${address}`;
  const result = await nativeCook(
    {
      semantic: "data-rgb",
      quality: "high",
      mode: "virtual",
      mips: "provided",
      inputs,
      exactCoverage: inputs.map((input) => ({
        ...input,
        rgba: input.rgba.map((value, index) => (index % 4 === 3 ? (index * 31) & 255 : value))
      })),
      exactMode: "virtual",
      cellSize: 128,
      addressU: address,
      addressV: address
    },
    join(output, name)
  );
  cases.push({ name, items: result.directory.items.length });
  console.log(`${name}: ${result.directory.items.length} source owners`);
}
await writeFile(join(output, "cases.json"), JSON.stringify(cases, null, 2));
