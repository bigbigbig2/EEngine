import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  GPU_SURFACE_ABI_SCHEMA,
  GPU_SURFACE_ABI_VERSION,
  GPU_SURFACE_ABI_WGSL,
  GPU_SURFACE_ATTACHMENT_BYTES,
  GPU_SURFACE_BYTES_PER_PIXEL,
  GPU_SURFACE_CHANNEL_SEMANTICS,
  GPU_SURFACE_DEFINED_FLAGS_MASK,
  GPU_SURFACE_DEPTH_CONVENTION,
  GPU_SURFACE_EMPTY_METADATA,
  GPU_SURFACE_FLAGS,
  GPU_SURFACE_FLAGS_BITS,
  GPU_SURFACE_FLAGS_SHIFT,
  GPU_SURFACE_FLAGS_VALUE_MASK,
  GPU_SURFACE_FORMATS,
  GPU_SURFACE_MATERIAL_SLOT_BITS,
  GPU_SURFACE_MATERIAL_SLOT_MASK,
  GPU_SURFACE_MATERIAL_SLOT_SHIFT,
  GPU_SURFACE_MAX_MATERIAL_SLOT,
  GPU_SURFACE_PACKED_FLAGS_MASK,
  GPU_SURFACE_RESERVED_FLAGS_MASK,
  GPU_SURFACE_VELOCITY_CONVENTION,
  decodeGpuSurfaceMetadata,
  gpuSurfaceMetadataHasFlag,
  packGpuSurfaceMetadata
} from "../.test-dist/gpu/GpuSurfaceAbi.js";
globalThis.GPUShaderStage ??= { COMPUTE: 1, FRAGMENT: 2, VERTEX: 4 };
globalThis.GPUTextureUsage ??= {
  COPY_SRC: 1 << 0,
  COPY_DST: 1 << 1,
  TEXTURE_BINDING: 1 << 2,
  STORAGE_BINDING: 1 << 3,
  RENDER_ATTACHMENT: 1 << 4
};
globalThis.GPUBufferUsage ??= {
  MAP_READ: 1 << 0,
  COPY_SRC: 1 << 2,
  COPY_DST: 1 << 3,
  UNIFORM: 1 << 6,
  STORAGE: 1 << 7
};

const {
  GBUF_ALBEDO_FORMAT,
  GBUF_EMISSIVE_FORMAT,
  GBUF_NORMAL_FORMAT,
  GBUF_PBR_FORMAT,
  HDR_COLOR_FORMAT,
  VIS_DEPTH_FORMAT
} = await import("../.test-dist/render/RenderTargets.js");
const {
  VELOCITY_FORMAT,
  VELOCITY_WGSL
} = await import("../.test-dist/shaders/velocity.js");
const { PACKED_MATERIAL_RESOLVE_WGSL } = await import(
  "../.test-dist/shaders/packed_material_resolve.js"
);
const {
  DEPTH_DEBUG_WGSL,
  RENDER_DEBUG_VIEW_FORMAT,
  SURFACE_AO_DEBUG_WGSL,
  SURFACE_COLOR_DEBUG_WGSL,
  SURFACE_EMISSIVE_DEBUG_WGSL,
  SURFACE_FLAGS_DEBUG_WGSL,
  SURFACE_NORMAL_DEBUG_WGSL,
  SURFACE_PBR_DEBUG_WGSL,
  VELOCITY_DEBUG_WGSL
} = await import("../.test-dist/shaders/render_debug_view.js");
const { RenderDebugView } = await import(
  "../.test-dist/debug/RenderDebugView.js"
);
const { FrameGraph } = await import(
  "../.test-dist/framegraph/FrameGraph.js"
);
const { RenderDebugViewPass } = await import(
  "../.test-dist/render/passes/RenderDebugViewPass.js"
);
const { PACKED_SURFACE_COUNTER_WGSL } = await import(
  "../.test-dist/render/passes/PackedSurfaceCounterPass.js"
);
const { resolveFrameJitter } = await import(
  "../.test-dist/render/TemporalJitterController.js"
);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("R5-00 Surface ABI v1 freezes formats, channel semantics and 26 B/pixel", () => {
  assert.equal(GPU_SURFACE_ABI_VERSION, 1);
  assert.equal(GPU_SURFACE_ABI_SCHEMA.name, "OEngineSurfaceV1");
  assert.deepEqual(GPU_SURFACE_FORMATS, {
    depth: "depth32float",
    pbr: "rg8unorm",
    normal: "rgba16uint",
    albedoAo: "rgba8unorm",
    emissive: "r32uint",
    velocity: "rg16float",
    metadata: "r32uint",
    hdrColor: "rgba16float"
  });
  assert.deepEqual(GPU_SURFACE_DEPTH_CONVENTION, {
    reverseZ: true,
    empty: 0
  });
  assert.deepEqual(GPU_SURFACE_CHANNEL_SEMANTICS, {
    pbr: { r: "metallic", g: "perceptual-roughness" },
    normal: {
      xy: "encoded-shading-normal",
      zw: "encoded-geometric-normal"
    },
    albedoAo: {
      rgb: "working-linear-base-color",
      a: "ambient-occlusion"
    },
    emissive: "rgb9e5-linear-scene-referred"
  });
  assert.deepEqual(GPU_SURFACE_ATTACHMENT_BYTES, {
    pbr: 2,
    normal: 8,
    albedoAo: 4,
    emissive: 4,
    velocity: 4,
    metadata: 4
  });
  assert.equal(GPU_SURFACE_BYTES_PER_PIXEL, 26);

  assert.equal(VIS_DEPTH_FORMAT, GPU_SURFACE_FORMATS.depth);
  assert.equal(GBUF_PBR_FORMAT, GPU_SURFACE_FORMATS.pbr);
  assert.equal(GBUF_NORMAL_FORMAT, GPU_SURFACE_FORMATS.normal);
  assert.equal(GBUF_ALBEDO_FORMAT, GPU_SURFACE_FORMATS.albedoAo);
  assert.equal(GBUF_EMISSIVE_FORMAT, GPU_SURFACE_FORMATS.emissive);
  assert.equal(VELOCITY_FORMAT, GPU_SURFACE_FORMATS.velocity);
  assert.equal(RENDER_DEBUG_VIEW_FORMAT, GPU_SURFACE_FORMATS.hdrColor);
  assert.equal(HDR_COLOR_FORMAT, GPU_SURFACE_FORMATS.hdrColor);
});

test("R5-00 metadata is 16-bit resident material slot plus 16-bit flags", () => {
  assert.equal(GPU_SURFACE_MATERIAL_SLOT_BITS, 16);
  assert.equal(GPU_SURFACE_MATERIAL_SLOT_SHIFT, 0);
  assert.equal(GPU_SURFACE_MATERIAL_SLOT_MASK, 0x0000ffff);
  assert.equal(GPU_SURFACE_MAX_MATERIAL_SLOT, 0x0000ffff);
  assert.equal(GPU_SURFACE_FLAGS_BITS, 16);
  assert.equal(GPU_SURFACE_FLAGS_SHIFT, 16);
  assert.equal(GPU_SURFACE_FLAGS_VALUE_MASK, 0x0000ffff);
  assert.equal(GPU_SURFACE_PACKED_FLAGS_MASK, 0xffff0000);

  assert.deepEqual(GPU_SURFACE_FLAGS, {
    Valid: 1,
    MotionValid: 2,
    Reactive: 4,
    GradientFallback: 8,
    NormalTexture: 16,
    OrmTexture: 32,
    EmissiveTexture: 64,
    Unlit: 128
  });
  const defined = Object.values(GPU_SURFACE_FLAGS)
    .reduce((mask, flag) => mask | flag, 0);
  assert.equal(defined, GPU_SURFACE_DEFINED_FLAGS_MASK);
  assert.equal(GPU_SURFACE_DEFINED_FLAGS_MASK, 0x00ff);
  assert.equal(GPU_SURFACE_RESERVED_FLAGS_MASK, 0xff00);
  assert.equal(
    GPU_SURFACE_DEFINED_FLAGS_MASK & GPU_SURFACE_RESERVED_FLAGS_MASK,
    0
  );
  assert.equal(
    GPU_SURFACE_DEFINED_FLAGS_MASK | GPU_SURFACE_RESERVED_FLAGS_MASK,
    GPU_SURFACE_FLAGS_VALUE_MASK
  );

  const materialTableSource = readFileSync(
    path.join(root, "src/gpu/GpuMaterialVisibilityTable.ts"),
    "utf8"
  );
  const capacityMatch = materialTableSource.match(
    /GPU_MATERIAL_VISIBILITY_CAPACITY\s*=\s*(\d+)/
  );
  assert.notEqual(capacityMatch, null);
  const residentCapacity = Number(capacityMatch[1]);
  assert.equal(Number.isSafeInteger(residentCapacity), true);
  assert.equal(residentCapacity - 1 <= GPU_SURFACE_MAX_MATERIAL_SLOT, true);
});

test("R5-00 metadata codec covers empty, current capacity and u16 boundaries", () => {
  assert.equal(GPU_SURFACE_EMPTY_METADATA, 0);
  assert.deepEqual(decodeGpuSurfaceMetadata(GPU_SURFACE_EMPTY_METADATA), {
    materialSlot: 0,
    flags: 0
  });

  for (const materialSlot of [0, 1, 4095, GPU_SURFACE_MAX_MATERIAL_SLOT]) {
    for (const flags of [
      0,
      GPU_SURFACE_FLAGS.Valid,
      GPU_SURFACE_DEFINED_FLAGS_MASK
    ]) {
      const packed = packGpuSurfaceMetadata(materialSlot, flags);
      assert.deepEqual(decodeGpuSurfaceMetadata(packed), {
        materialSlot,
        flags
      });
    }
  }
  assert.equal(
    packGpuSurfaceMetadata(
      GPU_SURFACE_MAX_MATERIAL_SLOT,
      GPU_SURFACE_DEFINED_FLAGS_MASK
    ),
    0x00ffffff
  );

  const validReactive = packGpuSurfaceMetadata(
    17,
    GPU_SURFACE_FLAGS.Valid | GPU_SURFACE_FLAGS.Reactive
  );
  assert.equal(
    gpuSurfaceMetadataHasFlag(validReactive, GPU_SURFACE_FLAGS.Valid),
    true
  );
  assert.equal(
    gpuSurfaceMetadataHasFlag(validReactive, GPU_SURFACE_FLAGS.Reactive),
    true
  );
  assert.equal(
    gpuSurfaceMetadataHasFlag(validReactive, GPU_SURFACE_FLAGS.MotionValid),
    false
  );
});

test("R5-00 metadata codec rejects truncation instead of masking invalid CPU values", () => {
  for (const materialSlot of [-1, 0.5, GPU_SURFACE_MAX_MATERIAL_SLOT + 1]) {
    assert.throws(
      () => packGpuSurfaceMetadata(materialSlot, 0),
      /Surface materialSlot must be an integer/
    );
  }
  for (const flags of [-1, 0.5, GPU_SURFACE_FLAGS_VALUE_MASK + 1]) {
    assert.throws(
      () => packGpuSurfaceMetadata(0, flags),
      /Surface flags must be an integer/
    );
  }
  for (const reserved of [0x0100, GPU_SURFACE_RESERVED_FLAGS_MASK, 0xffff]) {
    assert.throws(
      () => packGpuSurfaceMetadata(0, reserved),
      /must not set reserved v1 bits/
    );
  }
  for (const packed of [-1, 0.5, 0x1_0000_0000]) {
    assert.throws(
      () => decodeGpuSurfaceMetadata(packed),
      /Surface metadata must be a u32/
    );
  }
});

test("R5-00 TS and WGSL share one metadata ABI truth source", () => {
  for (const [name, value] of [
    ["OENGINE_SURFACE_ABI_VERSION", GPU_SURFACE_ABI_VERSION],
    ["OENGINE_SURFACE_MATERIAL_SLOT_BITS", GPU_SURFACE_MATERIAL_SLOT_BITS],
    ["OENGINE_SURFACE_MATERIAL_SLOT_SHIFT", GPU_SURFACE_MATERIAL_SLOT_SHIFT],
    ["OENGINE_SURFACE_MATERIAL_SLOT_MASK", GPU_SURFACE_MATERIAL_SLOT_MASK],
    ["OENGINE_SURFACE_MAX_MATERIAL_SLOT", GPU_SURFACE_MAX_MATERIAL_SLOT],
    ["OENGINE_SURFACE_FLAGS_BITS", GPU_SURFACE_FLAGS_BITS],
    ["OENGINE_SURFACE_FLAGS_SHIFT", GPU_SURFACE_FLAGS_SHIFT],
    ["OENGINE_SURFACE_FLAGS_VALUE_MASK", GPU_SURFACE_FLAGS_VALUE_MASK],
    ["OENGINE_SURFACE_PACKED_FLAGS_MASK", GPU_SURFACE_PACKED_FLAGS_MASK],
    ["OENGINE_SURFACE_DEFINED_FLAGS_MASK", GPU_SURFACE_DEFINED_FLAGS_MASK],
    ["OENGINE_SURFACE_RESERVED_FLAGS_MASK", GPU_SURFACE_RESERVED_FLAGS_MASK],
    ["OENGINE_SURFACE_EMPTY_METADATA", GPU_SURFACE_EMPTY_METADATA],
    ["OENGINE_SURFACE_FLAG_VALID", GPU_SURFACE_FLAGS.Valid],
    ["OENGINE_SURFACE_FLAG_MOTION_VALID", GPU_SURFACE_FLAGS.MotionValid],
    ["OENGINE_SURFACE_FLAG_REACTIVE", GPU_SURFACE_FLAGS.Reactive],
    ["OENGINE_SURFACE_FLAG_GRADIENT_FALLBACK", GPU_SURFACE_FLAGS.GradientFallback],
    ["OENGINE_SURFACE_FLAG_NORMAL_TEXTURE", GPU_SURFACE_FLAGS.NormalTexture],
    ["OENGINE_SURFACE_FLAG_ORM_TEXTURE", GPU_SURFACE_FLAGS.OrmTexture],
    ["OENGINE_SURFACE_FLAG_EMISSIVE_TEXTURE", GPU_SURFACE_FLAGS.EmissiveTexture],
    ["OENGINE_SURFACE_FLAG_UNLIT", GPU_SURFACE_FLAGS.Unlit]
  ]) {
    assert.match(
      GPU_SURFACE_ABI_WGSL,
      new RegExp(`const ${name}: u32 = ${value}u;`)
    );
  }
  assert.match(GPU_SURFACE_ABI_WGSL, /fn oengine_surface_pack/);
  assert.match(
    GPU_SURFACE_ABI_WGSL,
    /flags & OENGINE_SURFACE_DEFINED_FLAGS_MASK/
  );
  assert.match(GPU_SURFACE_ABI_WGSL, /fn oengine_surface_material_slot/);
  assert.match(GPU_SURFACE_ABI_WGSL, /fn oengine_surface_flags/);
  assert.match(GPU_SURFACE_ABI_WGSL, /fn oengine_surface_has_flag/);
});

test("R5-00 Resolve, counters and debug consume the canonical Surface ABI", () => {
  assert.match(
    PACKED_MATERIAL_RESOLVE_WGSL,
    /oengine_surface_pack\(visible\.material_handle, surface_flags\)/
  );
  assert.match(
    PACKED_MATERIAL_RESOLVE_WGSL,
    /OENGINE_SURFACE_FLAG_MOTION_VALID/
  );
  assert.doesNotMatch(
    PACKED_MATERIAL_RESOLVE_WGSL,
    /const SURFACE_(?:VALID|MOTION_VALID|REACTIVE|GRADIENT_FALLBACK|NORMAL_TEXTURE|ORM_TEXTURE|EMISSIVE_TEXTURE|UNLIT)/
  );
  assert.doesNotMatch(
    PACKED_MATERIAL_RESOLVE_WGSL,
    /0x00ffffffu\) \| \(surface_flags << 24u\)/
  );

  assert.match(PACKED_SURFACE_COUNTER_WGSL, /oengine_surface_flags/);
  assert.match(
    PACKED_SURFACE_COUNTER_WGSL,
    /OENGINE_SURFACE_FLAG_GRADIENT_FALLBACK/
  );
  assert.doesNotMatch(
    PACKED_SURFACE_COUNTER_WGSL,
    /textureLoad\(surface_[^)]+\)[^;]*>> 24u/
  );

  assert.match(SURFACE_FLAGS_DEBUG_WGSL, /oengine_surface_material_slot/);
  assert.match(SURFACE_FLAGS_DEBUG_WGSL, /oengine_surface_flags/);
  assert.match(SURFACE_FLAGS_DEBUG_WGSL, /OENGINE_SURFACE_FLAG_MOTION_VALID/);
  assert.match(SURFACE_FLAGS_DEBUG_WGSL, /OENGINE_SURFACE_FLAG_REACTIVE/);
  assert.doesNotMatch(
    SURFACE_FLAGS_DEBUG_WGSL,
    /packed & 0x00ffffffu|packed >> 24u/
  );

  for (const sourcePath of [
    "src/shaders/packed_material_resolve.ts",
    "src/render/passes/PackedSurfaceCounterPass.ts",
    "src/shaders/render_debug_view.ts"
  ]) {
    const source = readFileSync(path.join(root, sourcePath), "utf8");
    assert.doesNotMatch(
      source,
      /surface_flags << 24u|surface_flags[^;\n]*0x00ffffff|packed >> 24u/
    );
  }

  const resolvePassSource = readFileSync(
    path.join(root, "src/render/passes/PackedMaterialResolvePass.ts"),
    "utf8"
  );
  assert.match(resolvePassSource, /"surface\/metadata"/);
  assert.doesNotMatch(resolvePassSource, /"surface\/flags"/);
});

test("R5-00 velocity is current-minus-previous internal pixels with fail-open invalid semantics", () => {
  assert.deepEqual(GPU_SURFACE_VELOCITY_CONVENTION, {
    space: "internal-pixel",
    direction: "current-minus-previous",
    jitter: "projection-matrix-inclusive",
    invalidVelocity: [0, 0],
    invalidMotionValid: false,
    invalidReactive: true
  });

  assert.match(
    PACKED_MATERIAL_RESOLVE_WGSL,
    /output\.velocity = position\.xy - previous_pixel/
  );
  assert.match(
    PACKED_MATERIAL_RESOLVE_WGSL,
    /output\.velocity = vec2f\(0\.0\)/
  );
  assert.match(
    PACKED_MATERIAL_RESOLVE_WGSL,
    /surface_flags \|= OENGINE_SURFACE_FLAG_MOTION_VALID/
  );
  assert.match(
    PACKED_MATERIAL_RESOLVE_WGSL,
    /surface_flags \|= OENGINE_SURFACE_FLAG_REACTIVE/
  );
  assert.match(
    PACKED_MATERIAL_RESOLVE_WGSL,
    /if previous_clip\.w > 1e-8/
  );
  assert.doesNotMatch(
    PACKED_MATERIAL_RESOLVE_WGSL,
    /abs\(previous_clip\.w\) > 1e-8/
  );
  assert.match(
    PACKED_MATERIAL_RESOLVE_WGSL,
    /if previous_world_h\.w > 1e-8/
  );
  assert.doesNotMatch(
    PACKED_MATERIAL_RESOLVE_WGSL,
    /abs\(previous_world_h\.w\) > 1e-8/
  );

  // Legacy Scene velocity keeps the same direction while Packed owns R5 mainline.
  assert.match(VELOCITY_WGSL, /return current_pixel - previous_pixel/);
  assert.match(VELOCITY_WGSL, /return current_pixel - previous\.xy/);

  const velocityPass = readFileSync(
    path.join(root, "src/render/passes/VelocityPass.ts"),
    "utf8"
  );
  assert.match(
    velocityPass,
    /currentCamera\.projection_matrix[\s\S]*previousCamera\.projection_matrix/
  );
});

test("R5-00 browser evidence exposes the canonical Surface ABI for A/B/C", () => {
  const gateSource = readFileSync(
    path.join(root, "../examples/benchmark-shared/R5SurfaceBrowserGate.ts"),
    "utf8"
  );
  const r4GateSource = readFileSync(
    path.join(root, "../examples/benchmark-shared/R4BBrowserGate.ts"),
    "utf8"
  );
  const pageSource = readFileSync(
    path.join(root, "../examples/benchmark-shared/BenchmarkPage.ts"),
    "utf8"
  );

  assert.match(gateSource, /taskId:\s*"R5-00"/);
  assert.match(gateSource, /GPU_SURFACE_ABI_SCHEMA/);
  assert.match(gateSource, /GPU_SURFACE_ABI_VERSION/);
  assert.match(gateSource, /GPU_SURFACE_BYTES_PER_PIXEL/);
  assert.match(gateSource, /GPU_SURFACE_MATERIAL_SLOT_BITS/);
  assert.match(gateSource, /GPU_SURFACE_FLAGS_BITS/);
  assert.match(gateSource, /GPU_SURFACE_DEFINED_FLAGS_MASK/);
  assert.match(gateSource, /GPU_SURFACE_RESERVED_FLAGS_MASK/);
  assert.match(gateSource, /GPU_SURFACE_VELOCITY_CONVENTION/);
  assert.match(gateSource, /software-visibility/);
  assert.match(gateSource, /hybrid-visibility/);
  assert.match(gateSource, /sameFeatureSet/);
  assert.match(r4GateSource, /R4_B_MAX_REACTIVE_SURFACE_PIXELS/);
  assert.match(r4GateSource, /A:\s*1/);
  assert.match(r4GateSource, /B:\s*0/);
  assert.match(r4GateSource, /C:\s*0/);
  assert.match(pageSource, /__OENGINE_R5_00_GATE__/);
  assert.match(pageSource, /createR500GateArtifact/);
});

function decodeUnorm8(value) {
  return value / 255;
}

function decodeOctahedralNormal(encodedX, encodedY) {
  const signedX = encodedX / 65535 * 2 - 1;
  const signedY = encodedY / 65535 * 2 - 1;
  let x = signedX;
  let y = signedY;
  const z = 1 - Math.abs(signedX) - Math.abs(signedY);
  const correction = Math.max(-z, 0);
  x += x > 0 ? -correction : correction;
  y += y > 0 ? -correction : correction;
  const inverseLength = 1 / Math.hypot(x, y, z);
  return [x * inverseLength, y * inverseLength, z * inverseLength];
}

function decodeRgb9e5(value) {
  const scale = 2 ** (((value >>> 27) & 0x1f) - 15 - 9);
  return [
    value & 0x1ff,
    (value >>> 9) & 0x1ff,
    (value >>> 18) & 0x1ff
  ].map((component) => component * scale);
}

test("FX-01 fixed Surface bytes decode metallic and perceptual roughness", () => {
  const pbr = Uint8Array.of(64, 192);
  assert.equal(decodeUnorm8(pbr[0]), 64 / 255);
  assert.equal(decodeUnorm8(pbr[1]), 192 / 255);
});

test("FX-01 fixed octahedral normal bytes decode to unit length", () => {
  const normal = decodeOctahedralNormal(49151, 32767);
  assert.ok(Math.abs(Math.hypot(...normal) - 1) < 1e-7);
  assert.ok(normal[0] > 0.7);
  assert.ok(normal[2] > 0.7);
});

test("FX-01 fixed RGB9E5 emissive bytes decode in linear scene space", () => {
  const packed = ((16 << 27) | (64 << 18) | (128 << 9) | 256) >>> 0;
  assert.deepEqual(decodeRgb9e5(packed), [1, 0.5, 0.25]);
});

test("FX-01 unlit resolve is emissive-only and carries the exact Unlit bit", () => {
  assert.match(
    PACKED_MATERIAL_RESOLVE_WGSL,
    /if is_unlit \{[\s\S]*output\.pbr = vec2f\(0\.0, 1\.0\);[\s\S]*output\.albedo = vec4f\(vec3f\(0\.0\), 1\.0\);[\s\S]*output\.emissive = rgbe9995_encode\(albedo\);[\s\S]*\}/
  );
  const packed = packGpuSurfaceMetadata(
    9,
    GPU_SURFACE_FLAGS.Valid | GPU_SURFACE_FLAGS.Unlit
  );
  assert.deepEqual(decodeGpuSurfaceMetadata(packed), {
    materialSlot: 9,
    flags: GPU_SURFACE_FLAGS.Valid | GPU_SURFACE_FLAGS.Unlit
  });
});

test("FX-01 motion-valid and reactive remain exact independent metadata bits", () => {
  const validMotion = packGpuSurfaceMetadata(
    3,
    GPU_SURFACE_FLAGS.Valid | GPU_SURFACE_FLAGS.MotionValid
  );
  const invalidMotion = packGpuSurfaceMetadata(
    3,
    GPU_SURFACE_FLAGS.Valid | GPU_SURFACE_FLAGS.Reactive
  );
  assert.equal(decodeGpuSurfaceMetadata(validMotion).flags, 0b0011);
  assert.equal(decodeGpuSurfaceMetadata(invalidMotion).flags, 0b0101);
  assert.equal(gpuSurfaceMetadataHasFlag(validMotion, GPU_SURFACE_FLAGS.Reactive), false);
  assert.equal(gpuSurfaceMetadataHasFlag(invalidMotion, GPU_SURFACE_FLAGS.MotionValid), false);
  assert.equal(gpuSurfaceMetadataHasFlag(invalidMotion, GPU_SURFACE_FLAGS.Reactive), true);
});

test("FX-01 disables projection jitter when neither TAA nor NSS consumes it", () => {
  const taa = [0.25, -0.125];
  const nss = [-0.375, 0.375];
  assert.deepEqual(resolveFrameJitter(false, false, taa, nss), [0, 0]);
  assert.deepEqual(resolveFrameJitter(true, false, taa, nss), taa);
  assert.deepEqual(resolveFrameJitter(false, true, taa, nss), nss);
});

test("FX-01 reverse-Z empty depth is the deterministic zero background sentinel", () => {
  assert.equal(GPU_SURFACE_DEPTH_CONVENTION.reverseZ, true);
  assert.equal(GPU_SURFACE_DEPTH_CONVENTION.empty, 0);
  assert.match(DEPTH_DEBUG_WGSL, /select\(0\.0,/);
  assert.match(DEPTH_DEBUG_WGSL, /depth > 0\.0/);
});

test("FX-01 payload debug graph reads canonical metadata with every Surface payload", () => {
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
    const graph = new FrameGraph(`FX-01 ${view}`);
    const imported = Object.fromEntries([
      "mesh", "triangle", "depth", "velocity", "pbr", "normal",
      "albedo", "emissive", "metadata"
    ].map((name) => [
      name,
      graph.import_resource(name, { kind: "imported", label: name }, {})
    ]));
    const resources = {
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
      surfaceFlags: imported.metadata
    };
    const output = pass.addToGraph(graph, view, resources, 64, 64);
    const sink = graph.add("sink", {}, () => {});
    sink.read(output);
    sink.make_side_effect();
    graph.compile();
    assert.deepEqual(
      graph.exportToJson().passes[0].reads,
      [imported[payloadName], imported.metadata],
      `${view} must read payload then metadata`
    );
  }
});

test("FX-01 payload shaders reject empty metadata before loading random Surface bytes", () => {
  for (const [label, shader] of [
    ["base color", SURFACE_COLOR_DEBUG_WGSL],
    ["normal", SURFACE_NORMAL_DEBUG_WGSL],
    ["PBR", SURFACE_PBR_DEBUG_WGSL],
    ["AO", SURFACE_AO_DEBUG_WGSL],
    ["emissive", SURFACE_EMISSIVE_DEBUG_WGSL],
    ["velocity", VELOCITY_DEBUG_WGSL]
  ]) {
    assert.match(shader, /OENGINE_SURFACE_ABI_VERSION/, `${label} must use the canonical ABI`);
    assert.match(shader, /surface_metadata:\s*texture_2d<u32>/, `${label} must bind metadata`);
    const metadataLoad = shader.indexOf("textureLoad(surface_metadata");
    const validGuard = shader.indexOf("OENGINE_SURFACE_FLAG_VALID", metadataLoad);
    const payloadLoad = shader.indexOf("textureLoad(source", validGuard);
    assert.ok(metadataLoad >= 0, `${label} must load metadata`);
    assert.ok(validGuard > metadataLoad, `${label} must test Valid`);
    assert.ok(payloadLoad > validGuard, `${label} must guard before payload load`);
  }
  assert.doesNotMatch(
    SURFACE_NORMAL_DEBUG_WGSL,
    /all\(encoded == vec2u\(0u\)\)/,
    "zero octahedral bytes are valid when metadata says the Surface is valid"
  );
});

test("FX-01 production browser Gate owns PNG metrics and rejects blank or collapsed views", () => {
  const runnerSource = readFileSync(
    path.join(root, "../examples/scripts/run-r5-fx01-gate.mjs"),
    "utf8"
  );
  const fixtureSource = readFileSync(
    path.join(root, "../examples/r5-surface-debug/main.ts"),
    "utf8"
  );
  const examplesTsconfig = readFileSync(
    path.join(root, "../examples/tsconfig.json"),
    "utf8"
  );

  assert.match(examplesTsconfig, /"r5-\*\/\*\*\/\*\.ts"/);
  assert.match(runnerSource, /screenshot-metrics\.json/);
  assert.match(runnerSource, /locator\("#gpu-canvas"\)\.screenshot/);
  assert.match(runnerSource, /captureCanvasScreenshot/);
  assert.match(runnerSource, /sidebar\.style\.visibility = "hidden"/);
  assert.match(runnerSource, /PNG\.sync\.read/);
  assert.match(runnerSource, /backgroundRatio/);
  assert.match(runnerSource, /nonBackgroundCoverage/);
  assert.match(runnerSource, /tileSamples/);
  assert.match(runnerSource, /distinctViewHashes/);
  assert.match(runnerSource, /allBlack/);
  assert.match(
    runnerSource,
    /const gateEligible = cleanEligible && buildProvenance\.passed;/
  );
  assert.match(runnerSource, /evaluateBuildProvenance/);
  assert.match(runnerSource, /evaluateDiagnosticSnapshots/);
  assert.match(runnerSource, /screenshot-canvas-final-direct-light-on\.png/);
  assert.match(runnerSource, /FX-02: legacy Direct Lighting changes the final unlit tile/);
  assert.match(runnerSource, /writeGateArtifacts/);
  assert.match(runnerSource, /__OENGINE_FX_01__\.renderView/);
  assert.match(fixtureSource, /previousTransforms/);
  assert.match(fixtureSource, /motionInvalidMetadata/);
  assert.match(fixtureSource, /sameMotionInvalidPixel/);
  assert.match(fixtureSource, /captureWebGpuLimits/);
  assert.match(fixtureSource, /renderer\.adapter_info/);
  assert.match(fixtureSource, /floatToHalf/);
  assert.match(fixtureSource, /halfToFloat/);
  assert.doesNotMatch(fixtureSource, /createImageBitmap\(canvas\)/);
  assert.doesNotMatch(fixtureSource, /function float32ToFloat16/);
});
