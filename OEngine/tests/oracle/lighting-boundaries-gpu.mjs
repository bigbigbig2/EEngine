import {
  LIGHT_DATABASE_READ_WGSL,
  POINT_LIGHT_RECORD_TYPE,
  SPOT_LIGHT_RECORD_TYPE,
  POINT_LIGHT_DESCRIPTOR,
  SPOT_LIGHT_DESCRIPTOR,
  LIGHT_DATABASE_DEFINITION,
} from "../../.test-dist/gpu/LightDatabase.js";
import {
  LIGHT_CLUSTER_POINT_LIST_WGSL,
  LIGHT_CLUSTER_ASSIGN_WGSL,
} from "../../.test-dist/shaders/light_cluster.js";
import { LIGHTING_DIRECT_CORE_WGSL } from "../../.test-dist/shaders/lighting_direct.js";
import { GPU_VIEW_TYPE } from "../../.test-dist/render/ViewContext.js";
import { writeWgslToBuffer } from "../../.test-dist/core/WgslBufferIO.js";

async function clusterBoundaries(device) {
  // Independent expected integer cells, including 32px edges and jitter offsets.
  const cells = [
    { pixel: [31.5, 1048.5, 0], expected: [0, 0, 0, 0] },
    { pixel: [32.5, 1047.5, 1], expected: [1, 1, 1, 2101] },
    { pixel: [31.9, 1048.1, 3], expected: [0, 0, 2, 4080] },
    { pixel: [32.1, 1047.9, 3], expected: [1, 1, 2, 4141] },
    { pixel: [1919.5, 0.5, 33554431], expected: [59, 33, 23, 48959] },
  ];
  const wgslFloat = (value) => (Number.isInteger(value) ? `${value}.0` : String(value));
  const output = device.createBuffer({ size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const parameters = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const view = device.createBuffer({
    size: GPU_VIEW_TYPE.size,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  try {
    const viewBytes = new ArrayBuffer(GPU_VIEW_TYPE.size);
    writeWgslToBuffer(
      {
        projection_matrix: Array(16).fill(0),
        width: 1920,
        height: 1080,
        frame_index: 0,
        upscale_ratio: [1, 1],
        jitter: [0, 0],
      },
      GPU_VIEW_TYPE,
      viewBytes,
      0,
    );
    device.queue.writeBuffer(view, 0, viewBytes);
    device.queue.writeBuffer(parameters, 0, new Float32Array([1, 1, 1, 0]));
    for (const [source, entry, groups] of [
      [
        `${LIGHTING_DIRECT_CORE_WGSL}
@group(3) @binding(0) var<storage, read_write> probe_result: array<vec4f>;
@compute @workgroup_size(1) fn probe_cells() {
  ${cells
    .map(
      (
        cell,
        i,
      ) => `let cell${i} = cluster_from_fragment_coord(vec3f(${cell.pixel.map(wgslFloat).join(", ")}));
  probe_result[${i}] = vec4f(vec3f(cell${i}), f32(grid3d_to_index(cell${i}, cluster_resolution_xy(vec2u(1920, 1080)))));`,
    )
    .join("\n")}
}`,
        "probe_cells",
        [
          [],
          [{ binding: 2, resource: { buffer: parameters } }],
          [{ binding: 0, resource: { buffer: view } }],
        ],
      ],
      [
        `${LIGHT_CLUSTER_ASSIGN_WGSL}
@group(3) @binding(0) var<storage, read_write> probe_result: array<vec4f>;
@compute @workgroup_size(1) fn probe_depths() {
  probe_result[5] = vec4f(
    cluster_depth_from_z_slice(0.0, vec3f(1.0, 1.0, 1.0), 24.0),
    cluster_depth_from_z_slice(1.0, vec3f(1.0, 1.0, 1.0), 24.0),
    cluster_depth_from_z_slice(2.0, vec3f(1.0, 1.0, 1.0), 24.0),
    cluster_depth_from_z_slice(24.0, vec3f(1.0, 1.0, 1.0), 24.0));
}`,
        "probe_depths",
        [[], [], []],
      ],
    ]) {
      const module = device.createShaderModule({ code: source });
      const pipeline = await device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint: entry },
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      [...groups, [{ binding: 0, resource: { buffer: output } }]].forEach((entries, group) =>
        pass.setBindGroup(
          group,
          device.createBindGroup({ layout: pipeline.getBindGroupLayout(group), entries }),
        ),
      );
      pass.dispatchWorkgroups(1);
      pass.end();
      device.queue.submit([encoder.finish()]);
    }
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 256);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = [...new Float32Array(readback.getMappedRange())];
    const results = cells.map((cell, i) => {
      const actual = values.slice(i * 4, i * 4 + 4);
      return {
        name: `cluster-cell-${i}`,
        expected: cell.expected,
        actual,
        passed: actual.every((v, k) => v === cell.expected[k]),
      };
    });
    const expected = [0, 1, 3, Math.fround(3.402823466e38)];
    const actual = values.slice(20, 24);
    results.push({
      name: "cluster-producer-near-far",
      expected,
      actual,
      passed: actual.every((v, k) => v === expected[k]),
    });
    return results;
  } finally {
    if (readback.mapState === "mapped") readback.unmap();
    for (const buffer of [output, readback, parameters, view]) buffer.destroy();
  }
}

async function cullBoundaries(device) {
  const base = LIGHT_DATABASE_DEFINITION.descriptors.reduce(
    (sum, descriptor) => sum + descriptor.page_limit,
    0,
  );
  const pageWords = POINT_LIGHT_DESCRIPTOR.page_size_bytes / 4;
  const bytes = new ArrayBuffer((base + 2 * pageWords) * 4);
  const words = new Uint32Array(bytes);
  words.fill(0xffffffff, 0, base);
  for (const [descriptor, page] of [
    [POINT_LIGHT_DESCRIPTOR, base],
    [SPOT_LIGHT_DESCRIPTOR, base + pageWords],
  ]) {
    words[descriptor.page_lookup_address] = page;
    const common = {
      color: [1, 1, 1],
      radius: 2,
      distance: 1,
      flags: 0,
      near_clip_distance: 0,
      shadow_id: 0,
    };
    const records =
      descriptor === POINT_LIGHT_DESCRIPTOR
        ? [
            { ...common, position: [3.5, 0, 0] },
            { ...common, position: [10, 0, 0], radius: 0.1, distance: 0 },
          ]
        : [
            { ...common, position: [0, 0, 3.5], direction: [0, 0, -1], coneCos: 0.5, penumbraCos: 0.8 },
            {
              ...common,
              position: [0, 0, 10],
              direction: [0, 0, -1],
              radius: 0.1,
              distance: 0,
              coneCos: 0.5,
              penumbraCos: 0.8,
            },
          ];
    records.forEach((record, slot) =>
      writeWgslToBuffer(
        record,
        descriptor.type,
        bytes,
        (page + descriptor.page_header_words) * 4 + slot * descriptor.packed_element_size_bytes,
      ),
    );
  }
  const database = device.createBuffer({
    label: "L3.0 cull boundary DB",
    size: bytes.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const result = device.createBuffer({
    label: "L3.0 cull outputs",
    size: 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    label: "L3.0 cull readback",
    size: 16,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    device.queue.writeBuffer(database, 0, bytes);
    const module = device.createShaderModule({
      label: "L3.0 actual cull helpers",
      code: `${LIGHT_CLUSTER_POINT_LIST_WGSL}
@group(3) @binding(0) var<storage, read_write> result: array<u32>;
@compute @workgroup_size(1) fn probe_cull() {
  let planes = array<vec4f, 6>(vec4f(1,0,0,1), vec4f(-1,0,0,1), vec4f(0,1,0,1), vec4f(0,-1,0,1), vec4f(0,0,1,1), vec4f(0,0,-1,1));
  result[0] = u32(point_light_intersects_frustum(&node, 0u, planes));
  result[1] = u32(point_light_intersects_frustum(&node, 1u, planes));
  result[2] = u32(spot_light_intersects_frustum(&node, 0u, planes));
  result[3] = u32(spot_light_intersects_frustum(&node, 1u, planes));
}`,
    });
    const pipeline = await device.createComputePipelineAsync({
      label: "L3.0 support cull",
      layout: "auto",
      compute: { module, entryPoint: "probe_cull" },
    });
    const encoder = device.createCommandEncoder({ label: "L3.0 support cull probe" });
    const pass = encoder.beginComputePass({ label: "L3.0 support cull" });
    pass.setPipeline(pipeline);
    for (let group = 0; group < 4; group++)
      pass.setBindGroup(
        group,
        device.createBindGroup({
          label: `L3.0 cull group ${group}`,
          layout: pipeline.getBindGroupLayout(group),
          entries:
            group === 1
              ? [{ binding: 0, resource: { buffer: database } }]
              : group === 3
                ? [{ binding: 0, resource: { buffer: result } }]
                : [],
        }),
      );
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(result, 0, readback, 0, 16);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const actual = [...new Uint32Array(readback.getMappedRange())];
    // A point inside the cube at z/x=0.9 has nonzero radiance in all four cases.
    return [
      "point-radius-shell-cull",
      "point-unbounded-cull",
      "spot-radius-shell-cull",
      "spot-unbounded-cull",
    ].map((name, i) => ({ name, expected: 1, actual: actual[i], passed: actual[i] === 1 }));
  } finally {
    if (readback.mapState === "mapped") readback.unmap();
    readback.destroy();
    result.destroy();
    database.destroy();
  }
}

export async function runLightingBoundariesGpuOracle(device) {
  const cases = [
    {
      name: "radius-support-shell",
      expression: "light_sphere_distance_attenuation(2.5, 2.0, 1.0)",
      expected: (1 - 0.5 ** 4) ** 2 / 2.5 ** 2,
    },
    {
      name: "finite-support-edge",
      expression: "light_sphere_distance_attenuation(3.0, 2.0, 1.0)",
      expected: 0,
    },
    { name: "unbounded", expression: "light_sphere_distance_attenuation(10.0, 0.0, 0.0)", expected: 0.01 },
    {
      name: "huge-default-spot-distance",
      expression: "light_sphere_distance_attenuation(4.0, 0.1, 3.402823466e38)",
      expected: 1 / 16,
    },
    ...[0.49, 0.5, 0.51].map((value) => ({
      name: `hard-cone-${value}`,
      expression: `light_get_spot_attenuation(0.5, 0.5, ${value})`,
      expected: value >= 0.5 ? 1 : 0,
    })),
    { name: "soft-cone", expression: "light_get_spot_attenuation(0.5, 0.9, 0.7)", expected: 0.5 },
  ];
  const output = device.createBuffer({
    label: "L3.0 boundary values",
    size: 256,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const download = device.createBuffer({
    label: "L3.0 boundary readback",
    size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const code = `${LIGHT_DATABASE_READ_WGSL}
@group(0) @binding(0) var<storage, read_write> output: array<f32>;
@compute @workgroup_size(1) fn probe() {
  ${cases.map((test, i) => `output[${i}u] = ${test.expression};`).join("\n")}
  var point: ${POINT_LIGHT_RECORD_TYPE.wgsl_ref};
  point.position = vec3f(0.0); point.radius = 0.1; point.distance = 1.0; point.color = vec3f(1.0);
  let incident = get_point_light_info(point, vec3f(0.0));
  output[8] = incident.direction.x; output[9] = incident.direction.y;
  output[10] = incident.direction.z; output[11] = incident.radius;
  output[12] = incident.color.x;
  var spot: ${SPOT_LIGHT_RECORD_TYPE.wgsl_ref};
  spot.position = vec3f(0.0); spot.radius = 0.1; spot.distance = 1.0; spot.color = vec3f(1.0);
  spot.direction = vec3f(0.0, 0.0, -1.0); spot.coneCos = 0.5; spot.penumbraCos = 0.5;
  let spot_incident = get_spot_light_info(spot, vec3f(0.0));
  output[13] = spot_incident.direction.x; output[14] = spot_incident.direction.y;
  output[15] = spot_incident.direction.z; output[16] = spot_incident.radius;
  output[17] = spot_incident.color.x;
}`;
    const module = device.createShaderModule({ label: "L3.0 actual LightDatabase math", code });
    const errors = (await module.getCompilationInfo()).messages.filter((message) => message.type === "error");
    if (errors.length) throw new Error(JSON.stringify(errors));
    const pipeline = await device.createComputePipelineAsync({
      label: "L3.0 boundary probe",
      layout: "auto",
      compute: { module, entryPoint: "probe" },
    });
    const group = device.createBindGroup({
      label: "L3.0 boundary outputs",
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: output } }],
    });
    const encoder = device.createCommandEncoder({ label: "L3.0 independent boundary probe" });
    const pass = encoder.beginComputePass({ label: "L3.0 boundary math" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, download, 0, 256);
    device.queue.submit([encoder.finish()]);
    await download.mapAsync(GPUMapMode.READ);
    const values = [...new Float32Array(download.getMappedRange())];
    const results = cases.map((test, i) => ({
      ...test,
      actual: values[i],
      passed:
        Number.isFinite(values[i]) &&
        Math.abs(values[i] - test.expected) <= 1e-5 * Math.max(1, Math.abs(test.expected)),
    }));
    for (const [name, start] of [
      ["point-emitter-center", 8],
      ["spot-emitter-center", 13],
    ]) {
      const actual = values.slice(start, start + 5);
      results.push({
        name,
        actual,
        passed: actual.every(Number.isFinite) && Math.hypot(...actual.slice(0, 3)) <= 1 && actual[3] <= 1,
      });
    }
    results.push(...(await cullBoundaries(device)));
    results.push(...(await clusterBoundaries(device)));
    // Log the complete independent expectation even on failure, preserving the original evidence.
    console.info(`L3.0 boundary results ${JSON.stringify(results)}`);
    if (results.some((result) => !result.passed))
      throw new Error(
        `Independent Lighting boundary failure: ${results
          .filter((result) => !result.passed)
          .map((result) => result.name)
          .join(", ")}`,
      );
    return {
      verdict: "passed",
      results,
      limitations: ["Helper math probe; production culling/HDR separately verified", "No hardware counters"],
    };
  } finally {
    if (download.mapState === "mapped") download.unmap();
    download.destroy();
    output.destroy();
  }
}
