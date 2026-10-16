import { ScgiRuntime } from "../../.test-dist/render/gi/ScgiRuntime.js";
import {
  SCGI_ABI,
  SCGI_ABI_WGSL,
  packScgiRecord,
  packScgiCoefficients
} from "../../.test-dist/render/gi/ScgiAbi.js";
import {
  planScgiNativeDescriptors,
  planScgiQueryDescriptors
} from "../../.test-dist/render/gi/ScgiCapacity.js";
import { assertScgiCompoundFact, bindScgiPublication } from "../../.test-dist/render/gi/ScgiPublication.js";
import {
  FrameGraph,
  FrameGraphBindingLayout,
  FrameGraphContext
} from "../../.test-dist/framegraph/FrameGraph.js";
import { ResourceAccounting } from "../../.test-dist/debug/profiling/ResourceAccounting.js";
import { scgiProfile, scgiGraphics, scgiCommand, scgiWriteKnown } from "./scgi-fixture.mjs";

const check = (value, message) => {
  if (!value) throw new Error(message);
};
const demand = { enabled: true, hasGeometry: true, hasLitMaterials: true };
const drain = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

export async function runScgiTransactionGpuOracle(device) {
  const resources = [];
  const runtimes = [];
  const results = [];
  const graphics = scgiGraphics(device);
  const accounting = new ResourceAccounting();
  const createRuntime = (epoch) => {
    const runtime = new ScgiRuntime(device, epoch, accounting);
    runtimes.push(runtime);
    return runtime;
  };
  const buffer = (size, usage) => {
    const resource = device.createBuffer({ size, usage, label: "SCGI oracle" });
    resources.push(resource);
    return resource;
  };
  const observe = (command, source, offset, bytes) => {
    const read = buffer(bytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    command.gpu_encoder.copyBufferToBuffer(source, offset, read, 0, bytes);
    return async () => {
      await read.mapAsync(GPUMapMode.READ);
      const data = read.getMappedRange().slice(0);
      read.unmap();
      return data;
    };
  };
  try {
    // Literal expected sizes and offsets are independent of generated WGSL.
    const layouts = {
      identity: [48, [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44]],
      cell: [8, [0, 4]],
      cacheState: [16, [0, 4, 8, 12]],
      patch: [288, [0, 16, 32, 80, 96, 112, 128, 144, 160, 208, 256, 272]],
      request: [96, [0, 16, 28, 32, 80]],
      halfField: [96, [0, 32, 36, 40, 44, 48]],
      raw: [64, [0, 48]],
      node: [64, [0, 12, 16, 28, 32, 44, 48, 60]],
      links: [8, [0, 4]],
      triangle: [16, [0]],
      directory: [32, [0, 16]],
      instance: [128, [0, 48, 96, 112]],
      ray: [48, [0, 16, 32]],
      result: [32, [0, 12, 16]],
      payload: [32, [0, 16]],
      continuation: [64, [0, 16, 32, 36, 48, 52, 56]],
      worldHeader: [256, [0, 16, 32, 48, 64, 80, 96, 160, 224, 240]]
    };
    for (const [kind, [stride, offsets]] of Object.entries(layouts)) {
      const abi = SCGI_ABI[kind];
      check(abi.stride === stride, `${kind} size`);
      const expected = new ArrayBuffer(stride * 2);
      const view = new DataView(expected);
      const assignments = [];
      const input = {};
      let fieldIndex = 0;
      for (const field of abi.fields) {
        check(field.offset === offsets[fieldIndex], `${kind}.${field.name} offset`);
        const values = [];
        for (let lane = 0; lane < field.count; lane++) {
          const value =
            field.type === "u32" ? 0xffffffff - fieldIndex * 32 - lane : -1.25 - fieldIndex * 32 - lane;
          values.push(value);
          const offset = stride + offsets[fieldIndex] + lane * 4;
          if (field.type === "u32") view.setUint32(offset, value, true);
          else view.setFloat32(offset, value, true);
          const index = field.count === 1 ? "" : `[${lane}]`;
          // Read typed input and write typed output in record1. Host expected uses
          // literal offsets; WGSL independently computes member + array strides.
          assignments.push(`  destination[1].${field.name}${index} = source[1].${field.name}${index};`);
        }
        input[field.name] = values;
        fieldIndex++;
      }
      const source = buffer(stride * 2, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      const destination = buffer(stride * 2, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      device.queue.writeBuffer(source, stride, packScgiRecord(kind, input));
      const module = device.createShaderModule({
        code: `${SCGI_ABI_WGSL}
@group(0) @binding(0) var<storage, read> source: array<${abi.name}>;
@group(0) @binding(1) var<storage, read_write> destination: array<${abi.name}>;
@compute @workgroup_size(1) fn main() {
${assignments.join("\n")}
}`
      });
      const pipeline = await device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint: "main" }
      });
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: source } },
          { binding: 1, resource: { buffer: destination } }
        ]
      });
      const command = scgiCommand(graphics);
      const pass = command.gpu_encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      const read = observe(command, destination, 0, stride * 2);
      command.finish();
      const actual = new Uint32Array(await read());
      const reference = new Uint32Array(expected);
      for (let word = 0; word < actual.length; word++)
        check(actual[word] === reference[word], `${kind} word ${word}`);
    }
    results.push("17 typed WGSL ABI records: second-element stride, nonzero/max u32 and signed floats");

    const coefficients = [1, -2, 3, 0.5, -0.25, 4, 5, 6, -7, 8, 9, 10];
    const packed = buffer(32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const unpacked = buffer(48, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    device.queue.writeBuffer(packed, 0, packScgiCoefficients(coefficients, 2));
    const halfModule = device.createShaderModule({
      code: `${SCGI_ABI_WGSL}
@group(0) @binding(0) var<storage, read> packed: array<u32, 8>;
@group(0) @binding(1) var<storage, read_write> decoded: array<f32, 12>;
@compute @workgroup_size(1) fn main() {
  decoded = scgi_unpack_l1(packed, 2.0);
}`
    });
    const halfPipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module: halfModule }
    });
    const halfGroup = device.createBindGroup({
      layout: halfPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: packed } },
        { binding: 1, resource: { buffer: unpacked } }
      ]
    });
    const halfCommand = scgiCommand(graphics);
    const halfPass = halfCommand.gpu_encoder.beginComputePass();
    halfPass.setPipeline(halfPipeline);
    halfPass.setBindGroup(0, halfGroup);
    halfPass.dispatchWorkgroups(1);
    halfPass.end();
    const halfRead = observe(halfCommand, unpacked, 0, 48);
    halfCommand.finish();
    const decoded = new Float32Array(await halfRead());
    for (let lane = 0; lane < 12; lane++) check(decoded[lane] === coefficients[lane], `half lane ${lane}`);
    results.push("scaled signed RGB L1 half storage decodes on f32-only device");

    // Complete Native physical descriptors, including material sampled saturation.
    for (const productGeometry of [false, true])
      for (const compact of [false, true])
        for (const virtualTextures of [false, true])
          for (const reflections of ["off", "sssr-base-coat"])
            for (const unlit of [false, true])
              for (const physicalSun of [false, true]) {
                const profile = {
                  productGeometry,
                  compact,
                  virtualTextures,
                  reflections,
                  unlit,
                  physicalSun,
                  reactive: true,
                  finalPixel: true
                };
                const base = planScgiNativeDescriptors(device.limits, profile, []);
                const count = device.limits.maxSampledTexturesPerShaderStage - base.counts.sampled;
                const textures = Array.from({ length: count }, (_, binding) => ({
                  binding,
                  visibility: GPUShaderStage.COMPUTE,
                  texture: { sampleType: "float" }
                }));
                const plan = planScgiNativeDescriptors(device.limits, profile, textures);
                const bindGroupLayouts = plan.groups.map((entries) =>
                  device.createBindGroupLayout({ entries })
                );
                device.createPipelineLayout({ bindGroupLayouts });
                check(plan.addedGiBindings === 0, "Native GI adds no bindings");
              }
    const query = planScgiQueryDescriptors(
      device.limits,
      [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }],
      []
    );
    check(query.counts.storage === 15, "query tail inventory");
    device.createPipelineLayout({
      bindGroupLayouts: query.groups.map((entries) => device.createBindGroupLayout({ entries }))
    });
    results.push("64 actual Native route layouts with saturated material textures; 15-SSBO query tail");

    const runtime = createRuntime(1);
    await runtime.configure({ ...demand, enabled: false }, scgiProfile);
    check(runtime.snapshot().totalBytes === 0, "disabled allocates nothing");
    await runtime.configure(demand, scgiProfile);
    const observations = [];
    let lastWorld;
    let firstPublication;
    for (const [submit, value] of [
      [true, 11],
      [false, 99],
      [true, 22],
      [true, 33]
    ]) {
      const command = scgiCommand(graphics);
      const transaction = runtime.prepare(command, { scene: 3, view: 7 });
      runtime.encode(transaction);
      scgiWriteKnown(transaction, value);
      if (submit) {
        const pub = transaction.publication;
        const world = pub.candidateWorld;
        const read = observe(command, world.buffer, 0, world.plan.bytes);
        const field = observe(command, pub.candidateWorldField.segments[0].buffer, 0, 4);
        observations.push({ value, read, field, plan: world.plan, generation: observations.length + 1 });
        command.finish();
        firstPublication ??= pub;
        lastWorld = world;
      } else {
        command.abort(new Error("intentional pre-submit failure"));
        check(
          runtime.activeGeneration === 1 && runtime.sampleSerial === 1,
          "abort keeps generation and sample serial"
        );
      }
    }
    check(runtime.activeGeneration === 3, "three submitted frames before awaiting completion");
    for (const observation of observations) {
      const bytes = await observation.read();
      const u32 = new Uint32Array(bytes);
      const f32 = new Float32Array(bytes);
      const ranges = observation.plan.ranges;
      check(u32[0] === observation.generation, "queue generation");
      check(u32[ranges.map.offset / 4] === observation.value, "known map survives abort/retry");
      check(u32[ranges.map.offset / 4 + 2] === 0xffffffff, "untouched cells use EMPTY sentinel");
      check(f32[(ranges.patches.offset + 160) / 4] === observation.value + 0.25, "known A0");
      check(f32[(ranges.patches.offset + 208) / 4] === observation.value + 0.5, "known A2");
      check(u32[16] === observation.value + 3, "allocator state");
      check(u32[ranges.bounceRequests.offset / 4] === observation.value + 7, "bounce queue");
      check(new Uint32Array(await observation.field())[0] === observation.value + 8, "world field");
    }
    // Fourth frame performs only the real full-state copy, with no fixture write.
    const copiedCommand = scgiCommand(graphics);
    const copied = runtime.prepare(copiedCommand, { scene: 3, view: 7 });
    check(copied.publication.activeWorld.buffer === lastWorld.buffer, "late-bound active bank");
    runtime.encode(copied);
    const copiedRead = observe(
      copiedCommand,
      copied.publication.candidateWorld.buffer,
      0,
      copied.publication.candidateWorld.plan.bytes
    );
    copiedCommand.finish();
    const copyBytes = new Uint32Array(await copiedRead());
    const copyPlan = copied.publication.candidateWorld.plan;
    check(copyBytes[copyPlan.ranges.map.offset / 4] === 33, "map full copied");
    check(
      new Float32Array(copyBytes.buffer)[(copyPlan.ranges.patches.offset + 208) / 4] === 33.5,
      "A2 copied"
    );
    check(copyBytes[16] === 36, "allocator copied");
    check(copyBytes[copyPlan.ranges.bounceRequests.offset / 4] === 40, "bounce copied");
    results.push(
      "real command staging: abort/retry, 3 in flight, complete bank copy including allocator/A2/bounce"
    );

    const layout = new FrameGraphBindingLayout();
    const bound = bindScgiPublication(layout, { gi: firstPublication }, (bindings) => bindings.gi);
    const graph = new FrameGraph();
    let resolved;
    // Existing graph API carries an actual imported buffer through the slot.
    const worldSlot = layout.slot(
      "scgi-world-buffer",
      { gi: firstPublication },
      (bindings) => bindings.gi.candidateWorld.buffer
    );
    const resource = graph.import_resource("SCGI candidate", { kind: "imported" }, worldSlot);
    const pass = graph.add("SCGI publication resolve", bound, (publication, resources) => {
      resolved = publication.candidateWorld.buffer;
      check(resources.get(resource) === resolved, "imported buffer resolves current frame");
    });
    pass.read(resource);
    pass.make_side_effect();
    const compiled = graph.compile();
    compiled.execute(new FrameGraphContext(), { gi: copied.publication });
    check(resolved === copied.publication.candidateWorld.buffer, "cached graph resolves current publication");
    check(resource !== undefined, "graph resource");

    const resizeProfile = { ...scgiProfile, width: 17, height: 9 };
    await runtime.configure(demand, resizeProfile);
    const resizeCommand = scgiCommand(graphics);
    const resized = runtime.prepare(resizeCommand, { scene: 3, view: 7 });
    check(
      resized.publication.activeWorld.buffer === copied.publication.candidateWorld.buffer,
      "resize preserves world"
    );
    check(resized.publication.previousWorldField === null, "resize rejects screen history");
    runtime.encode(resized);
    scgiWriteKnown(resized, 44);
    const fact = {
      generation: resized.publication.generation,
      halfExtent: resized.publication.halfExtent,
      fieldStride: 96,
      identityBytes: 48,
      completeWrite: true,
      domain: "linear-rec709-unexposed"
    };
    assertScgiCompoundFact(resized.publication, fact);
    let rejected = false;
    try {
      assertScgiCompoundFact(resized.publication, { ...fact, identityBytes: 16 });
    } catch {
      rejected = true;
    }
    check(rejected, "compound constituent identity ABI checked");
    let resizedComplete = false;
    void resized.completion.then(() => {
      resizedComplete = true;
    });
    resizeCommand.finish();
    await runtime.configure(demand, { ...resizeProfile, patches: 16 });
    const replacementCommand = scgiCommand(graphics);
    const replacement = runtime.prepare(replacementCommand, { scene: 3, view: 7 });
    check(
      replacement.publication.activeWorld === null,
      "replacement does not read mismatched world capacity"
    );
    runtime.encode(replacement);
    scgiWriteKnown(replacement, 45);
    replacementCommand.finish();
    check(
      resizedComplete || runtime.snapshot().retiredBytes > 0,
      "replacement retains old bank unless its actual fence already completed"
    );
    runtime.disable();
    check(runtime.snapshot().retiredBytes > 0, "retirement retains submitted resources");
    await device.queue.onSubmittedWorkDone();
    await drain();
    check(runtime.snapshot().totalBytes === 0, "disable/resize retirement drains");
    results.push("resize preserves world, compound field fact, disable/last-fence accounting");

    const failed = createRuntime(2);
    await failed.configure(demand, scgiProfile);
    const failedCommand = scgiCommand(graphics);
    failedCommand.onFinished.addOne(() => {
      throw new Error("intentional observer exception");
    });
    const failedFrame = failed.prepare(failedCommand, { scene: 3, view: 7 });
    failed.encode(failedFrame);
    scgiWriteKnown(failedFrame, 55);
    let observerFailed = false;
    try {
      failedCommand.finish();
    } catch {
      observerFailed = true;
    }
    check(observerFailed && failedCommand.wasSubmitted, "post-submit observer fault");
    check(failed.activeGeneration === 1 && failed.poisoned, "fault retains submitted role and poisons");
    failed.disable();
    check(failed.snapshot().retiredBytes > 0, "observer fault retains fence");
    await device.queue.onSubmittedWorkDone();
    await drain();
    check(failed.snapshot().totalBytes === 0, "observer fault fence retires");

    const settlementRuntime = createRuntime(20);
    await settlementRuntime.configure(demand, scgiProfile);
    const settlementCommand = scgiCommand(graphics);
    const settlementFailure = new Error("intentional resource settlement exception");
    settlementCommand.observeSubmission({
      submitted() { throw settlementFailure; },
      aborted() { throw new Error("submitted settlement must not abort"); },
      failed() {}
    });
    const settlementFrame = settlementRuntime.prepare(settlementCommand, { scene: 3, view: 7 });
    settlementRuntime.encode(settlementFrame);
    scgiWriteKnown(settlementFrame, 61);
    let legacyCommitted = false;
    settlementCommand.onFinished.addOne(() => { legacyCommitted = true; });
    let settlementFailed = false;
    try {
      settlementCommand.finish();
    } catch (cause) {
      settlementFailed = cause === settlementFailure;
    }
    check(settlementFailed && legacyCommitted, "resource observer fault must settle legacy owners");
    check(settlementRuntime.activeGeneration === 1 && settlementRuntime.poisoned,
      "all resource observers settle before failure propagation");
    settlementRuntime.disable();
    await settlementCommand.gpuDone;
    await drain();
    check(settlementRuntime.snapshot().totalBytes === 0, "resource observer fault retirement drains");

    const abortedRuntime = createRuntime(21);
    await abortedRuntime.configure(demand, scgiProfile);
    const abortCommand = scgiCommand(graphics);
    const abortFailure = new Error("intentional resource rollback exception");
    abortCommand.observeSubmission({
      submitted() { throw new Error("aborted settlement must not submit"); },
      aborted() { throw abortFailure; },
      failed() {}
    });
    const abortFrame = abortedRuntime.prepare(abortCommand, { scene: 3, view: 7 });
    abortedRuntime.encode(abortFrame);
    scgiWriteKnown(abortFrame, 62);
    let legacyAborted = false;
    abortCommand.onAborted.addOne(() => { legacyAborted = true; });
    let abortFailed = false;
    try {
      abortCommand.abort();
    } catch (cause) {
      abortFailed = cause === abortFailure;
    }
    check(abortFailed && legacyAborted && abortFrame.state === "aborted",
      "resource rollback fault must settle all other owners");
    check(abortedRuntime.activeGeneration === 0, "rollback fault cannot publish candidate");
    await drain();
    abortedRuntime.destroy();
    check(abortedRuntime.snapshot().totalBytes === 0, "aborted candidate resources drain");
    results.push("resource settlement/rollback faults preserve every legacy publication notification");

    // Deliberate invalid GPU command is scoped so it cannot contaminate the
    // harness's outer error scope. Feed the actual asynchronous GPUError to owner.
    const validationRuntime = createRuntime(3);
    await validationRuntime.configure(demand, scgiProfile);
    device.pushErrorScope("validation");
    const invalidCommand = scgiCommand(graphics);
    const invalidFrame = validationRuntime.prepare(invalidCommand, { scene: 3, view: 7 });
    validationRuntime.encode(invalidFrame);
    invalidCommand.gpu_encoder.clearBuffer(invalidFrame.publication.candidateWorld.buffer, 1, 4);
    invalidCommand.finish();
    const error = await device.popErrorScope();
    check(error !== null, "actual asynchronous GPU validation fault");
    validationRuntime.poison(error, 3);
    check(
      validationRuntime.poisoned && invalidFrame.publication.status === "poisoned",
      "validation dependency chain poisoned"
    );
    validationRuntime.disable();
    await device.queue.onSubmittedWorkDone();
    await drain();
    check(accounting.snapshot().totalBytes === 0, "all accounted resources drain");
    results.push("post-submit observer fault and real scoped async GPU validation poisoning");

    // Device loss is exercised on a separate real device so the outer harness
    // can still report its own successful disposal and error scopes.
    const adapter = await navigator.gpu.requestAdapter();
    check(adapter !== null, "secondary loss adapter");
    const lostDevice = await adapter.requestDevice();
    const lostGraphics = scgiGraphics(lostDevice);
    const lostRuntime = new ScgiRuntime(lostDevice, 10);
    try {
      const segmentedPlan = await lostRuntime.configure(demand, {
        ...scgiProfile,
        resolution: 1,
        cascades: 1,
        width: 3840,
        height: 2160
      });
      check(segmentedPlan.screen.length > 1, "4K field exceeds actual single-binding limit and segments");
      const lossCommand = scgiCommand(lostGraphics);
      const lossFrame = lostRuntime.prepare(lossCommand, { scene: 1, view: 1 });
      lostRuntime.encode(lossFrame);
      scgiWriteKnown(lossFrame, 66);
      check(
        lossFrame.publication.candidateWorldField.segments.length === segmentedPlan.screen.length,
        "all actual segmented history buffers allocated"
      );
      const lastSegment = lossFrame.publication.candidateWorldField.segments.at(-1);
      const lastRead = lostDevice.createBuffer({
        size: 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      lossCommand.gpu_encoder.copyBufferToBuffer(
        lastSegment.buffer,
        lastSegment.plan.bytes - 4,
        lastRead,
        0,
        4
      );
      lossCommand.finish();
      await lastRead.mapAsync(GPUMapMode.READ);
      check(new Uint32Array(lastRead.getMappedRange())[0] === 0, "last segment fully initialized");
      lastRead.unmap();
      lastRead.destroy();
      lostDevice.destroy();
      await lostDevice.lost;
      await drain();
      check(lostRuntime.poisoned, "real device loss poisons old epoch");
      check(lostRuntime.snapshot().totalBytes === 0, "device teardown releases old resources");
      const recovered = createRuntime(11);
      recovered.poison(new Error("late old device callback"), 10);
      check(!recovered.poisoned, "late callback cannot mutate replacement epoch");
    } finally {
      lostRuntime.destroy();
      lostGraphics.buffer_allocator_main.destroy();
      lostGraphics.buffer_allocator_staging.destroy();
      lostDevice.destroy();
    }
    results.push(
      "real 4K segmented history, separate device loss, teardown and old-epoch callback isolation"
    );
    return {
      passed: true,
      results,
      cost: {
        fixturePeakBytes: accounting.snapshot().peakBytes,
        productionDispatchesAdded: 0,
        productionSubmitsAdded: 0
      },
      scope: "SCGI-1 nonproduction infrastructure; no GI image or performance claim"
    };
  } finally {
    for (const runtime of runtimes) runtime.destroy();
    await device.queue.onSubmittedWorkDone();
    await drain();
    graphics.buffer_allocator_main.destroy();
    graphics.buffer_allocator_staging.destroy();
    for (const resource of resources) resource.destroy();
  }
}
