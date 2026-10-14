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
const { nativeSurfaceWgsl, nativeSurfaceBindingGroups } =
  await import("../../.test-dist/shaders/native_surface.js");
const { VSM_RECEIVER_DEMAND_WGSL, vsmReceiverDemandDiagnosticWgsl } =
  await import("../../.test-dist/shaders/vsm_receiver_demand.js");
const { VSM_DEMAND_SCAN_WGSL } = await import("../../.test-dist/shaders/vsm_demand_scan.js");
const { VSM_CASTER_RECORDS_WGSL } = await import("../../.test-dist/shaders/vsm_caster_records.js");
const { nativeTemporalSeedWgsl, NATIVE_TEMPORAL_SEED_CLASSIFY_WGSL } =
  await import("../../.test-dist/shaders/native_temporal_seed.js");
const { NATIVE_TEMPORAL_V2_ANALYZE_WGSL } = await import("../../.test-dist/shaders/native_temporal_amd.js");
const { NativeTemporalSeed } = await import("../../.test-dist/render/temporal/NativeTemporalSeed.js");
const { ResourceAccounting } = await import("../../.test-dist/debug/profiling/ResourceAccounting.js");
const { buildFrameProgram } = await import("../../.test-dist/render/program/FrameProgram.js");

test("A1: SurfaceV4 retains exact single-triangle broadcast in uniform control flow for compact and dense profiles", () => {
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
    assert.doesNotMatch(wgsl, /wg_cache_keys|wg_cache_valid|atomicCompareExchangeWeak/);
    assert.ok(wgsl.includes("var<workgroup> wg_cache_work: array<OEngineMeshletRasterWork, 1>;"));
    assert.ok(wgsl.includes("var<workgroup> wg_cache_entry: array<NativeMaterialDirectoryEntry, 1>;"));
    assert.ok(wgsl.includes("var<workgroup> wg_cache_instance_source: array<OEngineInstanceRecord, 1>;"));
    assert.ok(wgsl.includes("var<workgroup> wg_cache_corners: array<GeometryCompletion, 1>;"));
    assert.ok(wgsl.includes("let cache_hit = cache_slot == 0u;"));

    // Verify no lane-divergent return occurs before the last workgroupBarrier() in main()
    const mainStart = wgsl.indexOf("fn main(");
    assert.ok(mainStart > 0);
    const mainBody = wgsl.slice(mainStart);
    const lastBarrier = mainBody.lastIndexOf("workgroupUniformLoad(&wg_tile_broadcast)");
    const firstReturn = mainBody.indexOf("if (!lane_active) { return; }");
    assert.ok(
      lastBarrier > 0 && firstReturn > lastBarrier,
      "workgroupBarrier must precede lane-divergent return",
    );
  }
});

test("A2: exact receiver projection, sparse bit scan and conservative caster culling", () => {
  for (const wgsl of [VSM_RECEIVER_DEMAND_WGSL, vsmReceiverDemandDiagnosticWgsl()]) {
    assert.doesNotMatch(wgsl, /wg_tile_corner_pages|wg_tile_cluster_pages/);
    assert.match(wgsl, /return project_pixel_depth_to_page\(id\.xy, depth\)/);
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

test("A3: TemporalIdentity preserves all four words in rgba32uint (52 B/px total Seed budget) and guards Analyze neighbor/prior loads", async () => {
  const seedWgsl = nativeTemporalSeedWgsl(0, 6, 8, 9, true);
  assert.ok(seedWgsl.includes("var temporal_identity: texture_storage_2d<rgba32uint, write>;"));
  assert.doesNotMatch(seedWgsl, /seed_pack_identity|% 4094u|% 63u/);
  assert.doesNotMatch(NATIVE_TEMPORAL_SEED_CLASSIFY_WGSL, /seed_unpack_identity/);
  assert.doesNotMatch(NATIVE_TEMPORAL_V2_ANALYZE_WGSL, /unpack_identity/);
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
  assert.equal(identityBinding?.storageTexture?.format, "rgba32uint");

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
  assert.equal(identityFact?.format, "rgba32uint");

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
  assert.equal(frame.identity.format, "rgba32uint");
  assert.equal(frame.previousIdentity.format, "rgba32uint");
  assert.equal(owner.allocatedBytes, 32 * 16 * 52);
  assert.equal(accounting.snapshot().totalBytes, 32 * 16 * 52);
  owner.abort();
  owner.destroy();
  assert.equal(owner.allocatedBytes, 0);
  assert.equal(accounting.snapshot().totalBytes, 0);
});
