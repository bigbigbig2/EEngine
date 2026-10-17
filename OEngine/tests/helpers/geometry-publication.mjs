/** Frame seam for CPU contracts. Copies and callbacks belong to one command;
 * nothing commits at encode time. A controlled fence exercises failed reuse. */
export function geometryPublicationCommand(completion = Promise.resolve()) {
  const submitted = [];
  const aborted = [];
  const operations = [];
  const observers = [];
  let closed = false;
  return {
    get closed() {
      return closed;
    },
    regions: [],
    copies: [],
    gpuDone: completion,
    onFinished: {
      addOne(callback) {
        submitted.push(callback);
      },
    },
    onAborted: {
      addOne(callback) {
        aborted.push(callback);
      },
    },
    observeSubmission(observer) {
      if (closed) throw new Error("Cannot attach a resource transaction to a closed command");
      observers.push(observer);
    },
    uploadRegions(regions) {
      this.regions.push(...regions);
      for (const region of regions)
        operations.push(() => {
          if (region.destination.bytes)
            region.destination.bytes.set(region.bytes, region.destinationOffset);
        });
    },
    copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size) {
      this.copies.push({ source, sourceOffset, destination, destinationOffset, size });
      operations.push(() => {
        if (!source.bytes || !destination.bytes)
          throw new Error("Copy fixture requires byte-backed buffers");
        destination.bytes.set(
          source.bytes.subarray(sourceOffset, sourceOffset + size),
          destinationOffset,
        );
      });
    },
    submit() {
      if (closed) throw new Error("Publication command already closed");
      closed = true;
      for (const operation of operations) operation();
      let failure;
      for (const observer of observers) {
        try {
          observer.submitted(completion);
        } catch (error) {
          failure ??= { cause: error };
        }
      }
      for (const callback of submitted) {
        try {
          callback();
        } catch (error) {
          failure ??= { cause: error };
        }
      }
      if (failure !== undefined) {
        for (const observer of observers) {
          try {
            observer.failed(failure.cause);
          } catch {
            // Preserve the originating failure after notifying every owner.
          }
        }
        throw failure.cause;
      }
    },
    abort() {
      if (closed) throw new Error("Publication command already closed");
      closed = true;
      let failure;
      for (const observer of observers) {
        try {
          observer.aborted(new Error("Publication aborted"));
        } catch (error) {
          failure ??= { cause: error };
        }
      }
      for (const callback of aborted) {
        try {
          callback();
        } catch (error) {
          failure ??= { cause: error };
        }
      }
      if (failure !== undefined) throw failure.cause;
    },
  };
}

export function publishGeometryPages(residency, pageIds = []) {
  const command = geometryPublicationCommand();
  residency.preparePublication(command, pageIds);
  command.submit();
  return command;
}
