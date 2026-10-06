import { AppearanceGraphBuilder } from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { bindAppearanceProducts } from "../../.test-dist/material/AppearanceProductBinding.js";
import { cookAppearanceMipProduct } from "../../.test-dist/material/AppearanceMipCooker.js";
import {
  writeAppearanceAssetPackage,
  openAppearanceAssetPackage
} from "../../.test-dist/assets/AppearanceAssetPackage.js";
import { lowerAppearanceWgsl } from "../../.test-dist/shaders/appearance_program.js";
import { packAppearanceDagPublication } from "../../.test-dist/gpu/GpuAppearanceDagAbi.js";
import { APPEARANCE_DAG_PRODUCT_SAMPLING_WGSL } from "../../.test-dist/shaders/appearance_dag_sampling.js";
import { decodeFloat16 } from "../../.test-dist/core/Float16.js";
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** Local diagnostic integration. Both kernels consume the original payload;
 * all output pixels are compared, and warm-up is excluded from paired timings.
 * This deliberately cache-friendly fixture isolates filtering/decoding overhead,
 * not scene residency or the memory behavior of many independent products. */
async function measureProductSampling(
  device,
  source,
  data,
  texture,
  sampler,
  productIndex,
  bankWords,
  gradients,
  magnitudes,
  retained
) {
  check(device.features.has("timestamp-query"), "sampler cost requires negotiated timestamps");
  const width = 1920;
  const height = 1080;
  const count = width * height;
  const outputBytes = count * 16;
  const warmup = 2;
  const samples = 6;
  const pairs = warmup + samples;
  const createBuffer = (label, size, usage) => {
    const buffer = device.createBuffer({ label, size, usage });
    retained.push(buffer);
    return buffer;
  };
  const settings = createBuffer(
    "Product cost settings",
    16,
    GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  );
  device.queue.writeBuffer(settings, 0, new Uint32Array([productIndex, count, bankWords, width]));
  const outputs = ["software", "hardware"].map((name) =>
    createBuffer("Product cost " + name, outputBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
  );
  const readbacks = outputs.map((_output, index) =>
    createBuffer(
      "Product cost result " + index,
      outputBytes,
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    )
  );
  const querySet = device.createQuerySet({
    label: "Paired Product sampling timestamps",
    type: "timestamp",
    count: pairs * 4
  });
  retained.push(querySet);
  const resolve = createBuffer(
    "Product timestamp resolve",
    pairs * 32,
    GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
  );
  const timestamps = createBuffer(
    "Product timestamp readback",
    pairs * 32,
    GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
  );
  const layout = device.createBindGroupLayout({
    label: "Product sampling comparison layout",
    entries: [
      ...[0, 1, 2, 3].map((binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage" }
      })),
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }
    ]
  });
  const pipelineLayout = device.createPipelineLayout({
    label: "Product sampling comparison pipeline layout",
    bindGroupLayouts: [layout]
  });
  const declarations = source.slice(0, source.indexOf("@compute"));
  const extent = [texture.width, texture.height];
  const calls = [
    "appearance_dag_product(settings.x, uv, dx, dy)",
    "textureSampleGrad(reference_texture, reference_sampler, (uv - vec2f(-1.0, -2.0)) / vec2f(3.0, 6.0), dx / vec2f(3.0, 6.0), dy / vec2f(3.0, 6.0))"
  ];
  const pipelines = [];
  for (let method = 0; method < 2; method++) {
    const module = device.createShaderModule({
      label: "Product cost " + (method === 0 ? "production sampler" : "hardware reference"),
      code:
        declarations +
        /* wgsl */ `
@compute @workgroup_size(64)
fn measure(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= settings.y { return; }
  dag_product_bank_words = settings.z;
  let coordinate = vec2u(id.x % settings.w, id.x / settings.w);
  let center = vec2f(-1.0, -2.0) + vec2f(coordinate) / vec2f(${width - 1}.0, ${height - 1}.0) * vec2f(3.0, 6.0);
  var result = vec4f(0.0);
  for (var query = 0u; query < 4u; query++) {
    let footprint = 0.7 + f32(query) * 1.3;
    let uv = center + vec2f(f32(query) * 0.0013, -f32(query) * 0.0007);
    let dx = vec2f(3.0 * footprint / ${extent[0]}.0, 0.0);
    let dy = vec2f(0.0, 6.0 * footprint / ${extent[1]}.0);
    result += ${calls[method]};
  }
  values[id.x] = result;
}
`
    });
    const info = await module.getCompilationInfo();
    check(!info.messages.some((message) => message.type === "error"), JSON.stringify(info.messages));
    pipelines.push(
      await device.createComputePipelineAsync({
        label: "Product sampling cost " + method,
        layout: pipelineLayout,
        compute: { module, entryPoint: "measure" }
      })
    );
  }
  const groups = outputs.map((output, method) =>
    device.createBindGroup({
      label: "Product sampling cost inputs " + method,
      layout,
      entries: [...data, output]
        .map((buffer, binding) => ({ binding, resource: { buffer } }))
        .concat([
          { binding: 5, resource: texture.createView() },
          { binding: 6, resource: sampler },
          { binding: 7, resource: { buffer: settings } }
        ])
    })
  );
  const encoder = device.createCommandEncoder({ label: "Paired Product sampler diagnostic" });
  for (let pair = 0; pair < pairs; pair++) {
    // Alternate order to avoid always charging the cold cache to one method.
    for (const method of pair % 2 === 0 ? [0, 1] : [1, 0]) {
      const query = pair * 4 + method * 2;
      const pass = encoder.beginComputePass({
        label: "Product sampler " + method + " pair " + pair,
        timestampWrites: { querySet, beginningOfPassWriteIndex: query, endOfPassWriteIndex: query + 1 }
      });
      pass.setPipeline(pipelines[method]);
      pass.setBindGroup(0, groups[method]);
      pass.dispatchWorkgroups(Math.ceil(count / 64));
      pass.end();
    }
  }
  encoder.resolveQuerySet(querySet, 0, pairs * 4, resolve, 0);
  encoder.copyBufferToBuffer(resolve, 0, timestamps, 0, pairs * 32);
  for (let method = 0; method < 2; method++) {
    encoder.copyBufferToBuffer(outputs[method], 0, readbacks[method], 0, outputBytes);
  }
  device.queue.submit([encoder.finish()]);
  await Promise.all([timestamps, ...readbacks].map((buffer) => buffer.mapAsync(GPUMapMode.READ)));
  const ticks = new BigUint64Array(timestamps.getMappedRange());
  const values = readbacks.map((buffer) => new Float32Array(buffer.getMappedRange()));
  const bounds = Array.from(
    { length: 4 },
    (_value, channel) => 4 * (gradients[channel] / 256 + Math.max(magnitudes[channel], 1) * 2 ** -22)
  );
  let worstAbsoluteError = 0;
  for (let index = 0; index < count * 4; index++) {
    const actual = values[0][index];
    const expected = values[1][index];
    const error = Math.abs(actual - expected);
    check(
      Number.isFinite(actual) && Number.isFinite(expected) && error <= bounds[index % 4],
      JSON.stringify({ index, actual, expected, error, bound: bounds[index % 4] })
    );
    worstAbsoluteError = Math.max(worstAbsoluteError, error);
  }
  const times = [[], []];
  for (let pair = warmup; pair < pairs; pair++) {
    for (let method = 0; method < 2; method++) {
      const at = pair * 4 + method * 2;
      check(ticks[at + 1] > ticks[at], "timestamp interval must be available and positive");
      times[method].push(Number(ticks[at + 1] - ticks[at]) / 1e6);
    }
  }
  timestamps.unmap();
  readbacks.forEach((buffer) => buffer.unmap());
  const percentile = (values, fraction) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.ceil(sorted.length * fraction) - 1];
  };
  return {
    extent,
    output: [width, height],
    queriesPerItem: 4,
    warmup,
    samples,
    outputBytesPerMethod: outputBytes,
    comparedComponents: count * 4,
    worstAbsoluteError,
    softwareMs: times[0],
    hardwareMs: times[1],
    softwareP50Ms: percentile(times[0], 0.5),
    softwareP95Ms: percentile(times[0], 0.95),
    hardwareP50Ms: percentile(times[1], 0.5),
    hardwareP95Ms: percentile(times[1], 0.95),
    limitations:
      "cache-friendly single Product, uncontrolled clocks; output stores included, no Geometry/VM/Surface attribution"
  };
}
/** The actual immutable bank sampler/packing versus independent native
 * textureSampleGrad on the ORIGINAL half texels, all formats/mips/domain.
 * This fixture owns reference textures only; production has no second path. */
export async function runAppearanceProductSamplingCostGpuOracle(device) {
  return runAppearanceProductSamplingGpuOracle(device, { cost: true });
}

export async function runAppearanceProductSamplingGpuOracle(device, { cost = false } = {}) {
  const width = cost ? 256 : 8;
  const height = cost ? 128 : 4;
  const mipCount = cost ? 9 : 4;
  const graph = new AppearanceGraphBuilder();
  const uv = graph.input("uv0", 2, "surface", undefined, "uv0");
  const u = graph.swizzle(uv, [0]),
    v = graph.swizzle(uv, [1]);
  const scale = graph.constant(0.0001);
  graph.output("scalar", graph.operation("multiply", graph.operation("sin", u), scale));
  graph.output(
    "pair",
    graph.operation("multiply", graph.combine(graph.operation("cos", u), graph.operation("sin", v)), scale)
  );
  graph.output(
    "rgb",
    graph.operation(
      "multiply",
      graph.combine(
        graph.operation("multiply", u, u),
        graph.operation("multiply", v, v),
        graph.operation("multiply", u, v)
      ),
      scale
    )
  );
  const original = compileAppearanceGraph(graph.build());
  const cooked = cookAppearanceMipProduct(original, original.outputs, {
    width,
    height,
    mipCount,
    byteBudget: cost ? 16 * 1024 * 1024 : 65536,
    validationProbeBudget: cost ? 1024 * 1024 : 65536,
    domainMin: [-1, -2],
    domainMax: [2, 4],
    coordinateDomain: "uv0",
    error: { absolute: 0.01, relative: 0 },
    storagePrecision: "float16",
    sample: () => []
  });
  const asset = await openAppearanceAssetPackage(
    await writeAppearanceAssetPackage(cooked, {
      uri: "oracle/product-sampling",
      contentHash: "b".repeat(64),
      dependencies: []
    })
  );
  const program = bindAppearanceProducts(original, [{ source: original, asset, roots: original.outputs }]);
  const packed = packAppearanceDagPublication(
    [
      {
        program,
        lowered: lowerAppearanceWgsl(program),
        constantBase: 0,
        routeBase: 0,
        inputBase: 0,
        textureBindingSetId: 0
      }
    ],
    cost ? 16 * 1024 * 1024 : 65536,
    cost ? 512 * 1024 : 512
  );
  check(packed.products[1].byteLength > 4, "fixture must read payload across both physical banks");
  const retained = [];
  const buffer = (data, usage = GPUBufferUsage.STORAGE) => {
    const b = device.createBuffer({
      size: data.byteLength,
      usage: usage | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    });
    device.queue.writeBuffer(b, 0, data);
    retained.push(b);
    return b;
  };
  const code = /* wgsl */ `
@group(0) @binding(0) var<storage, read> dag_code: array<u32>;
@group(0) @binding(1) var<storage, read> dag_product_0: array<u32>;
@group(0) @binding(2) var<storage, read> dag_product_1: array<u32>;
@group(0) @binding(3) var<storage, read> queries: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> values: array<vec4f>;
@group(0) @binding(5) var reference_texture: texture_2d<f32>;
@group(0) @binding(6) var reference_sampler: sampler;
@group(0) @binding(7) var<uniform> settings: vec4u;
var<private> dag_entry: u32;
var<private> dag_product_bank_words: u32;
${APPEARANCE_DAG_PRODUCT_SAMPLING_WGSL}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= settings.y { return; }
  dag_product_bank_words = settings.z;
  let q = queries[id.x];
  // Independent oracle transformation of this fixture's authored domain.
  let native_uv = (q.xy - vec2f(-1.0, -2.0)) / vec2f(3.0, 6.0);
  let native_dx = vec2f(q.z, 0.0) / vec2f(3.0, 6.0);
  let native_dy = vec2f(0.0, q.w) / vec2f(3.0, 6.0);
  values[id.x * 2u] = appearance_dag_product(settings.x, q.xy, vec2f(q.z, 0.0), vec2f(0.0, q.w));
  values[id.x * 2u + 1u] = textureSampleGrad(reference_texture, reference_sampler, native_uv, native_dx, native_dy);
}
`;
  const module = device.createShaderModule({ code });
  const info = await module.getCompilationInfo();
  check(
    info.messages.every((message) => message.type !== "error"),
    JSON.stringify(info.messages)
  );
  const pipeline = await device.createComputePipelineAsync({
    layout: "auto",
    compute: { module, entryPoint: "main" }
  });
  const sampler = device.createSampler({
    minFilter: "linear",
    magFilter: "linear",
    mipmapFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge"
  });
  const queries = [];
  for (const footprint of [0, 0.5, 1, 1.4, 1.6, 2, 3.2, 4, 8, 64])
    for (const coordinate of [
      [-4, -6],
      [-1, -2],
      [0, 0],
      [0.125, 0.625],
      [1.5, 3.5],
      [2, 4],
      [5, 8]
    ])
      queries.push(...coordinate, (footprint * 3) / 8, (footprint * 6) / 4);
  const q = buffer(new Float32Array(queries));
  const data = [buffer(packed.code), ...packed.products.map((item) => buffer(item)), q];
  const rows = [];
  try {
    for (let index = 0; index < program.productReads.length; index++) {
      const field = program.productReads[index].field;
      const gradients = new Float64Array(4),
        magnitudes = new Float64Array(4);
      for (const mip of field.mips) {
        const words = new Uint16Array(mip.payload.buffer, mip.payload.byteOffset, mip.payload.byteLength / 2);
        const width = field.width === 3 ? 4 : field.width;
        for (let channel = 0; channel < width; channel++) {
          let dx = 0,
            dy = 0;
          for (let y = 0; y < mip.height; y++)
            for (let x = 0; x < mip.width; x++) {
              const at = (y * mip.width + x) * width + channel,
                value = decodeFloat16(words[at]);
              magnitudes[channel] = Math.max(magnitudes[channel], Math.abs(value));
              if (x + 1 < mip.width) dx = Math.max(dx, Math.abs(value - decodeFloat16(words[at + width])));
              if (y + 1 < mip.height)
                dy = Math.max(dy, Math.abs(value - decodeFloat16(words[at + mip.width * width])));
            }
          gradients[channel] = Math.max(gradients[channel], dx + dy);
        }
      }
      const texture = device.createTexture({
        size: [width, height],
        format: field.format,
        mipLevelCount: mipCount,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      });
      retained.push(texture);
      const channels = field.width === 3 ? 4 : field.width;
      for (let level = 0; level < field.mips.length; level++) {
        const mip = field.mips[level];
        device.queue.writeTexture(
          { texture, mipLevel: level },
          mip.payload,
          { bytesPerRow: mip.width * channels * 2 },
          { width: mip.width, height: mip.height }
        );
      }
      const values = buffer(new Float32Array(queries.length * 2));
      const settings = buffer(
        new Uint32Array([index, queries.length / 4, packed.productBankWords, 0]),
        GPUBufferUsage.UNIFORM
      );
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [...data, values]
          .map((item, binding) => ({ binding, resource: { buffer: item } }))
          .concat([
            { binding: 5, resource: texture.createView() },
            { binding: 6, resource: sampler },
            { binding: 7, resource: { buffer: settings } }
          ])
      });
      const readback = device.createBuffer({
        size: values.size,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
      });
      retained.push(readback);
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(queries.length / 4 / 64));
      pass.end();
      encoder.copyBufferToBuffer(values, 0, readback, 0, values.size);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const output = new Float32Array(readback.getMappedRange());
      let worst = 0;
      for (let query = 0; query < queries.length / 4; query++)
        for (let channel = 0; channel < 4; channel++) {
          const actual = output[query * 8 + channel],
            expected = output[query * 8 + 4 + channel];
          const error = Math.abs(actual - expected);
          worst = Math.max(worst, error);
          // Both paths load IDENTICAL stored half texels, so no additional half
          // quantization allowance. A 1/256 texel fraction error on each axis is
          // bounded independently by measured adjacent-texel differences; f32
          // rounding is bounded by the original payload magnitude.
          const bound = gradients[channel] / 256 + Math.max(magnitudes[channel], 1) * 2 ** -22;
          check(
            Number.isFinite(actual) && error <= bound,
            JSON.stringify({ field: field.name, query, channel, actual, expected, error, bound })
          );
        }
      readback.unmap();
      const timing = cost
        ? await measureProductSampling(
            device,
            code,
            data,
            texture,
            sampler,
            index,
            packed.productBankWords,
            gradients,
            magnitudes,
            retained
          )
        : undefined;
      rows.push({
        field: field.name,
        format: field.format,
        queries: queries.length / 4,
        worstAbsoluteError: worst,
        ...(timing === undefined ? {} : { timing })
      });
    }
    return {
      passed: true,
      scope: cost
        ? "isolated production Product sampler cost versus hardware, identical texels; not full Surface performance"
        : "production immutable bank sampler versus original hardware filtering",
      rows,
      physicalBanks: packed.products.map((item) => item.byteLength)
    };
  } finally {
    retained.forEach((item) => item.destroy());
  }
}
