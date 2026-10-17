import { runScgiProductionGpuOracle } from "./scgi-production-gpu.mjs";

export async function runScgiGatherMaterialsGpuOracle() {
  return runScgiProductionGpuOracle({ gather: true });
}
