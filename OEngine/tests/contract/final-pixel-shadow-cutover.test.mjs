import test from "node:test";
import assert from "node:assert/strict";
import "../webgpu-test-globals.mjs";
import { FrameProgramCache } from "../../.test-dist/render/program/FrameProgram.js";
import { nativeSurfacePublicationDescriptors } from "../../.test-dist/shaders/native_surface.js";
import { AppearanceGraphBuilder } from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { lowerNativeMaterial } from "../../.test-dist/shaders/native_material.js";
import { FinalPixelLightingPublication } from "../../.test-dist/render/lighting/FinalPixelLightingPublication.js";

globalThis.GPUBufferUsage ??= { COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };

test("final lighting frame pool retains three fences, rolls back abort and releases device epoch", async () => {
  const buffers = [];
  let lose;
  const device = {
    lost: new Promise((resolve) => (lose = resolve)),
    limits: {
      minStorageBufferOffsetAlignment: 256,
      maxBufferSize: 1 << 28,
      maxStorageBufferBindingSize: 1 << 27,
    },
    queue: { writeBuffer() {} },
    createBuffer(descriptor) {
      const buffer = {
        ...descriptor,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
      buffers.push(buffer);
      return buffer;
    },
  };
  const owner = new FinalPixelLightingPublication(device);
  const makeCommand = () => {
    let done;
    const finished = [],
      aborted = [];
    return {
      device,
      closed: false,
      gpuDone: new Promise((resolve) => (done = resolve)),
      onFinished: { addOne: (fn) => finished.push(fn) },
      onAborted: { addOne: (fn) => aborted.push(fn) },
      finish() {
        this.closed = true;
        for (const fn of finished) fn();
      },
      abort() {
        this.closed = true;
        for (const fn of aborted) fn();
      },
      done() {
        done();
      },
    };
  };
  const commands = Array.from({ length: 3 }, makeCommand);
  const frames = commands.map((command) => {
    const frame = owner.prepare(24, 260, command);
    command.finish();
    return frame;
  });
  assert.equal(new Set(frames.map((frame) => frame.buffer)).size, 3);
  assert.throws(() => owner.prepare(24, 260, makeCommand()), /three unresolved/);
  assert.ok(buffers.every((buffer) => !buffer.destroyed));
  commands[0].done();
  await commands[0].gpuDone;
  await Promise.resolve();
  const aborted = makeCommand();
  const reused = owner.prepare(24, 260, aborted);
  assert.equal(reused.buffer, frames[0].buffer);
  aborted.abort();
  const pending = makeCommand();
  const resized = owner.prepare(48, 260, pending);
  assert.notEqual(resized.buffer, frames[0].buffer);
  assert.equal(frames[0].buffer.destroyed, true);
  lose({ reason: "destroyed" });
  await Promise.resolve();
  assert.equal(pending.closed, true);
  assert.equal(resized.buffer.destroyed, true);
  assert.ok(frames.slice(1).every((frame) => !frame.buffer.destroyed));
  for (const command of commands.slice(1)) command.done();
  await Promise.all(commands.map((command) => command.gpuDone));
  await Promise.resolve();
  assert.equal(owner.allocatedBytes, 0);
  assert.ok(buffers.every((buffer) => buffer.destroyed));
  assert.throws(() => owner.prepare(24, 260, makeCommand()), /live frame/);
});

test("Shadow production product is post-commit sampling, never a receiver mask", () => {
  const plan = new FrameProgramCache().getOrCreate({
    kind: "scene",
    intent: "present",
    viewFamily: "main",
    outputWidth: 1920,
    outputHeight: 1080,
    outputFormat: "bgra8unorm",
    capabilityProfile: "1",
    internalWidth: 1920,
    internalHeight: 1080,
    virtualGeometry: true,
    virtualBankCount: 4,
    previousHzb: false,
    currentHzbLateRecheck: false,
    activeSets: [0],
    hasLit: true,
    physicalEnvironment: true,
    shadowProfile: "vsm-directional-high",
  });
  assert.ok(!plan.products.includes("shadow-visibility"));
  const sampling = plan.facts.find((fact) => fact.product === "shadow-sampling");
  assert.ok(sampling);
  assert.equal(sampling.format, "structured-buffer");
  assert.equal(sampling.domain, "gpu-work");
  assert.equal(sampling.extent, null);
  assert.ok(sampling.consumers.includes("surface"));
});

test("ordinary lit Native uses one legal complete Sun invocation at the minimum sampled limit", () => {
  const builder = new AppearanceGraphBuilder();
  builder.output("baseColor", builder.constant([1, 1, 1]));
  const program = lowerNativeMaterial(compileAppearanceGraph(builder.build()));
  const material = Array.from({ length: 10 }, (_, binding) => ({
    binding,
    visibility: 4,
    texture: { sampleType: "float" },
  }));
  const result = nativeSurfacePublicationDescriptors(
    program,
    material,
    {
      compact: true,
      productGeometry: true,
      unlit: false,
      reactive: true,
      physicalSun: true,
    },
    { maxSampledTexturesPerShaderStage: 16 },
  );
  assert.equal(result.continuation, undefined);
  assert.equal(result.descriptor.groups.flat().filter((entry) => entry.texture).length, 16);
  assert.match(result.descriptor.source, /vsm_sample_directional\(resolved_position/);
  assert.doesNotMatch(result.descriptor.source, /directional_shadow_visibility_at|prior_native_hdr/);
});
