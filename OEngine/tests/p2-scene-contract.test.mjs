import assert from "node:assert/strict";
import test from "node:test";

const {
  DEFAULT_RENDERER_CONFIG,
  rendererConfigSettingsPatch,
  mergeRendererConfig,
  validateRendererConfig
} = await import("../.test-dist/render/RendererConfig.js");
const { createRenderFrameContract } = await import(
  "../.test-dist/render/RenderFrameContract.js"
);

test("P2 默认 RendererConfig 是单一中等偏高配置且效果默认开启", () => {
  const patch = rendererConfigSettingsPatch(DEFAULT_RENDERER_CONFIG);
  assert.equal(patch.resolution.internalScale, 1);
  assert.equal(patch.ao.resolutionScale, 0.5);
  assert.equal(patch.ssr.resolutionScale, 0.5);
  assert.equal(patch.features.ambientOcclusion, true);
  assert.equal(patch.features.screenSpaceReflections, true);
  assert.equal(patch.features.temporalAntiAliasing, true);
  assert.equal(DEFAULT_RENDERER_CONFIG.renderSettings, undefined);
});

test("P2 初始化配置覆盖便捷字段但不产生第二套管线", () => {
  const merged = mergeRendererConfig(DEFAULT_RENDERER_CONFIG, {
    renderScale: 0.75,
    enableSSSR: false,
    renderSettings: { features: { screenSpaceReflections: true } },
    requiredFeatures: ["timestamp-query"]
  });
  const patch = rendererConfigSettingsPatch(merged);
  assert.equal(patch.resolution.internalScale, 0.75);
  assert.equal(patch.features.screenSpaceReflections, true);
  assert.deepEqual(merged.requiredFeatures, ["timestamp-query"]);
  validateRendererConfig(merged);
  assert.throws(
    () => validateRendererConfig({ requiredFeatures: [""] }),
    /must not be empty/
  );
});

test("P2 帧合同冻结 View/FrameGraph 共用的尺寸、jitter 和拓扑", () => {
  const contract = createRenderFrameContract({
    frameIndex: 3,
    cameraId: 4,
    sceneId: 5,
    internalWidth: 960,
    internalHeight: 540,
    outputWidth: 1920,
    outputHeight: 1080,
    jitter: [0.25, -0.125],
    enabledFeatureBits: 17,
    historyFormatRevision: 3
  });
  assert.equal(Object.isFrozen(contract), true);
  assert.equal(Object.isFrozen(contract.jitter), true);
  assert.deepEqual(contract.jitter, [0.25, -0.125]);
  assert.throws(
    () => createRenderFrameContract({ ...contract, internalWidth: 0 }),
    /dimensions must be positive/
  );
});
