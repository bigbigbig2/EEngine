import { createValidationController, attachGpuErrorCollection, withGpuErrorScopes,
  snapshotAdapterInfo, snapshotGpuFeatures, snapshotGpuLimits } from "../../harness/browser.ts";
// Use legal current Product publications and independent complete-set and
// fail-closed assertions. Do not restore the retired visibility shader/heap.
// @ts-expect-error Browser oracle is an intentionally untyped .mjs test module.
import { runGeometryProductScaleGpuOracle } from "../../../OEngine/tests/oracle/geometry-product-scale-gpu.mjs";

let device: GPUDevice | undefined;
let collection: ReturnType<typeof attachGpuErrorCollection> | undefined;
let disposed = false;
const controller = createValidationController({ caseId: "virtual-geometry-component",
  workloadId: "virtual-geometry-component-v1" }, async () => {
  collection?.remove();
  disposed = true;
  device?.destroy();
  return { disposed };
});
void run();
async function run() {
  try {
    controller.transition("negotiating");
    const adapter = await navigator.gpu.requestAdapter({ featureLevel: "core" });
    if (!adapter || !adapter.features.has("timestamp-query") || adapter.limits.maxStorageBuffersPerShaderStage < 16) {
      controller.unsupported("Current Product oracle requires timestamps and sixteen storage bindings");
      return;
    }
    controller.addEvidence("adapter", { info: snapshotAdapterInfo(adapter.info),
      features: snapshotGpuFeatures(adapter.features), limits: snapshotGpuLimits(adapter.limits) });
    device = await adapter.requestDevice({ requiredFeatures: ["timestamp-query"], requiredLimits: {
      maxStorageBuffersPerShaderStage: 16,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize
    } });
    collection = attachGpuErrorCollection(device, controller, () => disposed);
    controller.transition("ready");
    controller.transition("warming");
    controller.transition("sampling");
    const result = await withGpuErrorScopes(device, "Current Product complete-work oracle", () =>
      runGeometryProductScaleGpuOracle(device));
    controller.addEvidence("completeWorkAndFailureControls", result.value);
    controller.transition("draining");
    await device.queue.onSubmittedWorkDone();
    controller.pass();
  } catch (error) {
    controller.fail(error instanceof Error ? error.stack ?? error.message : String(error));
  }
}
