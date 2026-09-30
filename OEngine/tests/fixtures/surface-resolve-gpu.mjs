import assert from "node:assert/strict";
import { surfaceSampleCapacity, packSurfaceSampleHeader, SURFACE_SAMPLE_HEADER_WORDS,
  SURFACE_SAMPLE_TILE, SURFACE_SAMPLE_COUNTER, SURFACE_SAMPLE_RESULT_FIELD as FIELD,
  SURFACE_SAMPLE_RESULT_PACKING as PACK, SURFACE_SAMPLE_RESULT_TEXELS } from "../../.test-dist/render/surface/SurfaceSampleAbi.js";
import { SURFACE_SAMPLE_RESOLVE_WGSL } from "../../.test-dist/shaders/surface_sample_resolve.js";
import { surfaceResolveReference } from "../../.test-dist/render/surface/SurfaceSignalPlan.js";
import { halfToFloat } from "../../.test-dist/loaders/float16.js";

/** Synthetic immutable input exercises GPU reconstruction independent of BRDF noise. */
export async function surfaceResolveGpuOracle(device) {
  const allocated = [];
  const texture = (size, format, usage) => { const value = device.createTexture({ size, format, usage }); allocated.push(value); return value; };
  const buffer = (size, usage, data) => {
    const value = device.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST }); allocated.push(value);
    if (data) device.queue.writeBuffer(value, 0, data); return value;
  };
  device.pushErrorScope("validation");
  try {
    const capacity = surfaceSampleCapacity(8, 8, device.limits);
    const words = new Uint32Array(capacity.workBytes / 4); words.set(packSurfaceSampleHeader(capacity));
    words[SURFACE_SAMPLE_HEADER_WORDS] = 1;
    words[SURFACE_SAMPLE_COUNTER.results] = 16;
    const samples = [];
    const texels = new Uint32Array(capacity.resultWidth * capacity.resultHeight * 4);
    const floats = new Float32Array(texels.buffer);
    for (let cell = 0; cell < 16; cell++) {
      words[SURFACE_SAMPLE_HEADER_WORDS + SURFACE_SAMPLE_TILE.cellRates + cell] = 3;
      words[SURFACE_SAMPLE_HEADER_WORDS + SURFACE_SAMPLE_TILE.cellResults + cell] = cell;
      const x = (cell % 4) * 2, y = Math.floor(cell / 4) * 2;
      const sample = { value: [x / 8, y / 8, 0.25, 1], normal: [0,0,1], depth: 0.5,
        domain: x === 4 ? 9 : 7, identity: [2,3,4], representation: 0, layout: 3,
        position: [x,y], stride: [2,2], valid: true, kind: 1 };
      if (x === 0 && y === 4) sample.depth = 0.9;
      if (x === 2 && y === 4) sample.normal = [1,0,0];
      samples.push(sample);
      const at = cell * SURFACE_SAMPLE_RESULT_TEXELS * 4;
      floats.set(sample.value, at + FIELD.value * 4); floats.set([...sample.normal, 1], at + FIELD.normal * 4);
      texels[at + FIELD.closure * 4 + 3] = (1 << PACK.kindShift) | (3 << PACK.rateShift);
      floats[at + FIELD.footprint * 4] = sample.depth; texels.set([x,y,0], at + FIELD.footprint * 4 + 1);
      texels.set([...sample.identity, sample.domain], at + FIELD.identity * 4);
    }
    const work = buffer(capacity.workBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, words);
    const results = texture([capacity.resultWidth,capacity.resultHeight], "rgba32uint", GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
    device.queue.writeTexture({ texture: results }, texels, { bytesPerRow: capacity.resultWidth * 16 }, [capacity.resultWidth, capacity.resultHeight]);
    const keys = texture([8,8], "r32uint", GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
    device.queue.writeTexture({ texture: keys }, new Uint32Array(64), { bytesPerRow: 32 }, [8,8]);
    const depth = texture([8,8], "depth32float", GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT);
    const hdr = texture([8,8], "rgba16float", GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC);
    const budget = buffer(32, GPUBufferUsage.UNIFORM, new Float32Array([0,0,0.01,0.02,0,0,0,0]));
    const readback = buffer(8 * 256 + 256, GPUBufferUsage.MAP_READ);
    const module = device.createShaderModule({ code: SURFACE_SAMPLE_RESOLVE_WGSL });
    assert.deepEqual((await module.getCompilationInfo()).messages.filter(message => message.type === "error"), []);
    const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "resolve" } });
    const encoder = device.createCommandEncoder();
    const clear = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: {
      view: depth.createView(), depthLoadOp: "clear", depthClearValue: 0.5, depthStoreOp: "store" } }); clear.end();
    const pass = encoder.beginComputePass(); pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: work } }, { binding: 1, resource: results.createView() },
      { binding: 2, resource: hdr.createView() }, { binding: 3, resource: keys.createView() },
      { binding: 4, resource: depth.createView() }, { binding: 5, resource: { buffer: budget } }
    ] })); pass.dispatchWorkgroups(1); pass.end();
    encoder.copyTextureToBuffer({ texture: hdr }, { buffer: readback, bytesPerRow: 256 }, [8,8]);
    encoder.copyBufferToBuffer(work, 0, readback, 8 * 256, 256);
    device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
    const mapped = readback.getMappedRange();
    const output = new Uint16Array(mapped);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const owner = samples[Math.floor(y / 2) * 4 + Math.floor(x / 2)];
      const expected = surfaceResolveReference(owner, samples.filter(sample => sample !== owner), 0.02, 0.01, [x,y], 0.5);
      for (let channel = 0; channel < 4; channel++) assert.ok(Math.abs(halfToFloat(output[y * 128 + x * 4 + channel]) - expected[channel]) < 0.001);
    }
    const counts = new Uint32Array(mapped, 8 * 256, 64);
    assert.ok(counts[SURFACE_SAMPLE_COUNTER.reconstructionAccepted] > 0);
    assert.ok(counts[SURFACE_SAMPLE_COUNTER.reconstructionRejected] > 0);
    readback.unmap(); assert.equal(await device.popErrorScope(), null);
  } finally { allocated.forEach(value => value.destroy()); }
}
