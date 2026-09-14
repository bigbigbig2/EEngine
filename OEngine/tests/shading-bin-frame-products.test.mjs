import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  diffuseSurfaceLiteFrame,
  directLightingFrame,
  shadingBinFrame,
  shadingSurfaceLiteFrame,
  specializedShadingFrame,
  textureDomain
} from "../.test-dist/render/pipeline/FrameProducts.js";

function validFrame() {
  return {
    abiVersion: 1,
    heap: 10,
    indirectArgs: 11,
    generation: 7,
    activeBinMaskLo: 0x8000_0001,
    activeBinMaskHi: 0x4000_0002,
    microtileWidth: 8,
    microtileHeight: 8,
    domain: textureDomain("internal-full", 1920, 1080, 1)
  };
}

test("ADR-0013 ShadingBinFrame freezes the GPU queue consumer identity", () => {
  const frame = shadingBinFrame(validFrame());
  assert.equal(Object.isFrozen(frame), true);
  assert.equal(Object.isFrozen(frame.domain), true);
  assert.deepEqual(frame, validFrame());

  assert.throws(() => shadingBinFrame({ ...frame, abiVersion: 2 }), /ABI/u);
  assert.throws(() => shadingBinFrame({ ...frame, heap: null }), /must not be null/u);
  assert.throws(() => shadingBinFrame({ ...frame, indirectArgs: -1 }), /resource id/u);
  assert.throws(() => shadingBinFrame({ ...frame, generation: 0 }), /positive/u);
  assert.throws(
    () => shadingBinFrame({ ...frame, activeBinMaskLo: -1 }),
    /u32/u
  );
  assert.throws(
    () => shadingBinFrame({ ...frame, activeBinMaskHi: 0x1_0000_0000 }),
    /u32/u
  );
  assert.throws(
    () => shadingBinFrame({ ...frame, microtileHeight: 16 }),
    /microtile shape/u
  );
  assert.throws(
    () => shadingBinFrame({
      ...frame,
      domain: textureDomain("internal-half", 960, 540, 0.5)
    }),
    /internal-full/u
  );
});

test("candidate composition publishes and consumes the formal ShadingBinFrame", async () => {
  const pipeline = await readFile(
    new URL("../src/render/pipeline/SparseShadingCandidatePipeline.ts", import.meta.url),
    "utf8"
  );
  const executor = await readFile(
    new URL("../src/render/pipeline/SparseShadingCandidateExecutor.ts", import.meta.url),
    "utf8"
  );

  assert.match(
    pipeline,
    /mutable\.indirectArgs = finalizer\.write[\s\S]*?mutable\.shadingBins = shadingBinFrame/u
  );
  assert.match(pipeline, /activeBinMaskLo: snapshot\.summary\.activeBinMaskLo/u);
  assert.match(pipeline, /activeBinMaskHi: snapshot\.summary\.activeBinMaskHi/u);
  assert.match(executor, /assertShadingBinProduct\(frame, activeBins\)/u);
  assert.match(executor, /FrameProduct does not match the active-bin consumer set/u);
});

test("production SpecializedShadingFrame validates one exact internal-full composition seam", () => {
  const domain = textureDomain("internal-full", 1920, 1080, 1);
  const frame = specializedShadingFrame({
    bins: shadingBinFrame(validFrame()),
    status: null,
    direct: directLightingFrame({ hdr: 20, domain }),
    shading: shadingSurfaceLiteFrame({
      normal: 21,
      roughnessFlags: 22,
      metallicSpecular: 22,
      normalSpace: "world",
      domain
    }),
    diffuse: diffuseSurfaceLiteFrame({
      diffuseReflectance: 23,
      materialAo: 23,
      receiverFlags: 22,
      colorSpace: "working-linear",
      receiverModulation: "unapplied",
      domain
    }),
    velocity: 24,
    domain
  });
  assert.equal(Object.isFrozen(frame), true);
  assert.equal(frame.direct.hdr, 20);
  assert.equal(frame.bins.heap, 10);
  assert.throws(
    () => specializedShadingFrame({
      ...frame,
      shading: { ...frame.shading, normalSpace: "view" }
    }),
    /normal space/u
  );
  assert.throws(
    () => specializedShadingFrame({
      ...frame,
      diffuse: {
        ...frame.diffuse,
        domain: textureDomain("internal-full", 1280, 720, 1)
      }
    }),
    /does not match/u
  );
});

test("production SurfaceFeature owns the complete ShadingBin composition", async () => {
  const surface = await readFile(
    new URL("../src/render/features/SurfaceFeature.ts", import.meta.url),
    "utf8"
  );
  assert.match(surface, /SparseShading\/clear \+ classify production Visibility MRT/u);
  assert.match(surface, /SparseShading\/finalize production indirect arguments/u);
  assert.match(surface, /SparseShading\/active-bin production indirect resolve/u);
  assert.match(surface, /specializedShadingFrame\(/u);
});

test("compact Surface consumers validate depth before every background-sensitive read", async () => {
  const [gtao, ssgi, ssrResolve, ssrDenoise] = await Promise.all([
    readFile(new URL("../src/shaders/gtao.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/shaders/ssgi.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/shaders/ssr_resolve.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/shaders/ssr_denoise.ts", import.meta.url), "utf8")
  ]);
  const section = (source, start, end) => source.slice(
    source.indexOf(start),
    end === null ? source.length : source.indexOf(end)
  );
  const before = (source, guard, read, label) => {
    const guardOffset = source.indexOf(guard);
    const readOffset = source.indexOf(read);
    assert.ok(guardOffset >= 0, `${label}: missing validity guard`);
    assert.ok(readOffset >= 0, `${label}: missing compact read`);
    assert.ok(guardOffset < readOffset, `${label}: compact read precedes validity guard`);
  };

  const gtaoRaw = section(gtao, "export const THREE_GTAO_RAW_WGSL", "export const GTAO_SPATIAL_WGSL");
  before(gtaoRaw, "if (device_depth <= 0.0)", "textureLoad(ray_ws, pixel", "GTAO raw center");
  assert.doesNotMatch(
    gtaoRaw.slice(gtaoRaw.indexOf("if (device_depth <= 0.0)"), gtaoRaw.indexOf("let position_ws")),
    /textureLoad\(ray_ws/u
  );
  const gtaoSpatial = section(gtao, "export const GTAO_SPATIAL_WGSL", "export const GTAO_TEMPORAL_WGSL");
  before(gtaoSpatial, "if (center_depth <= 0.0)", "let center_normal", "GTAO spatial center");
  before(gtaoSpatial, "if (sample_depth <= 0.0)", "let sample_normal", "GTAO spatial tap");
  const gtaoResolve = section(gtao, "export const GTAO_JOINT_BILATERAL_RESOLVE_WGSL", null);
  before(gtaoResolve, "if (center_depth <= 0.0)", "let center_normal", "GTAO resolve center");
  before(gtaoResolve, "if (sample_depth <= 0.0)", "let sample_normal", "GTAO resolve tap");

  const ssgiTrace = section(ssgi, "export const THREE_SSGI_TRACE_WGSL", "export const SSGI_SPATIAL_WGSL");
  before(ssgiTrace, "if (center_depth <= 0.0)", "let center_normal", "SSGI trace center");
  const ssgiSpatial = section(ssgi, "export const SSGI_SPATIAL_WGSL", "export const SSGI_TEMPORAL_WGSL");
  before(ssgiSpatial, "if (center_depth <= 0.0)", "let center_normal", "SSGI spatial center");
  before(ssgiSpatial, "if (sample_depth <= 0.0)", "let sample_normal", "SSGI spatial tap");
  const ssgiResolve = section(ssgi, "export const SSGI_RESOLVE_WGSL", "export const SSGI_LINEAR_DEPTH_WGSL");
  before(ssgiResolve, "if (center_depth <= 0.0)", "let center_normal", "SSGI resolve center");
  before(ssgiResolve, "if (sample_view_depth <= 0.0)", "let sample_normal", "SSGI resolve tap");

  before(ssrResolve, "if (is_background(surface_depth) || is_background(hit_depth))", "textureLoad(normal_source", "SSR hit resolve");
  const ssrUpsample = section(ssrDenoise, "export const SSR_UPSAMPLE_WGSL", "export const SSR_TEMPORAL_WGSL");
  before(ssrUpsample, "if (is_background(center_depth))", "let center_normal", "SSR upsample center");
  before(ssrUpsample, "if (is_background(sample_depth))", "let sample_normal", "SSR upsample tap");
  const ssrTemporal = section(ssrDenoise, "export const SSR_TEMPORAL_WGSL", "export const SSR_RECURRENT_DENOISE_WGSL");
  before(ssrTemporal, "let curvature_factor", "if (is_background(center_depth))", "SSR temporal derivatives");
  before(ssrTemporal, "if (is_background(tap_depth))", "let tap_normal", "SSR temporal history tap");
  before(ssrTemporal, "if (!is_background(hit_depth))", "let hit_normal", "SSR temporal hit");
  const ssrRecurrent = section(ssrDenoise, "export const SSR_RECURRENT_DENOISE_WGSL", null);
  before(ssrRecurrent, "if (is_background(center_depth)", "let center_normal", "SSR recurrent center");
  before(ssrRecurrent, "if (is_background(sample_depth))", "let sample_normal", "SSR recurrent tap");
});
