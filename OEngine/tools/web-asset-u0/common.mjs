import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const root = fileURLToPath(new URL("../../../", import.meta.url));
export const out = join(root, ".local/web-asset-u0");
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const json = async (path) => JSON.parse(await readFile(path, "utf8"));
export function run(command, args) {
  const result = spawnSync(command, args.map(String), { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command}: ${result.error ?? result.stdout + result.stderr} (${result.status})`);
  return result.stdout;
}
export async function readRange(path, offset, length) {
  const f = await open(path, "r");
  try {
    const bytes = Buffer.alloc(length);
    let at = 0;
    while (at < length) {
      const { bytesRead } = await f.read(bytes, at, length - at, offset + at);
      if (!bytesRead) throw new Error("Unexpected EOF");
      at += bytesRead;
    }
    return bytes;
  } finally { await f.close(); }
}
export async function glbDirectory(path) {
  const header = await readRange(path, 0, 20);
  if (header.toString("ascii", 0, 4) !== "glTF" || header.readUInt32LE(16) !== 0x4e4f534a) throw new Error("Not GLB");
  const length = header.readUInt32LE(12);
  return { document: JSON.parse((await readRange(path, 20, length)).toString()), binOffset: 28 + length };
}
export function metrics(expected, actual, semantic) {
  if (expected.length !== actual.length) throw new Error("Metric size mismatch");
  const mse = [0, 0, 0, 0], max = [0, 0, 0, 0];
  let angleMax = 0, angleSum = 0;
  for (let i = 0; i < expected.length; i += 4) {
    for (let c = 0; c < 4; c++) {
      const d = expected[i + c] - actual[i + c];
      mse[c] += d * d; max[c] = Math.max(max[c], Math.abs(d));
    }
    if (semantic === "normal-linear") {
      const a = [0, 1, 2].map((c) => expected[i + c] / 127.5 - 1);
      const b = [0, 1, 2].map((c) => actual[i + c] / 127.5 - 1);
      const denominator = Math.hypot(...a) * Math.hypot(...b);
      const angle = denominator ? Math.acos(Math.max(-1, Math.min(1, a.reduce((s, x, c) => s + x * b[c], 0) / denominator))) * 180 / Math.PI : 0;
      angleMax = Math.max(angleMax, angle); angleSum += angle;
    }
  }
  const count = expected.length / 4;
  return { mse: mse.map((v) => v / count), max, psnrRgb: mse.slice(0, 3).reduce((a, b) => a + b) ? 10 * Math.log10(255 ** 2 * count * 3 / mse.slice(0, 3).reduce((a, b) => a + b)) : null,
    ...(semantic === "normal-linear" ? { normalAngleMean: angleSum / count, normalAngleMax: angleMax } : {}) };
}
