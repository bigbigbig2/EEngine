import test from "node:test";
import assert from "node:assert/strict";

import {
  RENDER_DEBUG_VIEW_OPTIONS,
  RenderDebugView,
  getRenderDebugViewStatus,
  isRenderableRenderDebugView
} from "../.test-dist/debug/RenderDebugView.js";
import {
  DEPTH_DEBUG_WGSL,
  PACKED_VISIBILITY_DEBUG_RESOLVE_WGSL,
  RENDER_DEBUG_VIEW_FORMAT,
  SURFACE_AO_DEBUG_WGSL,
  SURFACE_COLOR_DEBUG_WGSL,
  SURFACE_EMISSIVE_DEBUG_WGSL,
  SURFACE_FLAGS_DEBUG_WGSL,
  SURFACE_NORMAL_DEBUG_WGSL,
  SURFACE_PBR_DEBUG_WGSL,
  SSR_HISTORY_CONFIDENCE_DEBUG_WGSL,
  SSR_HIT_MISS_DEBUG_WGSL,
  VELOCITY_DEBUG_WGSL,
  VISIBILITY_KEY_DEBUG_WGSL
} from "../.test-dist/shaders/render_debug_view.js";
import {
  GPU_VISIBILITY_DEBUG_SETTINGS_SIZE,
  GPU_VISIBILITY_DEBUG_STATUS
} from "../.test-dist/gpu/GpuVisibilityDebugResolve.js";
globalThis.GPUShaderStage ??= { COMPUTE: 1, FRAGMENT: 2, VERTEX: 4 };
globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 1, RENDER_ATTACHMENT: 2 };
const { FrameGraph } = await import("../.test-dist/framegraph/FrameGraph.js");
const { RenderDebugViewPass } = await import(
  "../.test-dist/render/passes/RenderDebugViewPass.js"
);

test("unified render debug catalog reports supported and unsupported views", () => {
  assert.equal(RENDER_DEBUG_VIEW_OPTIONS.length, 29);
  assert.equal(new Set(RENDER_DEBUG_VIEW_OPTIONS.map((entry) => entry.view)).size, 29);
  assert.deepEqual(
    RENDER_DEBUG_VIEW_OPTIONS
      .filter((entry) => entry.status === "supported")
      .map((entry) => entry.view),
    [
      RenderDebugView.VisibilityKey,
      RenderDebugView.Depth,
      RenderDebugView.MaterialId,
      RenderDebugView.BaseColor,
      RenderDebugView.ShadingNormal,
      RenderDebugView.Roughness,
      RenderDebugView.Metallic,
      RenderDebugView.Occlusion,
      RenderDebugView.AmbientOcclusionRaw,
      RenderDebugView.AmbientOcclusionDenoised,
      RenderDebugView.AmbientOcclusionTemporal,
      RenderDebugView.Emissive,
      RenderDebugView.ScreenSpaceReflectionHitMiss,
      RenderDebugView.ScreenSpaceReflectionResolve,
      RenderDebugView.ScreenSpaceReflectionTemporal,
      RenderDebugView.ScreenSpaceReflectionHistoryConfidence,
      RenderDebugView.Velocity,
      RenderDebugView.HistoryValidity,
      RenderDebugView.Reactive,
      RenderDebugView.IndirectDiffuse,
      RenderDebugView.IndirectSpecular,
      RenderDebugView.LinearHdr
    ]
  );
  assert.equal(getRenderDebugViewStatus(RenderDebugView.None).status, "disabled");
  assert.equal(getRenderDebugViewStatus(RenderDebugView.HzbMip).status, "unsupported");
  assert.match(
    getRenderDebugViewStatus(RenderDebugView.RasterClassification).reason,
    /硬件光栅/
  );
  assert.equal(isRenderableRenderDebugView(RenderDebugView.VisibilityKey), true);
  assert.equal(isRenderableRenderDebugView(RenderDebugView.HistoryValidity), true);
  assert.throws(() => getRenderDebugViewStatus("not-a-view"), /Unknown/);
});

test("supported debug shaders share HDR output and explicit source scaling", () => {
  assert.equal(RENDER_DEBUG_VIEW_FORMAT, "rgba16float");
  for (const source of [
    VISIBILITY_KEY_DEBUG_WGSL,
    DEPTH_DEBUG_WGSL,
    VELOCITY_DEBUG_WGSL,
    SURFACE_COLOR_DEBUG_WGSL,
    SURFACE_NORMAL_DEBUG_WGSL,
    SURFACE_PBR_DEBUG_WGSL,
    SURFACE_AO_DEBUG_WGSL,
    SURFACE_EMISSIVE_DEBUG_WGSL,
    SURFACE_FLAGS_DEBUG_WGSL
  ]) {
    assert.match(source, /source_coordinate/);
    assert.match(source, /output_size/);
    assert.match(source, /@fragment/);
    assert.doesNotMatch(source, /\blet\s+target\b/);
  }
  assert.match(VISIBILITY_KEY_DEBUG_WGSL, /16777216u/);
  assert.match(VISIBILITY_KEY_DEBUG_WGSL, /triangle_ids/);
  assert.match(DEPTH_DEBUG_WGSL, /texture_depth_2d/);
  assert.match(DEPTH_DEBUG_WGSL, /pow\(clamp\(depth/);
  assert.match(VELOCITY_DEBUG_WGSL, /atan2/);
  assert.match(VELOCITY_DEBUG_WGSL, /length\(velocity\)/);
  assert.match(SSR_HIT_MISS_DEBUG_WGSL, /texture_2d<u32>/);
  assert.match(SSR_HIT_MISS_DEBUG_WGSL, /confidence/);
  assert.match(SSR_HISTORY_CONFIDENCE_DEBUG_WGSL, /texture_2d<f32>/);
  assert.match(SSR_HISTORY_CONFIDENCE_DEBUG_WGSL, /confidence/);
  assert.match(SURFACE_NORMAL_DEBUG_WGSL, /surface_metadata/);
  assert.match(SURFACE_NORMAL_DEBUG_WGSL, /OENGINE_SURFACE_FLAG_VALID/);
  assert.doesNotMatch(SURFACE_NORMAL_DEBUG_WGSL, /all\(encoded == vec2u\(0u\)\)/);
  assert.match(SURFACE_FLAGS_DEBUG_WGSL, /oengine_surface_material_slot\(packed\)/);
  assert.match(SURFACE_FLAGS_DEBUG_WGSL, /oengine_surface_flags\(packed\)/);
  assert.match(SURFACE_FLAGS_DEBUG_WGSL, /OENGINE_SURFACE_FLAG_MOTION_VALID/);
  assert.match(SURFACE_FLAGS_DEBUG_WGSL, /OENGINE_SURFACE_FLAG_REACTIVE/);
  assert.doesNotMatch(SURFACE_FLAGS_DEBUG_WGSL, /0x00ffffffu|packed >> 24u/);
  for (const lookup of [
    "debug_raster_work.opaque_header.written",
    "debug_raster_work.mask_header.written",
    "raster_work_slot - debug_raster_work.opaque_header.capacity < mask_count",
    "work.meshlet_record_index >= min",
    "work.local_triangle_index >= meshlet.triangle_count",
    "work.instance_record_index >= min",
    "work.geometry_record_index >= settings.geometry_record_count",
    "instance.geometry_record_index != work.geometry_record_index",
    "work.material_handle >= min"
  ]) {
    assert.match(PACKED_VISIBILITY_DEBUG_RESOLVE_WGSL, new RegExp(lookup));
  }
  assert.doesNotMatch(PACKED_VISIBILITY_DEBUG_RESOLVE_WGSL, /material\.material_id/);
  assert.match(PACKED_VISIBILITY_DEBUG_RESOLVE_WGSL, /OEngineRasterWork/);
  assert.doesNotMatch(PACKED_VISIBILITY_DEBUG_RESOLVE_WGSL, /OEngineVisibleClusterRecord/);
  assert.match(PACKED_VISIBILITY_DEBUG_RESOLVE_WGSL, /OEngineInstanceRecord/);
  assert.match(PACKED_VISIBILITY_DEBUG_RESOLVE_WGSL, /GpuMeshletRecord/);
  assert.match(PACKED_VISIBILITY_DEBUG_RESOLVE_WGSL, /OEngineMaterialVisibilityRecord/);
  assert.equal(Object.keys(GPU_VISIBILITY_DEBUG_STATUS).length, 13);
});

test("FX-01 legacy payload shaders use the mesh-id clear sentinel", () => {
  for (const [label, shader] of [
    ["base color", SURFACE_COLOR_DEBUG_WGSL],
    ["normal", SURFACE_NORMAL_DEBUG_WGSL],
    ["PBR", SURFACE_PBR_DEBUG_WGSL],
    ["AO", SURFACE_AO_DEBUG_WGSL],
    ["emissive", SURFACE_EMISSIVE_DEBUG_WGSL],
    ["velocity", VELOCITY_DEBUG_WGSL]
  ]) {
    assert.match(
      shader,
      /settings\.contract\.x == 1u && (?:metadata|packed) == 16777216u/,
      `${label} must reject the legacy mesh-id clear sentinel`
    );
    assert.doesNotMatch(
      shader,
      /settings\.contract\.x == 1u && (?:metadata|packed) == 0xffffffffu/,
      `${label} must not treat the Packed VisibilityKey sentinel as legacy mesh metadata`
    );
  }
});

test("debug graph work exists only for a supported non-disabled selection", () => {
  const pass = new RenderDebugViewPass({ device: {} });
  const resources = {
    meshId: 0,
    triangleId: 1,
    visibilityKey: null,
    packedVisibility: null,
    depth: 2,
    velocity: 3,
    gPbr: 4,
    gNormal: 5,
    gAlbedo: 6,
    gEmissive: 7,
    surfaceFlags: 8
  };
  const graph = new FrameGraph("debug-enabled");
  for (const name of [
    "mesh",
    "triangle",
    "depth",
    "velocity",
    "pbr",
    "normal",
    "albedo",
    "emissive",
    "surface-flags"
  ]) {
    graph.import_resource(name, { kind: "imported", label: name }, {});
  }
  const output = pass.addToGraph(
    graph,
    RenderDebugView.VisibilityKey,
    resources,
    960,
    540
  );
  const sink = graph.add("debug sink", {}, () => {});
  sink.read(output);
  sink.make_side_effect();
  graph.compile();
  assert.equal(graph.passCount, 2);
  assert.equal(graph.listExecutablePasses()[0].culled, false);

  const disabledGraph = new FrameGraph("debug-disabled");
  if (isRenderableRenderDebugView(RenderDebugView.None)) {
    pass.addToGraph(disabledGraph, RenderDebugView.None, resources, 960, 540);
  }
  assert.equal(disabledGraph.passCount, 0);

  const unsupportedGraph = new FrameGraph("debug-unsupported");
  if (isRenderableRenderDebugView(RenderDebugView.HzbMip)) {
    pass.addToGraph(unsupportedGraph, RenderDebugView.HzbMip, resources, 960, 540);
  }
  assert.equal(unsupportedGraph.passCount, 0);
});

test("R4-A-04 packed VisibilityKey debug is one pass with the complete lookup binding ABI", () => {
  const pass = new RenderDebugViewPass({ device: {} });
  const entries = pass.packedVisibilityPipeline.layout.bindGroupLayouts[0].entries;
  assert.equal(entries.length, 6);
  assert.equal(entries[0].texture.sampleType, "uint");
  assert.deepEqual(
    entries.slice(1, 5).map((entry) => entry.buffer.type),
    Array(4).fill("read-only-storage")
  );
  assert.equal(entries[5].buffer.type, "uniform");
  assert.equal(entries[5].buffer.minBindingSize, GPU_VISIBILITY_DEBUG_SETTINGS_SIZE);

  const graph = new FrameGraph("R4-A-04 packed debug");
  const imported = [
    "mesh",
    "triangle",
    "key",
    "depth",
    "velocity",
    "pbr",
    "normal",
    "albedo",
    "emissive",
    "surface-flags"
  ].map((name) =>
    graph.import_resource(name, { kind: "imported", label: name }, {})
  );
  const output = pass.addToGraph(
    graph,
    RenderDebugView.VisibilityKey,
    {
      meshId: imported[0],
      triangleId: imported[1],
      visibilityKey: imported[2],
      packedVisibility: { resolve: () => { throw new Error("execute only"); } },
      depth: imported[3],
      velocity: imported[4],
      gPbr: imported[5],
      gNormal: imported[6],
      gAlbedo: imported[7],
      gEmissive: imported[8],
      surfaceFlags: imported[9]
    },
    1280,
    720
  );
  const sink = graph.add("packed debug sink", {}, () => {});
  sink.read(output);
  sink.make_side_effect();
  graph.compile();

  assert.equal(graph.passCount, 2);
  const debugPass = graph.listExecutablePasses()[0];
  assert.equal(debugPass.name, "Render debug/visibility-key");
  assert.equal(debugPass.culled, false);
  assert.equal(graph.exportToJson().passes[0].reads.includes(imported[2]), true);
});

test("R4-B surface debug views read exactly one resolved Surface attachment", () => {
  const pass = new RenderDebugViewPass({ device: {} });
  const graph = new FrameGraph("R4-B surface debug");
  const imported = Array.from({ length: 9 }, (_, index) =>
    graph.import_resource(
      `surface-${index}`,
      { kind: "imported", label: `surface-${index}` },
      {}
    )
  );
  const resources = {
    meshId: imported[0],
    triangleId: imported[1],
    visibilityKey: null,
    packedVisibility: null,
    depth: imported[2],
    velocity: imported[3],
    gPbr: imported[4],
    gNormal: imported[5],
    gAlbedo: imported[6],
    gEmissive: imported[7],
    surfaceFlags: imported[8]
  };
  const output = pass.addToGraph(
    graph,
    RenderDebugView.HistoryValidity,
    resources,
    640,
    360
  );
  const sink = graph.add("surface debug sink", {}, () => {});
  sink.read(output);
  sink.make_side_effect();
  graph.compile();

  const debugPass = graph.exportToJson().passes[0];
  assert.deepEqual(debugPass.reads, [imported[8]]);
  assert.equal(debugPass.name, "Render debug/history-validity");
});

test("FX-01 legacy Scene payload debug uses visibility metadata without Packed Surface metadata", () => {
  const pass = new RenderDebugViewPass({ device: {} });
  const cases = [
    [RenderDebugView.Velocity, "velocity"],
    [RenderDebugView.BaseColor, "albedo"],
    [RenderDebugView.ShadingNormal, "normal"],
    [RenderDebugView.Metallic, "pbr"],
    [RenderDebugView.Roughness, "pbr"],
    [RenderDebugView.Occlusion, "albedo"],
    [RenderDebugView.Emissive, "emissive"]
  ];

  for (const [view, payloadName] of cases) {
    const graph = new FrameGraph(`FX-01 legacy ${view}`);
    const imported = Object.fromEntries([
      "mesh", "triangle", "depth", "velocity", "pbr", "normal",
      "albedo", "emissive"
    ].map((name) => [
      name,
      graph.import_resource(name, { kind: "imported", label: name }, {})
    ]));
    const output = pass.addToGraph(
      graph,
      view,
      {
        meshId: imported.mesh,
        triangleId: imported.triangle,
        visibilityKey: null,
        packedVisibility: null,
        depth: imported.depth,
        velocity: imported.velocity,
        gPbr: imported.pbr,
        gNormal: imported.normal,
        gAlbedo: imported.albedo,
        gEmissive: imported.emissive,
        surfaceFlags: null
      },
      640,
      360
    );
    const sink = graph.add("legacy debug sink", {}, () => {});
    sink.read(output);
    sink.make_side_effect();
    graph.compile();
    assert.deepEqual(
      graph.exportToJson().passes[0].reads,
      [imported[payloadName], imported.mesh],
      `${view} must use the legacy mesh-id sentinel as validity metadata`
    );
  }
});

test("FX-01 legacy Scene rejects metadata-only debug views without Surface metadata", () => {
  const pass = new RenderDebugViewPass({ device: {} });
  for (const view of [
    RenderDebugView.MaterialId,
    RenderDebugView.HistoryValidity,
    RenderDebugView.Reactive
  ]) {
    const graph = new FrameGraph(`FX-01 legacy metadata ${view}`);
    const imported = Object.fromEntries([
      "mesh", "triangle", "depth", "velocity", "pbr", "normal",
      "albedo", "emissive"
    ].map((name) => [
      name,
      graph.import_resource(name, { kind: "imported", label: name }, {})
    ]));
    assert.throws(
      () => pass.addToGraph(
        graph,
        view,
        {
          meshId: imported.mesh,
          triangleId: imported.triangle,
          visibilityKey: null,
          packedVisibility: null,
          depth: imported.depth,
          velocity: imported.velocity,
          gPbr: imported.pbr,
          gNormal: imported.normal,
          gAlbedo: imported.albedo,
          gEmissive: imported.emissive,
          surfaceFlags: null
        },
        640,
        360
      ),
      /requires Surface metadata/
    );
  }
});
