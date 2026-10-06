import { surfaceWorkAppearanceWgsl } from "../../.test-dist/shaders/surface_work.js";
import { GPU_FRAME_INSTANCE_OFFSETS } from "../../.test-dist/gpu/GpuFrameInstanceAbi.js";
import { GPU_INSTANCE_RECORD_OFFSETS } from "../../.test-dist/gpu/GpuInstanceAbi.js";
import { GPU_GEOMETRY_RECORD_SCHEMA } from "../../.test-dist/gpu/GpuGeometryAbi.js";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

// Independent double-precision Gaussian elimination, rather than the shader's
// normalized cross-product rows. Solve homogeneous projected weights and then
// normalize their sum; no reciprocal vertex W, including zero/negative W.
function weights(clips, pixel) {
  const ndc = [(pixel[0] / 16) * 2 - 1, 1 - (pixel[1] / 16) * 2, 1];
  const rows = [0, 1, 3].map((axis, row) => [...clips.map((clip) => clip[axis]), ndc[row]]);
  for (let column = 0; column < 3; column++) {
    let pivot = column;
    for (let row = column + 1; row < 3; row++) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (rows[pivot][column] === 0) return null;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let k = column; k < 4; k++) rows[column][k] /= divisor;
    for (let row = 0; row < 3; row++)
      if (row !== column) {
        const factor = rows[row][column];
        for (let k = column; k < 4; k++) rows[row][k] -= factor * rows[column][k];
      }
  }
  const values = rows.map((row) => row[3]),
    sum = values.reduce((a, b) => a + b);
  return sum === 0 ? null : values.map((value) => value / sum);
}

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const positions = [
  [-1, -1, 0.5],
  [3, -1, 0.5],
  [-1, 3, 0.5]
];
function transform(matrix, position) {
  return [0, 1, 2, 3].map(
    (row) =>
      matrix[row] * position[0] +
      matrix[row + 4] * position[1] +
      matrix[row + 8] * position[2] +
      matrix[row + 12]
  );
}

/** Actual frame producer -> arena -> current Geometry completion/point body.
 * This probe isolates boundary math; Surface's regular oracle owns PBR/HDR and
 * raster coverage. It does not claim an independently rasterized clip image. */
export async function checkSurfaceGeometryBoundaries(device, input) {
  const { arena, vertexOwner, vertices, frameInstances, instances, work, vertexPayload, camera, product } =
    input;
  const retained = [];
  const make = (data, usage) => {
    const buffer = device.createBuffer({ size: data.byteLength, usage });
    device.queue.writeBuffer(buffer, 0, data);
    retained.push(buffer);
    return buffer;
  };
  const original = instances.slice();
  const source =
    surfaceWorkAppearanceWgsl(product !== null, false) +
    `
@group(1) @binding(7) var<storage, read_write> boundary_output: array<vec4f>;
@compute @workgroup_size(1)
fn boundary_probe() {
  geometry_prepare_needs((1u << 1u) | (1u << 2u) | (1u << 5u) | (1u << 6u) | (1u << 7u), false);
  geometry_completion = geometry_build_completion(settings.reserved);
  let interpolation = winner_interpolate(geometry_completion.coefficients, vec2f(8.5), vec2f(16.0));
  boundary_output[0] = vec4f(interpolation.weights, f32(interpolation.flags));
  boundary_output[1] = vec4f(interpolation.dx, geometry_completion.coefficients.row0.w);
  boundary_output[2] = vec4f(interpolation.dy, f32(surface_frame_geometry(0u, 0u).valid));
  boundary_output[3] = geometry_completion.world_plane;
  if (interpolation.flags & WINNER_VALUE_VALID) != 0u {
    let point = geometry_point(interpolation.weights, (1u << 5u) | (1u << 6u) | (1u << 7u));
    boundary_output[4] = point.normal;
    boundary_output[5] = point.tangent;
    boundary_output[6] = point.position;
    boundary_output[7] = geometry_attribute(geometry_completion.uv, interpolation.weights);
  }
}`;
  try {
    const module = device.createShaderModule({
      label: "Independent current Surface Geometry boundary probe",
      code: source
    });
    const diagnostics = await module.getCompilationInfo();
    check(
      !diagnostics.messages.some((message) => message.type === "error"),
      JSON.stringify(diagnostics.messages)
    );
    const pipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module, entryPoint: "boundary_probe" }
    });
    const settingsWords = new Uint32Array(32);
    settingsWords[0] = settingsWords[1] = 16;
    settingsWords[21] = GPU_GEOMETRY_RECORD_SCHEMA.stride / 4;
    settingsWords[23] = 4;
    settingsWords[27] = arena.layout.header.offset / 4;
    const settings = make(settingsWords, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const control = make(new Uint32Array(512), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const staleGeneration = make(new Uint32Array([10]), GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    const output = make(
      new Float32Array(32),
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    );
    const readback = device.createBuffer({
      size: 128,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    retained.push(readback);
    const group0 = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: work } },
        { binding: 1, resource: { buffer: arena.buffer } },
        { binding: 2, resource: { buffer: vertexPayload } },
        { binding: 3, resource: { buffer: frameInstances } },
        ...(product === null
          ? []
          : [product.heap, ...product.banks].map((buffer, index) => ({
              binding: 4 + index,
              resource: { buffer }
            }))),
        { binding: 9, resource: { buffer: camera } },
        { binding: 10, resource: { buffer: settings } }
      ]
    });
    const group1 = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(1),
      entries: [
        { binding: 6, resource: { buffer: control } },
        { binding: 7, resource: { buffer: output } }
      ]
    });
    const near = identity.slice();
    near[3] = 0.5;
    near[15] = 0.25;
    near[14] = -0.5;
    const zero = identity.slice();
    zero[3] = 0.25;
    zero[15] = 0.25;
    const degenerate = identity.slice();
    degenerate[5] = 0;
    const cases = [
      ["ordinary", identity, false],
      ["negative W", identity.map((value) => -value), false],
      ["near clip with mixed W", near, false],
      ["zero vertex W", zero, false],
      ["degenerate projection", degenerate, false],
      ["double sided back facing", identity, true],
      ["stale prepared generation", identity, false]
    ];
    const results = [];
    for (const [name, clipMatrix, sided] of cases) {
      instances.set(original);
      new Float32Array(instances.buffer, instances.byteOffset).set(
        clipMatrix,
        GPU_FRAME_INSTANCE_OFFSETS.objectToClip / 4
      );
      if (sided) {
        const view = new DataView(instances.buffer, instances.byteOffset);
        view.setUint32(
          GPU_INSTANCE_RECORD_OFFSETS.flags,
          view.getUint32(GPU_INSTANCE_RECORD_OFFSETS.flags, true) | 16,
          true
        );
        // Flip authored normals so the independent camera-facing rule reverses
        // both normal and tangent, while geometry plane stays unchanged.
        new Float32Array(instances.buffer, instances.byteOffset)[
          GPU_FRAME_INSTANCE_OFFSETS.normalX / 4 + 10
        ] = -1;
      }
      device.queue.writeBuffer(frameInstances, 0, instances);
      device.queue.writeBuffer(output, 0, new Float32Array(32));
      const encoder = device.createCommandEncoder();
      vertexOwner.encode(encoder, vertices);
      if (name === "stale prepared generation") {
        encoder.copyBufferToBuffer(staleGeneration, 0, arena.buffer, arena.sourceDirectory.offset + 4, 4);
      }
      const pass = encoder.beginComputePass({ label: "Independent current Surface Geometry boundaries" });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group0);
      pass.setBindGroup(1, group1);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, 128);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const actual = new Float32Array(readback.getMappedRange().slice(0));
      readback.unmap();
      const clips = positions.map((position) => transform(clipMatrix, position));
      const expected = weights(clips, [8.5, 8.5]);
      const expectedX = weights(clips, [9.5, 8.5]),
        expectedY = weights(clips, [8.5, 9.5]);
      const close = (value, reference, label) =>
        check(
          Math.abs(value - reference) <= 2e-5 * Math.max(1, Math.abs(reference)),
          `${name} ${label}: ${value} != ${reference}`
        );
      const flags = expected === null ? 0 : 1 | (expectedX === null ? 0 : 2) | (expectedY === null ? 0 : 4);
      check(actual[3] === flags, name + " independent value/neighbor validity");
      if (
        arena.layout.attributeCapacity === 0 ||
        arena.layout.attributeCapacity === 20 ||
        name === "stale prepared generation"
      ) {
        check(
          actual[11] ===
            Number(arena.layout.attributeCapacity === 20 && name !== "stale prepared generation"),
          name + " actually executes prepared or resident branch"
        );
      }
      if (expected !== null) {
        for (let axis = 0; axis < 3; axis++) {
          close(actual[axis], expected[axis], "weight");
          close(actual[4 + axis], expectedX === null ? 0 : expectedX[axis] - expected[axis], "finite dx");
          close(actual[8 + axis], expectedY === null ? 0 : expectedY[axis] - expected[axis], "finite dy");
          close(
            actual[24 + axis],
            positions.reduce((sum, position, corner) => sum + expected[corner] * position[axis], 0),
            "world position"
          );
        }
        close(actual[18], 1, "facing normal");
        close(actual[20], sided ? -1 : 1, "facing tangent");
        close(actual[30], 1 - actual[28], "UV1 preserves authored interpolation");
      }
      close(actual[14], 1, "plane normal");
      close(actual[15], -0.5, "plane distance");
      results.push({
        name,
        source: product === null ? "ordinary" : "Product",
        attributeCapacity: arena.layout.attributeCapacity,
        flags,
        prepared: actual[11] === 1
      });
    }
    for (const [name, key] of [
      ["background key", 0xffffffff],
      ["invalid key", 0xfffffffe],
      ["work slot outside publication", 5],
      ["primitive outside meshlet", 2 << 24]
    ]) {
      settingsWords[31] = key;
      device.queue.writeBuffer(settings, 0, settingsWords);
      device.queue.writeBuffer(output, 0, new Float32Array(32));
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass({ label: "Independent current Surface rejected key" });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group0);
      pass.setBindGroup(1, group1);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, 128);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const actual = new Float32Array(readback.getMappedRange().slice(0));
      readback.unmap();
      check(actual[3] === 0 && actual[7] === 0, name + " cannot publish valid interpolation");
      check(
        Array.from(actual.slice(12)).every((value) => value === 0),
        name + " cannot publish Geometry attributes"
      );
      results.push({
        name,
        source: product === null ? "ordinary" : "Product",
        attributeCapacity: arena.layout.attributeCapacity,
        flags: 0
      });
    }
    return results;
  } finally {
    instances.set(original);
    device.queue.writeBuffer(frameInstances, 0, instances);
    const restore = device.createCommandEncoder();
    vertexOwner.encode(restore, vertices);
    device.queue.submit([restore.finish()]);
    await device.queue.onSubmittedWorkDone();
    retained.forEach((buffer) => buffer.destroy());
  }
}
