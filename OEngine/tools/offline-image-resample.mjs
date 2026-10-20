import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Offline canonical filtering only; the executable contains no block encoder. */
export function resampleOfflineImage(executable, scratch, input, srgb, normal) {
  const { width: sw, height: sh, rgba } = input;
  if (!Number.isInteger(sw) || !Number.isInteger(sh) || sw < 1 || sh < 1 ||
      sw > 16384 || sh > 16384 || rgba.byteLength !== sw * sh * 4) {
    throw new RangeError("Offline canonical resampler input exceeds its complete domain");
  }
  const width = Math.max(1, Math.floor(sw / 2));
  const height = Math.max(1, Math.floor(sh / 2));
  const source = join(scratch, "resample-input.rgba");
  const target = join(scratch, "resample-output.rgba");
  writeFileSync(source, rgba);
  const args = [sw, sh, width, height, Number(srgb), Number(normal), source, target].map(String);
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`Canonical resampler failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  }
  const output = readFileSync(target);
  if (output.length !== width * height * 4) throw new Error("Canonical resampler output size mismatch");
  return { width, height, rgba: new Uint8Array(output) };
}
