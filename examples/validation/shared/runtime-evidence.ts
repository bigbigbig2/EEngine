import type {
  ValidationAdapterIdentity,
  ValidationGpuDiagnostics
} from "../fixture-protocol.ts";
import type {
  BenchmarkAdapterIdentity,
  FrameProfileSnapshot,
  FrameProfiler,
  FrameProfilerDiagnostics
} from "../../../OEngine/src/index.ts";

export function validationAdapter(
  adapter: BenchmarkAdapterIdentity | null,
  device: GPUDevice | null
): ValidationAdapterIdentity | null {
  if (adapter === null || device === null) return null;
  return {
    vendor: adapter.vendor,
    architecture: adapter.architecture,
    device: adapter.device,
    description: adapter.description,
    features: [...device.features].sort(),
    limits: {
      maxBufferSize: Number(device.limits.maxBufferSize),
      maxStorageBufferBindingSize: Number(device.limits.maxStorageBufferBindingSize),
      maxStorageBuffersPerShaderStage: Number(device.limits.maxStorageBuffersPerShaderStage)
    }
  };
}

export function validationDiagnostics(
  diagnostics: FrameProfilerDiagnostics | undefined
): ValidationGpuDiagnostics {
  return {
    validationErrorCount: diagnostics?.validationErrorCount ?? 0,
    uncapturedErrorCount: diagnostics?.uncapturedErrorCount ?? 0,
    deviceLostCount: diagnostics?.deviceLostCount ?? 0,
    uncapturedErrors: diagnostics?.uncapturedErrors ?? [],
    deviceLostReasons: diagnostics?.deviceLostReasons ?? [],
    failedGpuCounterSamples: diagnostics?.failedGpuCounterSamples ?? 0,
    droppedGpuCounterSamples: diagnostics?.droppedGpuCounterSamples ?? 0
  };
}

export function waitForCompletedGpuCounters(
  profiler: FrameProfiler,
  afterFrame: number,
  timeoutMs = 15_000
): Promise<FrameProfileSnapshot> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for GPU counters after frame ${afterFrame}`));
    }, timeoutMs);
    const unsubscribe = profiler.subscribe((snapshot) => {
      if (
        snapshot.frameIndex <= afterFrame ||
        !snapshot.gpuCounters.sampled ||
        snapshot.gpuCounters.pending ||
        snapshot.gpuCounters.dropped
      ) {
        return;
      }
      window.clearTimeout(timeout);
      unsubscribe();
      resolve(snapshot);
    });
  });
}

export function hasGpuFailure(diagnostics: ValidationGpuDiagnostics): boolean {
  return diagnostics.validationErrorCount > 0 ||
    diagnostics.uncapturedErrorCount > 0 ||
    diagnostics.deviceLostCount > 0 ||
    (diagnostics.failedGpuCounterSamples ?? 0) > 0;
}

/**
 * Validation teardown is an explicit one-shot checkpoint, so it may wait for
 * work submitted before RAF was stopped. This prevents pending staging maps
 * from being aborted by Renderer.destroy(). Normal frame rendering never waits.
 */
export async function settleRendererForValidationDestroy(
  renderer: { readonly device: GPUDevice }
): Promise<void> {
  await renderer.device.queue.onSubmittedWorkDone().catch(() => undefined);
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}
