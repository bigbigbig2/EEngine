import {
  captureGpuSparseShadingCapabilityRecord,
  createGpuSparseShadingCapabilityPlan,
  UnsupportedGpuPerformanceBaselineError
} from "../../../../OEngine/src/gpu/GpuSparseShadingCapability.js";
import { createValidationController } from "../../host/protocol.ts";
import { attachGpuErrorCollection, snapshotAdapterInfo, snapshotGpuFeatures, snapshotGpuLimits } from "../../host/webgpu.ts";
import { SparseShadingResolveFixture } from "./fixture.ts";

const status = document.querySelector<HTMLElement>("#status");
let device: GPUDevice | undefined;
let fixture: SparseShadingResolveFixture | undefined;
let errors: ReturnType<typeof attachGpuErrorCollection> | undefined;
let intentionalLoss = false;

const controller = createValidationController({
  caseId: "shading-resolve-component",
  workloadId: "shading-resolve-component-v1"
}, async () => {
  fixture?.destroy();
  errors?.remove();
  intentionalLoss = true;
  device?.destroy();
  const lost = errors === undefined ? null : await Promise.race([
    errors.lost,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000))
  ]);
  return {
    ...fixture?.resourceCounts(),
    devices: 0,
    listeners: 0,
    intentionalDeviceDestroy: intentionalLoss,
    deviceLost: lost === null ? null : { reason: lost.reason, message: lost.message }
  };
});

try {
  controller.transition("negotiating");
  if (!window.isSecureContext || !navigator.gpu) {
    controller.unsupported("WebGPU secure context is unavailable");
  } else {
    const adapter = await navigator.gpu.requestAdapter({ featureLevel: "core", powerPreference: "high-performance" });
    if (!adapter) {
      controller.unsupported("No WebGPU core adapter is available");
    } else {
      const adapterLimits = snapshotGpuLimits(adapter.limits);
      const adapterInfo = adapter.info as GPUAdapterInfo & { readonly subgroupMinSize?: number; readonly subgroupMaxSize?: number };
      let plan;
      try {
        plan = createGpuSparseShadingCapabilityPlan({
          features: adapter.features,
          limits: adapterLimits,
          info: { subgroupMinSize: adapterInfo.subgroupMinSize, subgroupMaxSize: adapterInfo.subgroupMaxSize }
        }, {
          requiredLimits: { maxStorageBuffersPerShaderStage: 12 }
        });
      } catch (error) {
        if (error instanceof UnsupportedGpuPerformanceBaselineError) {
          controller.unsupported(error.message);
          plan = undefined;
        } else throw error;
      }
      if (plan !== undefined) {
        controller.addEvidence("adapter", {
          info: snapshotAdapterInfo(adapter.info),
          features: snapshotGpuFeatures(adapter.features),
          limits: adapterLimits
        });
        device = await adapter.requestDevice({ requiredFeatures: plan.requiredFeatures, requiredLimits: plan.requiredLimits });
        errors = attachGpuErrorCollection(device, controller, () => intentionalLoss);
        const deviceLimits = snapshotGpuLimits(device.limits);
        const capability = captureGpuSparseShadingCapabilityRecord(plan, {
          features: device.features,
          limits: deviceLimits,
          textureFormatFeatures: ["rgba16float-storage", "rgba16uint-storage", "rg32uint-storage", "rg16float-storage"],
          formatProfile: "adr-0013-step-5-wide-v1"
        });
        controller.addEvidence("capability", capability);
        controller.transition("ready");
        controller.transition("warming");
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
        controller.transition("sampling");
        fixture = await SparseShadingResolveFixture.create(device, capability);
        const evidence = await fixture.runAll();
        controller.transition("draining");
        controller.addEvidence("readback", {
          schemaVersion: 1,
          phase: "gpu-execution-oracle",
          ...evidence
        });
        controller.addEvidence("submit", { mainPerScenario: 1, scenarios: evidence.scenarios.length });
        if (status) status.textContent = `passed ${evidence.scenarios.length} GPU resolve scenarios`;
        controller.pass();
      }
    }
  }
} catch (error) {
  controller.fail(error instanceof Error ? error.message : String(error));
}
