import { runCase } from "./native-surface-acceptance-gpu.mjs";

function inspection() {
  let renderer;
  let owner;
  let priorPrepare;
  let frame;
  return {
    async initialize(value) {
      renderer = value;
      owner = renderer._localLightWork;
      priorPrepare = owner.prepare;
      owner.prepare = function (request) {
        frame = priorPrepare.call(owner, request);
        return frame;
      };
    },
    prepare() {},
    async record() {
      const allocation = owner.frames.get(frame)?.allocation;
      if (!allocation) throw new Error("Missing real finalized Lighting allocation");
      const sources = [allocation.data, allocation.settings, allocation.lookup, allocation.scratch];
      const sizes = [128, 32, allocation.lookup.size, allocation.scratch.size];
      const readbacks = sizes.map((size) =>
        renderer.device.createBuffer({
          label: "Lighting/untimed product inspection",
          size,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        })
      );
      try {
        const encoder = renderer.device.createCommandEncoder();
        for (let i = 0; i < sources.length; i++) {
          encoder.copyBufferToBuffer(sources[i], 0, readbacks[i], 0, sizes[i]);
        }
        renderer.device.queue.submit([encoder.finish()]);
        await Promise.all(readbacks.map((buffer) => buffer.mapAsync(GPUMapMode.READ)));
        const [header, settings, ranges, scratch] = readbacks.map(
          (buffer) => new Uint32Array(buffer.getMappedRange())
        );
        if (header[0] !== 1 || header[1] !== 2 || header[2] !== 0) {
          throw new Error("Inspection requires valid finalized SPARSE work");
        }
        const clusters = header[10];
        const tiles = clusters / 24;
        let activeSurfaceClusters = 0;
        for (let tile = 0; tile < tiles; tile++) {
          let mask = scratch[settings[5] + tile];
          if (mask >>> 24) throw new Error("Occupancy exceeds the published 24 slices");
          while (mask) {
            mask = (mask & (mask - 1)) >>> 0;
            activeSurfaceClusters++;
          }
        }
        let indices = 0;
        let nonemptyLightClusters = 0;
        let maxListLength = 0;
        for (let cluster = 0; cluster < clusters; cluster++) {
          const offset = ranges[cluster * 2];
          const count = ranges[cluster * 2 + 1];
          if (count > header[6] || offset + count > header[11]) {
            throw new Error("Finalized range exceeds admission/index capacity");
          }
          if (count) nonemptyLightClusters++;
          indices += count;
          maxListLength = Math.max(maxListLength, count);
        }
        if (indices !== header[13] || nonemptyLightClusters > activeSurfaceClusters) {
          throw new Error("Finalized ranges disagree with header/Surface occupancy");
        }
        return {
          scope: "Untimed read-only finalized GPU product; no current-frame CPU control",
          finalHeader: [...header],
          activeSurfaceClusters,
          nonemptyLightClusters,
          maxListLength,
          meanPerActiveSurfaceCluster: indices / Math.max(1, activeSurfaceClusters),
          meanPerNonemptyLightCluster: indices / Math.max(1, nonemptyLightClusters),
          indicesWritten: indices,
          globalCount: header[8]
        };
      } finally {
        for (const buffer of readbacks) {
          if (buffer.mapState === "mapped") buffer.unmap();
          buffer.destroy();
        }
      }
    },
    async destroy() {
      owner.prepare = priorPrepare;
    }
  };
}

export async function runLightingProductInspectionGpuOracle() {
  const cases = [];
  for (const specification of [
    { name: "sparse-product", type: "mixed", distribution: "sparse", counts: [1, 64, 128] },
    { name: "overlap-product", type: "point", distribution: "overlap", counts: [128] }
  ]) {
    cases.push(
      await runCase({
        name: specification.name,
        construction: inspection(),
        lighting: { ...specification, correctnessOnly: true }
      })
    );
  }
  return { verdict: "passed", cases, limitations: ["Untimed diagnostic snapshots, not performance samples"] };
}
