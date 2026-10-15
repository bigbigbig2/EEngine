/** Frame seam for CPU contracts. Copies and callbacks belong to one command;
 * nothing commits at encode time. A controlled fence exercises failed reuse. */
export function geometryPublicationCommand(completion = Promise.resolve()) {
  const submitted = [];
  const aborted = [];
  let closed = false;
  return {
    regions: [],
    gpuDone: completion,
    onFinished: { addOne(callback) { submitted.push(callback); } },
    onAborted: { addOne(callback) { aborted.push(callback); } },
    uploadRegions(regions) { this.regions.push(...regions); },
    submit() {
      if (closed) throw new Error("Publication command already closed");
      closed = true;
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
