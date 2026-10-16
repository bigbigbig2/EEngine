import {
  frameGeometrySourceWgsl,
  FRAME_ATTRIBUTE_OCT_DECODE_WGSL,
} from "../../.test-dist/shaders/geometry_source_decode.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../../.test-dist/gpu/GpuInstanceAbi.js";
import { GPU_FRAME_INSTANCE_WGSL } from "../../.test-dist/gpu/GpuFrameInstanceAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../../.test-dist/gpu/GpuMeshletRasterWorkAbi.js";
import { GeometryProductMultiRuntimeV1 } from "../../.test-dist/gpu/GeometryProductMultiRuntime.js";
import { triangleProductFixture } from "../helpers/geometry-product-fixture.mjs";

// Decode the production functions, including private format restoration, against
// independent scalar math. Odd strides and offsets exercise cross-word loads.
export async function runProductAttributeDecodeGpuOracle(device) {
  const count = 1024;
  const banks = Array.from({ length: 4 }, () => new ArrayBuffer(65536));
  const formats = new Uint32Array(count * 4);
  const expected = new Float32Array(count * 20);
  const snorm = [-32768, -32767, -24576, -1, 0, 1, 16384, 32767];
  const half = [0, 0x8000, 1, 0x3c00, 0xbc00, 0x3555, 0x7bff, 0x0400];
  const halfValue = (word) => {
    const sign = word & 0x8000 ? -1 : 1;
    const exponent = (word >> 10) & 31;
    return (
      sign * (exponent === 0 ? (word & 1023) * 2 ** -24 : (1 + (word & 1023) / 1024) * 2 ** (exponent - 15))
    );
  };
  const oct = (x, y) => {
    x = Math.max(-1, x / 32767);
    y = Math.max(-1, y / 32767);
    const z = 1 - Math.abs(x) - Math.abs(y);
    if (z < 0) [x, y] = [(1 - Math.abs(y)) * (x < 0 ? -1 : 1), (1 - Math.abs(x)) * (y < 0 ? -1 : 1)];
    const length = Math.hypot(x, y, z);
    return [x / length, y / length, z / length];
  };
  for (let id = 0; id < count; id++) {
    const view = new DataView(banks[id & 3]);
    const base = id * 48 + (id & 3);
    const mask = 1 | ((id >> 2) & 62);
    formats.set(
      [35 | (mask << 16), 1 | (13 << 8) | (17 << 16) | (23 << 24), 27 | (31 << 8) | (1 << 16), 0],
      id * 4,
    );
    const position = [Math.fround(id / 7 - 100), Math.fround(-id / 13), Math.fround(0.125 * id)];
    position.forEach((value, i) => view.setFloat32(base + 1 + i * 4, value, true));
    const nx = snorm[id & 7],
      ny = snorm[(id >> 3) & 7];
    const tx = snorm[(id + 3) & 7],
      ty = snorm[((id >> 3) + 5) & 7];
    view.setInt16(base + 13, nx, true);
    view.setInt16(base + 15, ny, true);
    view.setInt16(base + 17, tx, true);
    view.setInt16(base + 19, ty, true);
    view.setUint16(base + 21, id & 1 ? 0xffff : 0, true);
    const uv = Array.from({ length: 4 }, (_, i) => half[(id + i) & 7]);
    uv.forEach((value, i) => view.setUint16(base + 23 + i * 2, value, true));
    const color = [id & 255, (id * 17) & 255, (255 - id) & 255];
    color.forEach((value, i) => view.setUint8(base + 31 + i, value));
    expected.set(
      [
        ...position,
        1,
        ...(mask & 2 ? oct(nx, ny) : [0, 0, 1]),
        0,
        ...(mask & 4 ? [...oct(tx, ty), id & 1 ? -1 : 1] : [1, 0, 0, 1]),
        ...(mask & 8 ? uv.slice(0, 2).map(halfValue) : [0, 0]),
        ...(mask & 16 ? uv.slice(2).map(halfValue) : [0, 0]),
        ...(mask & 32 ? color.map((value) => value / 255) : [1, 1, 1]),
        1,
      ],
      id * 20,
    );
  }
  const resources = [];
  const buffer = (size, usage, data) => {
    const value = device.createBuffer({ size, usage, mappedAtCreation: data !== undefined });
    if (data !== undefined) {
      new Uint8Array(value.getMappedRange()).set(new Uint8Array(data.buffer ?? data));
      value.unmap();
    }
    resources.push(value);
    return value;
  };
  const heap = buffer(formats.byteLength, GPUBufferUsage.STORAGE, formats);
  const pages = banks.map((data) => buffer(data.byteLength, GPUBufferUsage.STORAGE, data));
  const output = buffer(expected.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const readback = buffer(expected.byteLength, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
  try {
    const module = device.createShaderModule({
      code: `requires unrestricted_pointer_parameters;
${GPU_INSTANCE_RECORD_WGSL}
${GPU_FRAME_INSTANCE_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
@group(0) @binding(1) var<storage, read> frame_instances: array<OEngineFrameInstanceRecord>;
${frameGeometrySourceWgsl(true, true)}
${FRAME_ATTRIBUTE_OCT_DECODE_WGSL}
@group(0) @binding(0) var<storage, read_write> result: array<vec4f>;
@compute @workgroup_size(64)
fn probe(@builtin(global_invocation_id) invocation: vec3u) {
  let id = invocation.x;
  if id >= ${count}u { return; }
  // Poison a preceding format, then restore the selected meshlet's format as
  // a raster-cache hit does. No workgroup state may cross private invocations.
  frame_vertex_load_format(((id + 1u) % ${count}u) * 4u);
  frame_vertex_load_format(id * 4u);
  source_resident_address = ((id & 3u) << 30u) | (id * 48u + (id & 3u));
  result[id * 5u] = vec4f(frame_vertex_position(0u), 1.0);
  result[id * 5u + 1u] = frame_vertex_normal(0u);
  result[id * 5u + 2u] = frame_vertex_tangent(0u);
  result[id * 5u + 3u] = vec4f(frame_vertex_uv(0u, 0u), frame_vertex_uv(0u, 1u));
  result[id * 5u + 4u] = frame_vertex_color(0u);
}`,
    });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((value) => value.type === "error");
    if (errors.length) throw new Error(errors.map((value) => value.message).join("\n"));
    const pipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module, entryPoint: "probe" },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: output } },
        { binding: 8, resource: { buffer: heap } },
        ...pages.map((value, i) => ({ binding: 9 + i, resource: { buffer: value } })),
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(count / 64);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, expected.byteLength);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const actual = new Float32Array(readback.getMappedRange());
    let maximumError = 0;
    for (let i = 0; i < actual.length; i++) {
      const error = Math.abs(actual[i] - expected[i]);
      maximumError = Math.max(maximumError, error);
      if (!Number.isFinite(actual[i]) || error > 2e-6)
        throw new Error(`Product attribute ${i}: ${actual[i]} vs ${expected[i]}`);
    }
    readback.unmap();
    const rawPage = await checkOriginalPage(device, buffer, oct, halfValue);
    return {
      vertices: count,
      components: expected.length,
      banks: 4,
      attributeMasks: 32,
      oddStride: 35,
      maximumError,
      rawPage,
    };
  } finally {
    if (readback.mapState === "mapped") readback.unmap();
    resources.forEach((value) => value.destroy());
  }
}

async function checkOriginalPage(device, buffer, oct, halfValue) {
  const { descriptor, page } = triangleProductFixture();
  const view = new DataView(page.buffer);
  const format = new DataView(descriptor.vertexFormats.buffer);
  // A valid complete logical Page with interleaved float position, oct normal
  // and half UV. The independent CPU reads the same original bytes that the
  // real residency owner validates and uploads as a compact prefix.
  format.setUint16(0, 20, true);
  format.setUint16(2, 11, true);
  format.setUint8(7, 16);
  for (let vertex = 0; vertex < 3; vertex++) {
    const at = 116 + vertex * 20;
    for (let axis = 0; axis < 3; axis++) {
      view.setFloat32(at + axis * 4, (vertex - 1) * (axis + 1) / 8, true);
    }
    view.setInt16(at + 12, [-16384, 8192, 24576][vertex], true);
    view.setInt16(at + 14, [8192, -24576, 16384][vertex], true);
    view.setUint16(at + 16, [0x3555, 0x3c00, 0x0400][vertex], true);
    view.setUint16(at + 18, [0xbc00, 0, 0x3800][vertex], true);
  }
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", page));
  descriptor.pageRecords.set(hash.subarray(0, 16));
  const source = {
    descriptor,
    async readPage(pageId) {
      if (pageId !== 0) throw new Error("Unexpected original Page");
      return {
        productId: descriptor.productId, revision: descriptor.revision, pageId,
        bytes: page.slice().buffer,
        decodedHash128: hash.slice(0, 16), decodedPageHash128: hash.slice(0, 16),
      };
    },
    release() {},
  };
  const runtime = new GeometryProductMultiRuntimeV1(device, { descriptors: [descriptor] });
  try {
    const handle = await runtime.load(source);
    const binding = runtime.bindings();
    const location = handle.residency.pageLocation(0);
    const result = buffer(3 * 32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const read = buffer(3 * 32, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const module = device.createShaderModule({
      label: "Original Page production position/normal/UV oracle",
      code: `requires unrestricted_pointer_parameters;
${GPU_INSTANCE_RECORD_WGSL}
${GPU_FRAME_INSTANCE_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
@group(0) @binding(1) var<storage, read> frame_instances: array<OEngineFrameInstanceRecord>;
${frameGeometrySourceWgsl(true, true)}
${FRAME_ATTRIBUTE_OCT_DECODE_WGSL}
@group(0) @binding(0) var<storage, read_write> result: array<vec4f>;
@compute @workgroup_size(1)
fn probe(@builtin(global_invocation_id) invocation: vec3u) {
  let id = invocation.x;
  frame_vertex_load_format(product_heap[11u]);
  source_resident_address = ${(location.bankIndex * 2 ** 30 + location.byteOffset + 116) >>> 0}u;
  let normal = frame_vertex_normal(id);
  result[id * 2u] = vec4f(frame_vertex_position(id), normal.x);
  result[id * 2u + 1u] = vec4f(normal.yz, frame_vertex_uv(id, 0u));
}`,
    });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter(message => message.type === "error");
    if (errors.length) throw new Error(errors.map(message => message.message).join("\n"));
    const pipeline = await device.createComputePipelineAsync({
      label: "Original Page production decode", layout: "auto",
      compute: { module, entryPoint: "probe" },
    });
    const group = device.createBindGroup({
      label: "Original Page real residency bindings", layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: result } },
        { binding: 8, resource: { buffer: binding.metadata } },
        ...binding.banks.map((bank, index) => ({ binding: 9 + index, resource: { buffer: bank } })),
      ],
    });
    const encoder = device.createCommandEncoder({ label: "Original Page decode comparison" });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(3);
    pass.end();
    encoder.copyBufferToBuffer(result, 0, read, 0, read.size);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const actual = new Float32Array(read.getMappedRange().slice(0));
    read.unmap();
    let maximumError = 0;
    for (let vertex = 0; vertex < 3; vertex++) {
      const at = 116 + vertex * 20;
      const normal = oct(view.getInt16(at + 12, true), view.getInt16(at + 14, true));
      const expected = [
        view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true),
        ...normal, halfValue(view.getUint16(at + 16, true)), halfValue(view.getUint16(at + 18, true)),
      ];
      for (let component = 0; component < 8; component++) {
        const value = actual[vertex * 8 + component];
        const error = Math.abs(value - expected[component]);
        maximumError = Math.max(maximumError, error);
        if (!Number.isFinite(value) || error > 2e-6) {
          throw new Error(`Original Page vertex ${vertex}/${component}: ${value} vs ${expected[component]}`);
        }
      }
    }
    return { vertices: 3, logicalBytes: page.byteLength, payloadBytes: location.payloadBytes, maximumError };
  } finally {
    await device.queue.onSubmittedWorkDone();
    runtime.destroy();
  }
}
