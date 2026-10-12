import assert from "node:assert/strict";
import { FrameGraph, FrameGraphContext } from "../../.test-dist/framegraph/FrameGraph.js";
import { NativeTemporalV2 as Before } from "./fixtures/native-temporal-observation/before.mjs";
import { NativeTemporalV2 as Candidate } from "../../.test-dist/render/temporal/NativeTemporalV2.js";

// One captured real Dungeon frame. Capture copies happen after each input's
// last writer, before alias/reuse; they never participate in production control.
// Replay restores the same prior histories before every timed complete chain.
export async function runNativeTemporalObservationReplayGpuOracle(device) {
  const base = "/.local/native-temporal-observation-20261012/A1-v2/temporal-inputs/";
  const manifest = await (await fetch(base + "manifest.json")).json();
  const products = new Map();
  const owned = [];
  const runtimes = [];
  const createBuffer = (size, usage) => {
    const buffer = device.createBuffer({ size, usage });
    owned.push(buffer);
    return buffer;
  };
  const proxy = new Proxy(device, {
    get(target, key) {
      if (key === "createTexture") {
        return (descriptor) => target.createTexture({ ...descriptor, usage: descriptor.usage | GPUTextureUsage.COPY_DST });
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    for (const product of manifest.products) {
      const response = await fetch(base + product.name + ".bin");
      assert.ok(response.ok, `Missing capture ${product.name}`);
      const bytes = await response.arrayBuffer();
      assert.equal(bytes.byteLength, product.bytes);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const sha256 = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
      assert.equal(sha256, product.sha256, `Captured input changed: ${product.name}`);
      let resource;
      if (product.format) {
        resource = device.createTexture({
          label: `Replay/${product.name}`,
          size: [product.width, product.height],
          format: product.format,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
        });
        owned.push(resource);
        device.queue.writeTexture({ texture: resource }, bytes, { bytesPerRow: product.bytesPerRow }, [product.width, product.height]);
      } else {
        resource = createBuffer(bytes.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
        device.queue.writeBuffer(resource, 0, bytes);
      }
      products.set(product.name, { resource, bytes, descriptor: product });
    }
    const frameBytes = products.get("frame").bytes;
    const frameUint = new Uint32Array(frameBytes);
    const frameFloat = new Float32Array(frameBytes);
    const [width, height] = frameUint;
    assert.deepEqual([width, height], [1920, 1080]);
    assert.equal(frameUint[2], 1, "Capture must contain eligible submitted history");
    runtimes.push(new Before(proxy), new Candidate(proxy));
    const query = device.createQuerySet({ type: "timestamp", count: 256 });
    owned.push(query);
    const resolved = createBuffer(256 * 8, GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC);
    const readback = createBuffer(256 * 8, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const historyNames = {
      color: "previousColor",
      depth: "previousDepth",
      luma: "previousLuma",
      lumaHistory: "previousLumaHistory",
      confidence: "previousConfidence",
      frameInfo: "previousFrameInfo",
    };
    const samples = [];
    async function encode(index, record = false) {
      const owner = runtimes[index];
      owner.prepareFrame({ writeBuffer: (...args) => device.queue.writeBuffer(...args) }, {
        width, height, reset: true,
        jitter: [frameFloat[4], frameFloat[5]],
        frameTimeMs: frameFloat[8] * 1000,
        cameraFar: frameFloat[9],
      });
      // Keep the captured current/previous jitter, validity and exposure state.
      device.queue.writeBuffer(owner.constants, 0, frameBytes);
      const graph = new FrameGraph("Real Dungeon complete Temporal replay");
      const imported = (name) => graph.import_resource(name, { kind: "imported" }, products.get(name).resource);
      const output = owner.addToGraph(graph, {
        color: imported("color"), seed: imported("seed"), response: imported("response"),
        identity: imported("identity"), previousIdentity: imported("previousIdentity"),
        preExposure: imported("preExposure"), priorExposure: imported("priorExposure"), width, height,
      }, (_name, resolve) => resolve(owner));
      const consume = graph.add("Replay output", {}, () => {});
      consume.read(output);
      consume.make_side_effect();
      const compiled = graph.compile();
      const encoder = device.createCommandEncoder();
      for (const [history, name] of Object.entries(historyNames)) {
        const product = products.get(name);
        encoder.copyTextureToTexture(
          { texture: product.resource },
          { texture: owner.candidate[history][owner.readIndex] },
          [product.descriptor.width, product.descriptor.height],
        );
      }
      const sample = samples.length;
      const passes = [];
      const command = {
        gpu_encoder: encoder,
        beginComputePass(descriptor) {
          const queryBase = sample * 16 + passes.length * 2;
          passes.push(descriptor.label);
          return encoder.beginComputePass({ ...descriptor, ...(record ? {
            timestampWrites: { querySet: query, beginningOfPassWriteIndex: queryBase, endOfPassWriteIndex: queryBase + 1 },
          } : {}) });
        },
        copyBufferToBuffer: (...args) => encoder.copyBufferToBuffer(...args),
      };
      let finish;
      const completion = new Promise((resolve) => { finish = resolve; });
      compiled.execute(new FrameGraphContext({ device, encoder: command, completion }));
      assert.equal(passes.length, index === 0 ? 6 : 7);
      device.queue.submit([encoder.finish()]);
      const done = device.queue.onSubmittedWorkDone();
      owner.commit(done);
      await done;
      finish();
      compiled.destroy();
      if (record) samples.push({ path: index === 0 ? "before" : "candidate", passes });
    }
    for (let frame = 0; frame < 8; frame++) {
      await encode(0);
      await encode(1);
    }
    for (let frame = 0; frame < 16; frame++) await encode([0, 1, 1, 0][frame % 4], true);
    const encoder = device.createCommandEncoder();
    encoder.resolveQuerySet(query, 0, 256, resolved, 0);
    encoder.copyBufferToBuffer(resolved, 0, readback, 0, 256 * 8);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const ticks = new BigUint64Array(readback.getMappedRange());
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index];
      const base = index * 16;
      sample.stageMs = sample.passes.map((label, pass) => ({ label, ms: Number(ticks[base + pass * 2 + 1] - ticks[base + pass * 2]) / 1e6 }));
      sample.ms = Number(ticks[base + sample.passes.length * 2 - 1] - ticks[base]) / 1e6;
    }
    readback.unmap();
    return { status: "passed", capture: base, domain: [width, height], jitter: [frameFloat[4], frameFloat[5]], samples,
      limitation: "One real captured history state and jitter phase; eight short ABBA samples/path. Restoring prior histories precedes timestamps. Replay is complete-chain cost evidence, not whole-frame or dynamic quality qualification." };
  } finally {
    runtimes.forEach((owner) => owner.destroy());
    await device.queue.onSubmittedWorkDone();
    await Promise.resolve();
    owned.forEach((resource) => resource.destroy());
  }
}
