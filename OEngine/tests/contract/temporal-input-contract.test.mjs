import test from "node:test";
import assert from "node:assert/strict";
import "../webgpu-test-globals.mjs";
import { TemporalFabric } from "../../.test-dist/render/TemporalFabric.js";
globalThis.GPUBufferUsage ??= {
  MAP_READ: 1,
  COPY_SRC: 4,
  COPY_DST: 8,
  UNIFORM: 64,
  STORAGE: 128,
  INDIRECT: 256
};
const { GPUViewContext } = await import("../../.test-dist/render/ViewContext.js");
const { GPUCameraState } = await import("../../.test-dist/render/GPUCameraState.js");
const { PerspectiveCamera } = await import("../../.test-dist/camera/PerspectiveCamera.js");
const { Renderer } = await import("../../.test-dist/render/pipeline/RendererCore.js");

test("actual perspective raster displacement equals the FSR pixel offset at first frame and resize", () => {
  const camera = new PerspectiveCamera();
  const state = new GPUCameraState({ createBuffer: () => ({ destroy() {} }) }, camera);
  const view = Object.assign(Object.create(GPUViewContext.prototype), {
    camera: state,
    jitter: new Float32Array(2),
    width: 1,
    height: 1,
    resolutionValue: new Uint32Array(2),
    hierarchical_z_buffer: { setViewportSize() {} }
  });
  const command = { writeBuffer() {} };
  for (const [width, height] of [
    [640, 360],
    [1920, 1080],
    [960, 540]
  ]) {
    view.setViewportSize(width, height);
    for (const [jx, jy] of [
      [0, -1 / 6],
      [0.375, -0.389],
      [-0.4375, 0.4375]
    ]) {
      view.setJitter(jx, jy);
      state.update(command);
      // Project a fixed view point z=-2 and apply the real top-left viewport.
      const p = state.projection_matrix;
      const base = camera.projection_matrix;
      const actual = [(-(p[8] - base[8]) * width) / 2, ((p[9] - base[9]) * height) / 2];
      assert.ok(Math.abs(actual[0] - jx) < 1e-6, `${width} x jitter`);
      assert.ok(Math.abs(actual[1] - jy) < 1e-6, `${height} y jitter`);
    }
  }
});

test("production Fabric cycles SDK Halton phases at 1x, 1.5x and 2x including retry", () => {
  for (const [internal, output, phases] of [
    [1280, 1280, 8],
    [1280, 1920, 18],
    [960, 1920, 32]
  ]) {
    const fabric = new TemporalFabric();
    const frame = (index) => ({
      frameIndex: index,
      output: [output, 1080],
      internal: [internal, 720],
      cameraRevision: 1,
      sceneRevision: 1,
      representationRevision: 1,
      lightRevision: "1",
      view: "main",
      renderScale: internal / output,
      featureRevision: 1,
      formatRevision: 1,
      deviceRevision: 1,
      preExposure: { generation: 1, multiplier: 1, colorSpace: "working-linear" },
      temporalEnabled: true,
      nssEnabled: false
    });
    const first = [...fabric.begin(frame(0))];
    fabric.abort(0);
    assert.deepEqual([...fabric.begin(frame(0))], first);
    assert.equal(fabric.jitter.jitter_sequence_size, phases);
    fabric.abort(0);
    assert.deepEqual([...fabric.begin(frame(phases))], first);
    fabric.abort(phases);
  }
});

test("Renderer resize separates CSS, DPR output and scaled internal extents", () => {
  const resolution = () => ({
    x: 1,
    y: 1,
    set(x, y) {
      this.x = x;
      this.y = y;
    }
  });
  const canvas = { width: 1, height: 1, style: {} };
  const renderer = Object.assign(Object.create(Renderer.prototype), {
    context: { canvas, configure() {} },
    device: {
      limits: {
        maxTextureDimension2D: 8192,
        maxStorageBufferBindingSize: 1 << 28,
        maxComputeWorkgroupsPerDimension: 65535
      }
    },
    _width: 1,
    _height: 1,
    _output_resolution: resolution(),
    _render_resolution: resolution(),
    _renderTargets: { resize() {} },
    resolutionScale: 0.75,
    appliedPixelRatio: 1,
    _displayProfile: "sdr"
  });
  for (const dpr of [1, 1.25, 1.5, 2]) {
    renderer.pixelRatioOverride = dpr;
    renderer.resize(800, 600);
    const evidence = renderer.resolutionEvidence();
    assert.deepEqual(evidence.output, [800 * dpr, 600 * dpr]);
    assert.deepEqual(evidence.internal, [Math.floor(600 * dpr), Math.floor(450 * dpr)]);
    assert.equal(canvas.width, evidence.output[0]);
    assert.equal(canvas.style.width, "800px");
  }
});
