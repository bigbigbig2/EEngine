import { withEightSlotCache } from "./fixtures/surface-eight-slot-cache.mjs";
import { runNativeSurfaceIntegrationGpuOracle } from "./native-surface-integration-gpu.mjs";

/** Test-only counterfactual removes the mixed-triangle cache, while retaining
 * exact single-triangle broadcast, pixel interpolation and native lighting. */
export function withoutMixedTriangleCache(source) {
  if (!source.includes("var<workgroup> wg_cache_keys")) return source;
  const begin = source.indexOf("  var cache_slot = select(");
  const end = source.indexOf("  if (!lane_active) { return; }", begin);
  if (begin < 0 || end < 0) throw new Error("Mixed cache counterfactual no longer matches production");
  source =
    source.slice(0, begin) +
    "  let cache_slot = select(0xffffffffu, 0u, tile_broadcast);\n" +
    source.slice(end);
  source = source.replace(
    /  if lane < 8u \{\s*atomicStore\(&wg_cache_keys\[lane\], OENGINE_VISIBILITY_KEY_EMPTY\);\s*wg_cache_valid\[lane\] = 0u;\s*\}/g,
    "",
  );
  source = source.replace(/var<workgroup> wg_cache_(?:keys|valid):[^;]+;\n/g, "");
  source = source.replace(/(var<workgroup> wg_cache_\w+: array<[^>]+), 8>;/g, "$1, 1>;");
  return source;
}

export async function runSurfaceWorkgroupCostGpuOracle(device) {
  const create = device.createShaderModule.bind(device);
  const rows = [];
  let direct = false;
  device.createShaderModule = (descriptor) =>
    create({
      ...descriptor,
      code: descriptor.code.includes("let cache_hit = cache_slot")
        ? direct
          ? withoutMixedTriangleCache(descriptor.code)
          : withEightSlotCache(descriptor.code)
        : descriptor.code,
    });
  try {
    // Identical extent, materials and providers; change only triangle footprint
    // to expose no reuse, intermediate reuse and high reuse in a physical tile.
    for (const cellPixels of [1, 4, 8]) {
      for (const mode of ["eight", "direct", "direct", "eight"]) {
        direct = mode === "direct";
        const result = await runNativeSurfaceIntegrationGpuOracle(device, {
          width: 256,
          height: 256,
          cellPixels,
          cost: true,
        });
        rows.push({
          cellPixels,
          mode,
          measured: result.measured,
          rows: result.rows,
          visiblePixels: result.visiblePixels,
          executionBins: result.executionBins,
        });
      }
    }
    return {
      scope:
        "Local 256x256 triangle-footprint ABBA; not a reduced final-scene benchmark or whole-renderer claim",
      rows,
    };
  } finally {
    device.createShaderModule = create;
  }
}
