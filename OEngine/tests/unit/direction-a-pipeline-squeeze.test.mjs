import "../webgpu-test-globals.mjs";
import assert from "node:assert/strict";
import test from "node:test";

globalThis.GPUTextureUsage = {
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  RENDER_ATTACHMENT: 16,
};

const { AppearanceGraphBuilder } = await import("../../.test-dist/material/AppearanceGraph.js");
const { compileAppearanceGraph } = await import("../../.test-dist/material/AppearanceGraphCompiler.js");
const { lowerNativeMaterial } = await import("../../.test-dist/shaders/native_material.js");
const { nativeSurfaceWgsl, nativeSurfaceBindingGroups } = await import(
  "../../.test-dist/shaders/native_surface.js"
);
const { VSM_RECEIVER_DEMAND_WGSL, vsmReceiverDemandDiagnosticWgsl } = await import(
  "../../.test-dist/shaders/vsm_receiver_demand.js"
);
const { VSM_DEMAND_SCAN_WGSL } = await import("../../.test-dist/shaders/vsm_demand_scan.js");
const { VSM_CASTER_RECORDS_WGSL } = await import("../../.test-dist/shaders/vsm_caster_records.js");
const { nativeTemporalSeedWgsl, NATIVE_TEMPORAL_SEED_CLASSIFY_WGSL } = await import(
  "../../.test-dist/shaders/native_temporal_seed.js"
);
const { NATIVE_TEMPORAL_V2_ANALYZE_WGSL } = await import(
  "../../.test-dist/shaders/native_temporal_amd.js"
);
const { NativeTemporalSeed } = await import("../../.test-dist/render/temporal/NativeTemporalSeed.js");
const { ResourceAccounting } = await import("../../.test-dist/debug/profiling/ResourceAccounting.js");
const { buildFrameProgram } = await import("../../.test-dist/render/program/FrameProgram.js");

test("A1: SurfaceV4 emits 8-slot workgroup unique triangle cache in uniform control flow for compact and dense profiles", () => {
  const builder = new AppearanceGraphBuilder();
  builder.output("baseColor", builder.constant([0.6, 0.5, 0.4]));
  const program = lowerNativeMaterial(compileAppearanceGraph(builder.build()));

  for (const compact of [true, false]) {
    const wgsl = nativeSurfaceWgsl(program, {
      compact,
      productGeometry: true,
      unlit: false,
      reactive: true,
      physicalSun: true,
      finalPixel: true,
    });
    assert.ok(wgsl.includes("var<workgroup> wg_cache_keys: array<atomic<u32>, 8>;"));
    assert.ok(wgsl.includes("var<workgroup> wg_cache_valid: array<u32, 8>;"));
    assert.ok(wgsl.includes("var<workgroup> wg_cache_work: array<OEngineMeshletRasterWork, 8>;"));
    assert.ok(wgsl.includes("var<workgroup> wg_cache_entry: array<NativeMaterialDirectoryEntry, 8>;"));
    assert.ok(wgsl.includes("var<workgroup> wg_cache_instance_source: array<OEngineInstanceRecord, 8>;"));
    assert.ok(wgsl.includes("var<workgroup> wg_cache_corners: array<GeometryCompletion, 8>;"));
    assert.ok(wgsl.includes("let cache_hit = cache_slot < 8u;"));

    // Verify no lane-divergent return occurs before the last workgroupBarrier() in main()
    const mainStart = wgsl.indexOf("fn main(");
    assert.ok(mainStart > 0);
    const mainBody = wgsl.slice(mainStart);
    const lastBarrier = mainBody.lastIndexOf("workgroupBarrier();");
    const firstReturn = mainBody.indexOf("if (!lane_active) { return; }");
    assert.ok(lastBarrier > 0 && firstReturn > lastBarrier, "workgroupBarrier must precede lane-divergent return");
  }
});

test("A2: VSM receiver demand, bit scan, and caster record shaders include two-cluster, fast-skip, and hierarchical shared culling", () => {
  for (const wgsl of [VSM_RECEIVER_DEMAND_WGSL, vsmReceiverDemandDiagnosticWgsl()]) {
    assert.ok(wgsl.includes("var<workgroup> wg_tile_c0_max: atomic<u32>;"));
    assert.ok(wgsl.includes("var<workgroup> wg_tile_c1_min: atomic<u32>;"));
    assert.ok(wgsl.includes("var<workgroup> wg_tile_corner_pages: array<u32, 16>;"));
    assert.ok(wgsl.includes("var<workgroup> wg_tile_cluster_pages: vec2u;"));
    assert.ok(wgsl.includes("let cluster_page = select(cluster_pages.y, cluster_pages.x, depth <= z_split);"));
  }

  assert.ok(VSM_DEMAND_SCAN_WGSL.includes("if (marked == 0u) {\n    return;\n  }"));
  assert.ok(VSM_DEMAND_SCAN_WGSL.includes("while (marked != 0u) {"));
  assert.ok(VSM_DEMAND_SCAN_WGSL.includes("let bit = firstTrailingBit(marked);"));
  assert.ok(VSM_DEMAND_SCAN_WGSL.includes("marked &= marked - 1u;"));

  assert.ok(VSM_CASTER_RECORDS_WGSL.includes("var<workgroup> wg_page_rects: array<vec4f, 64>;"));
  assert.ok(VSM_CASTER_RECORDS_WGSL.includes("var<workgroup> wg_group_rects: array<vec4f, 8>;"));
  assert.ok(VSM_CASTER_RECORDS_WGSL.includes("var<workgroup> wg_batch_rect: vec4f;"));
  assert.ok(VSM_CASTER_RECORDS_WGSL.includes("let batch_rect = workgroupUniformLoad(&wg_batch_rect);"));
});

test("A3: TemporalIdentity compresses to r32uint (28 B/px total Seed budget) and guards Analyze neighbor/prior loads", async () => {
  const seedWgsl = nativeTemporalSeedWgsl(0, 6, 8, 9, true);
  assert.ok(seedWgsl.includes("var temporal_identity: texture_storage_2d<r32uint, write>;"));
  assert.ok(seedWgsl.includes("fn seed_pack_identity(identity: vec4u) -> u32"));
  assert.ok(NATIVE_TEMPORAL_SEED_CLASSIFY_WGSL.includes("fn seed_unpack_identity(raw: vec4u) -> vec4u"));
  assert.ok(NATIVE_TEMPORAL_V2_ANALYZE_WGSL.includes("fn unpack_identity(raw: vec4u) -> vec4u"));
  assert.ok(NATIVE_TEMPORAL_V2_ANALYZE_WGSL.includes("if (native.z > 0.5 && reactive < 0.1)"));

  const groups = nativeSurfaceBindingGroups([], {
    compact: true,
    productGeometry: true,
    unlit: false,
    reactive: true,
    physicalSun: true,
    finalPixel: true,
  });
  const identityBinding = groups[0].find((entry) => entry.binding === 9);
  assert.equal(identityBinding?.storageTexture?.format, "r32uint");

  const program = buildFrameProgram({
    kind: "scene",
    intent: "present",
    viewFamily: "main",
    outputWidth: 1920,
    outputHeight: 1080,
    outputFormat: "bgra8unorm",
    capabilityProfile: "device-1",
    internalWidth: 1920,
    internalHeight: 1080,
    virtualGeometry: true,
    virtualBankCount: 4,
    previousHzb: true,
    currentHzbLateRecheck: false,
    activeSets: [0],
    hasLit: true,
    physicalEnvironment: true,
  });
  const identityFact = program.facts.find((f) => f.product === "temporal-identity");
  assert.equal(identityFact?.format, "r32uint");

  const accounting = new ResourceAccounting();
  const textures = [];
  const device = {
    limits: {
      maxTextureDimension2D: 4096,
      maxComputeWorkgroupsPerDimension: 65535,
      maxStorageTexturesPerShaderStage: 4,
      maxSampledTexturesPerShaderStage: 4,
    },
    lost: new Promise(() => {}),
    createBindGroupLayout: (v) => v,
    createPipelineLayout: (v) => v,
    createShaderModule: (v) => v,
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createTexture({ size, format, label }) {
      const tex = {
        label,
        width: size[0],
        height: size[1],
        format,
        destroyed: false,
        createView() {
          return { texture: this };
        },
        destroy() {
          this.destroyed = true;
        },
      };
      textures.push(tex);
      return tex;
    },
  };
  const identityMat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const owner = new NativeTemporalSeed(device, accounting);
  const frame = owner.prepare(32, 16, "native", {
    view: identityMat,
    projection: identityMat,
    inverseView: identityMat,
    inverseProjection: identityMat,
    jitter: [0, 0],
    preExposure: 1,
  });
  assert.equal(frame.identity.format, "r32uint");
  assert.equal(frame.previousIdentity.format, "r32uint");
  assert.equal(owner.allocatedBytes, 32 * 16 * 28);
  assert.equal(accounting.snapshot().totalBytes, 32 * 16 * 28);
  owner.abort();
  owner.destroy();
  assert.equal(owner.allocatedBytes, 0);
  assert.equal(accounting.snapshot().totalBytes, 0);
});
