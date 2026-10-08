/** Untimed observation of the actual finalized LocalLightWork header. */
export async function createLightingInspection(device) {
  const readback = device.createBuffer({
    label: "LocalLightWork/untimed header readback",
    size: 128,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
  });
  return {
    encode(encoder, entries) {
      encoder.copyBufferToBuffer(
        entries.find((entry) => entry.binding === 3).resource.buffer,
        0,
        readback,
        0,
        128
      );
    },
    async read() {
      await readback.mapAsync(GPUMapMode.READ);
      const values = [...new Uint32Array(readback.getMappedRange())];
      readback.unmap();
      if (values[0] !== 1 || (values[2] & 12) !== 0)
        throw new Error("Invalid finalized LocalLightWork header");
      return {
        abi: values[0],
        mode: values[1],
        flags: values[2],
        epoch: values[3],
        frame: values[4],
        publication: values[5],
        admitted: values[6],
        globalCount: values[8],
        clusters: values[10],
        indexCapacity: values[11],
        indicesWritten: values[13],
        regionTasks: values[14],
        taskBudget: values[15]
      };
    },
    destroy() {
      if (readback.mapState === "mapped") readback.unmap();
      readback.destroy();
    }
  };
}
