import { VSM_RECEIVER_WORD_AGGREGATION_WGSL } from "../../.test-dist/shaders/vsm_receiver_demand.js";

export async function runVsmReceiverAggregationGpuOracle(device) {
  const invalid = 0xffffffff;
  const records = [];
  const add = (name, pages) => records.push({ name, pages });
  add("same page", Array(64).fill(3));
  add(
    "all bits in one word",
    Array.from({ length: 64 }, (_, i) => 320 + (i % 32))
  );
  add(
    "64 distinct words",
    Array.from({ length: 64 }, (_, i) => i * 32 + (i % 32))
  );
  add(
    "64 hash collisions / full table",
    Array.from({ length: 64 }, (_, i) => i * 64 * 32 + (i % 32))
  );
  add("empty", Array(64).fill(invalid));
  add(
    "one valid lane",
    Array.from({ length: 64 }, (_, i) => (i === 63 ? 131071 : invalid))
  );
  add(
    "mixed invalid and duplicate collisions",
    Array.from({ length: 64 }, (_, i) => (i % 3 === 0 ? invalid : (i % 7) * 64 * 32 + (i % 32)))
  );
  let seed = 0x61732;
  for (let group = 0; group < 128; group++) {
    add(
      `random ${group}`,
      Array.from({ length: 64 }, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % 9 === 0 ? invalid : (seed >>> 8) % 131072;
      })
    );
  }
  // Tail invocation guards must still reach the shared barrier.
  add("partial final group", [0, 31, 32, 131071, invalid, 320, 321]);
  // Disjoint requested domains prevent one case's bits masking another case's
  // failure. Offsets are multiples of 64 words, preserving collision patterns.
  const pages = new Uint32Array(
    records.flatMap((record, group) =>
      record.pages.map((page) => (page === invalid ? invalid : page + group * 131072))
    )
  );
  const input = device.createBuffer({
    size: pages.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  });
  const requested = device.createBuffer({
    size: records.length * 4096 * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
  });
  const readback = device.createBuffer({
    size: requested.size,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
  });
  const expected = new Uint32Array(records.length * 4096);
  for (const page of pages) if (page !== invalid) expected[page >>> 5] |= 1 << (page & 31);
  device.queue.writeBuffer(input, 0, pages);
  const cases = [];
  try {
    // Use the production fragment unchanged, then inject 1/0 attempt limits
    // only in this oracle to exercise partial fallback and total exhaustion.
    for (const attempts of [64, 1, 0]) {
      const fragment =
        attempts === 64
          ? VSM_RECEIVER_WORD_AGGREGATION_WGSL
          : VSM_RECEIVER_WORD_AGGREGATION_WGSL.replace("attempt < 64u", `attempt < ${attempts}u`);
      const module = device.createShaderModule({
        code: /* wgsl */ `
const VSM_INVALID_SLOT: u32 = 0xffffffffu;
@group(0) @binding(1) var<storage, read> input_pages: array<u32>;
@group(0) @binding(4) var<storage, read_write> requested: array<atomic<u32>>;
${fragment}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u,
  @builtin(local_invocation_index) lane: u32) {
  var page = VSM_INVALID_SLOT;
  if (id.x < arrayLength(&input_pages)) {
    page = input_pages[id.x];
  }
  publish_receiver_word(page, lane);
}
`
      });
      const info = await module.getCompilationInfo();
      if (info.messages.some((message) => message.type === "error"))
        throw new Error(JSON.stringify(info.messages));
      const pipeline = await device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint: "main" }
      });
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 1, resource: { buffer: input } },
          { binding: 4, resource: { buffer: requested } }
        ]
      });
      for (let repeat = 0; repeat < 3; repeat++) {
        const encoder = device.createCommandEncoder();
        encoder.clearBuffer(requested);
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(pages.length / 64));
        pass.end();
        encoder.copyBufferToBuffer(requested, 0, readback, 0, requested.size);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const actual = new Uint32Array(readback.getMappedRange());
        for (let word = 0; word < expected.length; word++) {
          if (actual[word] !== expected[word])
            throw new Error(
              JSON.stringify({ attempts, repeat, word, actual: actual[word], expected: expected[word] })
            );
        }
        readback.unmap();
        cases.push({ attempts, repeat, groups: records.length, exactWords: expected.length });
      }
    }
    // Fresh dispatch must not retain previous workgroup masks or global bits.
    const module = device.createShaderModule({
      code: /* wgsl */ `
const VSM_INVALID_SLOT: u32 = 0xffffffffu;
@group(0) @binding(4) var<storage, read_write> requested: array<atomic<u32>>;
${VSM_RECEIVER_WORD_AGGREGATION_WGSL}
@compute @workgroup_size(64)
fn main(@builtin(local_invocation_index) lane: u32) { publish_receiver_word(VSM_INVALID_SLOT, lane); }
`
    });
    const pipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module, entryPoint: "main" }
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 4, resource: { buffer: requested } }]
    });
    const encoder = device.createCommandEncoder();
    encoder.clearBuffer(requested);
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(2);
    pass.end();
    encoder.copyBufferToBuffer(requested, 0, readback, 0, requested.size);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    if (new Uint32Array(readback.getMappedRange()).some((word) => word !== 0))
      throw new Error("Empty reset retained requests");
    readback.unmap();
  } finally {
    if (readback.mapState === "mapped") readback.unmap();
    readback.destroy();
    requested.destroy();
    input.destroy();
  }
  return { passed: true, cases, records: records.map(({ name }) => name), resetEmpty: true };
}
