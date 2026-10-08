import { authoredTexture } from "./native-surface-production-gpu.mjs";
import { directReference, workingColor } from "./native-surface-reference.mjs";
import { Renderer } from "../../.test-dist/render/pipeline/RendererCore.js";
import { SurfaceV4 } from "../../.test-dist/render/surface/SurfaceV4.js";
import { createLightingInspection } from "./lighting-inspection-gpu.mjs";
import { Scene } from "../../.test-dist/scene/Scene.js";
import { Mesh } from "../../.test-dist/scene/Mesh.js";
import { BoxGeometry, buildBoxSourceGeometry } from "../../.test-dist/geometry/BoxGeometry.js";
import { cookGeometryAssetPackage } from "../../.test-dist/geometry/GeometryCooker.js";
import { createGeometryCookRecipe } from "../../.test-dist/assets/GeometryCookRecipe.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import {
  AppearanceGraphBuilder,
  snapshotAppearanceTexture
} from "../../.test-dist/material/AppearanceGraph.js";
import { PointLight } from "../../.test-dist/light/PointLight.js";
import { SpotLight } from "../../.test-dist/light/SpotLight.js";
import { PerspectiveCamera } from "../../.test-dist/camera/PerspectiveCamera.js";
import { decodeFloat16 } from "../../.test-dist/core/Float16.js";
import { createPackedSceneSourceFromScene } from "../../.test-dist/gpu/GpuSceneAdapter.js";
import { GPU_INSTANCE_FLAGS } from "../../.test-dist/gpu/GpuInstanceAbi.js";
import { GPU_VISIBILITY_KEY_MESHLET_WORK_SLOT_MASK } from "../../.test-dist/gpu/GpuVisibilityKeyAbi.js";
import { summarizeGpuTimingCost } from "../../.test-dist/debug/GpuTimingCost.js";
import { lightSphereDistanceAttenuation } from "../../.test-dist/render/ClusteredLightingReference.js";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const normalize = (v) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
const distribution = (values) => {
  check(values.length > 0 && values.every(Number.isFinite), "Missing finite acceptance measurements");
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1)
  };
};

function customGraph(textures, repetitions) {
  const g = new AppearanceGraphBuilder();
  const uv = g.input("uv0", 2, "surface", undefined, "uv0");
  let coordinate = uv;
  for (let i = 0; i < repetitions; i++) {
    coordinate = g.operation(
      "add",
      uv,
      g.operation(
        "multiply",
        g.operation("sin", g.operation("multiply", coordinate, g.constant(3 + i))),
        g.constant(0.02)
      )
    );
  }
  const normal = g.texture(snapshotAppearanceTexture(textures.normal, "linear-rgb"), coordinate);
  const shifted = g.operation(
    "add",
    coordinate,
    g.operation("multiply", g.swizzle(normal, [0, 1]), g.constant(0.002))
  );
  const color = g.texture(snapshotAppearanceTexture(textures.color, "srgb-rgb"), shifted);
  const orm = g.texture(snapshotAppearanceTexture(textures.orm, "linear-rgb"), coordinate);
  const normalTs = g.operation(
    "subtract",
    g.operation("multiply", g.swizzle(normal, [0, 1, 2]), g.constant(2)),
    g.constant(1)
  );
  g.output("baseColor", g.operation("multiply", g.swizzle(color, [0, 1, 2]), g.parameter("gain", 0.7)));
  g.output("alpha", g.constant(1));
  g.output("normalTS", normalTs);
  g.output("roughness", g.operation("multiply", g.swizzle(orm, [1]), g.constant(0.8)));
  g.output("metallic", g.operation("multiply", g.swizzle(orm, [2]), g.constant(0.2)));
  g.output("occlusion", g.swizzle(orm, [0]));
  g.output("emissive", g.constant([0.01, 0.005, 0.002]));
  g.output("ior", g.constant(1.5));
  g.output("specularWeight", g.constant(1));
  g.output("specularColor", g.constant([1, 1, 1]));
  g.output("coatWeight", g.constant(0.4));
  g.output("coatRoughness", g.constant(0.3));
  g.output("coatNormalTS", normalTs);
  return { schemaVersion: 1, graph: g.build() };
}

/** S3 actual production Renderer workload. No alternate shader, provider fixture,
 * graph lowering or renderer is installed. Readbacks occur only on untimed
 * inspection frames. CPU timing covers renderer.render; waits are host-side.
 * This generated scene complements the authored Showcase, not a whole-renderer
 * quality/streaming acceptance claim. */
export async function runCase({
  name,
  programs = 1,
  complex = false,
  unlit = false,
  lighting = null,
  construction = null
}) {
  const width = 1920,
    height = 1080;
  const cameraZ = lighting?.cameraZ ?? 6;
  const sampleCount = lighting?.correctnessOnly ? 1 : (lighting?.sampleCount ?? 120);
  const renderer = new Renderer({
    autoExposure: false,
    fixedExposure: 1,
    textureMaxResolution: 256,
    requiredFeatures: ["timestamp-query"]
  });
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("webgpu");
  check(context, "Acceptance canvas unavailable");
  await renderer.initialize({ context });
  renderer.resize(width, height);
  const device = renderer.device;
  // Untimed counterfactual uses the actual native shader and same-frame providers.
  // Only the local-list payload is empty. It never owns a production frame/submit.
  const referenceSurface = lighting ? new SurfaceV4(device, true, renderer.graphics) : null;
  const referenceLookup = lighting
    ? device.createBuffer({
        label: "L3.0 zero-local lookup",
        size: 60 * 34 * 24 * 16,
        usage: GPUBufferUsage.STORAGE
      })
    : null;
  const referenceData = lighting
    ? device.createBuffer({
        label: "L3.0 zero-local data",
        size: 32 + 16380 * 4,
        usage: GPUBufferUsage.STORAGE
      })
    : null;
  const referenceHdr = lighting
    ? device.createTexture({
        label: "L3.0 same-frame reference",
        size: [width, height],
        format: "rgba16float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
      })
    : null;
  const referenceReactive = lighting
    ? device.createTexture({
        label: "L3.0 reference reactive",
        size: [width, height],
        format: "rgba8unorm",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
      })
    : null;
  await referenceSurface?.ready;
  const clusterInspection = lighting ? await createLightingInspection(device, 60 * 34 * 24) : null;
  const errors = [];
  device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  camera.aspect = width / height;
  camera.fov_degrees = 60;
  camera.transform.position.set(0, 0, cameraZ);
  camera.transform.lookAt({ x: 0, y: 0, z: 0 });
  camera.update();
  await construction?.initialize(renderer, scene, camera);
  const textures = {
    normal: await authoredTexture("normal-linear", () => [128, 128, 255, 255], 256),
    orm: await authoredTexture("orm-linear", () => [255, 128, 64, 255], 256),
    color: await authoredTexture(
      "base-color-srgb",
      (x, y, size) => [x < size / 2 ? 96 : 192, y < size / 2 ? 128 : 64, 64, 255],
      256
    )
  };
  const geometry = new BoxGeometry(1, 1, 1);
  const cooked = await cookGeometryAssetPackage(buildBoxSourceGeometry(1, 1, 1), createGeometryCookRecipe());
  const materials = Array.from({ length: 64 }, (_, index) => {
    const m = new StandardShadeMaterial();
    m.diffuse_color.set(0.35 + index / 512, 0.2, 0.1, 1);
    m.roughness_factor = 0.8;
    m.metallic_factor = 0.2;
    m.texture_normal = textures.normal;
    m.texture_orm = textures.orm;
    m.is_unlit = unlit;
    if (complex) {
      m.appearance_definition = customGraph(textures, programs === 1 ? 8 : 1 + (index % programs));
      m.appearance_inputs.set("gain", [0.7]);
    }
    return m;
  });
  const meshes = materials.map((material, index) => {
    const matrix = new Float32Array([
      1.5,
      0,
      0,
      0,
      0,
      0.825,
      0,
      0,
      0,
      0,
      0.1,
      0,
      -5.25 + (index % 8) * 1.5,
      -2.8875 + Math.floor(index / 8) * 0.825,
      0,
      1
    ]);
    return Mesh.from(geometry, material, matrix);
  });
  scene.add(meshes);
  const lights = [];
  const addLights = (count) => {
    if (lighting) {
      for (const light of lights) scene.remove(light);
      lights.length = 0;
    }
    for (let i = lights.length; i < count; i++) {
      const spot = lighting?.type === "spot" || (lighting?.type === "mixed" && i % 2 === 1);
      const light = spot ? new SpotLight() : new PointLight();
      light.intensity = 1;
      light.radius = 0.1;
      light.distance = 100;
      light.position.set(Math.cos((i * Math.PI) / 4) * 2, Math.sin((i * Math.PI) / 4) * 2, 4);
      if (lighting?.distribution === "sparse") {
        light.distance = 1 + (i % 3) * 0.25;
        light.radius = 0.05 + (i % 5) * 0.025;
        light.position.set(-5 + (i % 16) * (10 / 15), -2.8 + (Math.floor(i / 16) % 8) * 0.8, 0.8);
      }
      if (spot) {
        light.angle = Math.PI / 3;
        light.penumbra = 0.25;
        light.forward = [0, 0, -1];
      }
      if (lighting?.boundary) lighting.boundary(light, i);
      lights.push(light);
      scene.add(light);
    }
  };
  let inspection = null,
    inspectNext = false,
    frame = null;
  const prepare = renderer._surface.prepareFrameNow.bind(renderer._surface);
  renderer._surface.prepareFrameNow = (value, ...rest) => {
    frame = value;
    construction?.prepare(value);
    return prepare(value, ...rest);
  };
  const encode = renderer._surface.encode.bind(renderer._surface);
  renderer._surface.encode = (encoder) => {
    encode(encoder);
    construction?.encode(encoder);
    if (!inspectNext) return;
    const make = (size) =>
      device.createBuffer({
        label: "S3/untimed inspection",
        size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
    const hdrPitch = Math.ceil((frame.width * 8) / 256) * 256;
    const keyPitch = Math.ceil((frame.width * 4) / 256) * 256;
    const hdr = make(hdrPitch * frame.height),
      winner = make(keyPitch * frame.height);
    const work = make(frame.geometry.meshletWork.size);
    encoder.copyTextureToBuffer({ texture: frame.output }, { buffer: hdr, bytesPerRow: hdrPitch }, [
      frame.width,
      frame.height
    ]);
    encoder.copyTextureToBuffer({ texture: frame.visibility }, { buffer: winner, bytesPerRow: keyPitch }, [
      frame.width,
      frame.height
    ]);
    encoder.copyBufferToBuffer(frame.geometry.meshletWork, 0, work, 0, work.size);
    clusterInspection?.encode(encoder, frame.lightingEntries);
    let reference = null;
    if (referenceSurface) {
      referenceSurface.prepareFrameNow({
        ...frame,
        output: referenceHdr,
        reactive: frame.reactive ? referenceReactive : undefined,
        lightingEntries: frame.lightingEntries.map((entry) =>
          entry.binding === 2
            ? { binding: 2, resource: { buffer: referenceLookup } }
            : entry.binding === 3
              ? { binding: 3, resource: { buffer: referenceData } }
              : entry
        )
      });
      referenceSurface.encode(encoder);
      reference = make(hdrPitch * frame.height);
      encoder.copyTextureToBuffer({ texture: referenceHdr }, { buffer: reference, bytesPerRow: hdrPitch }, [
        frame.width,
        frame.height
      ]);
    }
    inspection = {
      hdr,
      winner,
      work,
      reference,
      hdrPitch,
      keyPitch,
      width: frame.width,
      height: frame.height
    };
  };
  const tick = async () => {
    const previous = renderer.frame_count;
    for (let attempt = 0; attempt < 200; attempt++) {
      const start = performance.now();
      renderer.render(camera, scene);
      const elapsed = performance.now() - start;
      await device.queue.onSubmittedWorkDone();
      await construction?.settle();
      check(errors.length === 0, `Acceptance GPU errors: ${errors.join(" | ")}`);
      if (renderer.frame_count !== previous) return elapsed;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("S3 publication did not become ready");
  };
  const inspect = async () => {
    // Exact cross-light coverage comparison requires the same production jitter.
    // Extra alignment frames are outside the measured 120-frame window.
    const jitterPeriod = renderer._temporal.jitter.jitter_sequence_size;
    if (lighting) {
      while (renderer.frame_count % jitterPeriod !== 0) await tick();
    }
    const inspectionFrame = renderer.frame_count;
    inspectNext = true;
    await tick();
    inspectNext = false;
    referenceSurface?.commit(Promise.resolve());
    const current = inspection;
    check(current, "Production Surface was not encoded");
    await Promise.all(
      [current.hdr, current.winner, current.work, current.reference]
        .filter(Boolean)
        .map((buffer) => buffer.mapAsync(GPUMapMode.READ))
    );
    const hdr = new Uint16Array(current.hdr.getMappedRange());
    const reference = current.reference ? new Uint16Array(current.reference.getMappedRange()) : null;
    const winner = new Uint32Array(current.winner.getMappedRange());
    const work = new Uint32Array(current.work.getMappedRange());
    const counts = new Map(),
      instances = new Set();
    let visible = 0,
      lit = 0;
    for (let y = 0; y < current.height; y++) {
      for (let x = 0; x < current.width; x++) {
        const offset = (y * current.hdrPitch) / 2 + x * 4;
        check(
          [0, 1, 2].every((k) => Number.isFinite(decodeFloat16(hdr[offset + k]))),
          "Non-finite HDR in actual output domain"
        );
        const key = winner[(y * current.keyPitch) / 4 + x];
        if (key === 0xffffffff) continue;
        visible++;
        const item = 8 + (key & GPU_VISIBILITY_KEY_MESHLET_WORK_SLOT_MASK) * 6;
        const slot = work[item + 3];
        instances.add(work[item]);
        counts.set(slot, (counts.get(slot) ?? 0) + 1);
        if (decodeFloat16(hdr[offset]) > 0) lit++;
      }
    }
    check(
      instances.size === 64 && lit === visible,
      `Required 64 instances lost shading: ${instances.size}/${lit}/${visible}; GPU errors: ${errors.join(" | ")}`
    );
    const samples = [];
    for (let iy = 0; iy < 8; iy++) {
      for (let ix = 0; ix < 8; ix++) {
        const viewDistance = cameraZ - 0.05;
        const x = lighting?.cameraZ
            ? Math.round(
                width *
                  (0.5 + (-5.25 + ix * 1.5) / ((2 * viewDistance * Math.tan(Math.PI / 6) * width) / height))
              )
            : Math.round(width * (0.08 + ix * 0.12)),
          y = lighting?.cameraZ
            ? Math.round(height * (0.5 - (-2.8875 + iy * 0.825) / (2 * viewDistance * Math.tan(Math.PI / 6))))
            : Math.round(height * (0.08 + iy * 0.12));
        if (x >= current.width || y >= current.height) continue;
        check(winner[(y * current.keyPitch) / 4 + x] !== 0xffffffff, "Reference sample has no winner");
        const key = winner[(y * current.keyPitch) / 4 + x];
        const materialSlot = work[8 + (key & GPU_VISIBILITY_KEY_MESHLET_WORK_SLOT_MASK) * 6 + 3];
        samples.push({
          x,
          y,
          materialSlot,
          rgb: [0, 1, 2].map((k) => decodeFloat16(hdr[(y * current.hdrPitch) / 2 + x * 4 + k])),
          referenceRgb: reference
            ? [0, 1, 2].map((k) => decodeFloat16(reference[(y * current.hdrPitch) / 2 + x * 4 + k]))
            : undefined
        });
      }
    }
    [current.hdr, current.winner, current.work, current.reference].filter(Boolean).forEach((buffer) => {
      buffer.unmap();
      buffer.destroy();
    });
    inspection = null;
    check(errors.length === 0, `Actual Renderer GPU errors: ${errors}`);
    return {
      inspectionFrame,
      jitterPeriod,
      jitterPhase: inspectionFrame % jitterPeriod,
      visible,
      coverage: visible / (current.width * current.height),
      materials: counts.size,
      samples,
      clusters: await clusterInspection?.read()
    };
  };
  // Untimed inspection of the actual bound provider products. This extra
  // diagnostic submission is never included in production frame timing.
  const inspectProviders = async () => {
    if (unlit) return null;
    const vsm = renderer._vsm;
    check(vsm?.pageTable && vsm?.casterRecords, "Required production VSM unavailable");
    const make = (size, usage) => device.createBuffer({ label: "S3/provider inspection", size, usage });
    const pages = make(vsm.pageTable.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const casters = make(16, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const values = make(64 * 3 * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const download = make(values.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const buffers = [pages, casters, values, download];
    try {
      const module = device.createShaderModule({
        label: "S3/read actual IBL products",
        code: /* wgsl */ `
@group(0) @binding(0) var diffuse: texture_2d<f32>;
@group(0) @binding(1) var specular: texture_2d<f32>;
@group(0) @binding(2) var dfg: texture_2d<f32>;
@group(0) @binding(3) var<storage, read_write> values: array<vec4f>;
@compute @workgroup_size(64)
fn inspect(@builtin(local_invocation_index) index: u32) {
  let uv = (vec2f(f32(index % 8u), f32(index / 8u)) + vec2f(0.5)) / 8.0;
  values[index] = textureLoad(diffuse, vec2i(uv * vec2f(textureDimensions(diffuse))), 0);
  values[index + 64u] = textureLoad(specular, vec2i(uv * vec2f(textureDimensions(specular))), 0);
  values[index + 128u] = textureLoad(dfg, vec2i(uv * vec2f(textureDimensions(dfg))), 0);
}
`
      });
      check(
        !(await module.getCompilationInfo()).messages.some((m) => m.type === "error"),
        "Provider inspection WGSL invalid"
      );
      const pipeline = await device.createComputePipelineAsync({
        label: "S3/provider inspection",
        layout: "auto",
        compute: { module, entryPoint: "inspect" }
      });
      const entries = [5, 6, 7].map((binding, index) => {
        const entry = frame.lightingEntries.find((e) => e.binding === binding);
        check(entry, `Actual IBL binding ${binding} missing`);
        return { binding: index, resource: entry.resource };
      });
      entries.push({ binding: 3, resource: { buffer: values } });
      const group = device.createBindGroup({
        label: "S3/actual IBL views",
        layout: pipeline.getBindGroupLayout(0),
        entries
      });
      const encoder = device.createCommandEncoder({ label: "S3/untimed provider inspection" });
      encoder.copyBufferToBuffer(vsm.pageTable, 0, pages, 0, pages.size);
      encoder.copyBufferToBuffer(vsm.casterRecords, 0, casters, 0, 16);
      const pass = encoder.beginComputePass({ label: "S3/provider inspection" });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(values, 0, download, 0, values.size);
      device.queue.submit([encoder.finish()]);
      await Promise.all([pages, casters, download].map((b) => b.mapAsync(GPUMapMode.READ)));
      const words = new Uint32Array(pages.getMappedRange());
      let allocated = 0,
        valid = 0;
      for (let i = 0; i < words.length; i += 8) {
        if (words[i + 3] & 1) allocated++;
        if (words[i + 3] & 8) valid++;
      }
      const counts = new Uint32Array(casters.getMappedRange());
      check(
        allocated > 0 && valid > 0 && counts[1] > 0 && counts[2] === 0,
        `VSM page/caster work invalid: allocated=${allocated}, valid=${valid}, caster header=${counts}`
      );
      const floats = new Float32Array(download.getMappedRange());
      check(floats.every(Number.isFinite), "IBL provider contains non-finite values");
      const peaks = [0, 1, 2].map((product) => {
        let peak = 0;
        for (let i = product * 256; i < (product + 1) * 256; i += 4) {
          peak = Math.max(peak, floats[i], floats[i + 1], floats[i + 2]);
        }
        check(peak > 0, "Actual bound IBL product is zero");
        return peak;
      });
      return {
        allocatedPages: allocated,
        validPages: valid,
        casters: counts[1],
        overflow: counts[2],
        iblPeaks: peaks
      };
    } finally {
      for (const buffer of buffers) {
        if (buffer.mapState === "mapped") buffer.unmap();
        buffer.destroy();
      }
    }
  };
  try {
    const adapted = createPackedSceneSourceFromScene(scene, [{ geometry, asset: cooked.asset }]);
    adapted.source.flags.fill(GPU_INSTANCE_FLAGS.CastsShadow | GPU_INSTANCE_FLAGS.ReceivesShadow);
    await renderer.uploadPackedScene(scene, adapted.source);
    await tick();
    // Inspect caster writes on the initial dirty-content frame. Stable VSM
    // content legitimately has zero current-frame caster writes.
    const providers = await inspectProviders();
    for (let i = 0; i < 30; i++) await tick();
    const baseline = await inspect();
    check(
      lighting?.cameraZ
        ? baseline.coverage >= 0.23 && baseline.coverage <= 0.25
        : baseline.coverage >= 0.94 && baseline.coverage <= 0.98,
      `Unexpected unchanged scene coverage at cameraZ=${cameraZ}: ${baseline.coverage}`
    );
    const runtime = renderer.graphics.render_world.runtime(scene);
    const publication = runtime.nativeMaterials.publication;
    const sourceBySlot = new Map(
      runtime.nativeMaterials.materialSources.map((source) => [source.materialSlot, source.material])
    );
    const actualPrograms = new Set(publication.entries.map((entry) => entry.programIndex)).size;
    check(
      actualPrograms === programs,
      `Requested ${programs} structural programs but published ${actualPrograms}`
    );
    const records = [];
    for (const count of lighting?.counts ?? (unlit ? [0] : complex ? [8, 32] : [4, 8, 32])) {
      addLights(count);
      for (let i = 0; i < (lighting?.warmupFrames ?? 30); i++) await tick();
      renderer.profiler.setMode("record");
      renderer.profiler.configure({
        enabled: true,
        gpuSampleInterval: 1,
        gpuCounterSampleInterval: 1,
        gpuTimingMode: "full",
        historyCapacity: 512
      });
      renderer.perf_gpu_counters_enabled = true;
      const first = renderer.frame_count;
      const cpu = [];
      for (let i = 0; i < sampleCount; i++) {
        // Full diagnostic capture has a bounded 120-frame window.
        if (i > 0 && i % 120 === 0) renderer.profiler.configure({ gpuTimingMode: "full" });
        cpu.push(await tick());
      }
      for (let wait = 0; wait < 100; wait++) {
        const ready = renderer.profiler.history.filter(
          (p) =>
            p.frameIndex >= first && p.frameIndex < first + sampleCount && p.gpu.sampled && !p.gpu.pending
        );
        if (ready.length === sampleCount) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const profiles = renderer.profiler.history.filter(
        (p) => p.frameIndex >= first && p.frameIndex < first + sampleCount
      );
      check(
        profiles.length === sampleCount &&
          profiles.every(
            (p) =>
              p.gpu.sampled && !p.gpu.pending && !p.counters["gpu.timing.truncated"] && p.submits.count === 1
          ),
        "Incomplete/ambiguous production timestamps or multiple submits"
      );
      const costs = profiles.map((p) => summarizeGpuTimingCost(p.gpu.segments));
      const stage = profiles.map((p) =>
        p.gpu.segments
          .filter((s) => s.scope === "stage" && s.label.endsWith("/native-surface"))
          .reduce((n, s) => n + s.durationMs, 0)
      );
      check(
        stage.every((v) => v > 0),
        `Required native Surface stage scope missing: ${JSON.stringify(
          profiles
            .filter((_, index) => stage[index] <= 0)
            .slice(0, 1)
            .map((profile) => ({ frame: profile.frameIndex, segments: profile.gpu.segments }))
        )}`
      );
      const outputs = await inspect();
      const collection = renderer._environments.get(scene).lights;
      const actualLights = collection.pointLights.count + collection.spotLights.count;
      check(actualLights === count, `Actual published local lights ${actualLights}, expected ${count}`);
      let maxDirectDeltaError = 0;
      if (!complex && !unlit) {
        check(outputs.visible === baseline.visible, "Point lights changed geometry coverage");
        for (const [index, sample] of outputs.samples.entries()) {
          const position = [
            ((((sample.x + 0.5) / width) * 2 - 1) * ((cameraZ - 0.05) * Math.tan(Math.PI / 6)) * width) /
              height,
            (1 - ((sample.y + 0.5) / height) * 2) * ((cameraZ - 0.05) * Math.tan(Math.PI / 6)),
            0.05
          ];
          const material = sourceBySlot.get(sample.materialSlot);
          check(material !== undefined, "Numeric reference material is unpublished");
          const surface = {
            base: [material.diffuse_color.r, material.diffuse_color.g, material.diffuse_color.b],
            metallic: (0.2 * 64) / 255,
            roughness: (0.8 * 128) / 255,
            normal: normalize([1 / 255, 1 / 255, 1]),
            coatNormal: [0, 0, 1],
            coat: [0, 1]
          };
          let expected = [0, 0, 0];
          for (const light of lights) {
            const delta = [light.position.x, light.position.y, light.position.z].map(
              (v, i) => v - position[i]
            );
            const centerDistance = Math.hypot(...delta);
            // Independent support/fade definition; do not use the production CPU helper for M3.
            const surfaceDistance = Math.max(0, centerDistance - light.radius);
            const fade =
              light.distance > 0 ? Math.max(0, 1 - (surfaceDistance / light.distance) ** 4) ** 2 : 1;
            let attenuation = lighting
              ? fade / Math.max(centerDistance, light.radius, 0.01) ** 2
              : lightSphereDistanceAttenuation(centerDistance, 0.1, 100);
            if (light.isSpotLight) {
              const direction = normalize(delta);
              const cosine = -(
                direction[0] * light.forward.x +
                direction[1] * light.forward.y +
                direction[2] * light.forward.z
              );
              const outer = Math.cos(light.angle),
                inner = Math.cos(light.angle * (1 - light.penumbra));
              const t =
                inner === outer
                  ? Number(cosine >= outer)
                  : Math.min(1, Math.max(0, (cosine - outer) / (inner - outer)));
              attenuation *= inner === outer ? t : t * t * (3 - 2 * t);
            }
            const contribution = directReference(
              surface,
              position,
              normalize(delta),
              [attenuation * light.intensity, attenuation * light.intensity, attenuation * light.intensity],
              [0, 0, cameraZ]
            );
            expected = expected.map((v, k) => v + contribution[k]);
          }
          expected = workingColor(expected);
          expected.forEach((v, k) => {
            const actual = sample.rgb[k] - (sample.referenceRgb?.[k] ?? baseline.samples[index].rgb[k]);
            const error = Math.abs(v - actual);
            maxDirectDeltaError = Math.max(maxDirectDeltaError, error);
            check(
              error < 0.002 + Math.abs(v) * 0.003,
              `Independent point-light delta ${count}: ${actual} vs ${v} @${sample.x},${sample.y}`
            );
          });
        }
      }
      if (unlit) {
        outputs.samples.forEach((sample) => {
          const material = sourceBySlot.get(sample.materialSlot);
          const expected = workingColor([
            material.diffuse_color.r,
            material.diffuse_color.g,
            material.diffuse_color.b
          ]);
          sample.rgb.forEach((v, k) =>
            check(Math.abs(v - expected[k]) < 0.002, "Independent Unlit HDR differs")
          );
        });
      }
      const fields = [
        "surfacePassSumMs",
        "surfaceManagementMs",
        "surfaceEvaluationMs",
        "passSumMs",
        "commandSpanMs"
      ];
      const memory = renderer.memoryEvidence();
      const passLabels = [
        ...new Set(
          profiles.flatMap((p) => p.gpu.segments.filter((s) => s.scope === "pass").map((s) => s.label))
        )
      ];
      records.push({
        name,
        lights: count,
        pixels: width * height,
        visible: outputs.visible,
        coverage: outputs.coverage,
        inspectionJitter: {
          period: outputs.jitterPeriod,
          phase: outputs.jitterPhase,
          frameIndex: outputs.inspectionFrame
        },
        instances: runtime.instanceCount,
        materials: runtime.materialDictionaryCount,
        programs: actualPrograms,
        bins: publication.bins.length,
        bindingSets: new Set(publication.bins.map((bin) => bin.bindingSet)).size,
        maxDirectDeltaError,
        inspectedSamples: outputs.samples.length,
        independentSamples: complex ? 0 : outputs.samples.length,
        gpu: Object.fromEntries(fields.map((key) => [key, distribution(costs.map((c) => c[key] ?? 0))])),
        nativeSpanMs: distribution(stage),
        cpuRenderMs: distribution(cpu),
        memory,
        diagnosticReferenceBytes: referenceSurface?.allocatedBytes ?? 0,
        clusterObservation: outputs.clusters,
        constructedLocalLighting: await construction?.record(profiles),
        dispatches: distribution(profiles.map((p) => p.counters["gpu.commands.dispatch"] ?? 0)),
        actualLights,
        lightConfiguration: lighting
          ? {
              type: lighting.type,
              distribution: lighting.distribution,
              camera: { position: [0, 0, cameraZ], fov: 60, aspect: width / height },
              lights: lights.map((light) => ({
                type: light.type,
                position: [light.position.x, light.position.y, light.position.z],
                direction: [light.forward.x, light.forward.y, light.forward.z],
                radius: light.radius,
                distance: light.distance,
                intensity: light.intensity,
                angle: light.angle,
                penumbra: light.penumbra
              })),
              features: [...device.features],
              limits: {
                storage: device.limits.maxStorageBuffersPerShaderStage,
                sampled: device.limits.maxSampledTexturesPerShaderStage
              }
            }
          : undefined,
        raw: lighting
          ? profiles.map((profile, i) => ({
              frameIndex: profile.frameIndex,
              cpuRenderMs: cpu[i],
              segments: profile.gpu.segments,
              counters: profile.counters,
              submits: profile.submits,
              cpuOwners: profile.cpuMs,
              graph: profile.graph,
              gpuCounters: profile.gpuCounters
            }))
          : undefined,
        counters: profiles[0].counters,
        passes: Object.fromEntries(
          passLabels.map((label) => [
            label,
            distribution(
              profiles.map((p) =>
                p.gpu.segments
                  .filter((s) => s.scope === "pass" && s.label === label)
                  .reduce((sum, s) => sum + s.durationMs, 0)
              )
            )
          ])
        )
      });
      if (lighting)
        console.info(
          `L3.0 ${name}/${count}: ${JSON.stringify({ cpu: records.at(-1).cpuRenderMs, passes: records.at(-1).passes })}`
        );
    }
    if (complex) {
      const beforeEdit = await inspect();
      materials[0].appearance_inputs.set("gain", [0.2]);
      const edited = await inspect();
      check(
        edited.samples.some((sample, i) => sample.rgb.some((v, k) => v !== beforeEdit.samples[i].rgb[k])),
        "Custom parameter edit was not consumed"
      );
    }
    const before = renderer.memoryEvidence();
    renderer.resize(1280, 720);
    camera.aspect = 1280 / 720;
    await tick();
    renderer.resize(width, height);
    camera.aspect = width / height;
    await tick();
    const after = renderer.memoryEvidence();
    check(
      after.owners.nativeSurfaceScratch.allocatedBytes <= before.owners.nativeSurfaceScratch.allocatedBytes,
      "Completed resize leaked native scratch"
    );
    check(errors.length === 0, `Acceptance GPU errors: ${errors}`);
    return { records, providers, resize: { before, after }, baselineCoverage: baseline.coverage };
  } finally {
    await construction?.destroy();
    renderer.destroy();
    await device.queue.onSubmittedWorkDone();
    if (inspection)
      [inspection.hdr, inspection.winner, inspection.work, inspection.reference]
        .filter(Boolean)
        .forEach((buffer) => buffer.destroy());
    referenceSurface?.destroy();
    clusterInspection?.destroy();
    referenceLookup?.destroy();
    referenceData?.destroy();
    referenceHdr?.destroy();
    referenceReactive?.destroy();
    device.destroy();
  }
}

export async function runLightingBaselineGpuOracle() {
  const cases = [];
  // Alternating low/high groups, with identical geometry/material/provider quality.
  for (const specification of [
    { name: "point-overlap-low-a", lighting: { type: "point", distribution: "overlap", counts: [0, 1, 4] } },
    { name: "mixed-sparse-high-a", lighting: { type: "mixed", distribution: "sparse", counts: [64, 128] } },
    {
      name: "point-overlap-low-b",
      lighting: { type: "point", distribution: "overlap", counts: [8, 16, 32] }
    },
    { name: "mixed-sparse-high-b", lighting: { type: "mixed", distribution: "sparse", counts: [256, 1024] } },
    { name: "spot-overlap-low", lighting: { type: "spot", distribution: "overlap", counts: [1, 8, 32] } },
    {
      name: "point-overlap-high",
      lighting: { type: "point", distribution: "overlap", counts: [64, 128, 256, 1024] }
    },
    { name: "mixed-overlap-low", lighting: { type: "mixed", distribution: "overlap", counts: [4, 16] } },
    {
      name: "spot-overlap-high",
      lighting: { type: "spot", distribution: "overlap", counts: [64, 128, 256, 1024] }
    },
    { name: "coat-custom", complex: true, lighting: { type: "mixed", distribution: "sparse", counts: [8] } }
  ])
    cases.push(await runCase(specification));
  return {
    verdict: "passed",
    actualRenderer: true,
    cases,
    workload:
      "M1 real Renderer 64-instance generated grid, 1080p scale1, authored 256px normal/ORM, Sun/VSM/IBL/AO/Temporal/FSR",
    limitations: [
      "Not the 400MB authored large asset",
      "No hardware spill/register/DRAM counters",
      "Full instrumentation; external serialized GPU waits excluded from CPU render",
      "New DIRECT/SPARSE crossover not measured"
    ]
  };
}

export function lightingSupportSpecifications() {
  return [
    {
      name: "point-radius-offscreen",
      type: "point",
      boundary: (light) => {
        light.position.set(8, 0, 0.8);
        light.radius = 4;
        light.distance = 1;
        light.intensity = 4;
      }
    },
    {
      name: "point-unbounded-offscreen",
      type: "point",
      boundary: (light) => {
        light.position.set(8, 0, 4);
        light.distance = 0;
      }
    },
    {
      name: "spot-radius-shell",
      type: "spot",
      boundary: (light) => {
        light.position.set(0, 0, 4);
        light.radius = 4;
        light.distance = 1;
      }
    },
    {
      name: "spot-unbounded",
      type: "spot",
      boundary: (light) => {
        light.distance = 0;
      }
    },
    {
      name: "spot-default-distance-hard-edge",
      type: "spot",
      boundary: (light) => {
        light.distance = 3.4028234663852886e38;
        light.penumbra = 0;
      }
    },
    {
      name: "point-near-crossing",
      type: "point",
      boundary: (light) => {
        light.position.set(0, 0, 6);
        light.distance = 0.5;
        light.radius = 6;
      }
    }
  ];
}

export async function runLightingSupportGpuOracle() {
  const cases = [];
  for (const specification of lightingSupportSpecifications())
    cases.push(
      await runCase({
        name: specification.name,
        lighting: { ...specification, counts: [1], correctnessOnly: true, distribution: "boundary" }
      })
    );
  return { verdict: "passed", actualRenderer: true, correctnessOnly: true, cases };
}

export async function runLightingLowCoverageGpuOracle() {
  const result = await runCase({
    name: "point-low-coverage",
    lighting: { type: "point", distribution: "overlap", cameraZ: 12, counts: [0, 1, 4, 8, 16, 32] }
  });
  return {
    verdict: "passed",
    actualRenderer: true,
    cases: [result],
    limitations: [
      "Same geometry/material/resolution/quality; only camera distance changed for coverage input",
      "No DIRECT/SPARSE calibration"
    ]
  };
}

export async function runNativeSurfaceAcceptanceGpuOracle() {
  const cases = [];
  for (const specification of [
    { name: "ordinary" },
    { name: "complex", complex: true },
    { name: "programs-8", complex: true, programs: 8 },
    { name: "programs-32", complex: true, programs: 32 },
    { name: "unlit", unlit: true }
  ])
    cases.push(await runCase(specification));
  return {
    verdict: "passed",
    actualRenderer: true,
    cases,
    limitations: [
      "Generated 64-instance grid, not authored-scene image acceptance",
      "No hardware register/spill counters",
      "No performance comparison against retired Surface"
    ]
  };
}
