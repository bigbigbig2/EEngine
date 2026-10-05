// NEGATIVE CONTROL FIXTURE - this oracle must FAIL.
//
// It is a faithful copy of OEngine/tests/oracle/hzb-conservative-gpu.mjs (same
// inputs, same dispatches, same assertions) with exactly one change: the HZB
// reduction kernel is replaced by a deliberately non-conservative one that
// rounds the stored minimum TOWARD the viewer instead of outward.
//
// Purpose: prove that tools/gpu-oracle.mjs propagates a real-GPU failure with a
// non-zero exit code, and that the failure comes from numbers the GPU actually
// produced (the oracle's own independent CPU reference rejects them). The
// original oracle is never edited; the harness gets its assertion sensitivity
// checked against this copy.
//
// Imports are relative on purpose: served from /__gpu-oracle/self-test/ the URL
// normalizes "../../../OEngine/..." to "/OEngine/..." (clamped at the origin
// root), which is exactly the served path, and the same specifier also resolves
// when this file is imported directly by Node.

import assert from "node:assert/strict";
import { HZB_FOOTPRINT_WGSL } from "../../../OEngine/.test-dist/shaders/hzb_footprint.js";
import { buildHzbReference } from "../../../OEngine/.test-dist/render/HzbReference.js";

const WRONG_REDUCE_COMPUTE_WGSL = /* wgsl */ `
@group(0) @binding(0) var negative_control_source: texture_2d<f32>;
@group(0) @binding(1) var negative_control_output: texture_storage_2d<rg16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(negative_control_output);
  if (any(gid.xy >= size)) { return; }
  let min_max = textureLoad(negative_control_source, vec2i(gid.xy), 0).xy;
  // Deliberate defect: the minimum must round away from the viewer. Doubling it
  // rounds inward, which the oracle's independent CPU reference must reject.
  textureStore(negative_control_output, vec2i(gid.xy), vec4f(min_max.x * 2.0, min_max.y, 0.0, 0.0));
}
`;

function half(bits) {
  const e = (bits >>> 10) & 31,
    m = bits & 1023;
  return e === 0 ? m * 2 ** -24 : (1 + m / 1024) * 2 ** (e - 15);
}

/** Copy of the production oracle with a wrong reduction kernel; must fail its own assertions. */
export async function runWrongKernelHzbOracle(device) {
  const resources = [];
  const texture = (d) => {
    const t = device.createTexture(d);
    resources.push(t);
    return t;
  };
  const buffer = (d) => {
    const b = device.createBuffer(d);
    resources.push(b);
    return b;
  };
  try {
    const width = 256,
      height = 64,
      count = width * height;
    const values = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const bits = Math.min(i, 0x3bff);
      const z = Math.fround((half(bits) + half(bits + 1)) * 0.5);
      values[2 * i] = values[2 * i + 1] = i === count - 1 ? 1 : z;
    }
    const source = texture({
      size: [width, height],
      format: "rg32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const output = texture({
      size: [width, height],
      format: "rg16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    device.queue.writeTexture({ texture: source }, values, { bytesPerRow: width * 8 }, [width, height]);
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "rg16float" },
        },
      ],
    });
    const pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module: device.createShaderModule({ code: WRONG_REDUCE_COMPUTE_WGSL }), entryPoint: "main" },
    });
    const read = buffer({ size: count * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: source.createView() },
          { binding: 1, resource: output.createView() },
        ],
      }),
    );
    pass.dispatchWorkgroups(width / 8, height / 8);
    pass.end();
    encoder.copyTextureToBuffer({ texture: output }, { buffer: read, bytesPerRow: width * 4 }, [
      width,
      height,
    ]);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const result = new Uint16Array(read.getMappedRange());
    for (let i = 0; i < count; i++) {
      assert.ok(half(result[i * 2]) <= values[i * 2], `minimum rounded inward at ${i}`);
      assert.ok(half(result[i * 2 + 1]) >= values[i * 2 + 1], `maximum rounded inward at ${i}`);
    }
    read.unmap();

    const sw = 15,
      sh = 11,
      depth = new Float32Array(sw * sh).fill(0.75);
    depth[5 * sw + 7] = 0;
    depth[14] = 0;
    depth[10 * sw] = 0;
    const levels = buildHzbReference(depth, sw, sh);
    const pyramid = texture({
      size: [levels[0].width, levels[0].height],
      mipLevelCount: levels.length,
      format: "rg32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    levels.forEach((l, mipLevel) =>
      device.queue.writeTexture({ texture: pyramid, mipLevel }, l.minMax, { bytesPerRow: l.width * 8 }, [
        l.width,
        l.height,
      ]),
    );
    const rects = [];
    for (let y0 = 0; y0 < 8; y0++)
      for (let x0 = 0; x0 < 8; x0++)
        for (let y1 = y0 + 1; y1 <= 8; y1++)
          for (let x1 = x0 + 1; x1 <= 8; x1++) rects.push([x0 / 8, y0 / 8, x1 / 8, y1 / 8]);
    const input = buffer({
      size: rects.length * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(input, 0, new Float32Array(rects.flat()));
    const out = buffer({ size: rects.length * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readQueries = buffer({
      size: rects.length * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const queryLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 4, texture: { sampleType: "unfilterable-float" } },
        { binding: 1, visibility: 4, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: 4, buffer: { type: "storage" } },
      ],
    });
    const query = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [queryLayout] }),
      compute: {
        entryPoint: "main",
        module: device.createShaderModule({
          code:
            HZB_FOOTPRINT_WGSL +
            `
      @group(0) @binding(0) var hzb:texture_2d<f32>;
      @group(0) @binding(1) var<storage,read> rects:array<vec4f>;
      @group(0) @binding(2) var<storage,read_write> values:array<f32>;
      @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
        if(id.x<arrayLength(&rects)){let r=rects[id.x];values[id.x]=hzb_footprint_min_depth(hzb,r.xy,r.zw);}
      }`,
        }),
      },
    });
    const command = device.createCommandEncoder(),
      compute = command.beginComputePass();
    compute.setPipeline(query);
    compute.setBindGroup(
      0,
      device.createBindGroup({
        layout: queryLayout,
        entries: [
          { binding: 0, resource: pyramid.createView() },
          { binding: 1, resource: { buffer: input } },
          { binding: 2, resource: { buffer: out } },
        ],
      }),
    );
    compute.dispatchWorkgroups(Math.ceil(rects.length / 64));
    compute.end();
    command.copyBufferToBuffer(out, 0, readQueries, 0, out.size);
    device.queue.submit([command.finish()]);
    await readQueries.mapAsync(GPUMapMode.READ);
    const queries = new Float32Array(readQueries.getMappedRange());
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      let minimum = 1;
      for (let y = Math.floor(r[1] * sh); y < Math.ceil(r[3] * sh); y++)
        for (let x = Math.floor(r[0] * sw); x < Math.ceil(r[2] * sw); x++)
          minimum = Math.min(minimum, depth[y * sw + x]);
      assert.ok(queries[i] <= minimum, `NPOT footprint misses clear texel: ${r}`);
    }
    readQueries.unmap();
    return { halfBoundaryCases: count, footprintCases: rects.length };
  } finally {
    for (const resource of resources) resource.destroy();
  }
}
