import { runCase, lightingSupportSpecifications } from "./native-surface-acceptance-gpu.mjs";
import { LocalLightWorkGenerator } from "../../.test-dist/render/lighting/LocalLightWorkGenerator.js";
import { SurfaceV4 } from "../../.test-dist/render/surface/SurfaceV4.js";
import { nativeSurfacePublicationDescriptors } from "../../.test-dist/shaders/native_surface.js";
import { NATIVE_LOCAL_LIGHTING } from "../../.test-dist/shaders/native_local_lighting.js";
import { GpuNativeMaterialPublication } from "../../.test-dist/gpu/GpuNativeMaterialPublication.js";
import { localLightId } from "../../.test-dist/gpu/GpuLocalLightWorkAbi.js";

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

/** Extra isolated construction in the existing fixture's command. Production owner is unchanged.
 * Old work is still encoded and excluded from the new generator+Surface Cost Card. */
function construction(mode, capacities = {}, fault = null) {
  const requestedMode = (index) => (Array.isArray(mode) ? mode[index % mode.length] : mode);
  let renderer,
    scene,
    camera,
    owner,
    surface,
    materialOwner,
    nativeOwner,
    oldPublication,
    activeCommand,
    frame,
    prepared,
    pending;
  let priorCreate,
    lastProduct,
    lastHeader,
    maxBytes = 0,
    maxPeak = 0;
  const publications = [];
  const readHeader = async () => {
    if (!lastProduct) return;
    const device = renderer.device;
    const readback = device.createBuffer({
      size: 128,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(lastProduct.data, 0, readback, 0, 128);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      lastHeader = Array.from(new Uint32Array(readback.getMappedRange()));
      check(lastHeader[0] === 1 && lastHeader[3] === 23, "Native consumer used a stale ABI/epoch");
      check((lastHeader[2] & 12) === 0, "Count/scatter mismatch/invalid work");
    } finally {
      if (readback.mapState === "mapped") readback.unmap();
      readback.destroy();
    }
  };
  return {
    async initialize(r, s, c) {
      renderer = r;
      scene = s;
      camera = c;
      owner = new LocalLightWorkGenerator(renderer.device, 23);
      surface = new SurfaceV4(renderer.device, true, renderer.graphics);
      await Promise.all([owner.ready, surface.ready]);
      priorCreate = renderer._frameCoordinator.createCommand;
      renderer._frameCoordinator.createCommand = function (graphics, label) {
        const command = priorCreate(graphics, label);
        if (graphics === renderer.graphics && label === "Renderer/visibility-frame") activeCommand = command;
        return command;
      };
    },
    prepare(value) {
      frame = value;
      nativeOwner = renderer.graphics.render_world.runtime(scene).nativeMaterials;
      const snapshot = nativeOwner.prepared ?? nativeOwner.active ?? nativeOwner.candidate;
      if (oldPublication !== frame.publication) {
        oldPublication = frame.publication;
        materialOwner = new GpuNativeMaterialPublication(
          renderer.device,
          renderer.graphics.appearance_programs,
          snapshot.sources.map((source, index) => ({
            ...source,
            ...nativeSurfacePublicationDescriptors(
              source.program,
              snapshot.bindings[index].layoutEntries,
              {
                compact: snapshot.routes.length > 1,
                productGeometry: nativeOwner.productGeometry,
                unlit: snapshot.unlit[index],
                reactive: true,
                physicalSun: nativeOwner.physicalSun && !snapshot.unlit[index]
              },
              renderer.device.limits,
              NATIVE_LOCAL_LIGHTING
            )
          }))
        );
        publications.push(materialOwner);
        pending = materialOwner.ready.then(() => materialOwner.commit());
        prepared = false;
        return;
      }
      const collection = renderer._environments.get(scene).lights;
      const ids = new Uint32Array(collection.pointLights.count + collection.spotLights.count);
      for (let i = 0; i < collection.pointLights.count; i++) ids[i] = localLightId(i, 0);
      for (let i = 0; i < collection.spotLights.count; i++)
        ids[collection.pointLights.count + i] = localLightId(i, 1);
      lastProduct = owner.prepare({
        publication: {
          buffer: collection.buffer_data,
          revision: collection.publicationRevision,
          ids,
          currentRevision: () => collection.publicationRevision
        },
        view: {
          width: frame.width,
          height: frame.height,
          near: camera.near,
          far: camera.far,
          depthConversion: [0, camera.near],
          projection: [camera.projection_matrix[0], camera.projection_matrix[5], 0, 0],
          view: frame.viewMatrix
        },
        frameIndex: frame.frameIndex,
        deviceEpoch: 23,
        visibility: frame.visibility.createView(),
        depth: frame.depth.createView(),
        mode: ids.length ? requestedMode(frame.frameIndex) : 0,
        ...capacities
      });
      maxBytes = Math.max(maxBytes, lastProduct.reservedBytes);
      maxPeak = Math.max(maxPeak, owner.allocatedBytes);
      surface.prepareFrameNow({
        ...frame,
        publication: materialOwner,
        routes: frame.routes.map((route, index) => ({ ...route, ...materialOwner.bins[index] })),
        lightingEntries: [
          ...lastProduct.lightingEntries,
          ...frame.lightingEntries.filter((entry) => entry.binding > 3)
        ]
      });
      prepared = true;
    },
    encode(encoder) {
      if (!prepared) return;
      check(activeCommand && !activeCommand.closed, "Isolated construction lacks the real frame command");
      owner.encode(activeCommand, lastProduct);
      if (fault === "frame") {
        const corruptFrame = new Uint32Array([frame.frameIndex + 1]);
        renderer.device.queue.writeBuffer(lastProduct.parameters, 20, corruptFrame);
        renderer.device.queue.writeBuffer(lastProduct.data, 16, corruptFrame);
      } else if (fault === "extent") {
        renderer.device.queue.writeBuffer(lastProduct.parameters, 0, new Uint32Array([frame.width + 1]));
      }
      // Relabel the existing native consumer for timing, preserving every encoded command.
      const named = new Proxy(encoder, {
        get(target, key) {
          if (key === "beginComputePass")
            return (descriptor = {}) =>
              target.beginComputePass({ ...descriptor, label: `L3.1/${descriptor.label}` });
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
      surface.encode(named);
      activeCommand.onFinished.addOne(() => surface.commit(activeCommand.gpuDone));
      activeCommand.onAborted.addOne(() => surface.abort());
    },
    async settle() {
      await pending;
    },
    async record(profiles) {
      await readHeader();
      const raw = profiles.map((profile) => {
        const passes = profile.gpu.segments.filter((segment) => segment.scope === "pass");
        const work = passes
          .filter((segment) => segment.label.includes("/LocalLightWork/"))
          .reduce((sum, segment) => sum + segment.durationMs, 0);
        const native = passes
          .filter((segment) => segment.label.includes("/L3.1/"))
          .reduce((sum, segment) => sum + segment.durationMs, 0);
        check(
          native > 0 &&
            (requestedMode(profile.frameIndex) !== 2 ||
              lastProduct.request.publication.ids.length === 0 ||
              work > 0),
          "Missing native/light work timing scopes"
        );
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
        finalHeader: lastHeader,
        workMs: distribution(raw.map((row) => row.work)),
        nativeMs: distribution(raw.map((row) => row.native)),
        combinedMs: distribution(raw.map((row) => row.total)),
        modes: Object.fromEntries(
          [...new Set(raw.map((row) => row.requestedMode))].map((value) => {
            const samples = raw.filter((row) => row.requestedMode === value);
            return [
              value,
              {
                workMs: distribution(samples.map((row) => row.work)),
                nativeMs: distribution(samples.map((row) => row.native)),
                combinedMs: distribution(samples.map((row) => row.total))
              }
            ];
          })
        ),
        maxBytes,
        maxPeak,
        raw
      };
    },
    async destroy() {
      if (!renderer) return;
      renderer._frameCoordinator.createCommand = priorCreate;
      await renderer.device.queue.onSubmittedWorkDone();
      await readHeader();
      surface.destroy();
      owner.destroy();
      await Promise.all(publications.map((publication) => publication.retire(Promise.resolve())));
      check(owner.allocatedBytes === 0, "Local light frame owners survived teardown");
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
    scope:
      "L3.1 isolated generator and native consumer with actual Renderer providers; no production ownership switch",
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
      "1080p same fixture/math/providers, frame-interleaved DIRECT/SPARSE, 30+120 samples per mode; old producer excluded from new combined cost",
    cases
  };
}
