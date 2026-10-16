/** Frame seam for CPU contracts. Copies and callbacks belong to one command;
 * nothing commits at encode time. A controlled fence exercises failed reuse. */
export function geometryPublicationCommand(completion = Promise.resolve()) {
  const submitted = [];
  const aborted = [];
  const operations = [];
  let closed = false;
  return {
    regions: [],
    copies: [],
    gpuDone: completion,
    onFinished: { addOne(callback) { submitted.push(callback); } },
    onAborted: { addOne(callback) { aborted.push(callback); } },
    uploadRegions(regions) {
      this.regions.push(...regions);
      for (const region of regions) operations.push(() => {
        if (region.destination.bytes) region.destination.bytes.set(region.bytes, region.destinationOffset);
      });
    },
    copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size) {
      this.copies.push({ source, sourceOffset, destination, destinationOffset, size });
      operations.push(() => {
        if (!source.bytes || !destination.bytes) throw new Error("Copy fixture requires byte-backed buffers");
        destination.bytes.set(source.bytes.subarray(sourceOffset, sourceOffset + size), destinationOffset);
      });
    },
    submit() {
      if (closed) throw new Error("Publication command already closed");
      closed = true;
      for (const operation of operations) operation();
      for (const callback of submitted) callback();
    },
    abort() {
      if (closed) throw new Error("Publication command already closed");
      closed = true;
      for (const callback of aborted) callback();
    },
  };
}

export function publishGeometryPages(residency, pageIds = []) {
  const command = geometryPublicationCommand();
  residency.preparePublication(command, pageIds);
  command.submit();
  return command;
}
