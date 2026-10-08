import {
  LIGHT_DATABASE_READ_WGSL,
  POINT_LIGHT_RECORD_TYPE,
  SPOT_LIGHT_RECORD_TYPE,
  POINT_LIGHT_DESCRIPTOR,
  SPOT_LIGHT_DESCRIPTOR,
  LIGHT_DATABASE_DEFINITION
} from "../../.test-dist/gpu/LightDatabase.js";
export async function runLightingBoundariesGpuOracle(device) {
  const cases = [
    {
      name: "radius-support-shell",
      expression: "light_sphere_distance_attenuation(2.5, 2.0, 1.0)",
      expected: (1 - 0.5 ** 4) ** 2 / 2.5 ** 2
    },
    {
      name: "finite-support-edge",
      expression: "light_sphere_distance_attenuation(3.0, 2.0, 1.0)",
      expected: 0
    },
    { name: "unbounded", expression: "light_sphere_distance_attenuation(10.0, 0.0, 0.0)", expected: 0.01 },
    {
      name: "huge-default-spot-distance",
      expression: "light_sphere_distance_attenuation(4.0, 0.1, 3.402823466e38)",
      expected: 1 / 16
    },
    ...[0.49, 0.5, 0.51].map((value) => ({
      name: `hard-cone-${value}`,
      expression: `light_get_spot_attenuation(0.5, 0.5, ${value})`,
      expected: value >= 0.5 ? 1 : 0
    })),
    { name: "soft-cone", expression: "light_get_spot_attenuation(0.5, 0.9, 0.7)", expected: 0.5 }
  ];
  const output = device.createBuffer({
    label: "L3.0 boundary values",
    size: 256,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
  });
  const download = device.createBuffer({
    label: "L3.0 boundary readback",
    size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
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
      compute: { module, entryPoint: "probe" }
    });
    const group = device.createBindGroup({
      label: "L3.0 boundary outputs",
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: output } }]
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
        Math.abs(values[i] - test.expected) <= 1e-5 * Math.max(1, Math.abs(test.expected))
    }));
    for (const [name, start] of [
      ["point-emitter-center", 8],
      ["spot-emitter-center", 13]
    ]) {
      const actual = values.slice(start, start + 5);
      results.push({
        name,
        actual,
        passed: actual.every(Number.isFinite) && Math.hypot(...actual.slice(0, 3)) <= 1 && actual[3] <= 1
      });
    }
    // Culling and logarithmic boundaries are independently covered by local-light-work.
    // Log the complete independent expectation even on failure, preserving the original evidence.
    console.info(`L3.0 boundary results ${JSON.stringify(results)}`);
    if (results.some((result) => !result.passed))
      throw new Error(
        `Independent Lighting boundary failure: ${results
          .filter((result) => !result.passed)
          .map((result) => result.name)
          .join(", ")}`
      );
    return {
      verdict: "passed",
      results,
      limitations: ["Helper math probe; production culling/HDR separately verified", "No hardware counters"]
    };
  } finally {
    if (download.mapState === "mapped") download.unmap();
    download.destroy();
    output.destroy();
  }
}
