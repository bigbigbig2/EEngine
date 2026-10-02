import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { TextureVariationResidency } from '../../../OEngine/.test-dist/gpu/TextureVariationResidency.js';
import { buildTextureLocalVariation } from '../../../OEngine/.test-dist/texture/TextureLocalVariation.js';

if (!process.argv[2]) throw new Error('Pass the existing external webgpu runtime directory');
const { create, globals } = createRequire(resolve(process.argv[2], 'package.json'))('webgpu');
Object.assign(globalThis, globals);
const gpu = create(['backend=d3d12']);
const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
assert.ok(adapter && !adapter.info.isFallbackAdapter);
const bc = adapter.features.has('texture-compression-bc');
const device = await adapter.requestDevice({ requiredFeatures: bc ? ['texture-compression-bc'] : [] });
const errors = [], keepAlive = setInterval(() => {}, 1000);
device.addEventListener('uncapturederror', event => errors.push(event.error.message));
let disposing = false, loss = null;
void device.lost.then(info => { if (!disposing) loss = { reason: info.reason, message: info.message }; });
const output = resolve('.local/validation/surface-optimization-v1');
await mkdir(output, { recursive: true });
const report = { evidenceRole: 'diagnostic', passed: false, adapter: { vendor: adapter.info.vendor,
  architecture: adapter.info.architecture, description: adapter.info.description }, cases: [], apiErrors: errors };

// Independent diagnostic host adapter: encoder copies, one fixture submit.
// Production TextureVariationResidency is used unchanged, including its shader.
function command() {
  const encoder = device.createCommandEncoder(), buffers = [], finish = [], abort = [];
  return { device, closed: false, encoder, buffers,
    onFinished: { addOne(callback) { finish.push(callback); } },
    onAborted: { addOne(callback) { abort.push(callback); } },
    allocateTransientBuffer(usage, size) { const b = device.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST }); buffers.push(b); return b; },
    writeBuffer(target, offset, data, start, size) {
      const staging = device.createBuffer({ size, usage: GPUBufferUsage.COPY_SRC, mappedAtCreation: true });
      new Uint8Array(staging.getMappedRange()).set(new Uint8Array(data, start, size)); staging.unmap(); buffers.push(staging);
      encoder.copyBufferToBuffer(staging, 0, target, offset, size);
    },
    beginComputePass(options) { return encoder.beginComputePass(options); },
    async submit() { device.queue.submit([encoder.finish()]); this.closed = true; for (const callback of finish) callback(); await device.queue.onSubmittedWorkDone(); for (const b of buffers) b.destroy(); },
    abandon() { this.closed = true; for (const callback of abort) callback(); for (const b of buffers) b.destroy(); }
  };
}
const linear = x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
// Hardware sRGB decoding has implementation precision. Establish the actual
// decoded inputs with an independent per-texel consumer, then aggregate on CPU.
async function decodedMip(texture, width, height, mip, layer) {
  const module = device.createShaderModule({ code: `
    @group(0) @binding(0) var source:texture_2d_array<f32>;
    @group(0) @binding(1) var<storage,read_write> output:array<vec4f>;
    @group(0) @binding(2) var<uniform> dimensions:vec4u;
    @compute @workgroup_size(64) fn read(@builtin(global_invocation_id) id:vec3u){
      if id.x>=dimensions.x*dimensions.y{return;}
      output[id.x]=textureLoad(source,vec2i(i32(id.x%dimensions.x),i32(id.x/dimensions.x)),i32(dimensions.w),i32(dimensions.z));
    }` });
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'read' } });
  const result = device.createBuffer({ size: width*height*16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const settings = device.createBuffer({ size:16, usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(settings,0,new Uint32Array([width,height,mip,layer]));
  const group = device.createBindGroup({ layout:pipeline.getBindGroupLayout(0),entries:[
    {binding:0,resource:texture.createView({dimension:'2d-array'})},{binding:1,resource:{buffer:result}},{binding:2,resource:{buffer:settings}}] });
  const staging = device.createBuffer({ size:result.size, usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST });
  const encoder = device.createCommandEncoder(), pass=encoder.beginComputePass();
  pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(width*height/64));pass.end();
  encoder.copyBufferToBuffer(result,0,staging,0,result.size);device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);const rgba=new Float32Array(staging.getMappedRange()).slice();
  staging.unmap();staging.destroy();result.destroy();settings.destroy();return rgba;
}
async function capture(owner) {
  const staging = device.createBuffer({ size: owner.bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const encoder = device.createCommandEncoder(); encoder.copyBufferToBuffer(owner.buffer, 0, staging, 0, owner.bytes);
  device.queue.submit([encoder.finish()]); await staging.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(staging.getMappedRange()).slice(); staging.unmap(); staging.destroy();
  return { words: new Uint32Array(bytes.buffer), floats: new Float32Array(bytes.buffer) };
}
function compare(snapshot, slot, reference) {
  const descriptor = slot * 8, header = snapshot.words[descriptor + 3];
  assert.ok(header > 0); assert.equal(snapshot.words[descriptor + 2], reference.mips.length);
  let nodes = 0, maxError = 0;
  for (let mip = 0; mip < reference.mips.length; mip++) {
    const info = reference.mips[mip], row = header + mip * 8;
    assert.equal(snapshot.words[row], info.width); assert.equal(snapshot.words[row + 1], info.height);
    assert.equal(snapshot.words[row + 2], info.levels.length); assert.equal(snapshot.words[row + 4], 1);
    const levelTable = snapshot.words[row + 3];
    for (let level = 0; level < info.levels.length; level++) {
      const expected = info.levels[level], at = levelTable + level * 4;
      assert.equal(snapshot.words[at], expected.width); assert.equal(snapshot.words[at + 1], expected.height);
      assert.equal(snapshot.words[at + 2], expected.span); const data = snapshot.words[at + 3];
      for (let word = 0; word < expected.bounds.length; word++) {
        const error = Math.abs(snapshot.floats[data + word] - expected.bounds[word]);
        maxError = Math.max(maxError, error); assert.ok(error < 2e-6, `mip ${mip} level ${level} word ${word}: ${error}`);
      }
      nodes += expected.width * expected.height;
    }
  }
  return { nodes, maxError };
}
const owner = new TextureVariationResidency(device, 16);
const textures = [];
try {
  let slot = 0;
  for (const scenario of [
    { name: 'rgba8-npot', width: 13, height: 7, format: 'rgba8unorm', decodeSrgb: false },
    { name: 'rgba8-offline-published-bounds', width: 16, height: 8, format: 'rgba8unorm', decodeSrgb: false, offline: true },
    { name: 'rgba8-bank-srgb-decode', width: 16, height: 8, format: 'rgba8unorm', decodeSrgb: true },
    { name: 'srgb-format-hardware-decode', width: 8, height: 8, format: 'rgba8unorm-srgb', decodeSrgb: false }
  ]) {
    slot++; const mipCount = 3;
    const texture = device.createTexture({ size: [scenario.width, scenario.height, 2], format: scenario.format,
      mipLevelCount: mipCount, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }); textures.push(texture);
    const input = [];
    for (let mip = 0; mip < mipCount; mip++) {
      const width = Math.max(1, scenario.width >> mip), height = Math.max(1, scenario.height >> mip);
      const bytes = new Uint8Array(width * height * 4), rgba = new Float32Array(width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 4, values = [x < width / 2 ? 32 : 224, (y * 31 + mip * 13) % 256, 128, 255];
        bytes.set(values, at);
        for (let c = 0; c < 4; c++) { const value = values[c] / 255;
          rgba[at + c] = c < 3 && (scenario.decodeSrgb || scenario.format.endsWith('-srgb')) ? linear(value) : value; }
      }
      device.queue.writeTexture({ texture, mipLevel: mip, origin: [0, 0, 1] }, bytes, { bytesPerRow: width * 4 }, [width, height, 1]);
      input.push({ width, height, rgba: scenario.format.endsWith('-srgb') ? await decodedMip(texture,width,height,mip,1) : rgba });
    }
    const cmd = command(); assert.equal(owner.stage(cmd, { slot, generation: 1, revision: 7, texture, layer: 1,
      width: scenario.width, height: scenario.height, mipCount, availableMip: 0, decodeSrgb: scenario.decodeSrgb },
      scenario.offline ? buildTextureLocalVariation(input,4) : undefined), true);
    await cmd.submit();
    const result = compare(await capture(owner), slot, buildTextureLocalVariation(input, 4));
    report.cases.push({ name: scenario.name, ...result });
    const abandoned = command(); owner.stage(abandoned, { slot, generation: 1, revision: 8, texture, layer: 1,
      width: scenario.width, height: scenario.height, mipCount, availableMip: 0, decodeSrgb: scenario.decodeSrgb }); abandoned.abandon();
    assert.equal((await capture(owner)).words[slot * 8 + 5], 7, 'abort cannot publish revision or advance committed state');
  }
  if (bc) {
    slot++; const texture = device.createTexture({ size: [8, 8, 1], format: 'bc1-rgba-unorm', mipLevelCount: 2,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }); textures.push(texture);
    const input = [];
    for (let mip = 0; mip < 2; mip++) {
      const width = 8 >> mip, height = 8 >> mip, blocks = width / 4, data = new Uint8Array(blocks * blocks * 8);
      const rgba = new Float32Array(width * height * 4);
      for (let y = 0; y < blocks; y++) for (let x = 0; x < blocks; x++) {
        const red = x === 0, color = red ? 0xf800 : 0x07e0, at = (y * blocks + x) * 8;
        data[at] = color & 255; data[at + 1] = color >> 8; // endpoint1=black, all selectors endpoint0.
        for (let cy = 0; cy < 4; cy++) for (let cx = 0; cx < 4; cx++) rgba.set(red ? [1,0,0,1] : [0,1,0,1], ((y*4+cy)*width+x*4+cx)*4);
      }
      device.queue.writeTexture({ texture, mipLevel: mip }, data, { bytesPerRow: blocks * 8 }, [width, height, 1]); input.push({ width, height, rgba });
    }
    const cmd = command(); owner.stage(cmd, { slot, generation: 1, revision: 3, texture, layer: 0, width: 8, height: 8,
      mipCount: 2, availableMip: 0, decodeSrgb: false }); await cmd.submit();
    report.cases.push({ name: 'bc1-actual-decoded-values', ...compare(await capture(owner), slot, buildTextureLocalVariation(input, 4)) });
  } else report.bc = 'unsupported adapter feature; compressed GPU case not measured';
  assert.deepEqual(errors, []); assert.equal(loss, null); report.stats = owner.stats(); report.passed = true;
} catch (error) { report.error = String(error.stack ?? error); throw error; }
finally {
  owner.destroy(); for (const texture of textures) texture.destroy(); disposing = true; device.destroy(); clearInterval(keepAlive);
  report.deviceLost = loss; await writeFile(resolve(output, 'texture-variation-native.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
