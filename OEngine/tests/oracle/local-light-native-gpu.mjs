import { runCase, lightingSupportSpecifications } from "./native-surface-acceptance-gpu.mjs";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const distribution = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  check(sorted.length && sorted.every(Number.isFinite), "Missing light cost samples");
  return {
    count: sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1)
  };
};

/** Exercise the sole production owner. Overrides are oracle inputs, not a renderer selector. */
function construction(mode, capacities = {}, fault = null) {
  const requestedMode = (index) => (Array.isArray(mode) ? mode[index % mode.length] : mode);
  let renderer, owner, priorPrepare, lastProduct;
  let maxBytes = 0,
    maxPeak = 0;
  return {
    async initialize(r) {
      renderer = r;
      owner = renderer._localLightWork;
      priorPrepare = owner.prepare;
      owner.prepare = function (request) {
        lastProduct = priorPrepare.call(owner, {
          ...request,
          mode: request.publication.ids.length ? requestedMode(request.frameIndex) : 0,
          ...capacities
        });
        maxBytes = Math.max(maxBytes, lastProduct.reservedBytes);
        maxPeak = Math.max(maxPeak, owner.allocatedBytes);
        return lastProduct;
      };
    },
    prepare(frame) {
      if (fault === "frame") {
        const corrupt = new Uint32Array([frame.frameIndex + 1]);
        renderer.device.queue.writeBuffer(lastProduct.parameters, 20, corrupt);
        renderer.device.queue.writeBuffer(lastProduct.data, 16, corrupt);
      } else if (fault === "extent") {
        renderer.device.queue.writeBuffer(lastProduct.parameters, 0, new Uint32Array([frame.width + 1]));
      }
    },
    async record(profiles) {
      const readback = renderer.device.createBuffer({
        size: 128,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      let finalHeader;
      try {
        const encoder = renderer.device.createCommandEncoder();
        encoder.copyBufferToBuffer(lastProduct.data, 0, readback, 0, 128);
        renderer.device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        finalHeader = Array.from(new Uint32Array(readback.getMappedRange()));
        check(finalHeader[0] === 1 && finalHeader[3] === renderer.deviceEpoch, "Stale production ABI/epoch");
        check((finalHeader[2] & 12) === 0, "Count/scatter mismatch/invalid work");
      } finally {
        if (readback.mapState === "mapped") readback.unmap();
        readback.destroy();
      }
      const raw = profiles.map((profile) => {
        check(profile.submits.count === 1, "Production encoded multiple submits");
        check(profile.graph.cacheMisses === 0 && profile.graph.cacheHits === 1, "Stable graph rebuilt");
        const passes = profile.gpu.segments.filter((segment) => segment.scope === "pass");
        const work = passes
          .filter((segment) => segment.label.includes("/LocalLightWork/"))
          .reduce((sum, segment) => sum + segment.durationMs, 0);
        const native = passes
          .filter((segment) => segment.label.includes("/SurfaceV4/") && !segment.label.includes("/bins "))
          .reduce((sum, segment) => sum + segment.durationMs, 0);
        check(native > 0, "Missing actual production Surface timestamps");
        return {
          frameIndex: profile.frameIndex,
          requestedMode: requestedMode(profile.frameIndex),
          work,
          native,
          total: work + native
        };
      });
      return {
        requestedMode: mode,
        finalHeader,
        maxBytes,
        maxPeak,
        workMs: distribution(raw.map((row) => row.work)),
        nativeMs: distribution(raw.map((row) => row.native)),
        combinedMs: distribution(raw.map((row) => row.total)),
        raw
      };
    },
    async destroy() {
      owner.prepare = priorPrepare;
      await renderer.device.queue.onSubmittedWorkDone();
      // Retirement is checked again after Renderer.destroy by the shared harness.
    }
  };
}

export async function runLocalLightNativeGpuOracle() {
  const cases = [];
  for (const mode of [1, 2]) {
    cases.push(
      await runCase({
        name: `local-native-${mode}`,
        construction: construction(mode),
        lighting: { type: "mixed", distribution: "sparse", counts: [0, 1, 4, 8, 32], correctnessOnly: true }
      })
    );
  }
  cases.push(
    await runCase({
      name: "local-native-overflow",
      construction: construction(2, { indexCapacity: 1 }),
      lighting: { type: "mixed", distribution: "overlap", counts: [32], correctnessOnly: true }
    })
  );
  cases.push(
    await runCase({
      name: "local-native-custom",
      complex: true,
      programs: 8,
      construction: construction(2),
      lighting: { type: "mixed", distribution: "sparse", counts: [32], correctnessOnly: true }
    })
  );
  for (const specification of lightingSupportSpecifications()) {
    cases.push(
      await runCase({
        name: `local-native-${specification.name}`,
        construction: construction(2),
        lighting: { ...specification, counts: [1], correctnessOnly: true, distribution: "boundary" }
      })
    );
  }
  const rejectedContexts = [];
  for (const fault of ["frame", "extent"]) {
    let detected = false;
    try {
      await runCase({
        name: `local-native-stale-${fault}`,
        construction: construction(1, {}, fault),
        lighting: { type: "mixed", counts: [1], correctnessOnly: true }
      });
    } catch (error) {
      // rgba16float storage can clamp the invalid-context sentinel to 65504.
      // The independent HDR numeric gate must still reject that exact poisoned output.
      if (!/^Independent point-light delta 1: 655/.test(error.message)) throw error;
      detected = true;
    }
    check(detected, `Stale consumer ${fault} was silently accepted`);
    rejectedContexts.push(fault);
  }
  return {
    verdict: "passed",
    scope: "L3.2 sole production generator and native consumer, cache reuse and finalized modes",
    cases,
    rejectedContexts
  };
}

export async function runLocalLightCostGpuOracle() {
  const cases = [];
  for (const specification of [
    { name: "sparse", type: "mixed", distribution: "sparse", counts: [0, 1, 4, 8, 32, 64] },
    { name: "overlap", type: "mixed", distribution: "overlap", counts: [1, 4, 8, 32] },
    { name: "low-coverage", type: "mixed", distribution: "sparse", counts: [1, 4, 8], cameraZ: 12 }
  ]) {
    cases.push(
      await runCase({
        name: `local-cost-${specification.name}`,
        construction: construction([1, 2]),
        lighting: { ...specification, sampleCount: 240, warmupFrames: 60 }
      })
    );
  }
  return {
    verdict: "passed",
    scope:
      "1080p same fixture/math/providers, frame-interleaved DIRECT/SPARSE, 30+120 samples per mode; sole production owner",
    cases
  };
}
