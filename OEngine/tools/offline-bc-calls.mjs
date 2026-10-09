import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Tool-only C ABI calls let the existing PcTextureCook own mip/plane/schema logic.
// The native executable uses the same pinned scalar encoder and resampler.
export function nativeBcCalls(executable, scratch) {
  const heap = new Uint8Array(128 * 1024 * 1024);
  const allocations = new Set();
  let cursor = 16;
  const input = join(scratch, "input.rgba");
  const output = join(scratch, "output.bin");
  const call = (args, source, inputBytes, target, outputBytes) => {
    writeFileSync(input, heap.subarray(source, source + inputBytes));
    const result = spawnSync(executable, args.map(String), { encoding: "utf8", windowsHide: true });
    if (result.status !== 0)
      throw new Error(
        `Native BC ${args[0]} failed: ${result.error?.message ?? result.stderr ?? result.status}`
      );
    const bytes = readFileSync(output);
    if (bytes.length !== outputBytes) throw new Error("Native BC output size mismatch");
    heap.set(bytes, target);
    return 1;
  };
  return {
    HEAPU8: heap,
    _malloc(bytes) {
      const pointer = cursor;
      cursor = Math.ceil((cursor + bytes) / 16) * 16;
      if (cursor > heap.length) throw new Error("Native cook scratch budget exceeded");
      allocations.add(pointer);
      return pointer;
    },
    _free(pointer) {
      allocations.delete(pointer);
      if (!allocations.size) cursor = 16;
    },
    _bc_encode(source, w, h, format, srgb, channel, target) {
      return call(
        ["encode", w, h, format, srgb, input, output, channel],
        source,
        w * h * 4,
        target,
        Math.ceil(w / 4) * Math.ceil(h / 4) * (format === 7 ? 16 : 8)
      );
    },
    _bc_resample(source, sw, sh, target, w, h, srgb, normal) {
      return call(
        ["resample", sw, sh, w, h, srgb, normal, input, output],
        source,
        sw * sh * 4,
        target,
        w * h * 4
      );
    }
  };
}
