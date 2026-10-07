import assert from "node:assert/strict";
import test from "node:test";
import { Fsr3UpscalerRuntime } from "../../.test-dist/render/passes/fsr3/Fsr3UpscalerRuntime.js";
import { FrameGraph } from "../../.test-dist/framegraph/FrameGraph.js";

globalThis.GPUShaderStage = { COMPUTE: 1 };
globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
globalThis.GPUTextureUsage = { TEXTURE_BINDING: 1, STORAGE_BINDING: 2, COPY_DST: 4 };

function harness() {
  const writes = [];
  const textures = [];
  const device = {
    lost: new Promise(() => {}),
    limits: { maxTextureDimension2D: 8192, maxStorageBufferBindingSize: 1 << 27, maxBufferSize: 1 << 28 },
    queue: { writeBuffer() {}, writeTexture() {} },
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createComputePipeline: () => ({}),
    createSampler: () => ({}),
    createBuffer: () => ({ destroy() {} }),
    createTexture: (descriptor) => {
      const texture = {
        label: descriptor.label,
        width: descriptor.size[0],
        height: descriptor.size[1],
        format: descriptor.format,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        }
      };
      textures.push(texture);
      return texture;
    }
  };
  const command = {
    writeBuffer(_buffer, _offset, data) {
      writes.push(new DataView(data));
    }
  };
  return { device, command, writes, textures };
}

const frame = {
  renderWidth: 640,
  renderHeight: 360,
  outputWidth: 1280,
  outputHeight: 720,
  jitter: [0.5, -0.25],
  cameraNear: 0.1,
  cameraFar: 1000,
  cameraFovY: Math.PI / 3,
  cameraInfiniteFar: true,
  frameTimeMs: 16.67,
  reset: true
};

test("FSR3 frame constants follow camera jitter and retain history across ordinary frames", () => {
  const h = harness();
  const fsr3 = new Fsr3UpscalerRuntime(h.device);
  fsr3.prepareFrame(h.command, frame);
  fsr3.assertPreparedFrame(640, 360, 1280, 720);
  assert.throws(() => fsr3.assertPreparedFrame(800, 360, 1280, 720), /prepared frame/);
  assert.equal(fsr3.generation, 1);
  assert.equal(h.writes[0].getFloat32(64, true), -0.25);
  assert.equal(h.writes[0].getFloat32(68, true), 0.125);
  assert.equal(h.writes[0].getFloat32(124, true), 0);
  fsr3.commit(Promise.resolve());
  fsr3.prepareFrame(h.command, { ...frame, jitter: [-0.5, 0.25], reset: false });
  assert.equal(fsr3.generation, 1);
  assert.equal(h.writes[1].getFloat32(72, true), -0.25);
  assert.equal(h.writes[1].getFloat32(76, true), 0.125);
  assert.ok(Math.abs(h.writes[1].getFloat32(96, true) - -0.5 / 640) < 1e-9);
  // The GPU ratio pass replaces this neutral CPU placeholder before FSR3 reads it.
  assert.equal(h.writes[1].getFloat32(116, true), 1);
  assert.equal(h.writes[1].getFloat32(124, true), 1);
  fsr3.invalidate();
  fsr3.prepareFrame(h.command, { ...frame, reset: true });
  assert.equal(fsr3.generation, 2);
  assert.equal(h.writes[2].getFloat32(124, true), 0);
  fsr3.commit(Promise.resolve());
  fsr3.destroy();
});

test("FSR3 finite inverted depth reconstructs the camera near and far planes", () => {
  const h = harness();
  const fsr3 = new Fsr3UpscalerRuntime(h.device);
  fsr3.prepareFrame(h.command, { ...frame, cameraInfiniteFar: false });
  const constants = h.writes[0];
  const x = constants.getFloat32(48, true);
  const y = constants.getFloat32(52, true);
  assert.ok(Math.abs(y / (1 - x) - frame.cameraNear) < 1e-5);
  assert.ok(Math.abs(y / (0 - x) - frame.cameraFar) < 1e-3);
  fsr3.commit(Promise.resolve());
  fsr3.destroy();
});

test("FSR3 graph roles follow the prepared frame and retired histories wait for GPU completion", async () => {
  const h = harness();
  const fsr3 = new Fsr3UpscalerRuntime(h.device);
  fsr3.prepareFrame(h.command, frame);
  const graph = new FrameGraph("fsr3-history-binding");
  const imported = (name) => graph.import_resource(name, { kind: "imported", label: name }, {});
  const resolvers = new Map();
  const output = fsr3.addToGraph(
    graph,
    {
      color: imported("color"),
      depth: imported("depth"),
      motion: imported("motion"),
      reactiveMask: imported("reactive"),
      validityMask: imported("validity"),
      preExposure: imported("pre-exposure"),
      priorExposure: imported("prior-exposure"),
      width: 640,
      height: 360,
      outputWidth: 1280,
      outputHeight: 720
    },
    (name, resolve) => {
      resolvers.set(name, resolve);
      return resolve(fsr3);
    }
  );
  const present = graph.add("test/consume reconstructed color", {}, () => {});
  present.read(output);
  present.make_side_effect();
  const dump = graph.compile().dump();
  const executable = dump.executablePassOrder.map((id) => dump.passes[id].name);
  for (const stage of [
    "FSR3/GPU pre-exposure ratio",
    "FSR3/Prepare Inputs",
    "FSR3/Luma SPD source",
    "FSR3/Shading SPD source",
    "FSR3/Shading Change",
    "FSR3/Prepare Reactivity",
    "FSR3/Luma Instability",
    "FSR3/Accumulate",
    "FSR3/RCAS",
    "test/consume reconstructed color"
  ]) {
    assert.ok(executable.includes(stage), stage);
  }
  assert.ok(executable.indexOf("FSR3/GPU pre-exposure ratio") < executable.indexOf("FSR3/Prepare Inputs"));
  assert.equal(dump.resources.find((entry) => entry.name === "FSR3/previous color").imported, true);
  assert.equal(dump.resources.find((entry) => entry.name === "FSR3/current color").imported, true);
  const read = resolvers.get("FSR3/previous color");
  const write = resolvers.get("FSR3/current color");
  assert.ok(read && write);
  const firstRead = read(fsr3);
  const firstWrite = write(fsr3);
  let finishGpu;
  const gpuDone = new Promise((resolve) => {
    finishGpu = resolve;
  });
  fsr3.commit(gpuDone);
  fsr3.prepareFrame(h.command, { ...frame, reset: false });
  fsr3.assertPreparedFrame(640, 360, 1280, 720);
  assert.equal(read(fsr3), firstWrite);
  assert.equal(write(fsr3), firstRead);
  fsr3.commit(gpuDone);
  fsr3.prepareFrame(h.command, { ...frame, reset: true });
  assert.equal(firstRead.destroyed, false);
  assert.equal(firstWrite.destroyed, false);
  assert.notEqual(read(fsr3), firstRead);
  finishGpu();
  await gpuDone;
  await Promise.resolve();
  // Preparing a reset is a candidate, not permission to retire committed history.
  assert.equal(firstRead.destroyed, false);
  assert.equal(firstWrite.destroyed, false);
  fsr3.commit(Promise.resolve());
  await Promise.resolve();
  assert.equal(firstRead.destroyed, true);
  assert.equal(firstWrite.destroyed, true);
  fsr3.invalidate();
  fsr3.destroy();
});

test("FSR3 ordinary and resize abort restore committed history roles and jitter for retry", () => {
  const h = harness();
  const fsr3 = new Fsr3UpscalerRuntime(h.device);
  fsr3.prepareFrame(h.command, frame);
  fsr3.commit(Promise.resolve());
  const committed = h.textures.filter((texture) => texture.label?.startsWith("FSR3/color/"));
  const role = fsr3.readIndex;
  fsr3.prepareFrame(h.command, { ...frame, renderWidth: 800, outputWidth: 1600, reset: false });
  assert.equal(fsr3.generation, 2);
  const candidates = h.textures.filter(
    (texture) => texture.label?.startsWith("FSR3/color/") && !committed.includes(texture)
  );
  fsr3.abort();
  assert.equal(fsr3.generation, 1);
  assert.equal(fsr3.readIndex, role);
  assert.ok(committed.every((texture) => !texture.destroyed));
  assert.ok(candidates.every((texture) => texture.destroyed));
  assert.equal(fsr3.canRetainHistory(640, 360, 1280, 720), true);
  fsr3.prepareFrame(h.command, { ...frame, reset: false });
  fsr3.abort();
  assert.equal(fsr3.readIndex, role);
  fsr3.prepareFrame(h.command, { ...frame, reset: false });
  assert.equal(h.writes.at(-1).getFloat32(124, true), 1);
  assert.equal(h.writes.at(-1).getFloat32(72, true), -0.25);
  fsr3.commit(Promise.resolve());
  fsr3.destroy();
});

test("FSR3 physical accounting includes candidates and fence-retired histories", async () => {
  const h = harness();
  const fsr3 = new Fsr3UpscalerRuntime(h.device);
  const bytes = (f) => 16 * f.outputWidth * f.outputHeight + 22 * f.renderWidth * f.renderHeight + 32;
  const permanent = 177;
  assert.equal(fsr3.allocatedBytes, permanent);
  let finish;
  const fence = new Promise((resolve) => { finish = resolve; });
  fsr3.prepareFrame(h.command, frame);
  fsr3.commit(fence);
  assert.equal(fsr3.allocatedBytes, permanent + bytes(frame));
  const resized = { ...frame, renderWidth: 800, outputWidth: 1600, reset: false };
  fsr3.prepareFrame(h.command, resized);
  assert.equal(fsr3.allocatedBytes, permanent + bytes(frame) + bytes(resized));
  fsr3.abort();
  assert.equal(fsr3.allocatedBytes, permanent + bytes(frame));
  fsr3.prepareFrame(h.command, resized);
  fsr3.commit(fence);
  assert.equal(fsr3.allocatedBytes, permanent + bytes(frame) + bytes(resized));
  fsr3.destroy();
  assert.equal(fsr3.allocatedBytes, permanent + bytes(frame) + bytes(resized));
  finish();
  await fence;
  await Promise.resolve();
  assert.equal(fsr3.allocatedBytes, 0);
});
