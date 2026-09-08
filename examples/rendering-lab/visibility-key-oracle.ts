import {
  GPU_VISIBILITY_KEY_EMPTY,
  GPU_VISIBILITY_KEY_INVALID,
  GPU_VISIBILITY_KEY_SLOT_MASK,
  GPU_VISIBILITY_KEY_WGSL,
  decodeVisibilityKey,
  isVisibilityKeyValid,
  tryEncodeVisibilityKey
} from "../../OEngine/src/gpu/GpuVisibilityKeyAbi.ts";

interface VisibilityKeyOracleReport {
  readonly adapter: string;
  readonly vectorCount: number;
  readonly encodeVectorCount: number;
  readonly decodeVectorCount: number;
  readonly mismatchCount: number;
  readonly mismatches: readonly string[];
}

declare global {
  interface Window {
    __OENGINE_VISIBILITY_KEY_ORACLE__?: VisibilityKeyOracleReport;
    __OENGINE_VISIBILITY_KEY_ORACLE_ERROR__?: string;
  }
}

const INPUT_WORDS = 4;
const OUTPUT_WORDS = 6;
const OP_ENCODE = 0;
const OP_DECODE = 1;

const ORACLE_WGSL = /* wgsl */ `
${GPU_VISIBILITY_KEY_WGSL}

struct OracleInput {
  operation: u32,
  value0: u32,
  value1: u32,
  padding: u32,
};

struct OracleOutput {
  key: u32,
  encode_valid: u32,
  raster_work_slot: u32,
  kernel_class: u32,
  decode_valid: u32,
  empty: u32,
};

struct OracleInputs {
  values: array<OracleInput>,
};

struct OracleOutputs {
  values: array<OracleOutput>,
};

@group(0) @binding(0) var<storage, read> inputs: OracleInputs;
@group(0) @binding(1) var<storage, read_write> outputs: OracleOutputs;

@compute @workgroup_size(64)
fn visibility_key_oracle(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let index = global_id.x;
  if index >= arrayLength(&inputs.values) {
    return;
  }
  let input = inputs.values[index];
  var key = input.value0;
  var encode_valid = select(0u, 1u, oengine_visibility_key_is_valid(key));
  if input.operation == ${OP_ENCODE}u {
    let encoded = oengine_visibility_key_try_encode(input.value0, input.value1);
    key = encoded.key;
    encode_valid = encoded.valid;
  }
  let decoded = oengine_visibility_key_decode(key);
  outputs.values[index] = OracleOutput(
    key,
    encode_valid,
    decoded.raster_work_slot,
    decoded.kernel_class,
    decoded.valid,
    decoded.empty
  );
}
`;

function appendInput(target: number[], operation: number, value0: number, value1 = 0): void {
  target.push(operation >>> 0, value0 >>> 0, value1 >>> 0, 0);
}

function seededVectors(): { inputs: Uint32Array<ArrayBuffer>; encodeVectorCount: number } {
  const words: number[] = [];
  const boundarySlots = [
    0,
    1,
    GPU_VISIBILITY_KEY_SLOT_MASK - 1,
    GPU_VISIBILITY_KEY_SLOT_MASK,
    GPU_VISIBILITY_KEY_SLOT_MASK + 1,
    GPU_VISIBILITY_KEY_INVALID,
    GPU_VISIBILITY_KEY_EMPTY
  ];
  for (const slot of boundarySlots) {
    for (let kernelClass = 0; kernelClass <= 8; kernelClass++) {
      appendInput(words, OP_ENCODE, slot, kernelClass);
    }
  }

  let seed = 0x6d325632;
  const randomU32 = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  for (let index = 0; index < 4096; index++) {
    appendInput(words, OP_ENCODE, randomU32(), randomU32() & 15);
  }
  const encodeVectorCount = words.length / INPUT_WORDS;

  const decodeKeys = [
    GPU_VISIBILITY_KEY_EMPTY,
    GPU_VISIBILITY_KEY_INVALID,
    0,
    GPU_VISIBILITY_KEY_SLOT_MASK,
    (6 << 29) >>> 0,
    (((6 << 29) >>> 0) | GPU_VISIBILITY_KEY_SLOT_MASK) >>> 0
  ];
  for (const key of decodeKeys) appendInput(words, OP_DECODE, key);
  for (let index = 0; index < 2048; index++) {
    appendInput(words, OP_DECODE, randomU32());
  }
  return { inputs: new Uint32Array(words), encodeVectorCount };
}

function expectedOutput(input: Uint32Array, index: number): readonly number[] {
  const offset = index * INPUT_WORDS;
  const operation = input[offset]!;
  let key = input[offset + 1]!;
  let encodeValid = isVisibilityKeyValid(key) ? 1 : 0;
  if (operation === OP_ENCODE) {
    const encoded = tryEncodeVisibilityKey(key, input[offset + 2]!);
    key = encoded.key;
    encodeValid = encoded.valid ? 1 : 0;
  }
  const decoded = decodeVisibilityKey(key);
  return decoded.kind === "valid"
    ? [key, encodeValid, decoded.rasterWorkSlot, decoded.kernelClass, 1, 0]
    : [key, encodeValid, 0, 0, 0, decoded.kind === "empty" ? 1 : 0];
}

async function runOracle(): Promise<VisibilityKeyOracleReport> {
  if (navigator.gpu === undefined) throw new Error("navigator.gpu is unavailable");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (adapter === null) throw new Error("No WebGPU adapter is available");
  const device = await adapter.requestDevice();
  let intentionalDestroy = false;
  const deviceLost = new Promise<never>((_resolve, reject) => {
    void device.lost.then((info) => {
      if (!intentionalDestroy) {
        reject(new Error(
          `VisibilityKey oracle device lost (${info.reason}): ${info.message || "no message"}`
        ));
      }
    });
  });
  const { inputs, encodeVectorCount } = seededVectors();
  const vectorCount = inputs.length / INPUT_WORDS;
  const inputBuffer = device.createBuffer({
    label: "VisibilityKey oracle inputs",
    size: inputs.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  });
  const outputByteLength = vectorCount * OUTPUT_WORDS * Uint32Array.BYTES_PER_ELEMENT;
  const outputBuffer = device.createBuffer({
    label: "VisibilityKey oracle outputs",
    size: outputByteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
  });
  const readback = device.createBuffer({
    label: "VisibilityKey oracle readback",
    size: outputByteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  try {
    return await Promise.race([
      (async (): Promise<VisibilityKeyOracleReport> => {
        const module = device.createShaderModule({
          label: "VisibilityKey v3 CPU/WGSL oracle",
          code: ORACLE_WGSL
        });
        const compilation = await module.getCompilationInfo();
        const shaderErrors = compilation.messages.filter((message) => message.type === "error");
        if (shaderErrors.length > 0) {
          throw new Error(shaderErrors.map((message) => message.message).join("\n"));
        }
        const pipeline = await device.createComputePipelineAsync({
          label: "VisibilityKey v3 CPU/WGSL oracle",
          layout: "auto",
          compute: { module, entryPoint: "visibility_key_oracle" }
        });
        const bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: inputBuffer } },
            { binding: 1, resource: { buffer: outputBuffer } }
          ]
        });
        device.queue.writeBuffer(inputBuffer, 0, inputs);
        const encoder = device.createCommandEncoder({ label: "VisibilityKey oracle command" });
        const pass = encoder.beginComputePass({ label: "VisibilityKey oracle compute" });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(vectorCount / 64));
        pass.end();
        encoder.copyBufferToBuffer(outputBuffer, 0, readback, 0, outputByteLength);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ, 0, outputByteLength);
        const actual = new Uint32Array(readback.getMappedRange(0, outputByteLength));
        const mismatches: string[] = [];
        for (let index = 0; index < vectorCount; index++) {
          const expected = expectedOutput(inputs, index);
          const actualOffset = index * OUTPUT_WORDS;
          for (let word = 0; word < OUTPUT_WORDS; word++) {
            if (actual[actualOffset + word] !== expected[word]) {
              mismatches.push(
                `vector ${index} word ${word}: expected ${expected[word]}, got ${actual[actualOffset + word]}`
              );
              break;
            }
          }
          if (mismatches.length >= 16) break;
        }
        const info = adapter.info;
        return Object.freeze({
          adapter: [info.vendor, info.architecture, info.device].filter(Boolean).join(" / "),
          vectorCount,
          encodeVectorCount,
          decodeVectorCount: vectorCount - encodeVectorCount,
          mismatchCount: mismatches.length,
          mismatches: Object.freeze(mismatches)
        });
      })(),
      deviceLost
    ]);
  } finally {
    intentionalDestroy = true;
    if (readback.mapState === "mapped") readback.unmap();
    readback.destroy();
    outputBuffer.destroy();
    inputBuffer.destroy();
    device.destroy();
  }
}

const result = document.querySelector("#result")!;
void runOracle().then((report) => {
  window.__OENGINE_VISIBILITY_KEY_ORACLE__ = report;
  document.body.dataset.state = report.mismatchCount === 0 ? "ready" : "failed";
  result.textContent = JSON.stringify(report, null, 2);
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  window.__OENGINE_VISIBILITY_KEY_ORACLE_ERROR__ = message;
  document.body.dataset.state = "failed";
  result.textContent = message;
});
