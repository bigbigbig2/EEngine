/** Untimed read-only observation of the actual bound old Cluster ABI. */
export async function createLightingInspection(device, clusterCount) {
  const output = device.createBuffer({
    label: "L3.0 untimed cluster statistics",
    size: 32,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
  const readback = device.createBuffer({
    label: "L3.0 untimed cluster statistics readback",
    size: 32,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const module = device.createShaderModule({
    label: "L3.0 actual product observation",
    code: /* wgsl */ `
@group(0) @binding(0) var<storage, read> lookup: array<vec4u>;
@group(0) @binding(1) var<storage, read> data: array<u32>;
@group(0) @binding(2) var<storage, read_write> stats: array<atomic<u32>>;
@compute @workgroup_size(128) fn inspect(@builtin(global_invocation_id) id: vec3u) {
  if (id.x == 0u) {
    atomicStore(&stats[0], data[4]);
    atomicStore(&stats[1], data[1]);
    atomicStore(&stats[2], data[0]);
    atomicStore(&stats[3], data[2]);
    atomicStore(&stats[4], data[3]);
  }
  if (data[4] == 0u || id.x >= arrayLength(&lookup)) { return; }
  let metadata = lookup[id.x];
  if ((metadata.w & 8u) != 0u) { atomicAdd(&stats[5], 1u); }
  if (metadata.y + metadata.z > 0u) { atomicAdd(&stats[6], 1u); }
  atomicAdd(&stats[7], metadata.y + metadata.z);
}`,
  });
  const errors = (await module.getCompilationInfo()).messages.filter((message) => message.type === "error");
  if (errors.length) throw new Error(JSON.stringify(errors));
  const pipeline = await device.createComputePipelineAsync({
    label: "L3.0 actual product statistics",
    layout: "auto",
    compute: { module, entryPoint: "inspect" },
  });
  return {
    encode(encoder, entries) {
      encoder.clearBuffer(output);
      const group = device.createBindGroup({
        label: "L3.0 borrowed actual cluster products",
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: entries.find((entry) => entry.binding === 2).resource },
          { binding: 1, resource: entries.find((entry) => entry.binding === 3).resource },
          { binding: 2, resource: { buffer: output } },
        ],
      });
      const pass = encoder.beginComputePass({ label: "L3.0 untimed cluster observation" });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(clusterCount / 128));
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, 32);
    },
    async read() {
      await readback.mapAsync(GPUMapMode.READ);
      const values = [...new Uint32Array(readback.getMappedRange())];
      readback.unmap();
      return Object.fromEntries(
        [
          "active",
          "indicesWritten",
          "indicesAttempted",
          "indexCapacity",
          "dataOverflow",
          "fallbackClusters",
          "nonemptyLightClusters",
          "evaluatedClusterReferences",
        ].map((name, index) => [name, values[index]]),
      );
    },
    destroy() {
      if (readback.mapState === "mapped") readback.unmap();
      readback.destroy();
      output.destroy();
    },
  };
}
