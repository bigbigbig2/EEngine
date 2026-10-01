// Diagnostic of the production demand -> finite PSO -> field publication chain.
// Deterministic ABI/readback integration; no algorithm or performance adoption claim.
import { AppearanceProgramRegistry } from '../../../OEngine/.test-dist/gpu/AppearanceProgramRegistry.js';
import { GpuAppearancePublication } from '../../../OEngine/.test-dist/gpu/GpuAppearancePublication.js';
import { GpuAppearanceCache } from '../../../OEngine/.test-dist/gpu/GpuAppearanceCache.js';
import { AppearanceGraphBuilder } from '../../../OEngine/.test-dist/material/AppearanceGraph.js';
import { compileAppearanceGraph } from '../../../OEngine/.test-dist/material/AppearanceGraphCompiler.js';
import { StandardShadeMaterial } from '../../../OEngine/.test-dist/material/StandardShadeMaterial.js';
import { APPEARANCE_FIELD_COUNT } from '../../../OEngine/.test-dist/gpu/GpuAppearanceCacheAbi.js';
import { FrameGeometryArena } from '../../../OEngine/.test-dist/render/FrameGeometryArena.js';
import { WinnerPrimitiveInterpolation } from '../../../OEngine/.test-dist/render/surface/WinnerPrimitiveInterpolation.js';
import { GPU_FRAME_ATTRIBUTE_STRIDE, GPU_FRAME_ATTRIBUTE_VECTORS } from '../../../OEngine/.test-dist/gpu/GpuFrameGeometryAttributesAbi.js';

function check(condition, message) { if (!condition) throw new Error(message); }
function event() {
  const callbacks = [];
  return { addOne: callback => callbacks.push(callback), send: () => callbacks.splice(0).forEach(callback => callback()) };
}

export async function runAppearanceDemandFixture(device) {
  const width = 515, height = 515, pixels = width * height;
  const resources = [], registry = new AppearanceProgramRegistry(device);
  const cache = new GpuAppearanceCache(device, undefined, { pages: 1, maxDemandTasks: 1024, maxBytes: 65536, maxAge: 120 });
  let publication, winnerOwner, arenaOwner;
  function makeBuffer(size, usage, label) {
    const buffer = device.createBuffer({ size, usage, label }); resources.push(buffer); return buffer;
  }
  function command(label) {
    const encoder = device.createCommandEncoder({ label }), temporary = [];
    const c = { device, closed: false, gpu_encoder: encoder,
      onBeforeFinish: event(), onFinished: event(), onAborted: event(),
      writeBuffer(buffer, offset, bytes, start, length) {
        const staging = device.createBuffer({ size: length, usage: GPUBufferUsage.COPY_SRC, mappedAtCreation: true });
        new Uint8Array(staging.getMappedRange()).set(new Uint8Array(bytes, start, length)); staging.unmap();
        temporary.push(staging); encoder.copyBufferToBuffer(staging, 0, buffer, offset, length);
      },
      allocateTransientBufferAndLoad(bytes, usage) {
        const buffer = device.createBuffer({ size: bytes.byteLength, usage, mappedAtCreation: true });
        new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(bytes)); buffer.unmap(); temporary.push(buffer); return buffer;
      },
      async finish() {
        c.onBeforeFinish.send(); device.queue.submit([encoder.finish()]); c.closed = true; c.onFinished.send();
        await device.queue.onSubmittedWorkDone(); for (const buffer of temporary) buffer.destroy();
      }
    };
    return c;
  }
  function source(materialSlot, rgb) {
    const material = new StandardShadeMaterial(), graph = new AppearanceGraphBuilder();
    graph.output('baseColor', graph.parameter('oracle-color', rgb));
    graph.output('alpha', graph.constant(0.5));
    graph.output('normalTS', graph.constant([0, 0, 1]));
    return { materialSlot, material, program: compileAppearanceGraph(graph.build()), textureBindingSetId: 0, textureRefs: new Map() };
  }
  const colors = [[0.25, 0.5, 0.75], [2, 4, 8]], cases = [];
  try {
    const upload = command('Appearance diagnostic publication');
    publication = new GpuAppearancePublication(device, registry, colors.map((color, slot) => source(slot, color)),
      upload, new Map(), new Map(), undefined, undefined, cache);
    await publication.ready; await upload.finish();
    // Ensure this fixture really crosses the production bounded task pool.
    const taskBuffer = publication.demandCounters;
    const work = makeBuffer(80, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, 'Appearance diagnostic meshlet work');
    device.queue.writeBuffer(work, 0, new Uint32Array([2, 2, 0, 2, 0, 1, 0, 0,
      0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1]));
    const visibility = device.createTexture({ size: [width, height], format: 'r32uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }); resources.push(visibility);
    const visibilityView = visibility.createView();
    const metadata = makeBuffer(4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, 'Geometry source prefix');
    arenaOwner = new FrameGeometryArena(device);
    const arena = arenaOwner.prepare(metadata, 4, { workCapacity: 2, vertexCapacity: 6, triangleCapacity: 2,
      dictionaryCapacity: 1, coefficientCapacity: 1, probeLimit: 1, maxBytes: 65536 });
    device.queue.writeBuffer(arena.buffer, arena.sourceDirectory.offset, new Uint32Array([
      2, 1, 6, 2, 0, 0, 3, 1, 3, 1, 3, 1
    ]));
    device.queue.writeBuffer(arena.buffer, arena.clips.offset, new Float32Array([
      -1, 1, 0.5, 1, 3, 1, 0.5, 1, -1, -3, 0.5, 1,
      -1, 1, 0.5, 1, 3, 1, 0.5, 1, -1, -3, 0.5, 1
    ]));
    device.queue.writeBuffer(arena.buffer, arena.triangles.offset, new Uint32Array([0x020100, 0x020100]));
    const attributes = makeBuffer(6 * GPU_FRAME_ATTRIBUTE_STRIDE, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, 'Shared frame attributes');
    const attributeValues = new Float32Array(6 * GPU_FRAME_ATTRIBUTE_VECTORS * 4);
    for (let vertex = 0; vertex < 6; vertex++) attributeValues.set([1, 1, 1, 1], vertex * GPU_FRAME_ATTRIBUTE_VECTORS * 4 + 12);
    device.queue.writeBuffer(attributes, 0, attributeValues);
    winnerOwner = await WinnerPrimitiveInterpolation.create(device);
    const winner = winnerOwner.prepare({ visibility: visibilityView, width, height,
      geometry: { directory: arena.sourceDirectory, clips: arena.clips, triangles: arena.triangles },
      storage: { dictionary: arena.dictionary, coefficients: arena.coefficients, work: arena.work, control: arena.control },
      budget: { dictionaryCapacity: 1, coefficientCapacity: 1, probeLimit: 1, maxBytes: 65536 } });
    const fields = device.createTexture({ size: [width, height, APPEARANCE_FIELD_COUNT], format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC }); resources.push(fields);
    const rowBytes = Math.ceil(width * 8 / 256) * 256;
    const readback = makeBuffer(rowBytes * height * 3, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ, 'Appearance field readback');
    const counts = makeBuffer(16, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ, 'Appearance control readback');
    const view = fields.createView({ dimension: '2d-array' });
    const half = word => {
      const sign = word & 32768 ? -1 : 1, exponent = (word >> 10) & 31, fraction = word & 1023;
      return sign * (exponent === 0 ? fraction * 2 ** -24 : (1 + fraction / 1024) * 2 ** (exponent - 15));
    };
    for (const kind of ['all-visible', 'mixed-background-invalid', 'empty']) {
      const keys = new Uint32Array(pixels);
      for (let pixel = 0; pixel < pixels; pixel++) keys[pixel] = kind === 'empty' ? 0xffffffff :
        kind === 'mixed-background-invalid' && pixel % 7 === 0 ? 0xffffffff :
        kind === 'mixed-background-invalid' && pixel % 11 === 0 ? 0xfffffffe : pixel % 2;
      device.queue.writeTexture({ texture: visibility }, keys, { bytesPerRow: width * 4 }, [width, height]);
      const frame = command(`Appearance diagnostic ${kind}`);
      winnerOwner.encode(frame.gpu_encoder, winner);
      publication.encodeDemand(frame, { visibility: visibilityView, meshletWork: work,
        geometry: arena.buffer, attributes, frameHeaderWord: arena.layout.header.offset / 4,
        frameDirectoryWord: arena.sourceDirectory.offset / 4,
        textureBanks: [], width, height, fields: view, frame: cases.length + 1 });
      frame.gpu_encoder.copyBufferToBuffer(taskBuffer, 0, counts, 0, 16);
      for (const [index, layer] of [0, 1, 6].entries()) frame.gpu_encoder.copyTextureToBuffer(
        { texture: fields, origin: [0, 0, layer] }, { buffer: readback, offset: index * rowBytes * height, bytesPerRow: rowBytes }, [width, height]);
      await frame.finish();
      await counts.mapAsync(GPUMapMode.READ);
      const control = Array.from(new Uint32Array(counts.getMappedRange())); counts.unmap();
      const visible = keys.reduce((sum, key) => sum + (key < 2 ? 1 : 0), 0);
      check(control[1] === 0 && control[2] === visible && control[3] === visible, `${kind}: count/coverage mismatch ${control}`);
      await readback.mapAsync(GPUMapMode.READ);
      const values = new Uint16Array(readback.getMappedRange());
      let checked = 0;
      for (let pixel = 0; pixel < pixels; pixel++) {
        const key = keys[pixel], valid = key < 2, at = Math.floor(pixel / width) * (rowBytes / 2) + (pixel % width) * 4;
        const expected = valid ? colors[key] : [0, 0, 0];
        for (let channel = 0; channel < 3; channel++) {
          check(half(values[at + channel]) === expected[channel], `${kind}: RGB mismatch at ${pixel}:${channel}`); checked++;
          check(half(values[at + rowBytes * height + channel]) === (valid && channel === 2 ? 1 : 0), `${kind}: normal mismatch at ${pixel}:${channel}`); checked++;
        }
        check(half(values[at + rowBytes * height / 2]) === (valid ? 0.5 : 0), `${kind}: alpha mismatch at ${pixel}`); checked++;
      }
      readback.unmap(); cases.push({ kind, pixels, visible, checked, control });
    }
    return { passed: true, cases, publicationBytes: publication.allocatedBytes };
  } finally {
    publication?.destroy(); winnerOwner?.destroy(); arenaOwner?.destroy(); registry.destroy(); cache.destroy();
    for (const resource of resources) resource.destroy();
  }
}
