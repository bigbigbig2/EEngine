import { runVsmR3GpuOracle } from "./vsm-v4-r3-gpu.mjs";

/** Compare the exact production small-list path with the same conservative
 * hierarchy forced on every list. No change to page/pair/partition semantics. */
export async function runVsmCasterCostGpuOracle(device) {
  const create = device.createShaderModule.bind(device);
  const rows = [];
  let hierarchy = false;
  device.createShaderModule = (descriptor) => {
    let code = descriptor.code;
    if (hierarchy && code.includes("fn record_direct_pair")) {
      const begin = code.indexOf("  if (dirty_count < 64u) {");
      if (begin < 0) throw new Error("Caster cost reference no longer matches small-list path");
      let depth = 1,
        end = code.indexOf("{", begin) + 1;
      for (; depth > 0; end++) {
        if (code[end] === "{") depth++;
        if (code[end] === "}") depth--;
      }
      code = code.slice(0, begin) + code.slice(end);
    }
    return create({ ...descriptor, code });
  };
  try {
    for (const mode of ["hierarchy", "small-direct", "small-direct", "hierarchy"]) {
      hierarchy = mode === "hierarchy";
      const result = await runVsmR3GpuOracle(device);
      rows.push({ mode, costs: result.costs, cases: result.cases, abortRetry: result.abortRetry });
    }
    return { scope: "Local caster/partition ABBA; no whole-renderer performance claim", rows };
  } finally {
    device.createShaderModule = create;
  }
}
